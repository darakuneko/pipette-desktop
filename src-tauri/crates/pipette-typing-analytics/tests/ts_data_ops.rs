// SPDX-License-Identifier: GPL-2.0-or-later
//! The data operations against the TypeScript code: each scenario of
//! data_ops.json and of data_ops_local_days/<zone>.json
//! (scripts/analytics-db-fixtures/data-ops-harness.ts) replayed on the
//! recorder and [`DataOps`] must answer every step the same, announce the
//! same sync units in order, log the same lines and leave the same files
//! and cache tables. The local days run once per recorded time zone, each
//! in a process of its own.
//!
//! An OS error's text is not compared (`<os error>`), nor the temp
//! directory (`<userData>`).

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use common::{
    ManualTimer, Node, array, build_tree, field, fixture, hex, number, record_tree, table_rows, text, tree_of,
};
use pipette_entry_store::{Clock, FixedClock, SequenceIds, WriteLocks};
use pipette_js_json::{Object, Value};
use pipette_time::test_util::in_each_time_zone;
use pipette_typing_analytics::cache_rebuild::rebuild_cache_from_master_files;
use pipette_typing_analytics::device_delete::DeviceDays;
use pipette_typing_analytics::fingerprint::OsInfo;
use pipette_typing_analytics::import_export::export_typing_data_for_keyboard;
use pipette_typing_analytics::queries::{Context, Query};
use pipette_typing_analytics::{
    DataOps, DeleteScope, MachineIdentity, RebuildCache, Recorder, RecorderDeps, TypingAnalytics,
    rebuild_from_master_files,
};
use pipette_typing_analytics_db::{DATA_TABLE_NAMES, ToJs};
use sha2::{Digest, Sha256};

/// The warnings and errors logged, as `level: message`.
struct Captured(Mutex<Vec<String>>);

impl log::Log for Captured {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Warn
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            let level = record.level().as_str().to_lowercase();
            self.0.lock().unwrap().push(format!("{level}: {}", record.args()));
        }
    }

    fn flush(&self) {}
}

fn logs() -> &'static Captured {
    static LOGS: OnceLock<&'static Captured> = OnceLock::new();
    LOGS.get_or_init(|| {
        let captured: &'static Captured = Box::leak(Box::new(Captured(Mutex::new(Vec::new()))));
        log::set_logger(captured).unwrap();
        log::set_max_level(log::LevelFilter::Warn);
        captured
    })
}

/// `text` with the temp directory as `<userData>` and the text of an OS
/// error (`… (os error N)`) as `<os error>`, from the `Error: ` before it
/// on, or the whole text when there is none.
fn normalize(text: &str, user_data: &Path) -> String {
    let text = text.replace(user_data.to_str().unwrap(), "<userData>");
    let Some(at) = text.rfind(" (os error ").filter(|_| text.ends_with(')')) else { return text };
    match text[..at].rfind("Error: ") {
        Some(start) => format!("{}Error: <os error>", &text[..start]),
        None => "<os error>".to_owned(),
    }
}

struct Harness {
    ops: Arc<DataOps>,
    analytics: Arc<TypingAnalytics>,
    timer: Arc<ManualTimer>,
    clock: Arc<FixedClock>,
    units: Arc<Mutex<Vec<String>>>,
    rebuilds: Arc<AtomicUsize>,
    unlink_failures: Arc<Mutex<HashSet<PathBuf>>>,
    user_data: PathBuf,
}

