// SPDX-License-Identifier: GPL-2.0-or-later
//! Signing in and out without losing or misdirecting the pending units. The
//! units themselves and their owner live in `pipette_sync_pending`; this module
//! times the switch of tokens around them.
//!
//! A sign-in stores its tokens only once no pass holds the sync lock and no
//! analytics sync or remote day fetch (the Drive writers that don't take
//! the lock) runs, holding the lock and keeping those writers from starting
//! meanwhile; if they don't finish within [`ACCOUNT_SWITCH_WAIT`], the
//! sign-in fails and the old tokens stay. So no Drive request of work
//! started under one account is sent with another account's tokens. A
//! sign-out waits the same way but goes ahead after the wait: requests sent
//! after the tokens are gone fail instead of reaching another account. The
//! exception is a password change, which a sign-out refuses instead of
//! cutting short. Only one switch runs at a time; another is refused at
//! once.
//!
//! Each change of ownership is written before the tokens change; when it
//! cannot be, the tokens stay. Both forget the files this process created
//! on the previous account's Drive once the stored sign-in has changed
//! ([`forget_account_caches`]); the password-check and the sync-format
//! status are forgotten by `Preflight::forget_account`, which the app calls
//! from `GoogleAuth::on_account_changed` when the tokens are stored or
//! removed, inside the switch.

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use pipette_google_auth::{AuthError, GoogleAuth, StoreTokens, SwitchFuture, TokenSwitch};
use pipette_sync_pending::PendingStore;
use pipette_sync_runtime::SyncRuntime;
use pipette_sync_runtime::runtime::{AccountSwitch, SyncLockGuard};
use tokio::time::Instant;

/// How long a sign-in or sign-out waits for running sync work.
pub const ACCOUNT_SWITCH_WAIT: Duration = Duration::from_secs(30);

pub const ACCOUNT_SWITCH_BUSY_MESSAGE: &str =
    "Cannot switch accounts while sync is in progress. Try again in a moment.";

/// Refusal of a sign-out while a password change runs (an i18n key).
pub const SIGN_OUT_PASSWORD_CHANGING: &str = "sync.signOutPasswordChanging";

/// The `reason` of a refusal the renderer shows its own message for.
pub const SYNC_BUSY_REASON: &str = "syncBusy";

/// Why a sign-in or sign-out did not switch the tokens.
#[derive(Debug, thiserror::Error)]
pub enum AccountSwitchError {
    /// Sync work kept running past the wait, or another switch runs.
    #[error("{ACCOUNT_SWITCH_BUSY_MESSAGE}")]
    Busy,
    #[error("{SIGN_OUT_PASSWORD_CHANGING}")]
    PasswordChanging,
    /// The change of ownership could not be written; the tokens stay.
    #[error(transparent)]
    Pending(#[from] std::io::Error),
    /// The new tokens could not be stored.
    #[error(transparent)]
    Auth(AuthError),
}

impl AccountSwitchError {
    /// The `reason` the IPC result carries.
    pub fn reason(&self) -> Option<&'static str> {
        matches!(self, Self::Busy).then_some(SYNC_BUSY_REASON)
    }
}

/// The stored Google sign-in, as the switch needs it.
pub trait SignedInAccount: Send + Sync {
    /// The `sub` of the signed-in account's id_token.
    fn account_sub(&self) -> impl Future<Output = Option<String>> + Send;
    /// Removes the stored sign-in.
    fn sign_out(&self) -> impl Future<Output = ()> + Send;
}

impl SignedInAccount for GoogleAuth {
    fn account_sub(&self) -> impl Future<Output = Option<String>> + Send {
        GoogleAuth::account_sub(self)
    }

    fn sign_out(&self) -> impl Future<Output = ()> + Send {
        GoogleAuth::sign_out(self)
    }
}

/// The account caches the sync runtime holds: the files this run created
/// on the previous account's Drive. The rest is
/// [`crate::preflight::Preflight::forget_account`], run once per change of
/// the stored sign-in by its `GoogleAuth::on_account_changed` listener; it
/// bumps the sign-out generation before it empties anything, so it is not
/// repeated here.
pub fn forget_account_caches(runtime: &SyncRuntime) {
    runtime.remote().clear_created_files();
}

/// A switch of tokens under way: the sync lock when it was free in time,
/// released before the switch mark is cleared (the fields drop in order).
struct Switching {
    _lock: Option<SyncLockGuard>,
    _switch: AccountSwitch,
}

/// Times the sign-ins and sign-outs of `account` around the pending units.
/// Cheap to build: it holds handles to shared state.
pub struct AccountSwitcher<A> {
    runtime: SyncRuntime,
    pending: PendingStore,
    account: Arc<A>,
}

impl<A: SignedInAccount> AccountSwitcher<A> {
    pub fn new(runtime: SyncRuntime, pending: PendingStore, account: Arc<A>) -> Self {
        Self { runtime, pending, account }
    }

    /// Hands the pending units to the account the stored tokens belong to
    /// and returns its id. Called by every pass that uploads pending units,
    /// after its credential check and before it reads them, and once at
    /// startup.
    pub async fn adopt_pending_for_signed_in_account(&self) -> Option<String> {
        let sub = self.account.account_sub().await;
        self.pending.adopt_for_account(sub.as_deref());
        sub
    }

