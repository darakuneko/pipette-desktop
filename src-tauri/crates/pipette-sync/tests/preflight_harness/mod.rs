// SPDX-License-Identifier: GPL-2.0-or-later
//! The world of the preflight tests: the in-memory Drive of pipette-drive
//! behind a wrapper that logs each request as the TypeScript recorder does
//! (scripts/sync-fixtures/record-preflight-fixtures.test.ts), hides the
//! files created while listings lag and holds requests at a gate; a stored
//! password and a sign-in the test sets; a clock the test moves; and a
//! userData whose `local/auth/` holds the password-change state.

#![allow(clippy::unwrap_used, clippy::panic, dead_code)]

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pipette_drive::client::DriveClient;
use pipette_drive::fake::{DriveOp, Fault, InMemoryDrive};
use pipette_drive::retry::{RetryEnv, SleepFuture};
use pipette_drive::{DriveApi, DriveFile, DriveFuture, FileList, ListQuery, UploadedFile};
use pipette_sync::format::SyncFormatStatus;
use pipette_sync::preflight::{BoxFuture, PasswordStore, Preflight, PreflightDeps, SignIn};
use pipette_sync_format::password_check::encrypt_password_check;
use pipette_sync_runtime::{SyncCredentialFailureReason, SyncRuntime};
use tokio::sync::watch;
use zeroize::Zeroizing;

pub const START_MS: u64 = 1_000_000;

/// Retries without waiting.
pub struct NoWaits;

impl RetryEnv for NoWaits {
    fn is_quitting(&self) -> bool {
        false
    }

    fn now_ms(&self) -> i64 {
        0
    }

    fn random(&self) -> f64 {
        0.5
    }

    fn sleep(&self, _: Duration) -> SleepFuture<'_> {
        Box::pin(std::future::ready(()))
    }
}

/// A gate requests of one operation wait at until it opens.
struct Gate {
    op: DriveOp,
    /// Only listings with this `name_contains` (`None`: every one of `op`).
    name: Option<Option<String>>,
    open: watch::Sender<bool>,
    started: AtomicU64,
}

/// The in-memory Drive with a request log, listing lag and gates.
#[derive(Default)]
pub struct TestDrive {
    pub inner: InMemoryDrive,
    hide_new: AtomicBool,
    hidden: Mutex<HashSet<String>>,
    events: Mutex<Vec<String>>,
    gate: Mutex<Option<Arc<Gate>>>,
}

impl TestDrive {
    pub fn take_events(&self) -> Vec<String> {
        std::mem::take(&mut *self.events.lock().unwrap())
    }

    fn log(&self, event: String) {
        self.events.lock().unwrap().push(event);
    }

    /// While on, created files are missing from listings; turning it off
    /// shows them all.
    pub fn hide_new(&self, on: bool) {
        self.hide_new.store(on, Ordering::SeqCst);
        if !on {
            self.hidden.lock().unwrap().clear();
        }
    }

    /// Makes the next request of `op` fail with a 400.
    pub fn fail_next(&self, op: DriveOp) {
        self.inner.inject(Fault { only: Some(op), ..Fault::with_status(400) });
    }

    /// Holds requests of `op` (listings only with `name` when given) until
    /// [`TestDrive::open_gate`].
    pub fn hold(&self, op: DriveOp, name: Option<Option<&str>>) {
        let gate = Gate {
            op,
            name: name.map(|n| n.map(str::to_owned)),
            open: watch::Sender::new(false),
            started: AtomicU64::new(0),
        };
        *self.gate.lock().unwrap() = Some(Arc::new(gate));
    }

    pub fn held(&self) -> u64 {
        self.gate.lock().unwrap().as_ref().map_or(0, |gate| gate.started.load(Ordering::SeqCst))
    }

    pub fn open_gate(&self) {
        if let Some(gate) = self.gate.lock().unwrap().take() {
            gate.open.send_replace(true);
        }
    }

    fn gate_for(&self, op: DriveOp, name: Option<&Option<String>>) -> Option<watch::Receiver<bool>> {
        let gate = self.gate.lock().unwrap().clone()?;
        let matches = gate.op == op && gate.name.as_ref().is_none_or(|wanted| Some(wanted) == name);
        if !matches {
            return None;
        }
        gate.started.fetch_add(1, Ordering::SeqCst);
        Some(gate.open.subscribe())
    }

