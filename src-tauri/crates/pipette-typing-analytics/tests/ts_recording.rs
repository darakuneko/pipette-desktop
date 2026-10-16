// SPDX-License-Identifier: GPL-2.0-or-later
//! The recording against the TypeScript pipeline: each scenario of
//! recording.json (record-analytics-recording-fixtures.test.ts) replayed on
//! the [`Recorder`] must leave the same pending work and announced sync
//! units after every step, the same bytes in every day file and in
//! `sync_state.json`, and the same rows in every cache table.
//!
//! As in the generator, the debounce timer fires only when a step advances
//! the clock, and each step waits for the flush chain to finish.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::collections::{BTreeMap, VecDeque};
use std::fmt::Write;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{Node, array, field, fixture, number, record_tree, text, tree_of};
use pipette_entry_store::{FixedClock, SequenceIds};
use pipette_js_json::{JsString, Value};
use pipette_typing_analytics::fingerprint::OsInfo;
use pipette_typing_analytics::{
    Error, FlushTimer, MachineIdentity, RebuildCache, Recorder, RecorderDeps, TypingAnalytics,
};
use pipette_typing_analytics_db::DATA_TABLE_NAMES;
use rusqlite::types::ValueRef;

type Task = Box<dyn FnOnce() + Send>;

/// A timer driven by the test: its tasks run when [`ManualTimer::advance`]
/// moves the clock past their time.
struct ManualTimer {
    clock: Arc<FixedClock>,
    tasks: Mutex<Vec<(i64, Task)>>,
}

impl FlushTimer for ManualTimer {
    fn schedule(&self, delay: Duration, task: Task) {
        let due = pipette_entry_store::Clock::now_ms(self.clock.as_ref()) + delay.as_millis() as i64;
        self.tasks.lock().unwrap().push((due, task));
    }
}

impl ManualTimer {
    /// Moves the clock by `ms` and runs the tasks due by then, in the order
    /// they are due.
    fn advance(&self, ms: i64) {
        let now = pipette_entry_store::Clock::now_ms(self.clock.as_ref()) + ms;
        self.clock.set(now);
        let mut due: Vec<_> = {
            let mut tasks = self.tasks.lock().unwrap();
            let (due, later) = tasks.drain(..).partition(|(at, _)| *at <= now);
            *tasks = later;
            due
        };
        due.sort_by_key(|(at, _)| *at);
        for (_, task) in due {
            task();
        }
    }
}

fn cell(value: ValueRef<'_>) -> String {
    let hex = |bytes: &[u8]| {
        bytes.iter().fold(String::new(), |mut s, b| {
            write!(s, "{b:02x}").unwrap();
            s
        })
    };
    match value {
        ValueRef::Null => "n".to_owned(),
        ValueRef::Integer(i) => format!("i:{i}"),
        ValueRef::Real(r) => format!("r:{:016x}", r.to_bits()),
        ValueRef::Text(t) => format!("t:{}", hex(t)),
        ValueRef::Blob(b) => format!("b:{}", hex(b)),
    }
}