    /// The startup's [`Self::adopt_pending_for_signed_in_account`], which
    /// runs alongside the commands: `changes` counts the changes of the
    /// stored sign-in (bumped by `GoogleAuth::on_account_changed`). A
    /// sign-in or sign-out that changed it after the account was read hands
    /// the units over itself, so the account read is then stale and nothing
    /// is adopted. The check and the hand-over run with the switch marked,
    /// so no switch lands between them; one that starts meanwhile is
    /// refused as busy.
    pub async fn adopt_pending_at_startup(&self, changes: &AtomicU64) {
        let seen = changes.load(Ordering::SeqCst);
        let sub = self.account.account_sub().await;
        let Some(_switch) = self.runtime.try_begin_account_switch() else { return };
        if changes.load(Ordering::SeqCst) == seen {
            self.pending.adopt_for_account(sub.as_deref());
        }
    }

    /// Gives ownerless units to the account still signed in, before its
    /// tokens are replaced or removed.
    async fn claim_ownerless_for_signed_in_account(&self) -> std::io::Result<()> {
        if self.pending.owner().is_some() || !self.pending.has_pending_changes() {
            return Ok(());
        }
        let sub = self.account.account_sub().await;
        self.pending.claim_ownerless_durably(sub.as_deref())
    }

    /// Marks the switch, then waits up to [`ACCOUNT_SWITCH_WAIT`] for the
    /// sync lock and for the lock-free writers to end, holding the lock
    /// once it is free. When the wait runs out, `refuse` answers
    /// [`AccountSwitchError::Busy`]; otherwise the switch goes ahead, with
    /// the lock if it was had.
    async fn begin_switch(&self, refuse: bool) -> Result<Switching, AccountSwitchError> {
        let switch = self.runtime.try_begin_account_switch().ok_or(AccountSwitchError::Busy)?;
        let claim = self.runtime.claim_sync_lock_when_idle_by(Instant::now() + ACCOUNT_SWITCH_WAIT).await;
        if !claim.idle && refuse {
            return Err(AccountSwitchError::Busy);
        }
        Ok(Switching { _lock: claim.lock, _switch: switch })
    }

    /// The token switch of a new sign-in: once running sync work has finished,
    /// gives ownerless units to the account still signed in, hands the pending
    /// units to `new_account_sub`'s account, stores the new tokens with
    /// `store`, and forgets the previous account's caches before the lock is
    /// released. If storing fails, the old tokens stay and the next pass hands
    /// the units back to their account.
    pub async fn switch_account_keeping_pending(
        &self,
        store: impl Future<Output = Result<(), AuthError>> + Send,
        new_account_sub: Option<String>,
    ) -> Result<(), AccountSwitchError> {
        let _switching = self.begin_switch(true).await?;
        self.claim_ownerless_for_signed_in_account().await?;
        self.pending.adopt_durably(new_account_sub.as_deref())?;
        store.await.map_err(AccountSwitchError::Auth)?;
        forget_account_caches(&self.runtime);
        Ok(())
    }

    /// Signs out, first holding the account's pending units for its next
    /// sign-in, then forgets the account's caches; changes made from here on
    /// belong to whoever signs in next. If the hold cannot be written, the
    /// tokens and caches stay. The caller holds the sync lock (a reset
    /// removing the stored sign-in).
    pub async fn sign_out_keeping_pending_locked(&self) -> Result<(), AccountSwitchError> {
        self.claim_ownerless_for_signed_in_account().await?;
        self.pending.hold_for_sign_out_durably()?;
        self.account.sign_out().await;
        forget_account_caches(&self.runtime);
        Ok(())
    }

    /// [`Self::sign_out_keeping_pending_locked`] once running sync work has
    /// finished, or after the wait anyway. Refused while a password change
    /// runs, before the wait and again after it: removing the tokens would
    /// stop the change halfway. No password change starts while the switch
    /// is marked, but one can start between the first check and the mark.
    pub async fn sign_out_keeping_pending(&self) -> Result<(), AccountSwitchError> {
        if self.runtime.password_change_running() {
            return Err(AccountSwitchError::PasswordChanging);
        }
        let _switching = self.begin_switch(false).await?;
        if self.runtime.password_change_running() {
            return Err(AccountSwitchError::PasswordChanging);
        }
        self.sign_out_keeping_pending_locked().await
    }
}

/// The [`TokenSwitch`] of a sign-in: the store step runs inside
/// [`AccountSwitcher::switch_account_keeping_pending`]. A refusal reaches
/// the sign-in as [`AuthError::Switch`] carrying the [`AccountSwitchError`];
/// a failed store as its own error.
impl<A: SignedInAccount> TokenSwitch for AccountSwitcher<A> {
    fn switch<'a>(&'a self, store: StoreTokens<'a>, new_account_sub: Option<String>) -> SwitchFuture<'a> {
        Box::pin(async move {
            self.switch_account_keeping_pending(store.store(), new_account_sub).await.map_err(|err| match err
            {
                AccountSwitchError::Auth(err) => err,
                other => AuthError::Switch(Box::new(other)),
            })
        })
    }
}
