// SPDX-License-Identifier: GPL-2.0-or-later
//! The world of the password-change tests: the in-memory Drive of pipette-drive
//! behind a wrapper that logs each request in the form of the recorded goldens,
//! hides the files created while listings lag, fails the next request of an
//! operation and acts after a number of updates; a userData whose secret store
//! keeps the change keys in a key store in memory; and machines on that Drive,
//! each with its own sync runtime, which a test can restart.

#![allow(clippy::unwrap_used, clippy::panic, dead_code)]

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use pipette_drive::client::DriveClient;
use pipette_drive::fake::{DriveOp, Fault, InMemoryDrive};
use pipette_drive::retry::{RetryEnv, SleepFuture};
use pipette_drive::{DriveApi, DriveError, DriveFile, DriveFuture, FileList, ListQuery, UploadedFile};
use pipette_secret_store::{MemoryKeystore, SecretStore};
use pipette_sync::codec::{CodecFuture, EnvelopeCodec};
use pipette_sync::password::change::{PasswordChange, PasswordChangeDeps, PasswordChangeTuning};
use pipette_sync::password::lock::LockTiming;
use pipette_sync::preflight::{BoxFuture, PasswordStore, Preflight, PreflightDeps, SignIn};
use pipette_sync_format::Envelope;
use pipette_sync_format::crypto::{
    IV_LENGTH, KEY_LENGTH, SALT_LENGTH, decrypt_with_key, encrypt_with_key, key_for,
};
use pipette_sync_format::password_check::PASSWORD_CHECK_UNIT;
use pipette_sync_runtime::{SyncCredentialFailureReason, SyncRuntime};
use zeroize::Zeroizing;

/// 2026-10-16T00:00:00.000Z, the clock of the recordings.
pub const NOW: u64 = 1_792_108_800_000;
pub const MACHINE_HASH: &str = "golden-hash";

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

/// What happens after a number of updates.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /// The machine that sent the update starts quitting.
    Quit,
    /// Every lock file goes (another machine released them).
    DeleteLocks,
    /// Another machine writes `content` into the file `id`.
    Rewrite(String, String),
}

/// How the write that [`TestDrive::fail_write`] picks fails.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteFailure {
    /// Drive refuses it (a 400); nothing changes.
    Refused,
    /// Drive does it, then the answer is lost (a network error).
    AnswerLost,
}

/// The in-memory Drive with a request log, listing lag, failures and an
/// action after updates.
#[derive(Default)]
pub struct TestDrive {
    pub inner: InMemoryDrive,
    hide_new: AtomicBool,
    hidden: Mutex<HashSet<String>>,
    events: Mutex<Vec<String>>,
    after_updates: Mutex<Option<(u32, Action)>>,
    /// The runtime an `Action::Quit` stops.
    quitting: Mutex<Option<SyncRuntime>>,
    /// The writes (create, update, rename, delete) left before one fails.
    fail_write: Mutex<Option<(u32, WriteFailure)>>,
    writes: AtomicU64,
    yield_downloads: AtomicBool,
}

impl TestDrive {
    pub fn take_events(&self) -> Vec<String> {
        std::mem::take(&mut *self.events.lock().unwrap())
    }

    pub fn log(&self, event: String) {
        self.events.lock().unwrap().push(event);
    }

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

    pub fn after_updates(&self, count: u32, action: Action) {
        *self.after_updates.lock().unwrap() = Some((count, action));
    }

    /// Makes the `nth` write from now (1 for the next) fail as `failure`.
    pub fn fail_write(&self, nth: u32, failure: WriteFailure) {
        *self.fail_write.lock().unwrap() = Some((nth, failure));
    }

    /// While on, every download waits a turn of the runtime first.
    pub fn yield_downloads(&self, on: bool) {
        self.yield_downloads.store(on, Ordering::SeqCst);
    }

    /// Whether the last [`TestDrive::fail_write`] has not happened yet.
    pub fn write_failure_pending(&self) -> bool {
        self.fail_write.lock().unwrap().is_some()
    }

    /// How many writes were sent.
    pub fn writes(&self) -> u64 {
        self.writes.load(Ordering::SeqCst)
    }