fn harness(user_data: &Path, golden: &Value, scenario: &Value) -> Harness {
    let clock = Arc::new(FixedClock::new(number(field(scenario, "start")) as i64));
    let machine_id = text(golden, "machineId").to_owned();
    let identity = MachineIdentity::new(
        user_data,
        Arc::new(SequenceIds::new([text(golden, "installationId")])),
        Box::new(move || Ok(machine_id.clone())),
    );
    let rebuilds = Arc::new(AtomicUsize::new(0));
    let (counted, real) = (rebuilds.clone(), rebuild_from_master_files(clock.clone()));
    let rebuild: RebuildCache = Arc::new(move |db, user_data, hash| {
        counted.fetch_add(1, Ordering::SeqCst);
        real(db, user_data, hash)
    });
    let analytics = Arc::new(TypingAnalytics::new(user_data, identity, clock.clone(), rebuild));
    let timer = Arc::new(ManualTimer::new(clock.clone()));
    let units = Arc::new(Mutex::new(Vec::new()));
    let os = field(golden, "os");
    let ids: Vec<String> = array(golden, "ids").iter().map(|id| id.as_str().unwrap().to_owned()).collect();
    // randomUUID gives the sessions and the deleted ranges their ids from
    // one sequence.
    let ids = Arc::new(SequenceIds::new(ids));
    let recorded = units.clone();
    let deps = RecorderDeps {
        ids: ids.clone(),
        os: OsInfo {
            platform: text(os, "platform").into(),
            release: text(os, "release").into(),
            arch: text(os, "arch").into(),
        },
        timer: timer.clone(),
        notify: Arc::new(move |unit| recorded.lock().unwrap().push(unit.to_owned())),
        app_name: Arc::new(|| None),
    };
    let recorder = Recorder::new(analytics.clone(), deps, &tokio::runtime::Handle::current());
    let unlink_failures: Arc<Mutex<HashSet<PathBuf>>> = Arc::default();
    let failures = unlink_failures.clone();
    let ops =
        DataOps::new(recorder, Arc::new(WriteLocks::new()), ids).with_remove_file(Arc::new(move |path| {
            if failures.lock().unwrap().contains(path) {
                return Err(std::io::Error::from_raw_os_error(13));
            }
            std::fs::remove_file(path)
        }));
    Harness {
        ops: Arc::new(ops),
        analytics,
        timer,
        clock,
        units,
        rebuilds,
        unlink_failures,
        user_data: user_data.to_path_buf(),
    }
}

fn strings(value: &Value, key: &str) -> Vec<String> {
    array(value, key).iter().map(|v| v.as_str().unwrap().to_owned()).collect()
}

fn object(pairs: Vec<(&str, f64)>) -> Value {
    pairs.into_iter().map(|(key, n)| (key, Value::Number(n))).collect::<Object>().into()
}

impl Harness {
    fn now(&self) -> i64 {
        self.clock.now_ms()
    }

