// SPDX-License-Identifier: GPL-2.0-or-later
//! One step of a second machine for the interoperability test of the two
//! sync engines (scripts/sync-interop/): this crate's engine on a userData
//! of its own, against the Node fake Drive (scripts/fake-drive/server.ts)
//! over HTTP, as the Tauri build runs it. Each run is one step of a
//! machine that starts, does one thing and quits:
//!
//!   sync_peer '<json>'
//!
//! where the JSON has `userData`, `keystore` (a file outside the userData
//! that keeps the master key of the secrets between runs), `driveUrl` (the
//! fake Drive, on 127.0.0.1 only), `now` (the clock of the stores and of
//! the password-change lock, in milliseconds), `machineId`, `sub` (the
//! signed-in account) and `command`. It prints one line of JSON: the
//! command's answer, or `{"error": …}`, with the command's time
//! (`elapsedMs`) and the process's peak memory (`maxRssKb`, Linux only).
//!
//! Nothing reaches the network but the loopback interface: the URL must be
//! on 127.0.0.1 and the HTTP client refuses every other destination.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout, clippy::print_stderr)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pipette_drive::client::DriveClient;
use pipette_drive::http::HttpDrive;
use pipette_drive::retry::SystemRetryEnv;
use pipette_entry_store::{Clock, RandomUuid, WriteLocks};
use pipette_keyboard_stores::{
    FavoriteType, StoreContext, ensure_pipette_settings_dir, read_pipette_settings, save_favorite,
    write_pipette_settings,
};
use pipette_net::{Limits, ReqwestClient};
use pipette_secret_store::{Keystore, KeystoreError, SecretStore};
use pipette_sync::codec::{EnvelopeCodec, EnvelopeCrypto};
use pipette_sync::dispatch::{UnitSync, UnitSyncDeps};
use pipette_sync::execute::{
    ExecuteDeps, KeyboardMetaBackfill, PassAccount, SyncExecuteResult, SyncExecutor,
};
use pipette_sync::merge::{MergeEvents, PackKind};
use pipette_sync::meta_backfill::StoreMetaBackfill;
use pipette_sync::password::change::{PasswordChange, PasswordChangeDeps, random_lock_id};
use pipette_sync::password::lock::LockTiming;
use pipette_sync::preflight::{BoxFuture, Preflight, PreflightDeps, PreflightError, SignIn};
use pipette_sync::scope::SyncScope;
use pipette_sync::triggers::{SyncTriggers, TriggerDeps};
use pipette_sync_pending::{PendingStore, Scheduler};
use pipette_sync_runtime::{SyncDirection, SyncProgress, SyncRuntime};
use pipette_typing_analytics::fingerprint::OsInfo;
use pipette_typing_analytics::pipeline::FlushTimer;
use pipette_typing_analytics::{
    DataOps, MachineIdentity, Recorder, RecorderDeps, TypingAnalytics, rebuild_from_master_files,
};
use serde_json::{Value, json};
use zeroize::Zeroizing;

/// The master key of the secrets in a file of its own, so a later run of
/// the same machine opens what an earlier one stored.
struct FileKeystore(PathBuf);

impl FileKeystore {
    fn load(&self) -> BTreeMap<String, String> {
        std::fs::read(&self.0).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    fn save(&self, entries: &BTreeMap<String, String>) -> Result<(), KeystoreError> {
        std::fs::write(&self.0, serde_json::to_vec(entries).unwrap())
            .map_err(|err| KeystoreError::Unavailable(err.to_string()))
    }
}

impl Keystore for FileKeystore {
    fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, KeystoreError> {
        Ok(self.load().get(account).map(|text| Zeroizing::new(hex_decode(text))))
    }

    fn write(&self, account: &str, secret: &[u8]) -> Result<(), KeystoreError> {
        let mut entries = self.load();
        entries.insert(account.to_owned(), secret.iter().map(|b| format!("{b:02x}")).collect());
        self.save(&entries)
    }