    /// Counts a write; the failure it is to get, if due.
    fn write_failure(&self) -> Option<WriteFailure> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        let mut due = self.fail_write.lock().unwrap();
        let (count, failure) = due.as_mut()?;
        *count -= 1;
        if *count > 0 {
            return None;
        }
        let failure = *failure;
        *due = None;
        Some(failure)
    }

    /// Sends a write through `write`, failing it when due.
    fn write<'a, T: Send + 'a>(&'a self, write: DriveFuture<'a, T>) -> DriveFuture<'a, T> {
        let failure = self.write_failure();
        Box::pin(async move {
            match failure {
                None => write.await,
                Some(WriteFailure::Refused) => Err(DriveError::Status {
                    status: 400,
                    body: "{\"error\":{\"code\":400,\"message\":\"Injected failure\"}}".to_owned(),
                    retry_after: None,
                }),
                Some(WriteFailure::AnswerLost) => {
                    let _ = write.await;
                    Err(DriveError::Network(pipette_drive::fake::LOST_ANSWER.to_owned()))
                }
            }
        })
    }

    pub fn set_quit_target(&self, runtime: SyncRuntime) {
        *self.quitting.lock().unwrap() = Some(runtime);
    }

    fn created(&self, id: &str) {
        if self.hide_new.load(Ordering::SeqCst) {
            self.hidden.lock().unwrap().insert(id.to_owned());
        }
    }

    /// Creates a file without logging it, as a seed.
    pub async fn seed(&self, name: &str, content: &str) -> UploadedFile {
        let file = self.inner.create(name.to_owned(), content.to_owned()).await.unwrap();
        self.created(&file.id);
        file
    }

    /// Replaces a file's content (a new `modifiedTime`) without logging it.
    pub async fn rewrite(&self, id: &str, content: &str) {
        self.inner.update(id.to_owned(), content.to_owned()).await.unwrap();
    }

    pub fn content(&self, id: &str) -> Option<Vec<u8>> {
        self.inner.files().into_iter().find(|stored| stored.file.id == id).map(|stored| stored.content)
    }

    async fn run_after_update(&self) {
        let action = {
            let mut due = self.after_updates.lock().unwrap();
            let Some((count, action)) = due.as_mut() else { return };
            *count -= 1;
            if *count > 0 {
                return;
            }
            let action = action.clone();
            *due = None;
            action
        };
        match action {
            Action::Quit => {
                if let Some(runtime) = self.quitting.lock().unwrap().as_ref() {
                    runtime.set_quitting();
                }
            }
            Action::Rewrite(id, content) => self.rewrite(&id, &content).await,
            Action::DeleteLocks => {
                for stored in self.inner.files() {
                    if stored.file.name == "password-change-lock.json" {
                        self.inner.delete(stored.file.id).await.unwrap();
                    }
                }
            }
        }
    }
}

impl DriveApi for TestDrive {
    fn list_page(&self, query: ListQuery) -> DriveFuture<'_, FileList> {
        self.log(format!("list:{}", query.name_contains.as_deref().unwrap_or("*")));
        Box::pin(async move {
            let mut page = self.inner.list_page(query).await?;
            let hidden = self.hidden.lock().unwrap();
            page.files.retain(|file| !hidden.contains(&file.id));
            Ok(page)
        })
    }

    fn download(&self, id: String) -> DriveFuture<'_, Vec<u8>> {
        self.log(format!("download:{id}"));
        let wait = self.yield_downloads.load(Ordering::SeqCst);
        Box::pin(async move {
            if wait {
                tokio::task::yield_now().await;
            }
            self.inner.download(id).await
        })
    }

    fn create(&self, name: String, content: String) -> DriveFuture<'_, UploadedFile> {
        self.log(format!("create:{name}"));
        self.write(Box::pin(async move {
            let file = self.inner.create(name, content).await?;
            self.created(&file.id);
            Ok(file)
        }))
    }

    fn create_raw(&self, name: String, content: String) -> DriveFuture<'_, String> {
        self.log(format!("createRaw:{name} {content}"));
        self.write(Box::pin(async move {
            let id = self.inner.create_raw(name, content).await?;
            self.created(&id);
            Ok(id)
        }))
    }

    fn update(&self, id: String, content: String) -> DriveFuture<'_, UploadedFile> {
        self.log(format!("update:{id}"));
        self.write(Box::pin(async move {
            let file = self.inner.update(id, content).await?;
            self.run_after_update().await;
            Ok(file)
        }))
    }

    fn rename(&self, id: String, name: String) -> DriveFuture<'_, DriveFile> {
        self.log(format!("rename:{id} {name}"));
        self.write(Box::pin(async move { self.inner.rename(id, name).await }))
    }

    fn delete(&self, id: String) -> DriveFuture<'_, ()> {
        self.log(format!("delete:{id}"));
        self.write(Box::pin(async move { self.inner.delete(id).await }))
    }
}

