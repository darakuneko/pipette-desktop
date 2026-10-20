// SPDX-License-Identifier: GPL-2.0-or-later
//! The world of the reset, trash and scan tests: a userData with the
//! stores at a fixed time, the pending units restored from it, the
//! in-memory Drive of the preflight tests with a stored password, and the
//! rest of the app (the sign-out, polling, the app config, the key store
//! and the typing analytics) as fakes that log what the resets asked of
//! them. The sign-out can run the real hold of the pending units for a fake
//! account.

#![allow(clippy::unwrap_used, clippy::panic, dead_code)]

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pipette_drive::client::DriveClient;
use pipette_drive::trash_names::trash_file_name;
use pipette_drive::{DriveApi, DriveError, DriveFile, DriveFuture, FileList, ListQuery, UploadedFile};
use pipette_entry_store::{FixedClock, WriteLocks};
use pipette_keyboard_stores::StoreContext;
use pipette_sync::account::{AccountSwitcher, SignedInAccount};
use pipette_sync::preflight::{BoxFuture, Preflight, PreflightDeps};
use pipette_sync::reset::{ResetDeps, ResetHooks, Resets};
use pipette_sync::trash::manual::TrashEnv;
use pipette_sync_pending::{PendingStore, Scheduler};
use pipette_sync_runtime::SyncRuntime;

use crate::preflight_harness::{FakePasswords, FakeSignIn, NoWaits, START_MS, Stored, TestDrive};

pub const PASSWORD: &str = "pw";
/// The installation id the recorded goldens seed.
pub const INSTALLATION_ID: &str = "00000000-0000-4000-8000-00000000f1f0";
/// 2026-10-16T00:00:00.000Z, the clock of the recordings.
pub const NOW: i64 = 1_792_108_800_000;
pub const OWN_HASH: &str = "hash-own";

struct NoDelayedWrites;

impl Scheduler for NoDelayedWrites {
    fn schedule(&self, _: Duration, _: Box<dyn FnOnce() + Send>) {}
}

/// The signed-in account of a sign-out that runs the real hold.
pub struct FakeAccount {
    pub sub: Mutex<Option<String>>,
    pub log: Arc<Mutex<Vec<String>>>,
}

impl SignedInAccount for FakeAccount {
    fn account_sub(&self) -> impl std::future::Future<Output = Option<String>> + Send {
        std::future::ready(self.sub.lock().unwrap().clone())
    }

    fn sign_out(&self) -> impl std::future::Future<Output = ()> + Send {
        self.log.lock().unwrap().push("signOut".into());
        *self.sub.lock().unwrap() = None;
        std::future::ready(())
    }
}

type Probe = Box<dyn Fn(&str) + Send + Sync>;

/// Runs before a rename: an error fails it.
type RenameHook = Box<dyn Fn(&TestDrive, &str, &str) -> Option<DriveError> + Send + Sync>;

/// Runs before a listing.
type ListHook = Box<dyn Fn(&TestDrive) + Send + Sync>;

/// The test Drive with hooks before its listings and renames.
pub struct HookedDrive {
    pub inner: Arc<TestDrive>,
    pub before_list: Mutex<Option<ListHook>>,
    pub before_rename: Mutex<Option<RenameHook>>,
    pub lists: Mutex<usize>,
}

/// A failure Drive does not retry.
pub fn refused() -> DriveError {
    DriveError::Status { status: 400, body: "Drive rename failed".into(), retry_after: None }
}

impl DriveApi for HookedDrive {
    fn list_page(&self, query: ListQuery) -> DriveFuture<'_, FileList> {
        *self.lists.lock().unwrap() += 1;
        if let Some(hook) = self.before_list.lock().unwrap().as_ref() {
            hook(&self.inner);
        }
        self.inner.list_page(query)
    }

    fn download(&self, id: String) -> DriveFuture<'_, Vec<u8>> {
        self.inner.download(id)
    }

    fn create(&self, name: String, content: String) -> DriveFuture<'_, UploadedFile> {
        self.inner.create(name, content)
    }

    fn create_raw(&self, name: String, content: String) -> DriveFuture<'_, String> {
        self.inner.create_raw(name, content)
    }

    fn update(&self, id: String, content: String) -> DriveFuture<'_, UploadedFile> {
        self.inner.update(id, content)
    }

    fn rename(&self, id: String, name: String) -> DriveFuture<'_, DriveFile> {
        let failure =
            self.before_rename.lock().unwrap().as_ref().and_then(|hook| hook(&self.inner, &id, &name));
        match failure {
            Some(err) => Box::pin(std::future::ready(Err(err))),
            None => self.inner.rename(id, name),
        }
    }

    fn delete(&self, id: String) -> DriveFuture<'_, ()> {
        self.inner.delete(id)
    }
}