    /// The step's answer as JSON text (`None` for none), or its error.
    async fn answer(&self, step: &Value) -> Result<Option<Value>, String> {
        let recorder = self.ops.recorder();
        let uid = || text(step, "uid");
        let user_data = &self.user_data;
        let error = |err: pipette_typing_analytics::Error| err.to_string();
        match text(step, "op") {
            "event" => recorder.ingest(field(step, "payload")).await.map_err(error)?,
            "advance" => self.timer.advance(number(field(step, "ms")) as i64),
            "flush" => recorder.flush_for_uid(uid()).await,
            "quit" => {
                if recorder.has_pending_work() {
                    recorder.flush_before_quit().await;
                }
            }
            "deleteAll" => {
                let scope = if text(step, "scope") == "own" { DeleteScope::Own } else { DeleteScope::All };
                let result =
                    self.ops.delete_all_for_keyboard(uid(), self.now(), scope).await.map_err(error)?;
                return Ok(Some(result.to_js()));
            }
            "deleteDays" => {
                let dates = strings(step, "dates");
                let result = self.ops.delete_local_days(uid(), &dates, self.now()).await.map_err(error)?;
                return Ok(Some(result.to_js()));
            }
            "deleteDevice" => {
                let days = match field(step, "dates") {
                    Value::String(_) => DeviceDays::All,
                    _ => DeviceDays::Local(strings(step, "dates")),
                };
                self.ops
                    .delete_device_data(uid(), text(step, "hash"), days, self.now())
                    .await
                    .map_err(error)?;
            }
            "export" => {
                let ready = self.analytics.ready().await.map_err(|err| err.to_string())?;
                let days: HashSet<String> = strings(step, "dates").into_iter().collect();
                let written = export_typing_data_for_keyboard(
                    user_data,
                    uid(),
                    &ready.machine_hash,
                    &user_data.join(text(step, "dir")),
                    &days,
                )
                .map_err(|err| err.to_string())?;
                return Ok(Some(Value::Number(written as f64)));
            }
            "import" => {
                let paths = strings(step, "files").into_iter().map(|file| user_data.join(file)).collect();
                let result = self.ops.import_typing_files(paths, None).await.map_err(error)?;
                return Ok(Some(result.to_js()));
            }
            "rebuild" => {
                let ready = self.analytics.ready().await.map_err(|err| err.to_string())?;
                let (user_data, clock): (PathBuf, Arc<dyn Clock>) = (user_data.clone(), self.clock.clone());
                let result = tokio::task::spawn_blocking(move || {
                    rebuild_cache_from_master_files(&ready.db, &user_data, &ready.machine_hash, &clock)
                })
                .await
                .unwrap()
                .map_err(error)?;
                let r = result.rows;
                return Ok(Some(object(vec![
                    ("scopes", r.scopes as f64),
                    ("charMinutes", r.char_minutes as f64),
                    ("matrixMinutes", r.matrix_minutes as f64),
                    ("minuteStats", r.minute_stats as f64),
                    ("sessions", r.sessions as f64),
                    ("bigramMinutes", r.bigram_minutes as f64),
                    ("trigramMinutes", r.trigram_minutes as f64),
                    ("jsonlFilesRead", result.jsonl_files_read as f64),
                ])));
            }
            "ensureFresh" => {
                let before = self.rebuilds.load(Ordering::SeqCst);
                self.analytics.ready().await.map_err(|err| err.to_string())?;
                return Ok(Some(Value::Bool(self.rebuilds.load(Ordering::SeqCst) > before)));
            }
            "applyOwnRanges" => {
                self.ops.apply_own_deleted_ranges_for_all_keyboards(Arc::new(|_| false)).await
            }
            "heatmap" => {
                let ready = self.analytics.ready().await.map_err(|err| err.to_string())?;
                let args = vec![
                    field(step, "uid").clone(),
                    field(step, "layer").clone(),
                    field(step, "since").clone(),
                ];
                let (recorder, user_data) = (recorder.clone(), user_data.clone());
                let hash = ready.machine_hash.clone();
                let value = ready
                    .db
                    .call(move |db| {
                        let cx = Context {
                            db,
                            user_data: &user_data,
                            own_hash: &hash,
                            os_platform: "linux",
                            os_release: "6.8.0",
                            recorder: Some(&recorder),
                        };
                        Query::GetMatrixHeatmap.answer(&args, &cx)
                    })
                    .await
                    .unwrap()
                    .map_err(error)?;
                return Ok(Some(value));
            }
            "failUnlink" => {
                self.unlink_failures.lock().unwrap().insert(user_data.join(text(step, "path")));
            }
            "write" => {
                let path = user_data.join(text(step, "path"));
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, text(step, "content")).unwrap();
            }
            "mkdir" => std::fs::create_dir_all(user_data.join(text(step, "path"))).unwrap(),
            "remove" => {
                let _ = std::fs::remove_dir_all(user_data.join(text(step, "path")));
            }
            other => panic!("unknown step {other}"),
        }
        Ok(None)
    }

    /// The outcome text the generator records for a step.
    async fn outcome(&self, step: &Value) -> Value {
        let answered = self.answer(step).await;
        // Waits for the flush chain, the tasks the step queued included.
        self.ops.recorder().run_on_flush_chain(async {}).await;
        match answered {
            Ok(None) => Value::Null,
            Ok(Some(value)) => Value::from(pipette_js_json::stringify(&value)),
            Err(message) => {
                let error: Object =
                    [("error", Value::from(normalize(&message, &self.user_data)))].into_iter().collect();
                Value::from(pipette_js_json::stringify(&error.into()))
            }
        }
    }
}