/// The sync envelope format with each key derived once per password and salt.
/// It seals with one fixed salt and a new IV each time.
#[derive(Default)]
pub struct KeyCachedCodec {
    keys: Mutex<HashMap<KeyId, [u8; KEY_LENGTH]>>,
    sealed: AtomicU64,
}

/// A password and a salt.
type KeyId = (String, Vec<u8>);

const SEAL_SALT: [u8; SALT_LENGTH] = [7; SALT_LENGTH];

impl KeyCachedCodec {
    async fn key(self: &Arc<Self>, password: &str, salt: &[u8]) -> [u8; KEY_LENGTH] {
        let id = (password.to_owned(), salt.to_vec());
        if let Some(key) = self.keys.lock().unwrap().get(&id) {
            return *key;
        }
        let (p, s) = id.clone();
        let key = tokio::task::spawn_blocking(move || key_for(&p, &s)).await.unwrap();
        self.keys.lock().unwrap().insert(id, key);
        key
    }

    pub async fn seal_text(self: &Arc<Self>, plaintext: &str, password: &str, unit: &str) -> String {
        let key = self.key(password, &SEAL_SALT).await;
        let n = self.sealed.fetch_add(1, Ordering::SeqCst);
        let mut iv = [0u8; IV_LENGTH];
        iv[..8].copy_from_slice(&n.to_be_bytes());
        let envelope =
            encrypt_with_key(plaintext, &key, unit, &SEAL_SALT, &iv, "2026-10-16T00:00:00.000Z").unwrap();
        serde_json::to_string(&envelope).unwrap()
    }

    pub async fn open_text(self: &Arc<Self>, content: &[u8], password: &str) -> Result<String, String> {
        let envelope: Envelope =
            serde_json::from_str(&String::from_utf8_lossy(content)).map_err(|err| err.to_string())?;
        let salt = base64::engine::general_purpose::STANDARD
            .decode(&envelope.salt)
            .map_err(|err| err.to_string())?;
        let key = self.key(password, &salt).await;
        decrypt_with_key(&envelope, &key).map_err(|err| err.to_string())
    }
}

/// The codec of a world, as a handle the test keeps.
pub struct SharedCodec(pub Arc<KeyCachedCodec>);

impl EnvelopeCodec for SharedCodec {
    fn seal(&self, plaintext: String, password: Zeroizing<String>, unit: String) -> CodecFuture {
        let codec = self.0.clone();
        Box::pin(async move { Ok(codec.seal_text(&plaintext, &password, &unit).await) })
    }

    fn open(&self, content: Vec<u8>, password: Zeroizing<String>) -> CodecFuture {
        let codec = self.0.clone();
        Box::pin(async move { codec.open_text(&content, &password).await })
    }
}

/// The stored sync password; `None` when there is none.
#[derive(Default)]
pub struct FakePasswords(pub Mutex<Option<String>>);

impl FakePasswords {
    pub fn get(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }

    pub fn set(&self, password: Option<&str>) {
        *self.0.lock().unwrap() = password.map(str::to_owned);
    }
}

