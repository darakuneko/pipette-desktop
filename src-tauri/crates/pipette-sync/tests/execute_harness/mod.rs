// SPDX-License-Identifier: GPL-2.0-or-later
//! The world of the pass tests: a userData with the stores and the typing
//! analytics of a fixed machine at a fixed time, the in-memory Drive of the
//! preflight tests (requests logged, faults and gates), a stored password
//! and a password-check on Drive, the pending units, and the account, the
//! keyboard-name backfill and the flush and polling triggers as fakes that
//! record what the pass asked of them. The envelope is the bundle's text
//! itself unless a test asks for the real encryption.

#![allow(clippy::unwrap_used, clippy::panic, dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pipette_drive::UploadedFile;
use pipette_drive::canonical::Listing;
use pipette_drive::client::DriveClient;
use pipette_entry_store::{FixedClock, RandomUuid, WriteLocks};
use pipette_keyboard_stores::StoreContext;
use pipette_sync::codec::{CodecFuture, EnvelopeCodec};
use pipette_sync::dispatch::{UnitSync, UnitSyncDeps};
use pipette_sync::execute::{
    ExecuteDeps, KeyboardMetaBackfill, PassAccount, PassHooks, SyncExecuteResult, SyncExecutor,
};
use pipette_sync::format::{SYNC_FORMAT_VERSION, marker_content};
use pipette_sync::merge::{MergeEvents, PackKind};
use pipette_sync::preflight::{BoxFuture, Preflight, PreflightDeps, PreflightError};
use pipette_sync::scope::SyncScope;
use pipette_sync_format::Envelope;
use pipette_sync_format::crypto::{
    IV_LENGTH, KEY_LENGTH, SALT_LENGTH, decrypt_with_key, encrypt_with_key, key_for,
};
use pipette_sync_format::drive_names::{drive_file_name, sync_format_file_name};
use pipette_sync_pending::{PendingStore, Scheduler};
use pipette_sync_runtime::{SyncDirection, SyncProgress, SyncRuntime};
use pipette_typing_analytics::fingerprint::OsInfo;
use pipette_typing_analytics::pipeline::FlushTimer;
use pipette_typing_analytics::{
    DataOps, MachineIdentity, Recorder, RecorderDeps, TypingAnalytics, rebuild_from_master_files,
};

use crate::preflight_harness::{FakePasswords, FakeSignIn, NoWaits, START_MS, Stored, TestDrive};

pub const PASSWORD: &str = "pw";
/// The installation id the TypeScript recordings seed (FIXED_INSTALLATION_ID
/// of scripts/sync-fixtures/harness.ts).
pub const INSTALLATION_ID: &str = "00000000-0000-4000-8000-00000000f1f0";
pub const MACHINE_ID: &str = "golden-machine";
/// 2026-10-16T00:00:00.000Z, the clock of the recordings.
pub const NOW: i64 = 1_792_108_800_000;

/// The envelope as the bundle's text, as the TypeScript tests mock it.
pub struct PlainCodec;

impl EnvelopeCodec for PlainCodec {
    fn seal(&self, plaintext: String, _: zeroize::Zeroizing<String>, _: String) -> CodecFuture {
        Box::pin(std::future::ready(Ok(plaintext)))
    }

    fn open(&self, content: Vec<u8>, _: zeroize::Zeroizing<String>) -> CodecFuture {
        Box::pin(std::future::ready(Ok(String::from_utf8_lossy(&content).into_owned())))
    }
}

/// The envelope format of the Electron build with each key derived once
/// per password and salt: a recorded pass opens and seals dozens of
/// envelopes. It seals with one fixed salt and a new IV each time.
#[derive(Default)]
pub struct KeyCachedCodec {
    keys: Mutex<std::collections::HashMap<KeyId, [u8; KEY_LENGTH]>>,
    sealed: AtomicUsize,
}

/// A password and a salt.
type KeyId = (String, Vec<u8>);

const SEAL_SALT: [u8; SALT_LENGTH] = [7; SALT_LENGTH];

impl KeyCachedCodec {
    pub async fn key(self: &Arc<Self>, password: &str, salt: &[u8]) -> [u8; KEY_LENGTH] {
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
        let n = self.sealed.fetch_add(1, Ordering::SeqCst) as u64;
        let mut iv = [0u8; IV_LENGTH];
        iv[..8].copy_from_slice(&n.to_be_bytes());
        let envelope =
            encrypt_with_key(plaintext, &key, unit, &SEAL_SALT, &iv, "2026-10-16T00:00:00.000Z").unwrap();
        serde_json::to_string(&envelope).unwrap()
    }