/// The rest of the app as the resets see it.
pub struct FakeHooks {
    pub log: Arc<Mutex<Vec<String>>>,
    /// Signs out through the real hold of the pending units; without it,
    /// the sign-out is only logged.
    pub switcher: Option<AccountSwitcher<FakeAccount>>,
    pub sign_out_error: Mutex<Option<String>>,
    pub typing_keyboards: Mutex<Result<Vec<String>, String>>,
    pub failing_typing_uid: Mutex<Option<String>>,
    pub clear_config_error: Mutex<Option<String>>,
    /// Runs inside the sign-out and each typing cleanup (with the uid).
    pub probe: Mutex<Option<Probe>>,
}

impl FakeHooks {
    fn note(&self, entry: String) {
        if let Some(probe) = self.probe.lock().unwrap().as_ref() {
            probe(&entry);
        }
        self.log.lock().unwrap().push(entry);
    }
}

impl ResetHooks for FakeHooks {
    fn sign_out_keeping_pending_locked(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.note("signOutLocked".into());
            if let Some(err) = self.sign_out_error.lock().unwrap().clone() {
                return Err(err);
            }
            match &self.switcher {
                Some(switcher) => {
                    switcher.sign_out_keeping_pending_locked().await.map_err(|err| err.to_string())
                }
                None => Ok(()),
            }
        })
    }

    fn stop_polling(&self) {
        self.note("stopPolling".into());
    }

    fn clear_app_config(&self) -> Result<(), String> {
        self.note("clearConfig".into());
        self.clear_config_error.lock().unwrap().clone().map_or(Ok(()), Err)
    }

    fn forget_secret_key(&self) -> BoxFuture<'_, ()> {
        self.note("forgetKey".into());
        Box::pin(std::future::ready(()))
    }

    fn typing_keyboards(&self) -> BoxFuture<'_, Result<Vec<String>, String>> {
        Box::pin(std::future::ready(self.typing_keyboards.lock().unwrap().clone()))
    }

    fn delete_all_typing_for_keyboard<'a>(&'a self, uid: &'a str) -> BoxFuture<'a, Result<(), String>> {
        self.note(format!("typing:{uid}"));
        let failing = self.failing_typing_uid.lock().unwrap().as_deref() == Some(uid);
        Box::pin(std::future::ready(if failing { Err("disk full".into()) } else { Ok(()) }))
    }
}

pub struct World {
    _dir: tempfile::TempDir,
    pub root: PathBuf,
    pub drive: Arc<TestDrive>,
    pub hooked: Arc<HookedDrive>,
    pub preflight: Arc<Preflight>,
    pub passwords: Arc<FakePasswords>,
    pub sign_in: Arc<FakeSignIn>,
    pub runtime: SyncRuntime,
    pub pending: PendingStore,
    pub ctx: StoreContext,
    pub hooks: Arc<FakeHooks>,
    pub resets: Arc<Resets>,
    /// The units the stores reported changed.
    pub notified: Arc<Mutex<Vec<String>>>,
}

pub fn write(root: &Path, path: &str, content: &str) {
    let target = root.join(path);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(target, content).unwrap();
}

/// Options of a world.
pub struct Options {
    /// The account signed in for a sign-out through the real hold.
    pub account: Option<Option<String>>,
}

impl World {
    pub fn new(seed: impl FnOnce(&Path)) -> Self {
        Self::with(Options { account: None }, seed)
    }