    /// Creates a file without logging it, as a seed.
    pub async fn seed(&self, name: &str, content: &str) -> UploadedFile {
        let file = self.inner.create(name.to_owned(), content.to_owned()).await.unwrap();
        if self.hide_new.load(Ordering::SeqCst) {
            self.hidden.lock().unwrap().insert(file.id.clone());
        }
        file
    }

    pub async fn seed_password_check(&self, password: &str) -> UploadedFile {
        let password = password.to_owned();
        let envelope =
            tokio::task::spawn_blocking(move || encrypt_password_check(&password).unwrap()).await.unwrap();
        self.seed("password-check.enc", &serde_json::to_string(&envelope).unwrap()).await
    }

    /// Rewrites a file's content (a new `modifiedTime`) without logging it.
    pub async fn rewrite_password_check(&self, id: &str, password: &str) {
        let password = password.to_owned();
        let envelope =
            tokio::task::spawn_blocking(move || encrypt_password_check(&password).unwrap()).await.unwrap();
        self.inner.update(id.to_owned(), serde_json::to_string(&envelope).unwrap()).await.unwrap();
    }

    pub fn names(&self) -> Vec<String> {
        self.inner.files().into_iter().map(|stored| stored.file.name).collect()
    }
}

async fn wait(gate: Option<watch::Receiver<bool>>) {
    if let Some(mut gate) = gate {
        let _ = gate.wait_for(|open| *open).await;
    }
}

impl DriveApi for TestDrive {
    fn list_page(&self, query: ListQuery) -> DriveFuture<'_, FileList> {
        self.log(format!("list:{}", query.name_contains.as_deref().unwrap_or("*")));
        let gate = self.gate_for(DriveOp::List, Some(&query.name_contains));
        Box::pin(async move {
            wait(gate).await;
            let mut page = self.inner.list_page(query).await?;
            let hidden = self.hidden.lock().unwrap();
            page.files.retain(|file| !hidden.contains(&file.id));
            Ok(page)
        })
    }

    fn download(&self, id: String) -> DriveFuture<'_, Vec<u8>> {
        self.log(format!("download:{id}"));
        self.inner.download(id)
    }

    fn create(&self, name: String, content: String) -> DriveFuture<'_, UploadedFile> {
        self.log(format!("create:{name}"));
        let gate = self.gate_for(DriveOp::Create, None);
        Box::pin(async move {
            wait(gate).await;
            let file = self.inner.create(name, content).await?;
            if self.hide_new.load(Ordering::SeqCst) {
                self.hidden.lock().unwrap().insert(file.id.clone());
            }
            Ok(file)
        })
    }

    fn create_raw(&self, name: String, content: String) -> DriveFuture<'_, String> {
        self.log(format!("create:{name} {content}"));
        let gate = self.gate_for(DriveOp::Create, None);
        Box::pin(async move {
            wait(gate).await;
            let id = self.inner.create_raw(name, content).await?;
            if self.hide_new.load(Ordering::SeqCst) {
                self.hidden.lock().unwrap().insert(id.clone());
            }
            Ok(id)
        })
    }

    fn update(&self, id: String, content: String) -> DriveFuture<'_, UploadedFile> {
        self.log(format!("update:{id}"));
        self.inner.update(id, content)
    }

    fn rename(&self, id: String, name: String) -> DriveFuture<'_, DriveFile> {
        self.log(format!("rename:{id}"));
        self.inner.rename(id, name)
    }

    fn delete(&self, id: String) -> DriveFuture<'_, ()> {
        self.log(format!("delete:{id}"));
        self.inner.delete(id)
    }
}

/// The stored password as the TypeScript recorder's mock keeps it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stored {
    None,
    Readable(String),
    DecryptFailed,
    KeystoreUnavailable,
}

#[derive(Default)]
pub struct FakePasswords {
    pub state: Mutex<Option<Stored>>,
}