    pub async fn open_text(self: &Arc<Self>, content: &[u8], password: &str) -> Result<String, String> {
        let envelope: Envelope =
            serde_json::from_str(&String::from_utf8_lossy(content)).map_err(|err| err.to_string())?;
        let salt = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &envelope.salt)
            .map_err(|err| err.to_string())?;
        let key = self.key(password, &salt).await;
        decrypt_with_key(&envelope, &key).map_err(|err| err.to_string())
    }
}

/// The codec of a world, as a handle the test keeps.
pub struct SharedCodec(pub Arc<KeyCachedCodec>);

impl EnvelopeCodec for SharedCodec {
    fn seal(&self, plaintext: String, password: zeroize::Zeroizing<String>, unit: String) -> CodecFuture {
        let codec = self.0.clone();
        Box::pin(async move { Ok(codec.seal_text(&plaintext, &password, &unit).await) })
    }

    fn open(&self, content: Vec<u8>, password: zeroize::Zeroizing<String>) -> CodecFuture {
        let codec = self.0.clone();
        Box::pin(async move { codec.open_text(&content, &password).await })
    }
}

struct NoDelayedWrites;

impl Scheduler for NoDelayedWrites {
    fn schedule(&self, _: Duration, _: Box<dyn FnOnce() + Send>) {}
}

struct NoTimer;

impl FlushTimer for NoTimer {
    fn schedule(&self, _: Duration, _: Box<dyn FnOnce() + Send>) {}
}

#[derive(Default)]
pub struct FakeAccount(pub Mutex<Option<String>>);

impl PassAccount for FakeAccount {
    fn account_sub(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(std::future::ready(self.0.lock().unwrap().clone()))
    }
}

/// Names as many keyboards as the test says; counts its calls.
#[derive(Default)]
pub struct FakeBackfill {
    pub resolves: AtomicUsize,
    pub calls: AtomicUsize,
}

impl KeyboardMetaBackfill for FakeBackfill {
    fn backfill<'a>(&'a self, _: &'a str, _: &'a Listing) -> BoxFuture<'a, Result<usize, String>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(std::future::ready(Ok(self.resolves.load(Ordering::SeqCst))))
    }
}

/// The flushes and pollings the passes asked for.
#[derive(Default)]
pub struct RecordingHooks(pub Mutex<Vec<String>>);

impl PassHooks for RecordingHooks {
    fn schedule_flush_if_pending(&self, delay: Option<Duration>) {
        self.0.lock().unwrap().push(format!("flush {delay:?}"));
    }

    fn start_polling_if_auto_sync(&self) {
        self.0.lock().unwrap().push("poll".into());
    }
}

/// The units the merges reported as rewritten, and the pack lists.
#[derive(Default)]
pub struct Applied(pub Mutex<Vec<String>>);

impl MergeEvents for Applied {
    fn unit_applied(&self, unit: &str) {
        self.0.lock().unwrap().push(unit.to_owned());
    }

    fn pack_changed(&self, kind: PackKind) {
        self.0.lock().unwrap().push(format!("{kind:?} packs"));
    }
}

pub struct World {
    _dir: tempfile::TempDir,
    pub root: PathBuf,
    pub drive: Arc<TestDrive>,
    pub preflight: Arc<Preflight>,
    pub passwords: Arc<FakePasswords>,
    pub sign_in: Arc<FakeSignIn>,
    pub units: Arc<UnitSync>,
    pub executor: SyncExecutor,
    pub pending: PendingStore,
    pub ctx: StoreContext,
    pub ops: Arc<DataOps>,
    pub account: Arc<FakeAccount>,
    pub backfill: Arc<FakeBackfill>,
    pub hooks: Arc<RecordingHooks>,
    pub applied: Arc<Applied>,
    pub progress: Arc<Mutex<Vec<SyncProgress>>>,
    pub pending_events: Arc<Mutex<Vec<bool>>>,
}

pub struct Options {
    /// The envelope; the bundle's text itself when none is given.
    pub codec: Option<Arc<dyn EnvelopeCodec>>,
    pub concurrency: usize,
    /// Seeds a password-check of [`PASSWORD`] and stores the password.
    pub password: bool,
    /// Seeds this app's sync-format marker, so a pass creates none.
    pub marker: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self { codec: None, concurrency: 10, password: true, marker: true }
    }
}

