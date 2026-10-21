// SPDX-License-Identifier: GPL-2.0-or-later

use std::path::Path;
use std::sync::mpsc as std_mpsc;

use pipette_entry_store::{Clock, FixedClock, RandomUuid, SequenceIds};
use tempfile::TempDir;

use super::*;
use crate::identity::MachineIdentity;
use crate::service::RebuildCache;
use crate::sync_state::{TypingSyncState, load_sync_state, save_sync_state, sync_state_path};

const MACHINE_ID: &str = "machine";
const INSTALLATION_ID: &str = "0f1e2d3c-4b5a-4697-8877-665544332211";
const TS: i64 = 1_776_168_000_000; // 2026-04-14 12:00:00 UTC
const DAY: &str = "2026-04-14";

/// Runs the scheduled flushes only when a test asks.
#[derive(Default)]
struct HeldTimer(Mutex<Vec<Box<dyn FnOnce() + Send>>>);

impl FlushTimer for HeldTimer {
    fn schedule(&self, _: Duration, task: Box<dyn FnOnce() + Send>) {
        self.0.lock().unwrap().push(task);
    }
}

impl HeldTimer {
    fn fire(&self) {
        let tasks: Vec<_> = self.0.lock().unwrap().drain(..).collect();
        tasks.into_iter().for_each(|task| task());
    }
}

struct Fixture {
    dir: TempDir,
    clock: Arc<FixedClock>,
    timer: Arc<HeldTimer>,
    units: Arc<Mutex<Vec<String>>>,
    recorder: Arc<Recorder>,
    hash: String,
    /// The rebuilds the initializations tried.
    rebuilds: Arc<std::sync::atomic::AtomicUsize>,
}

fn hash() -> String {
    pipette_sync_format::machine_hash(MACHINE_ID, INSTALLATION_ID)
}

/// A recorder on a fresh userData directory whose cache is up to date
/// (`fresh`) or would need a rebuild, which fails.
fn fixture_with(fresh: bool, app_name: Arc<dyn Fn() -> Option<JsString> + Send + Sync>) -> Fixture {
    let dir = TempDir::new().unwrap();
    if fresh {
        save_sync_state(dir.path(), &TypingSyncState::empty(&hash())).unwrap();
    }
    let clock = Arc::new(FixedClock::new(TS));
    let identity = MachineIdentity::new(
        dir.path(),
        Arc::new(SequenceIds::new([INSTALLATION_ID])),
        Box::new(|| Ok(MACHINE_ID.into())),
    );
    let rebuilds = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = rebuilds.clone();
    let rebuild: RebuildCache = Arc::new(move |_, _, _| {
        counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Err(Error::CacheRebuild("no".into()))
    });
    let analytics = Arc::new(TypingAnalytics::new(dir.path(), identity, clock.clone(), rebuild));
    let timer = Arc::new(HeldTimer::default());
    let units = Arc::new(Mutex::new(Vec::new()));
    let recorded = units.clone();
    let deps = RecorderDeps {
        ids: Arc::new(RandomUuid),
        os: OsInfo { platform: "linux".into(), release: "6.8.0".into(), arch: "x64".into() },
        timer: timer.clone(),
        notify: Arc::new(move |unit| recorded.lock().unwrap().push(unit.to_owned())),
        app_name,
    };
    let recorder = Recorder::new(analytics, deps, &tokio::runtime::Handle::current());
    Fixture { dir, clock, timer, units, recorder, hash: hash(), rebuilds }
}

fn fixture() -> Fixture {
    fixture_with(true, Arc::new(|| None))
}

fn char_event(uid: &str, ts: i64, key: &str) -> Value {
    pipette_js_json::parse(&format!(
        r#"{{"kind":"char","key":"{key}","ts":{ts},"keyboard":{{"uid":"{uid}","vendorId":65261,"productId":0,"productName":"K"}}}}"#
    ))
    .unwrap()
}

fn release_event(ts: i64) -> Value {
    pipette_js_json::parse(&format!(
        r#"{{"kind":"matrix-release","row":0,"col":1,"layer":0,"keycode":4,"durationMs":120,"ts":{ts},"keyboard":{{"uid":"A","vendorId":65261,"productId":0,"productName":"K"}}}}"#
    ))
    .unwrap()
}

impl Fixture {
    async fn ingest(&self, event: Value) {
        self.recorder.ingest(&event).await.unwrap();
    }

    async fn settle(&self) {
        self.recorder.run_on_flush_chain(async {}).await;
    }

    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.dir.path().join("local/typing-analytics.db")).unwrap()
    }

    fn count(&self, sql: &str) -> i64 {
        self.db().query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn day_file(&self, uid: &str) -> std::path::PathBuf {
        device_day_jsonl_path(self.dir.path(), uid, &self.hash, DAY)
    }

    fn unit(&self, uid: &str) -> String {
        typing_analytics_device_day_sync_unit(uid, &self.hash, DAY)
    }
}