impl PasswordStore for FakePasswords {
    fn retrieve(&self) -> BoxFuture<'_, Result<Zeroizing<String>, SyncCredentialFailureReason>> {
        let result = self.get().map(Zeroizing::new).ok_or(SyncCredentialFailureReason::NoPasswordFile);
        Box::pin(std::future::ready(result))
    }

    fn store<'a>(&'a self, password: &'a str) -> BoxFuture<'a, Result<(), String>> {
        self.set(Some(password));
        Box::pin(std::future::ready(Ok(())))
    }

    fn clear(&self) -> BoxFuture<'_, ()> {
        self.set(None);
        Box::pin(std::future::ready(()))
    }
}

pub struct FakeSignIn(pub AtomicBool);

impl SignIn for FakeSignIn {
    fn is_signed_in(&self) -> BoxFuture<'_, bool> {
        Box::pin(std::future::ready(self.0.load(Ordering::SeqCst)))
    }
}

/// One machine on the world's Drive: its own sync runtime, preflight and
/// password change, over a userData of its own.
pub struct Machine {
    pub runtime: SyncRuntime,
    pub preflight: Arc<Preflight>,
    pub change: Arc<PasswordChange>,
    pub secrets: Arc<SecretStore>,
    pub passwords: Arc<FakePasswords>,
    pub sign_in: Arc<FakeSignIn>,
    pub user_data: PathBuf,
    keystore: Arc<MemoryKeystore>,
    next_lock_id: Arc<AtomicU64>,
    machine_hash: String,
}

/// What a machine is built with.
#[derive(Clone)]
pub struct MachineOptions {
    pub machine_hash: String,
    /// The number in this machine's first lock id; machines on one Drive
    /// take apart ones, as random ids are.
    pub first_lock_id: u64,
    pub tuning: PasswordChangeTuning,
}

impl Default for MachineOptions {
    fn default() -> Self {
        Self {
            machine_hash: MACHINE_HASH.to_owned(),
            first_lock_id: 1,
            tuning: PasswordChangeTuning { concurrency: 1, ..PasswordChangeTuning::default() },
        }
    }
}

pub struct World {
    pub drive: Arc<TestDrive>,
    pub codec: Arc<KeyCachedCodec>,
    _dir: tempfile::TempDir,
}

impl World {
    pub fn new() -> Self {
        Self {
            drive: Arc::new(TestDrive::default()),
            codec: Arc::new(KeyCachedCodec::default()),
            _dir: tempfile::tempdir().unwrap(),
        }
    }

    /// A machine whose userData is `name` under this world's directory.
    pub fn machine(&self, name: &str, options: MachineOptions) -> Machine {
        let user_data = self._dir.path().join(name);
        std::fs::create_dir_all(&user_data).unwrap();
        let keystore = Arc::new(MemoryKeystore::default());
        let secrets = Arc::new(SecretStore::new(&user_data, keystore.clone()));
        let passwords = Arc::new(FakePasswords::default());
        let sign_in = Arc::new(FakeSignIn(AtomicBool::new(true)));
        let next_lock_id = Arc::new(AtomicU64::new(options.first_lock_id));
        self.build(user_data, keystore, secrets, passwords, sign_in, next_lock_id, options)
    }