impl World {
    pub async fn new() -> Self {
        Self::with(Options::default(), |_| {}).await
    }

    /// A world whose userData `seed` fills before anything reads it.
    pub async fn with(options: Options, seed: impl FnOnce(&Path)) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        write(&root, "local/installation-id", INSTALLATION_ID);
        seed(&root);

        let pending_events = Arc::new(Mutex::new(Vec::new()));
        let events = pending_events.clone();
        let pending = PendingStore::restore(
            &root,
            Arc::new(NoDelayedWrites),
            Box::new(move |pending| events.lock().unwrap().push(pending)),
        );

        let clock = Arc::new(FixedClock::new(NOW));
        let identity =
            MachineIdentity::new(&root, Arc::new(RandomUuid), Box::new(|| Ok(MACHINE_ID.to_owned())));
        let analytics = Arc::new(TypingAnalytics::new(
            &root,
            identity,
            clock.clone(),
            rebuild_from_master_files(clock.clone()),
        ));
        let deps = RecorderDeps {
            ids: Arc::new(RandomUuid),
            os: OsInfo { platform: "linux".into(), release: "6.8.0".into(), arch: "x64".into() },
            timer: Arc::new(NoTimer),
            notify: Arc::new(|_: &str| {}),
            app_name: Arc::new(|| None),
        };
        let recorder = Recorder::new(analytics, deps, &tokio::runtime::Handle::current());
        let locks = Arc::new(WriteLocks::new());
        let notify = pending.clone();
        let ctx = StoreContext::new(
            &root,
            clock,
            locks.clone(),
            Arc::new(move |unit: &str| notify.notify_change(unit)),
        );
        let ops = Arc::new(DataOps::new(recorder, locks, Arc::new(RandomUuid)));

        let drive = Arc::new(TestDrive::default());
        let passwords = Arc::new(FakePasswords::default());
        let sign_in = Arc::new(FakeSignIn(AtomicBool::new(true)));
        let runtime = SyncRuntime::new();
        let client = DriveClient::new(drive.clone(), Arc::new(NoWaits));
        let preflight = Preflight::new(PreflightDeps {
            drive: client.clone(),
            runtime: runtime.clone(),
            passwords: passwords.clone(),
            sign_in: sign_in.clone(),
            auth_dir: root.join("local/auth"),
            now_ms: Arc::new(|| START_MS),
        });
        let applied = Arc::new(Applied::default());
        let codec = options.codec.clone().unwrap_or_else(|| Arc::new(PlainCodec));
        let units = Arc::new(UnitSync::new(UnitSyncDeps {
            drive: client,
            runtime: runtime.clone(),
            ctx: ctx.clone(),
            ops: ops.clone(),
            events: applied.clone(),
            codec,
        }));
        let account = Arc::new(FakeAccount::default());
        let backfill = Arc::new(FakeBackfill::default());
        let hooks = Arc::new(RecordingHooks::default());
        let executor = SyncExecutor::new(ExecuteDeps {
            preflight: preflight.clone(),
            units: units.clone(),
            pending: pending.clone(),
            account: account.clone(),
            backfill: backfill.clone(),
            hooks: hooks.clone(),
        })
        .with_concurrency(options.concurrency);
        let progress = Arc::new(Mutex::new(Vec::new()));
        let sink = progress.clone();
        runtime.progress().set(move |p: &SyncProgress| sink.lock().unwrap().push(p.clone()));