/// The rows of `table` ordered by its primary key, in the canonical text
/// of canonical.ts.
fn table_rows(conn: &rusqlite::Connection, table: &str) -> Vec<String> {
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

/// The files under the subtrees the recording writes.
fn recorded_files(user_data: &Path) -> BTreeMap<String, Node> {
    let mut files = BTreeMap::new();
    for root in ["sync", "local/typing-analytics"] {
        for (path, node) in record_tree(&user_data.join(root)) {
            if node != Node::Dir {
                files.insert(format!("{root}/{path}"), node);
            }
        }
    }
    files
}

fn strings(values: &[Value]) -> Vec<String> {
    values.iter().map(|v| v.as_str().unwrap().to_owned()).collect()
}

struct Harness {
    recorder: Arc<Recorder>,
    timer: Arc<ManualTimer>,
    units: Arc<Mutex<Vec<String>>>,
}

fn harness(user_data: &Path, golden: &Value, scenario: &Value) -> Harness {
    let clock = Arc::new(FixedClock::new(number(field(scenario, "start")) as i64));
    let machine_id = text(golden, "machineId").to_owned();
    let identity = MachineIdentity::new(
        user_data,
        Arc::new(SequenceIds::new([text(golden, "installationId")])),
        Box::new(move || Ok(machine_id.clone())),
    );
    let rebuild: RebuildCache = Arc::new(|_, _, _| Err(Error::CacheRebuild("the cache is up to date".into())));
    let analytics = Arc::new(TypingAnalytics::new(user_data, identity, clock.clone(), rebuild));
    let timer = Arc::new(ManualTimer { clock, tasks: Mutex::new(Vec::new()) });
    let units = Arc::new(Mutex::new(Vec::new()));
    let app_names: Mutex<VecDeque<Option<JsString>>> = Mutex::new(
        array(scenario, "appNames")
            .iter()
            .map(|name| match name {
                Value::String(name) => Some(name.clone()),
                _ => None,
            })
            .collect(),
    );
    let os = field(golden, "os");
    let recorded = units.clone();
    let deps = RecorderDeps {
        ids: Arc::new(SequenceIds::new(strings(array(golden, "sessionIds")))),
        os: OsInfo { platform: text(os, "platform").into(), release: text(os, "release").into(), arch: text(os, "arch").into() },
        timer: timer.clone(),
        notify: Arc::new(move |unit| recorded.lock().unwrap().push(unit.to_owned())),
        app_name: Arc::new(move || app_names.lock().unwrap().pop_front().flatten()),
    };
    let recorder = Recorder::new(analytics, deps, &tokio::runtime::Handle::current());
    Harness { recorder, timer, units }
}

impl Harness {
    async fn run(&self, step: &Value, user_data: &Path) {
        match text(step, "op") {
            "event" => self.recorder.ingest(field(step, "payload")).await.unwrap(),
            "advance" => self.timer.advance(number(field(step, "ms")) as i64),
            "flush" => {
                // The typingAnalyticsFlush handler.
                if let Some(uid) = field(step, "uid").as_str().filter(|uid| !uid.is_empty()) {
                    self.recorder.flush_for_uid(uid).await;
                }
            }
            "quit" => {
                if self.recorder.has_pending_work() {
                    self.recorder.flush_before_quit().await;
                }
            }
            "block" => std::fs::create_dir_all(user_data.join(text(step, "path"))).unwrap(),
            "unblock" => std::fs::remove_dir(user_data.join(text(step, "path"))).unwrap(),
            other => panic!("unknown step {other}"),
        }
        // Waits for the flush chain, the flush the step queued included.
        self.recorder.run_on_flush_chain(async {}).await;
    }
}

#[tokio::test]
async fn replays_every_scenario_as_the_typescript_pipeline() {
    let golden = fixture("recording.json");
    for scenario in array(&golden, "scenarios") {
        let name = text(scenario, "name");
        let dir = tempfile::tempdir().unwrap();
        let state_path = dir.path().join("local/typing-analytics/sync_state.json");
        std::fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        std::fs::write(&state_path, text(&golden, "freshSyncState")).unwrap();
        let harness = harness(dir.path(), &golden, scenario);

        let expected = field(scenario, "expected");
        let pending = array(expected, "pendingWork");
        let unit_counts = array(expected, "unitCounts");
        for (i, step) in array(scenario, "steps").iter().enumerate() {
            harness.run(step, dir.path()).await;
            let label = format!("{name}: step {i} ({})", text(step, "op"));
            assert_eq!(Value::Bool(harness.recorder.has_pending_work()), pending[i], "{label}: pending work");
            assert_eq!(harness.units.lock().unwrap().len() as f64, number(&unit_counts[i]), "{label}: units");
        }
        assert_eq!(*harness.units.lock().unwrap(), strings(array(expected, "units")), "{name}: units");
        assert_eq!(recorded_files(dir.path()), tree_of(field(expected, "files")), "{name}: files");

        let conn = rusqlite::Connection::open(dir.path().join("local/typing-analytics.db")).unwrap();
        for table in DATA_TABLE_NAMES {
            let rows = strings(array(field(field(expected, "tables"), table), "rows"));
            assert_eq!(table_rows(&conn, table), rows, "{name}: {table}");
        }
    }
}