impl FakePasswords {
    pub fn get(&self) -> Stored {
        self.state.lock().unwrap().clone().unwrap_or(Stored::None)
    }

    pub fn set(&self, stored: Stored) {
        *self.state.lock().unwrap() = Some(stored);
    }
}

impl PasswordStore for FakePasswords {
    fn retrieve(&self) -> BoxFuture<'_, Result<Zeroizing<String>, SyncCredentialFailureReason>> {
        let result = match self.get() {
            Stored::Readable(password) => Ok(Zeroizing::new(password)),
            Stored::None => Err(SyncCredentialFailureReason::NoPasswordFile),
            Stored::DecryptFailed => Err(SyncCredentialFailureReason::DecryptFailed),
            Stored::KeystoreUnavailable => Err(SyncCredentialFailureReason::KeystoreUnavailable),
        };
        Box::pin(std::future::ready(result))
    }

    fn store<'a>(&'a self, password: &'a str) -> BoxFuture<'a, Result<(), String>> {
        let result = if self.get() == Stored::KeystoreUnavailable {
            Err("OS keychain encryption is not available".to_owned())
        } else {
            self.set(Stored::Readable(password.to_owned()));
            Ok(())
        };
        Box::pin(std::future::ready(result))
    }

    fn clear(&self) -> BoxFuture<'_, ()> {
        if self.get() != Stored::KeystoreUnavailable {
            self.set(Stored::None);
        }
        Box::pin(std::future::ready(()))
    }
}

pub struct FakeSignIn(pub AtomicBool);

impl SignIn for FakeSignIn {
    fn is_signed_in(&self) -> BoxFuture<'_, bool> {
        Box::pin(std::future::ready(self.0.load(Ordering::SeqCst)))
    }
}

pub struct Harness {
    pub drive: Arc<TestDrive>,
    pub preflight: Arc<Preflight>,
    pub passwords: Arc<FakePasswords>,
    pub sign_in: Arc<FakeSignIn>,
    pub now: Arc<AtomicU64>,
    pub format_events: Arc<Mutex<Vec<Option<SyncFormatStatus>>>>,
    pub auth_dir: PathBuf,
    _dir: tempfile::TempDir,
}

impl Harness {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let auth_dir = dir.path().join("local/auth");
        let drive = Arc::new(TestDrive::default());
        let passwords = Arc::new(FakePasswords::default());
        let sign_in = Arc::new(FakeSignIn(AtomicBool::new(true)));
        let now = Arc::new(AtomicU64::new(START_MS));
        let clock = Arc::clone(&now);
        let preflight = Preflight::new(PreflightDeps {
            drive: DriveClient::new(drive.clone(), Arc::new(NoWaits)),
            runtime: SyncRuntime::new(),
            passwords: passwords.clone(),
            sign_in: sign_in.clone(),
            auth_dir: auth_dir.clone(),
            now_ms: Arc::new(move || clock.load(Ordering::SeqCst)),
        });
        let format_events = Arc::new(Mutex::new(Vec::new()));
        let events = Arc::clone(&format_events);
        preflight.set_sync_format_status_listener(move |status| events.lock().unwrap().push(status));
        Self { drive, preflight, passwords, sign_in, now, format_events, auth_dir, _dir: dir }
    }

    pub fn advance(&self, ms: u64) {
        self.now.fetch_add(ms, Ordering::SeqCst);
    }

    /// Writes this machine's password-change state file (`None` removes
    /// it), as a password change would, forgetting the cached answer.
    pub fn local_state(&self, content: Option<&str>) {
        std::fs::create_dir_all(&self.auth_dir).unwrap();
        let path = self.auth_dir.join("sync-password-change.json");
        match content {
            Some(content) => std::fs::write(path, content).unwrap(),
            None => {
                let _ = std::fs::remove_file(path);
            }
        }
        self.preflight.forget_change_state_cache();
    }

    pub async fn list_all(&self) -> Vec<DriveFile> {
        self.preflight.drive().list_files(None).await.unwrap()
    }

    pub fn validated(&self) -> Option<(String, String)> {
        self.preflight.runtime().credentials().validated_password_check().map(|v| (v.id, v.modified_time))
    }
}
