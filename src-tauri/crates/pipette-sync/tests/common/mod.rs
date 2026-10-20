// SPDX-License-Identifier: GPL-2.0-or-later
//! Helpers of the typing-analytics merge tests: the fixture values, the
//! userData trees, the cache tables in the canonical text of the recorded
//! goldens, and a Drive that logs the requests it answers.

#![allow(clippy::unwrap_used, clippy::panic, dead_code)]

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pipette_drive::fake::InMemoryDrive;
use pipette_drive::retry::{RetryEnv, SleepFuture};
use pipette_drive::{DriveApi, DriveFile, DriveFuture, FileList, ListQuery, UploadedFile};
use pipette_entry_store::{FixedClock, RandomUuid, WriteLocks};
use pipette_js_json::{Value, stringify};
use pipette_keyboard_stores::StoreContext;
use pipette_sync::merge::AnalyticsEnv;
use pipette_typing_analytics::fingerprint::OsInfo;
use pipette_typing_analytics::pipeline::FlushTimer;
use pipette_typing_analytics::{
    DataOps, MachineIdentity, Recorder, RecorderDeps, TypingAnalytics, rebuild_from_master_files,
};
use rusqlite::types::ValueRef;

/// Path → UTF-8 content, or `None` for an empty directory (`path/`).
pub type Tree = BTreeMap<String, Option<String>>;

pub fn get<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.as_object().and_then(|o| o.get(key)).unwrap_or_else(|| panic!("no {key} in {}", stringify(value)))
}

pub fn opt<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|o| o.get(key))
}

pub fn text(value: &Value) -> String {
    value.as_str().unwrap_or_else(|| panic!("not a string: {}", stringify(value))).to_owned()
}

pub fn strings(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items.iter().map(text).collect(),
        _ => panic!("not a list: {}", stringify(value)),
    }
}

pub fn tree_of(value: &Value) -> Tree {
    value
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.as_str().map(str::to_owned)))
        .collect()
}

pub fn write_tree(root: &Path, tree: &Tree) {
    for (path, content) in tree {
        let target = root.join(path.trim_end_matches('/'));
        match content {
            None => std::fs::create_dir_all(&target).unwrap(),
            Some(content) => {
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                std::fs::write(&target, content).unwrap();
            }
        }
    }
}

/// Every file (as UTF-8 text) and empty directory under `root`.
pub fn read_tree(root: &Path) -> Tree {
    fn walk(root: &Path, dir: &Path, tree: &mut Tree) {
        let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        let rel = |path: &Path| path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        if entries.is_empty() && dir != root {
            tree.insert(format!("{}/", rel(dir)), None);
        }
        for entry in entries {
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                walk(root, &path, tree);
            } else {
                tree.insert(
                    rel(&path),
                    Some(String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned()),
                );
            }
        }
    }
    let mut tree = Tree::new();
    walk(root, root, &mut tree);
    tree
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut s, b| {
        write!(s, "{b:02x}").unwrap();
        s
    })
}

fn cell(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => "n".to_owned(),
        ValueRef::Integer(i) => format!("i:{i}"),
        ValueRef::Real(r) => format!("r:{:016x}", r.to_bits()),
        ValueRef::Text(t) => format!("t:{}", hex(t)),
        ValueRef::Blob(b) => format!("b:{}", hex(b)),
    }
}

/// The rows of `table` of the cache under `user_data`, ordered by its
/// primary key, in the canonical text; none while the cache does not
/// exist yet.
pub fn table_dump(user_data: &Path, table: &str) -> Vec<String> {
    let path = user_data.join("local").join("typing-analytics.db");
    if !path.exists() {
        return Vec::new();
    }
    let conn = rusqlite::Connection::open(path).unwrap();
    let mut info = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap();
    let mut columns: Vec<(String, i64)> =
        info.query_map([], |r| Ok((r.get("name")?, r.get("pk")?))).unwrap().map(Result::unwrap).collect();
    let names = columns.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(", ");
    columns.retain(|(_, pk)| *pk > 0);
    columns.sort_by_key(|(_, pk)| *pk);
    let order = columns.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(", ");
    let mut stmt = conn.prepare(&format!("SELECT {names} FROM {table} ORDER BY {order}")).unwrap();
    let width = stmt.column_count();
    stmt.query_map([], |r| Ok((0..width).map(|i| cell(r.get_ref(i).unwrap())).collect::<Vec<_>>().join("|")))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

/// The in-memory Drive, logging each request as the generator writes it:
/// `list`, `delete {id}`, or the operation's name.
pub struct DriveLog {
    inner: InMemoryDrive,
    requests: Mutex<Vec<String>>,
}

impl DriveLog {
    pub fn new(inner: InMemoryDrive) -> Self {
        Self { inner, requests: Mutex::new(Vec::new()) }
    }

    pub fn inner(&self) -> &InMemoryDrive {
        &self.inner
    }

    pub fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }

    fn log(&self, request: String) {
        self.requests.lock().unwrap().push(request);
    }
}

