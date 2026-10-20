// SPDX-License-Identifier: GPL-2.0-or-later
//! The parts every sync entry point runs before it reads or writes data, in
//! the order of SYNC-PROCESS §3: the local guard, the credentials, the
//! listing, the remote guard, the sync-format marker and the
//! password-check. They stay separate parts, not one function, because the
//! entry points list Drive differently: a full pass (flush, polling, the
//! passes of [`crate::execute`]) takes one unfiltered listing, while the
//! Analyze sync and the fetch of another device's day take narrow,
//! name-filtered ones.
//!
//! [`Preflight`] holds what the parts share: the Drive client, the sync's
//! memory ([`SyncRuntime`]), the stored password, the sign-in, this
//! machine's password-change state and the work in flight. The parts are
//! its methods, in [`crate::format`], [`crate::format_status`] and
//! [`crate::password`].

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use pipette_drive::UploadedFile;
use pipette_drive::client::DriveClient;
use pipette_drive::retry::DriveFailure;
use pipette_sync_runtime::{SyncCredentialFailureReason, SyncRuntime};
use zeroize::Zeroizing;

use crate::format_status::FormatStatusCache;
use crate::password::guard::SyncBlockReason;
use crate::password::state::ChangeStateFile;
use crate::single_flight::SingleFlight;

/// How long a marker or password-check this process created and no listing
/// shows yet still counts as present (Drive's listing lag).
pub const CREATED_MEMORY_MS: u64 = 5 * 60 * 1000;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Why a part stopped the entry point. The message is what the renderer
/// shows (an i18n key, or the text of a Drive or storage failure).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum PreflightError {
    /// The guard blocks sync.
    #[error("{}", .0.i18n_key())]
    Blocked(SyncBlockReason),
    /// A credential failure, in the default namespace.
    #[error("sync.changePasswordError.{}", .0.as_str())]
    Credential(SyncCredentialFailureReason),
    /// The stored password does not open the password-check.
    #[error("sync.passwordMismatch")]
    PasswordMismatch,
    #[error("sync.passwordAlreadySet")]
    PasswordAlreadySet,
    #[error("sync.reenterPasswordNoRemote")]
    NoRemotePasswordCheck,
    /// The sign-in changed (a sign-out or another account) while the
    /// operation ran; what it learned about the previous account is not
    /// stored or written.
    #[error("The sign-in changed during the operation; nothing was stored")]
    AccountChanged,
    #[error("{0}")]
    Drive(DriveFailure),
    /// Anything else: a store, a parse or an encryption failure.
    #[error("{0}")]
    Other(String),
}

impl From<DriveFailure> for PreflightError {
    fn from(failure: DriveFailure) -> Self {
        Self::Drive(failure)
    }
}

/// The stored sync password.
pub trait PasswordStore: Send + Sync {
    /// The password, or the local reason it cannot be had
    /// (`NoPasswordFile`, `DecryptFailed` or `KeystoreUnavailable`).
    fn retrieve(&self) -> BoxFuture<'_, Result<Zeroizing<String>, SyncCredentialFailureReason>>;
    /// Stores `password`; the error is the message of the failure.
    fn store<'a>(&'a self, password: &'a str) -> BoxFuture<'a, Result<(), String>>;
    /// Removes the stored password; every failure is ignored.
    fn clear(&self) -> BoxFuture<'_, ()>;
}

/// Whether the sync is signed in.
pub trait SignIn: Send + Sync {
    fn is_signed_in(&self) -> BoxFuture<'_, bool>;
}

/// The clock of the created-file memories, in milliseconds.
pub type NowMs = Arc<dyn Fn() -> u64 + Send + Sync>;

/// What a [`Preflight`] is built from.
pub struct PreflightDeps {
    pub drive: DriveClient,
    pub runtime: SyncRuntime,
    pub passwords: Arc<dyn PasswordStore>,
    pub sign_in: Arc<dyn SignIn>,
    /// `local/auth/` of the userData, where this machine's password-change
    /// state file lives.
    pub auth_dir: PathBuf,
    pub now_ms: NowMs,
}

/// A password-check this process created, when, and in which sign-out
/// generation ([`Preflight::sync_format_generation`]).
#[derive(Clone, Debug)]
pub(crate) struct CreatedPasswordCheck {
    pub file: UploadedFile,
    pub at_ms: u64,
    pub generation: u64,
}

pub struct Preflight {
    pub(crate) drive: DriveClient,
    pub(crate) runtime: SyncRuntime,
    pub(crate) passwords: Arc<dyn PasswordStore>,
    pub(crate) sign_in: Arc<dyn SignIn>,
    pub(crate) now_ms: NowMs,
    pub(crate) change_state: ChangeStateFile,
    /// The creation of our sync-format marker in flight.
    pub(crate) marker_creating: SingleFlight<()>,
    /// The password-check this process created.
    pub(crate) password_check_created: Mutex<Option<CreatedPasswordCheck>>,
    /// The creation of the password-check in flight.
    pub(crate) password_check_creating: SingleFlight<UploadedFile>,
    /// Held for the whole of a set or a replace of the password, so only
    /// one of them decides at a time whether a password is stored and
    /// whether Drive needs a password-check.
    pub(crate) password_setting: tokio::sync::Mutex<()>,
    pub(crate) format_status: FormatStatusCache,
}

impl Preflight {
    pub fn new(deps: PreflightDeps) -> Arc<Self> {
        Arc::new(Self {
            drive: deps.drive,
            runtime: deps.runtime,
            passwords: deps.passwords,
            sign_in: deps.sign_in,
            now_ms: deps.now_ms,
            change_state: ChangeStateFile::new(&deps.auth_dir),
            marker_creating: SingleFlight::default(),
            password_check_created: Mutex::default(),
            password_check_creating: SingleFlight::default(),
            password_setting: tokio::sync::Mutex::new(()),
            format_status: FormatStatusCache::default(),
        })
    }

    pub fn drive(&self) -> &DriveClient {
        &self.drive
    }

    pub fn runtime(&self) -> &SyncRuntime {
        &self.runtime
    }

    /// Whether the sync is signed in.
    pub async fn is_signed_in(&self) -> bool {
        self.sign_in.is_signed_in().await
    }

    pub(crate) fn now(&self) -> u64 {
        (self.now_ms)()
    }

    /// What this process learned about the signed-in account and forgets when
    /// the sign-in changes: the validated and created password-check, the
    /// sync-format status and the marker this process created. The sign-out
    /// generation is bumped first, so work that started for the previous
    /// account and finishes meanwhile either records nothing or records before
    /// the caches below are emptied. A password-check creation in flight is
    /// forgotten: the next account's callers do not join it.
    pub fn forget_account(&self) {
        self.clear_sync_format_status();
        self.password_check_creating.forget();
        self.reset_password_check_cache();
    }
}