    /// `machine` after a restart: the same userData, key store, stored
    /// password and lock ids, with nothing in memory.
    pub fn restart(&self, machine: &Machine, options: MachineOptions) -> Machine {
        let secrets = Arc::new(SecretStore::new(&machine.user_data, machine.keystore.clone()));
        self.build(
            machine.user_data.clone(),
            machine.keystore.clone(),
            secrets,
            machine.passwords.clone(),
            machine.sign_in.clone(),
            machine.next_lock_id.clone(),
            options,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn build(
        &self,
        user_data: PathBuf,
        keystore: Arc<MemoryKeystore>,
        secrets: Arc<SecretStore>,
        passwords: Arc<FakePasswords>,
        sign_in: Arc<FakeSignIn>,
        next_lock_id: Arc<AtomicU64>,
        options: MachineOptions,
    ) -> Machine {
        let runtime = SyncRuntime::new();
        let preflight = Preflight::new(PreflightDeps {
            drive: DriveClient::new(self.drive.clone(), Arc::new(NoWaits)),
            runtime: runtime.clone(),
            passwords: passwords.clone(),
            sign_in: sign_in.clone(),
            auth_dir: secrets.auth_dir().to_path_buf(),
            now_ms: Arc::new(|| NOW),
        });
        let drive = self.drive.clone();
        let sleep_log: pipette_sync::password::lock::Sleep = Arc::new(move |duration: Duration| {
            drive.log(format!("sleep:{}", duration.as_millis()));
            Box::pin(std::future::ready(()))
        });
        let ids = next_lock_id.clone();
        let hash = options.machine_hash.clone();
        let change = PasswordChange::new(PasswordChangeDeps {
            preflight: preflight.clone(),
            secrets: secrets.clone(),
            codec: Arc::new(SharedCodec(self.codec.clone())),
            machine_hash: Arc::new(move || Ok(hash.clone())),
            new_lock_id: Arc::new(move || {
                format!("00000000-0000-4000-8000-{:012x}", ids.fetch_add(1, Ordering::SeqCst))
            }),
            lock_timing: LockTiming { sleep: sleep_log, ..LockTiming::default() },
            tuning: options.tuning,
        });
        self.drive.set_quit_target(runtime.clone());
        Machine {
            runtime,
            preflight,
            change,
            secrets,
            passwords,
            sign_in,
            user_data,
            keystore,
            next_lock_id,
            machine_hash: options.machine_hash,
        }
    }

    /// Seeds the Drive file of `unit` sealed with `password`, with the
    /// plaintext the recorder uses.
    pub async fn seed_data(&self, unit: &str, password: &str) -> UploadedFile {
        let plaintext = format!("{{\"unit\":\"{unit}\"}}");
        let content = self.codec.seal_text(&plaintext, password, unit).await;
        self.drive.seed(&format!("{}.enc", unit.replace('/', "_")), &content).await
    }

    pub async fn seed_password_check(&self, password: &str) -> UploadedFile {
        let content = self
            .codec
            .seal_text(r#"{"type":"password-check","version":1}"#, password, PASSWORD_CHECK_UNIT)
            .await;
        self.drive.seed("password-check.enc", &content).await
    }

    pub async fn seed_lock(&self, lock_id: &str, machine_hash: &str) -> UploadedFile {
        let content = format!(
            r#"{{"type":"password-change-lock","version":1,"lockId":"{lock_id}","machineHash":"{machine_hash}","startedAt":"2026-10-16T00:00:00.000Z"}}"#
        );
        self.drive.seed("password-change-lock.json", &content).await
    }

    /// The first of `passwords` that opens the file `id`, `None` when none
    /// does.
    pub async fn opener(&self, id: &str, passwords: &[&str]) -> Option<String> {
        let content = self.drive.content(id)?;
        for password in passwords {
            if self.codec.open_text(&content, password).await.is_ok() {
                return Some((*password).to_owned());
            }
        }
        None
    }
}

impl Machine {
    pub fn state_file(&self) -> Option<String> {
        std::fs::read_to_string(self.secrets.auth_dir().join("sync-password-change.json")).ok()
    }

    /// Writes the state file as another program would, forgetting the
    /// cached answer of the guard.
    pub fn write_state_file(&self, content: Option<&str>) {
        std::fs::create_dir_all(self.secrets.auth_dir()).unwrap();
        let path = self.secrets.auth_dir().join("sync-password-change.json");
        match content {
            Some(content) => std::fs::write(path, content).unwrap(),
            None => {
                let _ = std::fs::remove_file(path);
            }
        }
        self.preflight.forget_change_state_cache();
    }

    pub async fn keys_summary(&self) -> String {
        match pipette_sync::password::state::retrieve_change_keys(&self.secrets).await {
            Ok(keys) => format!("{}>{}", keys.old_password.as_str(), keys.new_password.as_str()),
            Err(reason) => reason.as_str().to_owned(),
        }
    }

    pub async fn store_keys(&self, old: &str, new: &str) {
        let keys = pipette_sync::password::state::ChangeKeys::new(old, new);
        pipette_sync::password::state::store_change_keys(&self.secrets, &keys).await.unwrap();
    }
}

/// A listed file of the Drive, for assertions.
pub fn file_names(drive: &TestDrive) -> Vec<String> {
    drive.inner.files().into_iter().map(|stored| stored.file.name).collect()
}