        if options.password {
            passwords.set(Stored::Readable(PASSWORD.to_owned()));
            drive.seed_password_check(PASSWORD).await;
        }
        if options.marker {
            drive.seed(&sync_format_file_name(SYNC_FORMAT_VERSION), &marker_content()).await;
        }
        Self {
            _dir: dir,
            root,
            drive,
            preflight,
            passwords,
            sign_in,
            units,
            executor,
            pending,
            ctx,
            ops,
            account,
            backfill,
            hooks,
            applied,
            progress,
            pending_events,
        }
    }

    pub fn runtime(&self) -> &SyncRuntime {
        self.preflight.runtime()
    }

    pub fn own_hash(&self) -> String {
        self.units.own_hash().unwrap()
    }

    pub async fn sync(
        &self,
        direction: SyncDirection,
        scope: SyncScope,
    ) -> Result<SyncExecuteResult, PreflightError> {
        self.executor.execute_sync(direction, &scope).await
    }

    pub async fn download(&self, scope: SyncScope) -> SyncExecuteResult {
        self.sync(SyncDirection::Download, scope).await.unwrap()
    }

    pub async fn upload(&self, scope: SyncScope) -> SyncExecuteResult {
        self.sync(SyncDirection::Upload, scope).await.unwrap()
    }

    pub fn write(&self, path: &str, content: &str) {
        write(&self.root, path, content);
    }

    pub fn read(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.root.join(path)).ok()
    }

    /// Puts the Drive file of `unit` holding `plaintext` (as the plain
    /// codec reads it), without logging it.
    pub async fn seed_unit(&self, unit: &str, plaintext: &str) -> UploadedFile {
        self.drive.seed(&drive_file_name(unit), plaintext).await
    }

    /// The Drive content of the canonical file of `unit`.
    pub fn drive_content(&self, unit: &str) -> Option<String> {
        let name = drive_file_name(unit);
        let mut files: Vec<_> =
            self.drive.inner.files().into_iter().filter(|f| f.file.name == name).collect();
        files.sort_by(|a, b| b.file.modified_time.cmp(&a.file.modified_time));
        files.first().map(|f| String::from_utf8_lossy(&f.content).into_owned())
    }

    /// The Drive requests since the last call, the listing of the password
    /// files aside.
    pub fn requests(&self) -> Vec<String> {
        self.drive.take_events()
    }

    pub fn statuses(&self) -> Vec<String> {
        self.progress.lock().unwrap().iter().map(describe).collect()
    }

    pub fn last_progress(&self) -> SyncProgress {
        self.progress.lock().unwrap().last().cloned().unwrap()
    }

    pub fn pending_units(&self) -> Vec<String> {
        self.pending.snapshot_generations().keys().map(|unit| unit.to_string_lossy().into_owned()).collect()
    }

    /// Whether the current Drive file of `unit` is the revision recorded as
    /// handled.
    pub fn is_known(&self, unit: &str) -> bool {
        let name = drive_file_name(unit);
        let listing = Listing::new(self.drive.inner.files().into_iter().map(|f| f.file).collect());
        let file = listing.pick_canonical(&name).cloned().unwrap();
        self.runtime().remote().is_known(&name, &file.id, &file.modified_time)
    }
}

pub fn write(root: &Path, path: &str, content: &str) {
    let target = root.join(path);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(target, content).unwrap();
}

/// `status[ unit][ current/total][: message]`.
pub fn describe(p: &SyncProgress) -> String {
    let mut text = format!("{:?}", p.status).to_lowercase();
    if let Some(unit) = &p.sync_unit {
        text.push_str(&format!(" {unit}"));
    }
    if let (Some(current), Some(total)) = (p.current, p.total) {
        text.push_str(&format!(" {current}/{total}"));
    }
    if let Some(message) = &p.message {
        text.push_str(&format!(": {message}"));
    }
    text
}

/// A favorites index of one v2 entry `id` with its body file `{id}.json`,
/// all its clocks at `at`.
pub fn favorite_index(ty: &str, ids: &[&str], at: &str) -> String {
    let entries: Vec<serde_json::Value> = ids
        .iter()
        .map(|id| {
            serde_json::json!({
                "id": id, "label": format!("Fav {id}"), "filename": format!("{ty}_{id}.json"), "savedAt": at,
                "updatedAt": at, "clocks": { "created": at, "body": at, "name": at, "hub": at },
            })
        })
        .collect();
    serde_json::json!({ "type": ty, "entries": entries }).to_string()
}

/// The bundle of a favorites unit with `ids`, each body `{"id":…}`.
pub fn favorite_bundle(ty: &str, ids: &[&str], at: &str) -> String {
    let index: serde_json::Value = serde_json::from_str(&favorite_index(ty, ids, at)).unwrap();
    let mut files = serde_json::Map::new();
    for id in ids {
        files.insert(format!("{ty}_{id}.json"), serde_json::Value::String(format!("{{\"id\":\"{id}\"}}")));
    }
    serde_json::json!({ "type": "favorite", "key": ty, "index": index, "files": files }).to_string()
}

/// Seeds a local favorites store of `ty` with `ids`.
pub fn seed_favorites(root: &Path, ty: &str, ids: &[&str], at: &str) {
    write(root, &format!("sync/favorites/{ty}/index.json"), &favorite_index(ty, ids, at));
    for id in ids {
        write(root, &format!("sync/favorites/{ty}/{ty}_{id}.json"), &format!("{{\"id\":\"{id}\"}}"));
    }
}