    fn delete(&self, account: &str) -> Result<(), KeystoreError> {
        let mut entries = self.load();
        entries.remove(account);
        self.save(&entries)
    }
}

fn hex_decode(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

/// The clock of the stores: the step's `now`.
struct StepClock(AtomicI64);

impl Clock for StepClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// The pending units are written once, before the run ends.
struct NoDelayedWrites;

impl Scheduler for NoDelayedWrites {
    fn schedule(&self, _: Duration, _: Box<dyn FnOnce() + Send>) {}
}

struct NoTimer;

impl FlushTimer for NoTimer {
    fn schedule(&self, _: Duration, _: Box<dyn FnOnce() + Send>) {}
}

struct SignedIn;

impl SignIn for SignedIn {
    fn is_signed_in(&self) -> BoxFuture<'_, bool> {
        Box::pin(std::future::ready(true))
    }
}

struct Account(String);

impl PassAccount for Account {
    fn account_sub(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(std::future::ready(Some(self.0.clone())))
    }
}

struct NoEvents;

impl MergeEvents for NoEvents {
    fn unit_applied(&self, _: &str) {}
    fn pack_changed(&self, _: PackKind) {}
}

struct Peer {
    ctx: StoreContext,
    pending: PendingStore,
    preflight: Arc<Preflight>,
    executor: SyncExecutor,
    triggers: Arc<SyncTriggers>,
    change: Arc<PasswordChange>,
    progress: Arc<Mutex<Vec<SyncProgress>>>,
}

fn field<'a>(value: &'a Value, name: &str) -> &'a str {
    value[name].as_str().unwrap_or_else(|| panic!("missing `{name}`"))
}

impl Peer {
    fn new(input: &Value) -> (Self, Arc<TypingAnalytics>) {
        let root = PathBuf::from(field(input, "userData"));
        let drive_url = field(input, "driveUrl");
        assert!(drive_url.starts_with("http://127.0.0.1:"), "the Drive must be on 127.0.0.1: {drive_url}");
        let now = input["now"].as_i64().expect("missing `now`");
        let machine_id = field(input, "machineId").to_owned();
        let handle = tokio::runtime::Handle::current();

        let pending = PendingStore::restore(&root, Arc::new(NoDelayedWrites), Box::new(|_| {}));
        let clock = Arc::new(StepClock(AtomicI64::new(now)));
        let identity =
            MachineIdentity::new(&root, Arc::new(RandomUuid), Box::new(move || Ok(machine_id.clone())));
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
        let recorder = Recorder::new(analytics, deps, &handle);
        let locks = Arc::new(WriteLocks::new());
        let notify = pending.clone();
        let ctx = StoreContext::new(
            &root,
            clock,
            locks.clone(),
            Arc::new(move |unit: &str| notify.notify_change(unit)),
        );
        let ops = Arc::new(DataOps::new(recorder, locks, Arc::new(RandomUuid)));
        // The app starts the typing analytics at launch (the cache rebuilt
        // from the day files when it cannot be trusted), before any pass.
        let analytics = ops.analytics().clone();

        let secrets = Arc::new(SecretStore::new(
            &root,
            Arc::new(FileKeystore(PathBuf::from(field(input, "keystore")))),
        ));
        let http = HttpDrive::new(
            ReqwestClient::loopback_only(Limits::DRIVE, "pipette-sync-peer"),
            || Ok(Some("peer-token".to_owned())),
            format!("{drive_url}/drive/v3"),
            format!("{drive_url}/upload/drive/v3"),
        );
        let runtime = SyncRuntime::new();
        let quitting = runtime.clone();
        let drive =
            DriveClient::new(Arc::new(http), Arc::new(SystemRetryEnv::new(move || quitting.is_quitting())));
        let now_ms = u64::try_from(now).unwrap();
        let preflight = Preflight::new(PreflightDeps {
            drive: drive.clone(),
            runtime: runtime.clone(),
            passwords: secrets.clone(),
            sign_in: Arc::new(SignedIn),
            auth_dir: secrets.auth_dir().to_path_buf(),
            now_ms: Arc::new(move || now_ms),
        });
        let events: Arc<dyn MergeEvents> = Arc::new(NoEvents);
        let units = Arc::new(UnitSync::new(UnitSyncDeps {
            drive: drive.clone(),
            runtime: runtime.clone(),
            ctx: ctx.clone(),
            ops,
            events: events.clone(),
            codec: Arc::new(EnvelopeCrypto),
        }));
        let account: Arc<dyn PassAccount> = Arc::new(Account(field(input, "sub").to_owned()));
        let triggers = Arc::new(SyncTriggers::new(TriggerDeps {
            preflight: preflight.clone(),
            units: units.clone(),
            pending: pending.clone(),
            account: account.clone(),
            auto_sync: false,
            now_ms: Arc::new(move || now_ms),
            handle,
            concurrency: pipette_sync::execute::SYNC_CONCURRENCY,
        }));
        let backfill: Arc<dyn KeyboardMetaBackfill> =
            Arc::new(StoreMetaBackfill { ctx: ctx.clone(), drive, events });
        let executor = SyncExecutor::new(ExecuteDeps {
            preflight: preflight.clone(),
            units: units.clone(),
            pending: pending.clone(),
            account,
            backfill,
            hooks: triggers.clone(),
        });
        let hash_units = units.clone();
        let change = PasswordChange::new(PasswordChangeDeps {
            preflight: preflight.clone(),
            secrets,
            codec: Arc::new(EnvelopeCrypto),
            machine_hash: Arc::new(move || hash_units.own_hash().map_err(|err| err.to_string())),
            new_lock_id: Arc::new(random_lock_id),
            lock_timing: LockTiming::default(),
            tuning: Default::default(),
        });
        let progress = Arc::new(Mutex::new(Vec::new()));
        let sink = progress.clone();
        runtime.progress().set(move |p: &SyncProgress| sink.lock().unwrap().push(p.clone()));
        (Self { ctx, pending, preflight, executor, triggers, change, progress }, analytics)
    }