    /// A world whose userData `seed` fills before the pending units are
    /// restored from it.
    pub fn with(options: Options, seed: impl FnOnce(&Path)) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        write(&root, "local/installation-id", INSTALLATION_ID);
        seed(&root);
        let pending = PendingStore::restore(&root, Arc::new(NoDelayedWrites), Box::new(|_| {}));
        let notified = Arc::new(Mutex::new(Vec::new()));
        let (sink, notify) = (notified.clone(), pending.clone());
        let ctx = StoreContext::new(
            &root,
            Arc::new(FixedClock::new(NOW)),
            Arc::new(WriteLocks::new()),
            Arc::new(move |unit: &str| {
                sink.lock().unwrap().push(unit.to_owned());
                notify.notify_change(unit);
            }),
        );
        let drive = Arc::new(TestDrive::default());
        let hooked = Arc::new(HookedDrive {
            inner: drive.clone(),
            before_list: Mutex::new(None),
            before_rename: Mutex::new(None),
            lists: Mutex::new(0),
        });
        let passwords = Arc::new(FakePasswords::default());
        passwords.set(Stored::Readable(PASSWORD.into()));
        let sign_in = Arc::new(FakeSignIn(AtomicBool::new(true)));
        let runtime = SyncRuntime::new();
        let preflight = Preflight::new(PreflightDeps {
            drive: DriveClient::new(hooked.clone(), Arc::new(NoWaits)),
            runtime: runtime.clone(),
            passwords: passwords.clone(),
            sign_in: sign_in.clone(),
            auth_dir: root.join("local/auth"),
            now_ms: Arc::new(|| START_MS),
        });
        let log = Arc::new(Mutex::new(Vec::new()));
        let switcher = options.account.map(|sub| {
            let account = Arc::new(FakeAccount { sub: Mutex::new(sub), log: log.clone() });
            AccountSwitcher::new(runtime.clone(), pending.clone(), account)
        });
        let hooks = Arc::new(FakeHooks {
            log,
            switcher,
            sign_out_error: Mutex::new(None),
            typing_keyboards: Mutex::new(Ok(Vec::new())),
            failing_typing_uid: Mutex::new(None),
            clear_config_error: Mutex::new(None),
            probe: Mutex::new(None),
        });
        let resets = Resets::new(ResetDeps {
            preflight: preflight.clone(),
            pending: pending.clone(),
            ctx: ctx.clone(),
            hooks: hooks.clone(),
        });
        Self {
            _dir: dir,
            root,
            drive,
            hooked,
            preflight,
            passwords,
            sign_in,
            runtime,
            pending,
            ctx,
            hooks,
            resets,
            notified,
        }
    }

    pub fn trash_env(&self, now_ms: i64) -> TrashEnv<'_> {
        TrashEnv { preflight: &self.preflight, own_hash: &|| Ok(OWN_HASH.to_owned()), now_ms }
    }

    pub fn log(&self) -> Vec<String> {
        self.hooks.log.lock().unwrap().clone()
    }

    pub fn exists(&self, path: &str) -> bool {
        self.root.join(path).exists()
    }

    /// Adds a Drive file, without logging it.
    pub async fn add(&self, name: &str) -> DriveFile {
        let file = self.drive.seed(name, "{}").await;
        self.file(&file.id)
    }

    /// Adds a Drive file and moves it to trash at `renamed_at_ms`.
    pub async fn add_trash(&self, name: &str, renamed_at_ms: i64) -> DriveFile {
        let file = self.add(name).await;
        let trash = trash_file_name(&file, renamed_at_ms).unwrap();
        self.drive.inner.rename(file.id.clone(), trash).await.unwrap();
        self.file(&file.id)
    }

    pub fn file(&self, id: &str) -> DriveFile {
        self.drive.inner.files().into_iter().find(|stored| stored.file.id == id).unwrap().file
    }

    /// The Drive files by id and name, in creation order.
    pub fn names(&self) -> Vec<(String, String)> {
        self.drive.inner.files().into_iter().map(|stored| (stored.file.id, stored.file.name)).collect()
    }

    /// The active pending units, sorted.
    pub fn pending_units(&self) -> Vec<String> {
        let mut units: Vec<String> = self
            .pending
            .snapshot_generations()
            .keys()
            .map(|unit| unit.to_string_lossy().into_owned())
            .collect();
        units.sort();
        units
    }

    /// Writes this machine's password-change state file.
    pub fn local_password_change(&self) {
        write(&self.root, "local/auth/sync-password-change.json", "{}");
        self.preflight.forget_change_state_cache();
    }
}

/// Every file (as UTF-8 text) and empty directory (`path/`, `None`) under
/// `root`, as the recorded goldens list them.
pub fn read_tree(root: &Path) -> std::collections::BTreeMap<String, Option<String>> {
    fn walk(root: &Path, dir: &Path, tree: &mut std::collections::BTreeMap<String, Option<String>>) {
        let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
        entries.sort_by_key(|entry| entry.file_name());
        let rel = |path: &Path| path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        if entries.is_empty() && dir != root {
            tree.insert(format!("{}/", rel(dir)), None);
        }
        for entry in entries {
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                walk(root, &path, tree);
            } else {
                let content = String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned();
                tree.insert(rel(&path), Some(content));
            }
        }
    }
    let mut tree = std::collections::BTreeMap::new();
    walk(root, root, &mut tree);
    tree
}