fn lines(path: &Path) -> usize {
    std::fs::read_to_string(path).map_or(0, |text| text.lines().count())
}

#[tokio::test]
async fn a_flush_writes_the_day_file_the_cache_and_the_sync_state_then_announces_each_keyboard() {
    let f = fixture();
    f.ingest(char_event("A", TS, "a")).await;
    f.ingest(char_event("B", TS, "a")).await;
    f.recorder.flush_now(true).await;
    assert_eq!(f.count("SELECT COUNT(*) FROM typing_minute_stats"), 2);
    assert_eq!(lines(&f.day_file("A")), 3);
    assert_eq!(*f.units.lock().unwrap(), [f.unit("A"), f.unit("B")]);
    let state = load_sync_state(f.dir.path()).unwrap();
    assert_eq!(state, TypingSyncState { last_synced_at: TS as f64, ..TypingSyncState::empty(&f.hash) });
}

#[tokio::test]
async fn an_event_schedules_one_debounced_flush_that_leaves_the_live_minute() {
    let f = fixture();
    f.ingest(char_event("A", TS, "a")).await;
    f.ingest(char_event("A", TS + 10, "b")).await;
    assert_eq!(f.timer.0.lock().unwrap().len(), 1);
    f.timer.fire();
    f.settle().await;
    // The minute is still open, so only the timer for the next try is set.
    assert_eq!(lines(&f.day_file("A")), 0);
    assert_eq!(f.timer.0.lock().unwrap().len(), 1);
    f.clock.set(TS + 60_000 + DRAIN_GRACE_MS);
    f.timer.fire();
    f.settle().await;
    assert_eq!(f.count("SELECT keystrokes FROM typing_minute_stats"), 2);
    // The session stays open: work is still pending, nothing is scheduled.
    assert!(f.recorder.has_pending_work());
    assert!(f.timer.0.lock().unwrap().is_empty());
}

const DRAIN_GRACE_MS: i64 = crate::minute_buffer::DRAIN_CLOSE_GRACE_MS as i64;

#[tokio::test]
async fn a_timer_disarmed_by_a_flush_does_nothing() {
    let app_names = Arc::new(Mutex::new(0));
    let counted = app_names.clone();
    let f = fixture_with(
        true,
        Arc::new(move || {
            *counted.lock().unwrap() += 1;
            None
        }),
    );
    f.ingest(char_event("A", TS, "a")).await;
    f.recorder.flush_now(true).await;
    f.ingest(char_event("A", TS + 1, "b")).await;
    // Both the stale timer and the live one fire: one flush runs.
    f.timer.fire();
    f.settle().await;
    assert_eq!(*app_names.lock().unwrap(), 2);
}

#[tokio::test]
async fn reports_pending_work_while_a_flush_is_running() {
    let (release, wait) = std_mpsc::channel::<()>();
    let wait = Mutex::new(wait);
    let f = fixture_with(
        true,
        Arc::new(move || {
            let _ = wait.lock().unwrap().recv();
            None
        }),
    );
    f.ingest(char_event("A", TS, "a")).await;
    f.recorder.close_sessions_for_uid("A", |_| true);
    let flush = f.recorder.flush_now(true);
    assert!(f.recorder.has_pending_work());
    release.send(()).unwrap();
    flush.await;
    assert!(!f.recorder.has_pending_work());
}