    async fn run(&self, command: &Value) -> Value {
        match field(command, "op") {
            "saveFavorite" => {
                let ty = FavoriteType::parse(field(command, "type")).unwrap();
                match save_favorite(&self.ctx, ty, field(command, "json"), field(command, "label")) {
                    Ok(_) => json!({ "success": true }),
                    Err(err) => json!({ "error": err.to_string() }),
                }
            }
            "writeSettings" => {
                let uid = field(command, "uid");
                let etag = read_pipette_settings(&self.ctx, uid).unwrap().etag;
                match write_pipette_settings(&self.ctx, uid, field(command, "content"), &etag) {
                    Ok(_) => json!({ "success": true }),
                    Err(err) => json!({ "error": err.to_string() }),
                }
            }
            "ensureKeyboard" => match ensure_pipette_settings_dir(&self.ctx, field(command, "uid")) {
                Ok(()) => json!({ "success": true }),
                Err(err) => json!({ "error": err.to_string() }),
            },
            "setPassword" => {
                answer(self.preflight.set_password_and_validate(field(command, "password")).await)
            }
            "replacePassword" => {
                answer(self.preflight.replace_password_and_validate(field(command, "password")).await)
            }
            "execute" => {
                let direction = match field(command, "direction") {
                    "download" => SyncDirection::Download,
                    _ => SyncDirection::Upload,
                };
                let scope = SyncScope::from_json(&command["scope"]).expect("an unknown scope");
                match self.executor.execute_sync(direction, &scope).await {
                    Ok(result) => execute_result(&result),
                    Err(err) => json!({ "error": err.to_string() }),
                }
            }
            "poll" => {
                self.triggers.poller().poll_for_remote_changes().await;
                json!({ "success": true })
            }
            "changePassword" => match self.change.start(field(command, "password")).await {
                Ok(()) => json!({ "success": true }),
                Err(err) => json!({ "error": err.to_string() }),
            },
            "resumeChange" => match self.change.resume().await {
                Ok(()) => json!({ "success": true }),
                Err(err) => json!({ "error": err.to_string() }),
            },
            "changeStatus" => serde_json::to_value(self.change.status().await).unwrap(),
            // Seals `count` envelopes at once: each derives its own key, so
            // this times the key derivations (4 at a time).
            "deriveKeys" => {
                let count = command["count"].as_u64().unwrap_or(16);
                let seals = (0..count).map(|i| {
                    EnvelopeCrypto.seal("{}".to_owned(), Zeroizing::new("pw".to_owned()), format!("unit-{i}"))
                });
                let sealed = futures_util::future::join_all(seals).await;
                json!({ "success": sealed.iter().all(Result::is_ok) })
            }
            other => json!({ "error": format!("unknown command {other}") }),
        }
    }