/// The files under the subtrees the data operations write.
fn recorded_files(user_data: &Path) -> BTreeMap<String, Node> {
    let mut files = BTreeMap::new();
    for root in ["sync", "local/typing-analytics", "exports"] {
        if !user_data.join(root).exists() {
            continue;
        }
        for (path, node) in record_tree(&user_data.join(root)) {
            if node != Node::Dir {
                files.insert(format!("{root}/{path}"), node);
            }
        }
    }
    files
}

fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// The recorded files, those of a compact fixture recorded as `{ sha256 }`
/// compared by digest.
fn assert_files(expected: &Value, user_data: &Path, label: &str) {
    let Value::Object(expected) = expected else { panic!("{label}: files") };
    let actual = recorded_files(user_data);
    let mut expected_paths: Vec<String> = expected.keys().map(|k| k.to_string_lossy().into_owned()).collect();
    expected_paths.sort();
    assert_eq!(actual.keys().cloned().collect::<Vec<_>>(), expected_paths, "{label}: the file paths");
    for (path, content) in expected.iter() {
        let path = path.to_string_lossy().into_owned();
        let Some(Node::File(bytes)) = actual.get(&path) else { panic!("{label}: {path}") };
        match content.as_object().and_then(|c| c.get("sha256")) {
            Some(digest) => assert_eq!(Some(sha256(bytes).as_str()), digest.as_str(), "{label}: {path}"),
            None => {
                let one: Value = [(path.clone(), content.clone())].into_iter().collect::<Object>().into();
                assert_eq!(Some(&Node::File(bytes.clone())), tree_of(&one).get(&path), "{label}: {path}");
            }
        }
    }
}

fn assert_tables(expected: &Value, user_data: &Path, label: &str) {
    let conn = rusqlite::Connection::open(user_data.join("local/typing-analytics.db")).unwrap();
    for table in DATA_TABLE_NAMES {
        let dump = field(expected, table);
        let rows = table_rows(&conn, table);
        if dump.as_object().unwrap().contains_key("rows") {
            assert_eq!(rows, strings(dump, "rows"), "{label}: {table}");
        } else {
            assert_eq!(rows.len() as f64, number(field(dump, "count")), "{label}: {table} rows");
            assert_eq!(sha256(rows.join("\n").as_bytes()), text(dump, "sha256"), "{label}: {table}");
        }
    }
}

async fn replay(golden: &Value, label: &str) {
    let logs = logs();
    for scenario in array(golden, "scenarios") {
        let label = format!("{label} {}", text(scenario, "name"));
        let dir = tempfile::tempdir().unwrap();
        build_tree(dir.path(), &tree_of(field(scenario, "tree")));
        logs.0.lock().unwrap().clear();
        let harness = harness(dir.path(), golden, scenario);
        let expected = field(scenario, "expected");
        let outcomes = array(expected, "outcomes");
        for (i, step) in array(scenario, "steps").iter().enumerate() {
            let got = harness.outcome(step).await;
            assert_eq!(got, outcomes[i], "{label}: step {i} ({})", text(step, "op"));
        }
        assert_eq!(*harness.units.lock().unwrap(), strings(expected, "units"), "{label}: units");
        let logged: Vec<String> =
            logs.0.lock().unwrap().iter().map(|line| normalize(line, dir.path())).collect();
        assert_eq!(logged, strings(expected, "logs"), "{label}: logs");
        assert_files(field(expected, "files"), dir.path(), &label);
        assert_tables(field(expected, "tables"), dir.path(), &label);
    }
}

#[tokio::test]
async fn replays_every_scenario_as_the_typescript_code() {
    replay(&fixture("data_ops.json"), "data ops:").await;
}

const ZONES: &[&str] = &["UTC", "Asia/Tokyo", "America/New_York", "America/Santiago", "America/Havana"];

#[test]
fn deletes_local_days_as_the_typescript_code_in_each_time_zone() {
    let Some(zone) = in_each_time_zone("deletes_local_days_as_the_typescript_code_in_each_time_zone", ZONES)
    else {
        return;
    };
    let golden = fixture(&format!("data_ops_local_days/{}.json", zone.to_lowercase().replace('/', "-")));
    assert_eq!(text(&golden, "timeZone"), zone);
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(replay(&golden, &zone));
}