impl DriveApi for DriveLog {
    fn list_page(&self, query: ListQuery) -> DriveFuture<'_, FileList> {
        self.log("list".into());
        self.inner.list_page(query)
    }

    fn download(&self, id: String) -> DriveFuture<'_, Vec<u8>> {
        self.log(format!("download {id}"));
        self.inner.download(id)
    }

    fn create(&self, name: String, content: String) -> DriveFuture<'_, UploadedFile> {
        self.log(format!("create {name}"));
        self.inner.create(name, content)
    }

    fn create_raw(&self, name: String, content: String) -> DriveFuture<'_, String> {
        self.log(format!("create {name}"));
        self.inner.create_raw(name, content)
    }

    fn update(&self, id: String, content: String) -> DriveFuture<'_, UploadedFile> {
        self.log(format!("update {id}"));
        self.inner.update(id, content)
    }

    fn rename(&self, id: String, name: String) -> DriveFuture<'_, DriveFile> {
        self.log(format!("rename {id}"));
        self.inner.rename(id, name)
    }

    fn delete(&self, id: String) -> DriveFuture<'_, ()> {
        self.log(format!("delete {id}"));
        self.inner.delete(id)
    }
}

/// The recording never records: the timer is never due.
pub struct NoTimer;

impl FlushTimer for NoTimer {
    fn schedule(&self, _: Duration, _: Box<dyn FnOnce() + Send>) {}
}

/// The analytics of a userData with this machine id at a fixed time, and
/// what their merges work with.
pub struct Harness {
    pub ctx: StoreContext,
    pub ops: Arc<DataOps>,
    /// The units the analytics announced.
    pub notified: Arc<Mutex<Vec<String>>>,
    /// Whether a reset holds every keyboard.
    pub held: Arc<AtomicBool>,
}

impl Harness {
    pub fn new(root: &std::path::Path, machine_id: &str, now: i64) -> Self {
        let clock = Arc::new(FixedClock::new(now));
        let machine_id = machine_id.to_owned();
        let identity =
            MachineIdentity::new(root, Arc::new(RandomUuid), Box::new(move || Ok(machine_id.clone())));
        let analytics = Arc::new(TypingAnalytics::new(
            root,
            identity,
            clock.clone(),
            rebuild_from_master_files(clock.clone()),
        ));
        let notified = Arc::new(Mutex::new(Vec::new()));
        let notify = {
            let notified = notified.clone();
            Arc::new(move |unit: &str| notified.lock().unwrap().push(unit.to_owned()))
        };
        let deps = RecorderDeps {
            ids: Arc::new(RandomUuid),
            os: OsInfo { platform: "linux".into(), release: "6.8.0".into(), arch: "x64".into() },
            timer: Arc::new(NoTimer),
            notify,
            app_name: Arc::new(|| None),
        };
        let recorder = Recorder::new(analytics, deps, &tokio::runtime::Handle::current());
        let locks = Arc::new(WriteLocks::new());
        let ctx = StoreContext::new(root, clock, locks.clone(), Arc::new(|_: &str| {}));
        let ops = Arc::new(DataOps::new(recorder, locks, Arc::new(RandomUuid)));
        Self { ctx, ops, notified, held: Arc::new(AtomicBool::new(false)) }
    }

    pub fn env(&self) -> AnalyticsEnv<'_> {
        let held = self.held.clone();
        AnalyticsEnv {
            ctx: &self.ctx,
            ops: &self.ops,
            holds: Arc::new(move |_: &str| held.load(Ordering::SeqCst)),
        }
    }
}

/// No waits and no quitting, for Drive calls that are not retried.
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