    /// The progress reports of the run that carry a message or a failure.
    fn progress(&self) -> Vec<Value> {
        let progress = self.progress.lock().unwrap();
        progress
            .iter()
            .filter(|p| p.message.is_some() || p.reason.is_some())
            .map(|p| json!({ "message": p.message, "reason": p.reason.map(|reason| reason.as_str()) }))
            .collect()
    }
}

fn answer(result: Result<(), PreflightError>) -> Value {
    match result {
        Ok(()) => json!({ "success": true }),
        Err(err) => json!({ "error": err.to_string() }),
    }
}

/// `SyncExecuteResult` of sync-execute.ts.
fn execute_result(result: &SyncExecuteResult) -> Value {
    match result {
        SyncExecuteResult::Completed => json!({ "status": "completed" }),
        SyncExecuteResult::Skipped(reason) => json!({ "status": "skipped", "skipReason": reason.as_str() }),
        SyncExecuteResult::Partial(units) => json!({ "status": "partial", "failedUnits": units }),
    }
}

/// The peak resident set size of this process (`VmHWM`), on Linux.
fn max_rss_kb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

/// The real userData directories of Pipette and of Electron, as the
/// harness of the TypeScript sync tests lists them
/// (scripts/sync-fixtures/harness.ts): under `~/.config`,
/// `$XDG_CONFIG_HOME`, `~/Library/Application Support` and `%APPDATA%`.
fn forbidden_roots() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let mut config_roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = &home {
        config_roots.push(home.join(".config"));
        config_roots.push(home.join("Library").join("Application Support"));
    }
    for name in ["XDG_CONFIG_HOME", "APPDATA"] {
        if let Some(dir) = std::env::var_os(name).filter(|dir| !dir.is_empty()) {
            config_roots.push(PathBuf::from(dir));
        }
    }
    config_roots
        .into_iter()
        .flat_map(|root| [root.join("pipette-desktop"), root.join("Electron")])
        .flat_map(|dir| {
            let resolved = resolve(&dir);
            [dir, resolved]
        })
        .collect()
}

/// `path` with its symlinks resolved: the deepest ancestor that exists,
/// canonicalized, with the rest of the path after it.
fn resolve(path: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        if let Ok(real) = std::fs::canonicalize(&current) {
            return rest.into_iter().rev().fold(real, |acc: PathBuf, part| acc.join(part));
        }
        match (current.file_name().map(ToOwned::to_owned), current.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                current = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// Exits before anything is touched when `path` is relative, or is or is
/// inside a real userData directory (itself or through a symlink).
fn refuse_unsafe_path(name: &str, path: &Path) {
    if !path.is_absolute() {
        eprintln!("sync_peer: {name} must be an absolute path");
        std::process::exit(2);
    }
    let candidates = [path.to_path_buf(), resolve(path)];
    for root in forbidden_roots() {
        if candidates.iter().any(|candidate| candidate.starts_with(&root)) {
            eprintln!(
                "sync_peer: refused {name} {} inside the real userData {}",
                path.display(),
                root.display()
            );
            std::process::exit(2);
        }
    }
}

fn main() {
    let input: Value = serde_json::from_str(&std::env::args().nth(1).expect("usage: sync_peer '<json>'"))
        .expect("the argument must be JSON");
    refuse_unsafe_path("userData", Path::new(field(&input, "userData")));
    refuse_unsafe_path("keystore", Path::new(field(&input, "keystore")));
    // The multi-threaded runtime of the app (Tauri's async runtime).
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
    let mut output = runtime.block_on(async {
        let (peer, analytics) = Peer::new(&input);
        if let Err(err) = analytics.ready().await {
            return json!({ "error": format!("the typing analytics did not start: {err}") });
        }
        let started = std::time::Instant::now();
        let mut answer = peer.run(&input["command"]).await;
        answer["elapsedMs"] = json!(started.elapsed().as_millis());
        peer.pending.persist_now();
        answer["progress"] = Value::Array(peer.progress());
        answer
    });
    output["maxRssKb"] = json!(max_rss_kb());
    println!("{output}");
}