#[tokio::test]
async fn concurrent_flushes_run_one_after_the_other() {
    let f = fixture();
    f.ingest(char_event("A", TS, "a")).await;
    let (a, b) = (f.recorder.flush_now(true), f.recorder.flush_now(true));
    tokio::join!(a, b);
    assert_eq!(f.count("SELECT COUNT(*) FROM typing_minute_stats"), 1);
    assert_eq!(f.units.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_flush_runs_to_its_end_when_its_caller_stops_waiting() {
    let f = fixture();
    f.ingest(char_event("A", TS, "a")).await;
    drop(f.recorder.flush_before_quit());
    f.settle().await;
    assert_eq!(f.count("SELECT COUNT(*) FROM typing_sessions"), 1);
    assert!(!f.recorder.has_pending_work());
}

#[tokio::test]
async fn updated_at_rises_across_flushes_in_one_millisecond() {
    let f = fixture();
    f.ingest(char_event("A", TS, "a")).await;
    f.recorder.flush_now(true).await;
    let first = f.count("SELECT updated_at FROM typing_minute_stats");
    f.ingest(char_event("A", TS, "b")).await;
    f.recorder.flush_now(true).await;
    assert!(f.count("SELECT updated_at FROM typing_minute_stats") > first);
    assert_eq!(f.count("SELECT keystrokes FROM typing_minute_stats"), 2);
    assert_eq!(f.recorder.claim_own_row_updated_at(TS as f64 + 10.0), TS as f64 + 11.0);
}

#[tokio::test]
async fn a_failed_cache_write_announces_nothing_and_the_next_flush_sends_the_whole_minute() {
    let f = fixture();
    f.ingest(char_event("A", TS, "a")).await;
    f.recorder.close_sessions_for_uid("A", |_| true);
    // Starts the analytics, then takes the table the cache write needs.
    f.recorder.flush_now(true).await;
    f.db().execute_batch("ALTER TABLE typing_minute_stats RENAME TO held").unwrap();
    let state_before = std::fs::read(sync_state_path(f.dir.path())).unwrap();
    let units_before = f.units.lock().unwrap().len();

    f.ingest(char_event("A", TS + 500, "b")).await;
    f.recorder.flush_now(true).await;
    assert_eq!(f.units.lock().unwrap().len(), units_before);
    assert_eq!(std::fs::read(sync_state_path(f.dir.path())).unwrap(), state_before);
    assert!(f.recorder.has_pending_work());
    // The day file was written before the cache failed.
    let written = lines(&f.day_file("A"));
    assert!(written > 0);
    // The chain schedules the retry.
    assert!(f.recorder.state().timer.is_some());

    f.db().execute_batch("ALTER TABLE held RENAME TO typing_minute_stats").unwrap();
    f.clock.set(TS + 60_000 + DRAIN_GRACE_MS);
    f.timer.fire();
    f.settle().await;
    assert_eq!(f.count("SELECT keystrokes FROM typing_minute_stats"), 2);
    assert!(lines(&f.day_file("A")) > written);
    assert_eq!(f.units.lock().unwrap().len(), units_before + 1);
}

#[tokio::test]
async fn a_failed_initialization_keeps_everything_buffered_until_one_succeeds() {
    let f = fixture_with(false, Arc::new(|| None));
    f.ingest(char_event("A", TS, "a")).await;
    f.recorder.flush_before_quit().await;
    f.recorder.flush_now(true).await;
    assert!(f.recorder.has_pending_work());
    assert!(!f.day_file("A").exists());
    assert!(f.units.lock().unwrap().is_empty());

    save_sync_state(f.dir.path(), &TypingSyncState::empty(&f.hash)).unwrap();
    f.recorder.flush_now(true).await;
    assert_eq!(f.count("SELECT COUNT(*) FROM typing_sessions"), 1);
    assert_eq!(f.count("SELECT keystrokes FROM typing_minute_stats"), 1);
    assert!(!f.recorder.has_pending_work());
}

#[tokio::test]
async fn a_debounced_flush_tries_a_failed_initialization_again_only_after_a_while() {
    let f = fixture_with(false, Arc::new(|| None));
    let rebuilds = || f.rebuilds.load(std::sync::atomic::Ordering::SeqCst);
    f.ingest(char_event("A", TS, "a")).await;
    f.timer.fire();
    f.settle().await;
    assert_eq!(rebuilds(), 1);
    f.clock.set(TS + 29_999);
    f.timer.fire();
    f.settle().await;
    assert_eq!(rebuilds(), 1);
    f.clock.set(TS + 30_000);
    f.timer.fire();
    f.settle().await;
    assert_eq!(rebuilds(), 2);
    // A final flush (the renderer's, the quit's) always tries.
    f.recorder.flush_now(true).await;
    assert_eq!(rebuilds(), 3);
    assert!(f.recorder.has_pending_work());
}

#[tokio::test]
async fn a_release_alone_neither_opens_a_session_nor_makes_a_day() {
    let f = fixture();
    f.ingest(release_event(TS)).await;
    f.recorder.flush_before_quit().await;
    assert_eq!(f.count("SELECT COUNT(*) FROM typing_sessions"), 0);
    assert_eq!(f.count("SELECT COUNT(*) FROM typing_minute_stats"), 0);
    assert_eq!(f.count("SELECT COUNT(*) FROM typing_matrix_minute"), 1);
}

#[tokio::test]
async fn invalid_events_are_ignored() {
    let f = fixture();
    f.ingest(pipette_js_json::parse(r#"{"kind":"char","key":"","ts":1}"#).unwrap()).await;
    f.ingest(Value::Null).await;
    assert!(!f.recorder.has_pending_work());
    assert!(f.timer.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_dropped_session_without_a_scope_is_not_queued_again() {
    let f = fixture();
    f.recorder.state().pending_sessions.push(FinalizedSession {
        id: "s".into(),
        uid: "never-typed".into(),
        scope_key: "k".into(),
        start_ms: TS as f64,
        end_ms: TS as f64,
        keystroke_count: 1,
    });
    f.recorder.state().dirty = true;
    f.recorder.flush_now(true).await;
    assert!(!f.recorder.has_pending_work());
    assert!(f.units.lock().unwrap().is_empty());
}

#[tokio::test]
async fn drop_buffered_typing_drops_minutes_and_sessions_of_the_keyboard() {
    let f = fixture();
    f.ingest(char_event("A", TS, "a")).await;
    f.ingest(char_event("B", TS, "b")).await;
    f.recorder.close_sessions_for_uid("A", |_| true);
    f.recorder.drop_buffered_typing("A", |ms| ms <= TS as f64);
    f.recorder.flush_now(true).await;
    assert!(!f.day_file("A").exists());
    assert!(f.day_file("B").exists());
    assert_eq!(f.clock.now_ms(), TS);
}

/// The state with `DAY` uploaded and reconciled for `uid`, written the way
/// the sync layer writes it.
fn record_upload(f: &Fixture, uid: &str) -> TypingSyncState {
    let key = format!("{uid}|{}", f.hash);
    f.recorder
        .analytics()
        .update_sync_state(&f.hash, |state| {
            state.uploaded = pipette_js_json::parse(&format!(r#"{{"{key}":["{DAY}"]}}"#)).unwrap();
            state.reconciled_at = pipette_js_json::parse(&format!(r#"{{"{key}":5}}"#)).unwrap();
            true
        })
        .unwrap();
    load_sync_state(f.dir.path()).unwrap()
}

#[tokio::test]
async fn a_flush_keeps_what_the_sync_layer_wrote_and_moves_only_last_synced_at() {
    let f = fixture();
    // Starts the analytics, which read the state once.
    f.ingest(char_event("A", TS, "a")).await;
    f.recorder.flush_now(true).await;
    let synced = record_upload(&f, "A");

    f.clock.set(TS + 1_000);
    f.ingest(char_event("A", TS + 1_000, "b")).await;
    f.recorder.flush_now(true).await;
    assert_eq!(f.count("SELECT keystrokes FROM typing_minute_stats"), 2);
    assert_eq!(
        load_sync_state(f.dir.path()).unwrap(),
        TypingSyncState { last_synced_at: (TS + 1_000) as f64, ..synced }
    );
}

#[tokio::test]
async fn a_flush_waits_for_an_update_of_the_state_and_keeps_its_change() {
    let f = fixture();
    f.ingest(char_event("A", TS, "a")).await;
    f.recorder.flush_now(true).await;

    let (analytics, hash) = (f.recorder.analytics().clone(), f.hash.clone());
    let (inside_tx, inside) = std_mpsc::channel();
    let (release, released) = std_mpsc::channel::<()>();
    let update = std::thread::spawn(move || {
        analytics.update_sync_state(&hash, |state| {
            inside_tx.send(()).unwrap();
            released.recv().unwrap();
            state.uploaded = pipette_js_json::parse(r#"{"A|h":["2026-04-14"]}"#).unwrap();
            true
        })
    });
    inside.recv().unwrap();

    f.clock.set(TS + 1_000);
    f.ingest(char_event("A", TS + 1_000, "b")).await;
    let flush = f.recorder.flush_now(true);
    tokio::pin!(flush);
    assert!(tokio::time::timeout(Duration::from_millis(50), &mut flush).await.is_err());
    release.send(()).unwrap();
    update.join().unwrap().unwrap();
    flush.await;

    let state = load_sync_state(f.dir.path()).unwrap();
    assert_eq!(state.uploaded, pipette_js_json::parse(r#"{"A|h":["2026-04-14"]}"#).unwrap());
    assert_eq!(state.last_synced_at, (TS + 1_000) as f64);
}

#[tokio::test]
async fn a_flush_over_a_state_that_cannot_be_read_writes_the_rows_and_leaves_the_file() {
    let f = fixture();
    f.ingest(char_event("A", TS, "a")).await;
    f.recorder.flush_now(true).await;
    let path = sync_state_path(f.dir.path());
    std::fs::write(&path, "{").unwrap();
    let units_before = f.units.lock().unwrap().len();

    f.ingest(char_event("A", TS + 500, "b")).await;
    f.recorder.flush_now(true).await;
    assert_eq!(f.count("SELECT keystrokes FROM typing_minute_stats"), 2);
    assert_eq!(f.units.lock().unwrap().len(), units_before + 1);
    // Nothing is reopened for a retry.
    assert!(!f.recorder.state().dirty);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{");
}
