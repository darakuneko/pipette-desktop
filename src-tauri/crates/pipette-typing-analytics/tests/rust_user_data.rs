// SPDX-License-Identifier: GPL-2.0-or-later
//! Writes a userData tree with the typing analytics of this crate, the way
//! the app does (every announced unit goes to the pending store of
//! pipette-sync-pending), into
//! `src-tauri/target/tmp/pipette-typing-analytics/rust_user_data/`:
//!
//! - `user-data/`: the tree after recording two keyboards, a day file of
//!   another device applied as a sync download applies it, the deletes of
//!   the Data modal (local days, another device's days, everything of a
//!   keyboard), an export and its import, keymap snapshots and the quit;
//! - `answers.json`: the machine hash, the sync state, the deleted ranges,
//!   the units announced, the cache tables, and the answer of every query
//!   member call of tests/fixtures/queries.json and queries_tz/utc.json
//!   (their uids and hashes swapped for the ones recorded here), as JSON
//!   text, twice: on the cache the recording left (`live`) and on the
//!   cache a restart rebuilds from the files (`rebuilt`).
//!
//! `pnpm run verify:analytics-rust-user-data` then reads a copy of the
//! tree with the Electron build's code and compares its answers with
//! these, byte for byte.
//!
//! Runs in a child process with `TZ=UTC`, the zone the reading side runs
//! in.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{ManualTimer, array, field, fixture, table_rows, text};
use pipette_entry_store::{Clock, FixedClock, SequenceIds, WriteLocks};
use pipette_js_json::{Object, Value};
use pipette_sync_pending::{PendingStore, Scheduler};
use pipette_time::test_util::in_each_time_zone;
use pipette_typing_analytics::device_delete::DeviceDays;
use pipette_typing_analytics::fingerprint::OsInfo;
use pipette_typing_analytics::import_export::export_typing_data_for_keyboard;
use pipette_typing_analytics::keymap_snapshots::{
    save_snapshot_request, snapshot_for_range_request, snapshot_summaries_request,
};
use pipette_typing_analytics::queries::{Context, Query, local_device_days};
use pipette_typing_analytics::{
    DataOps, DeleteScope, MachineIdentity, Recorder, RecorderDeps, TypingAnalytics,
    rebuild_from_master_files, replay_day_hiding_deleted_ranges,
};
use pipette_typing_analytics_db::{DATA_TABLE_NAMES, DayRows};

/// Drops the delayed writes: the test writes the pending state once, at
/// the end, as the quit sequence does.
struct NoDelayedWrites;

impl Scheduler for NoDelayedWrites {
    fn schedule(&self, _delay: Duration, _task: Box<dyn FnOnce() + Send>) {}
}

fn out_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("pipette-typing-analytics").join("rust_user_data")
}

const MACHINE_ID: &str = "rust-user-data-machine";
const INSTALLATION_ID: &str = "4d1c2b3a-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const REMOTE_MACHINE_ID: &str = "rust-user-data-remote";
const REMOTE_INSTALLATION_ID: &str = "9a8b7c6d-5e4f-4321-8fed-cba987654321";
const OS: (&str, &str, &str) = ("linux", "6.8.0-rust", "x64");

const KB_A: (&str, f64, f64, &str) = ("0xAABB", 65261.0, 0.0, "Pipette Keyboard");
const KB_B: (&str, f64, f64, &str) = ("0xCCDD", 4660.0, 1.0, "Other \"60\" 日本");

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
/// 2026-10-15T00:00:00Z, the day of the query fixtures' windows.
const DAY: i64 = 1_792_022_400_000;

fn at(day_offset: i64, h: i64, m: i64) -> i64 {
    DAY + day_offset * 24 * HOUR + h * HOUR + m * MINUTE
}

/// A burst of typing on one keyboard: presses with their releases and the
/// characters they type, `count` keys from `start`.
struct Burst {
    keyboard: (&'static str, f64, f64, &'static str),
    start: i64,
    count: usize,
    /// The typing test and run the presses are tagged with.
    test: Option<(&'static str, &'static str)>,
}

const KEYCODES: [f64; 16] =
    [20.0, 26.0, 8.0, 21.0, 4.0, 22.0, 7.0, 9.0, 29.0, 27.0, 6.0, 25.0, 44.0, 0x7000 as f64, 13.0, 51.0];

fn keyboard_json(keyboard: (&str, f64, f64, &str)) -> String {
    let product_name = pipette_js_json::stringify(&Value::from(keyboard.3));
    format!(
        r#"{{"uid":"{}","vendorId":{},"productId":{},"productName":{product_name}}}"#,
        keyboard.0, keyboard.1, keyboard.2
    )
}

/// The events of a burst, by time.
fn burst_events(burst: &Burst) -> Vec<(i64, String)> {
    let keyboard = keyboard_json(burst.keyboard);
    let tags = match burst.test {
        Some((test, run)) => format!(r#","typingTest":"{test}","runId":"{run}""#),
        None => String::new(),
    };
    let mut events = Vec::new();
    for i in 0..burst.count as i64 {
        let ts = burst.start + i * 430 + (i * 37) % 90;
        let (row, col) = ((i * 7) % 4, (i * 3) % 4);
        let keycode = KEYCODES[(row * 4 + col) as usize];
        let layer = i64::from(i % 13 == 0);
        let action = match i % 9 {
            0 => r#","action":"tap""#,
            4 => r#","action":"hold""#,
            _ => "",
        };
        let overlap = if i % 4 == 0 { "true" } else { "false" };
        let gap = 8 + i % 5;
        events.push((
            ts,
            format!(
                r#"{{"kind":"matrix","row":{row},"col":{col},"layer":{layer},"keycode":{keycode},"ts":{ts},"keyboard":{keyboard},"overlap":{overlap},"pollGapMs":{gap}{action}{tags}}}"#
            ),
        ));
        let letter = char::from(b'a' + (i % 26) as u8);
        events.push((
            ts + 5,
            format!(r#"{{"kind":"char","key":"{letter}","ts":{},"keyboard":{keyboard}{tags}}}"#, ts + 5),
        ));
        let duration = 60 + (i * 11) % 80;
        events.push((
            ts + duration,
            format!(
                r#"{{"kind":"matrix-release","row":{row},"col":{col},"layer":{layer},"keycode":{keycode},"ts":{},"durationMs":{duration},"keyboard":{keyboard}{tags}}}"#,
                ts + duration
            ),
        ));
    }
    events.sort_by_key(|(ts, _)| *ts);
    events
}

struct Device {
    analytics: Arc<TypingAnalytics>,
    ops: Arc<DataOps>,
    timer: Arc<ManualTimer>,
    clock: Arc<FixedClock>,
    user_data: PathBuf,
}

fn ids(prefix: u32) -> Vec<String> {
    (0..400).map(|i| format!("{prefix:08x}-0000-4000-8000-{i:012}")).collect()
}

fn device(
    user_data: &Path,
    machine_id: &'static str,
    installation_id: &str,
    start: i64,
    notify: Arc<dyn Fn(&str) + Send + Sync>,
    id_prefix: u32,
) -> Device {
    let clock = Arc::new(FixedClock::new(start));
    let identity = MachineIdentity::new(
        user_data,
        Arc::new(SequenceIds::new([installation_id])),
        Box::new(move || Ok(machine_id.to_owned())),
    );
    let analytics = Arc::new(TypingAnalytics::new(
        user_data,
        identity,
        clock.clone(),
        rebuild_from_master_files(clock.clone()),
    ));
    let timer = Arc::new(ManualTimer::new(clock.clone()));
    let flushes = AtomicUsize::new(0);
    let apps = [Some("Code"), Some("Code"), Some("Slack"), None, Some("Firefox"), Some("Code")];
    let ids = Arc::new(SequenceIds::new(ids(id_prefix)));
    let deps = RecorderDeps {
        ids: ids.clone(),
        os: OsInfo { platform: OS.0.into(), release: OS.1.into(), arch: OS.2.into() },
        timer: timer.clone(),
        notify,
        app_name: Arc::new(move || apps[flushes.fetch_add(1, Ordering::SeqCst) % apps.len()].map(Into::into)),
    };
    let recorder = Recorder::new(analytics.clone(), deps, &tokio::runtime::Handle::current());
    let ops = Arc::new(DataOps::new(recorder, Arc::new(WriteLocks::new()), ids));
    Device { analytics, ops, timer, clock, user_data: user_data.to_path_buf() }
}

impl Device {
    /// Moves the clock to `ms`, running the flushes due by then.
    async fn advance_to(&self, ms: i64) {
        let now = self.clock.now_ms();
        if ms > now {
            self.timer.advance(ms - now);
        }
        self.ops.recorder().run_on_flush_chain(async {}).await;
    }

    async fn type_burst(&self, burst: &Burst) {
        for (ts, event) in burst_events(burst) {
            self.advance_to(ts).await;
            self.ops.recorder().ingest(&pipette_js_json::parse(&event).unwrap()).await.unwrap();
        }
        // The minutes close and the debounced flush writes them.
        self.advance_to(self.clock.now_ms() + 2 * MINUTE).await;
    }

    async fn quit(&self) {
        let recorder = self.ops.recorder();
        if recorder.has_pending_work() {
            recorder.flush_before_quit().await;
        }
        recorder.run_on_flush_chain(async {}).await;
    }

    fn machine_hash(&self) -> String {
        self.analytics.machine_hash().unwrap()
    }
}

/// Every day file under `dir`, by name.
fn day_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl"))
        .collect();
    files.sort();
    files
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &to.join(entry.file_name()));
        } else {
            std::fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
        }
    }
}

/// The query fixtures' uids and hashes in `value`, swapped for these.
fn swap_names(value: &Value, swaps: &[(&str, &str)]) -> Value {
    match value {
        Value::String(s) => match swaps.iter().find(|(from, _)| s.as_str() == Some(*from)) {
            Some((_, to)) => Value::from(*to),
            None => value.clone(),
        },
        Value::Array(items) => Value::Array(items.iter().map(|v| swap_names(v, swaps)).collect()),
        Value::Object(object) => Value::Object(
            object.iter().map(|(key, v)| (key.clone(), swap_names(v, swaps))).collect::<Object>(),
        ),
        other => other.clone(),
    }
}

/// The member calls (`{ member, args }`, args tagged as tagged.ts tags
/// them) with the keymap snapshot members added.
fn calls(swaps: &[(&str, &str)]) -> Vec<Value> {
    let mut calls: Vec<Value> = array(&fixture("queries.json"), "calls")
        .iter()
        .chain(array(&fixture("queries_tz/utc.json"), "calls"))
        .map(|call| {
            let object: Object =
                [("member", field(call, "member").clone()), ("args", swap_names(field(call, "args"), swaps))]
                    .into_iter()
                    .collect();
            Value::Object(object)
        })
        .collect();
    let keymap_calls = [
        ("typingAnalyticsListKeymapSnapshots", format!(r#"["{}"]"#, KB_A.0)),
        ("typingAnalyticsListKeymapSnapshots", format!(r#"["{}"]"#, KB_B.0)),
        ("typingAnalyticsListKeymapSnapshots", r#"[""]"#.to_owned()),
        (
            "typingAnalyticsGetKeymapSnapshotForRange",
            format!(r#"["{}",{},{}]"#, KB_A.0, at(0, 9, 30), at(0, 10, 30)),
        ),
        (
            "typingAnalyticsGetKeymapSnapshotForRange",
            format!(r#"["{}",{},{}]"#, KB_A.0, at(0, 8, 0), at(0, 8, 30)),
        ),
        (
            "typingAnalyticsGetKeymapSnapshotForRange",
            format!(r#"["{}",{},{}]"#, KB_A.0, at(0, 9, 0), at(0, 9, 0)),
        ),
        ("typingAnalyticsGetKeymapSnapshotForRange", format!(r#"["{}",0,"later"]"#, KB_A.0)),
    ];
    for (member, args) in keymap_calls {
        let object: Object =
            [("member", Value::from(member)), ("args", pipette_js_json::parse(&args).unwrap())]
                .into_iter()
                .collect();
        calls.push(Value::Object(object));
    }
    calls
}

/// Each call with its answer as JSON text, `null` when it failed.
async fn answer_calls(device: &Device, calls: &[Value]) -> Value {
    let ready = device.analytics.ready().await.unwrap();
    let (user_data, hash, calls) = (device.user_data.clone(), ready.machine_hash.clone(), calls.to_vec());
    let answered = ready
        .db
        .call(move |db| {
            let cx = Context {
                db,
                user_data: &user_data,
                own_hash: &hash,
                os_platform: OS.0,
                os_release: OS.1,
                recorder: None,
            };
            calls
                .iter()
                .map(|call| {
                    let member = text(call, "member");
                    let Some(Value::Array(args)) = common::untag(field(call, "args")) else { panic!("args") };
                    let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
                    let answer = match member {
                        "typingAnalyticsListLocalDeviceDays" => {
                            Ok(local_device_days(&user_data, &arg(0), &arg(1)))
                        }
                        "typingAnalyticsListKeymapSnapshots" => {
                            snapshot_summaries_request(&user_data, &arg(0), || Ok(hash.clone()))
                                .map_err(|err| err.to_string())
                        }
                        "typingAnalyticsGetKeymapSnapshotForRange" => {
                            snapshot_for_range_request(&user_data, &arg(0), &arg(1), &arg(2), || {
                                Ok(hash.clone())
                            })
                            .map_err(|err| err.to_string())
                        }
                        _ => Query::from_member(member)
                            .unwrap_or_else(|| panic!("no query for {member}"))
                            .answer(&args, &cx)
                            .map_err(|err| err.to_string()),
                    };
                    let mut out = call.as_object().unwrap().clone();
                    out.insert(
                        "response",
                        answer.map_or(Value::Null, |value| Value::from(pipette_js_json::stringify(&value))),
                    );
                    Value::Object(out)
                })
                .collect::<Vec<_>>()
        })
        .await
        .unwrap();
    Value::Array(answered)
}

/// Every data table of the cache at `user_data`, in the canonical text of
/// canonical.ts. The write-ahead log is folded into the file first, so the
/// file alone holds the cache.
fn tables(user_data: &Path) -> Value {
    let conn = rusqlite::Connection::open(user_data.join("local/typing-analytics.db")).unwrap();
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(())).unwrap();
    let tables: Object = DATA_TABLE_NAMES
        .iter()
        .map(|table| (*table, Value::Array(table_rows(&conn, table).into_iter().map(Value::from).collect())))
        .collect();
    Value::Object(tables)
}

fn read_text(path: &Path) -> Value {
    std::fs::read_to_string(path).map_or(Value::Null, Value::from)
}

#[test]
fn writes_a_user_data_tree_for_the_typescript_code() {
    if in_each_time_zone("writes_a_user_data_tree_for_the_typescript_code", &["UTC"]).is_none() {
        return;
    }
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(write_tree());
}

async fn write_tree() {
    let out = out_dir();
    let _ = std::fs::remove_dir_all(&out);
    let user_data = out.join("user-data");
    let scratch = tempfile::tempdir().unwrap();

    // Another device's recording, on its own userData.
    let remote_dir = scratch.path().join("remote");
    let remote =
        device(&remote_dir, REMOTE_MACHINE_ID, REMOTE_INSTALLATION_ID, at(-1, 11, 0), Arc::new(|_| {}), 2);
    let remote_bursts = [
        Burst { keyboard: KB_A, start: at(-1, 12, 0), count: 200, test: None },
        Burst { keyboard: KB_A, start: at(0, 10, 1), count: 220, test: Some(("words (english)", "run-1")) },
        Burst { keyboard: KB_B, start: at(0, 10, 3), count: 100, test: None },
        Burst { keyboard: KB_A, start: at(1, 7, 0), count: 100, test: None },
    ];
    for burst in &remote_bursts {
        remote.type_burst(burst).await;
    }
    remote.quit().await;
    let remote_hash = remote.machine_hash();

    // This device.
    std::fs::create_dir_all(&user_data).unwrap();
    let pending = PendingStore::restore(&user_data, Arc::new(NoDelayedWrites), Box::new(|_| {}));
    let notified = Arc::new(Mutex::new(Vec::<String>::new()));
    let notify: Arc<dyn Fn(&str) + Send + Sync> = {
        let (pending, notified) = (pending.clone(), notified.clone());
        Arc::new(move |unit| {
            notified.lock().unwrap().push(unit.to_owned());
            pending.notify_change(unit);
        })
    };
    let own = device(&user_data, MACHINE_ID, INSTALLATION_ID, at(-1, 23, 0), notify, 1);
    let own_hash = own.machine_hash();
    for burst in [
        Burst { keyboard: KB_A, start: at(-1, 23, 50), count: 300, test: None },
        Burst { keyboard: KB_A, start: at(0, 9, 58), count: 400, test: None },
        Burst { keyboard: KB_B, start: at(0, 10, 0), count: 200, test: None },
        Burst { keyboard: KB_A, start: at(0, 10, 4), count: 120, test: Some(("words (english)", "run-1")) },
        Burst { keyboard: KB_A, start: at(0, 10, 30), count: 200, test: None },
    ] {
        own.type_burst(&burst).await;
    }

    // Keymap snapshots of keyboard A, one before the Analyze window and one
    // in it.
    for (saved_at, swap) in [(at(0, 9, 0), false), (at(0, 10, 2), true)] {
        let mut keys = Vec::new();
        for row in 0..4 {
            for col in 0..4 {
                keys.push(format!(
                    r#"{{"x":{},"y":{row},"width":1,"height":1,"row":{row},"col":{col}}}"#,
                    f64::from(col) + if row == 3 { 0.5 } else { 0.0 }
                ));
            }
        }
        let first_row =
            if swap { r#"["KC_Q","KC_A","KC_W","KC_E"]"# } else { r#"["KC_Q","KC_W","KC_E","KC_R"]"# };
        let request = format!(
            r#"{{"uid":"{}","productName":"Alpha","savedAt":{saved_at},"layers":2,"matrix":{{"rows":4,"cols":4}},"keymap":[[{first_row},["KC_A","KC_S","KC_D","KC_F"],["KC_Z","KC_X","KC_C","KC_V"],["KC_NO","MO(1)","KC_SPACE","LSFT(KC_F)"]],[["KC_1"]]],"layout":{{"keys":[{}]}},"vialProtocol":6}}"#,
            KB_A.0,
            keys.join(",")
        );
        let saved = save_snapshot_request(
            &user_data,
            &pipette_js_json::parse(&request).unwrap(),
            || Ok(own_hash.clone()),
            own.clock.now_ms(),
        );
        assert!(saved.saved);
    }

    // Delete All of keyboard B, then more typing on it.
    own.advance_to(at(0, 20, 0)).await;
    own.ops.delete_all_for_keyboard(KB_B.0, own.clock.now_ms(), DeleteScope::Own).await.unwrap();
    own.type_burst(&Burst {
        keyboard: KB_A,
        start: at(1, 8, 0),
        count: 150,
        test: Some(("novel.txt", "run-2")),
    })
    .await;
    own.type_burst(&Burst { keyboard: KB_B, start: at(1, 9, 0), count: 100, test: None }).await;

    // The other device's day files arrive and are applied as a sync
    // download applies them.
    own.advance_to(at(1, 10, 0)).await;
    let ready = own.analytics.ready().await.unwrap();
    for uid in [KB_A.0, KB_B.0] {
        let from = remote_dir.join(format!("sync/keyboards/{uid}/devices/{remote_hash}"));
        let to = user_data.join(format!("sync/keyboards/{uid}/devices/{remote_hash}"));
        std::fs::create_dir_all(&to).unwrap();
        for file in day_files(&from) {
            let target = to.join(file.file_name().unwrap());
            std::fs::copy(&file, &target).unwrap();
            let rows = DayRows::parse(&std::fs::read_to_string(&target).unwrap());
            let (uid, hash, own_hash, clock) =
                (uid.to_owned(), remote_hash.clone(), own_hash.clone(), own.clock.clone());
            ready
                .db
                .call(move |db| {
                    replay_day_hiding_deleted_ranges(
                        db,
                        &rows,
                        &uid,
                        &hash,
                        &own_hash,
                        clock.as_ref(),
                        Vec::new,
                    )
                })
                .await
                .unwrap()
                .unwrap();
        }
    }
    drop(ready);

    // The deletes of the Data modal: the other device's first day, then a
    // local day of this device.
    own.ops
        .delete_device_data(
            KB_A.0,
            &remote_hash,
            DeviceDays::Local(vec!["2026-10-14".into()]),
            own.clock.now_ms(),
        )
        .await
        .unwrap();
    own.advance_to(at(1, 10, 5)).await;
    own.ops.delete_local_days(KB_A.0, &["2026-10-14".to_owned()], own.clock.now_ms()).await.unwrap();

    // An export of a past day of keyboard A and its import back.
    own.advance_to(at(1, 10, 10)).await;
    let exports = scratch.path().join("exports");
    let days: HashSet<String> = ["2026-10-15".to_owned()].into_iter().collect();
    assert_eq!(export_typing_data_for_keyboard(&user_data, KB_A.0, &own_hash, &exports, &days).unwrap(), 1);
    let exported = std::fs::read_dir(&exports).unwrap().map(|entry| entry.unwrap().path()).collect();
    own.ops.import_typing_files(exported, None).await.unwrap();

    // Typing up to the quit, the last minute still open.
    let last = Burst { keyboard: KB_A, start: at(1, 11, 0), count: 40, test: None };
    for (ts, event) in burst_events(&last) {
        own.advance_to(ts).await;
        own.ops.recorder().ingest(&pipette_js_json::parse(&event).unwrap()).await.unwrap();
    }
    own.quit().await;
    pending.persist_now();

    let swaps = [
        ("uid-a", KB_A.0),
        ("uid-b", KB_B.0),
        ("hash-own", own_hash.as_str()),
        ("hash-remote", remote_hash.as_str()),
    ];
    let calls = calls(&swaps);
    let mut answers = Object::new();
    answers.insert("machineId", MACHINE_ID.into());
    answers.insert("machineHash", own_hash.as_str().into());
    answers.insert("remoteHash", remote_hash.as_str().into());
    answers.insert(
        "os",
        Value::Object(
            [("platform", OS.0), ("release", OS.1), ("arch", OS.2)]
                .into_iter()
                .map(|(k, v)| (k, Value::from(v)))
                .collect(),
        ),
    );
    answers.insert("clock", Value::Number(own.clock.now_ms() as f64));
    answers.insert("syncState", read_text(&user_data.join("local/typing-analytics/sync_state.json")));
    let mut ranges = Object::new();
    for (uid, hash) in [(KB_A.0, remote_hash.as_str()), (KB_B.0, own_hash.as_str())] {
        let dir = format!("sync/keyboards/{uid}/devices/{hash}");
        ranges.insert(dir.as_str(), read_text(&user_data.join(&dir).join("deleted-ranges.json")));
    }
    answers.insert("deletedRanges", Value::Object(ranges));
    answers.insert("live", answer_calls(&own, &calls).await);
    answers.insert("liveTables", tables(&user_data));
    let mut units: Vec<String> = Vec::new();
    for unit in notified.lock().unwrap().iter() {
        if !units.contains(unit) {
            units.push(unit.clone());
        }
    }
    answers.insert("pendingUnits", Value::Array(units.into_iter().map(Value::from).collect()));

    // A restart that rebuilds the cache from the files: no state file, no
    // cache, then this device's own deleted ranges applied.
    let restart_dir = scratch.path().join("restart");
    copy_dir(&user_data, &restart_dir);
    std::fs::remove_file(restart_dir.join("local/typing-analytics/sync_state.json")).unwrap();
    for name in ["typing-analytics.db", "typing-analytics.db-wal", "typing-analytics.db-shm"] {
        let _ = std::fs::remove_file(restart_dir.join("local").join(name));
    }
    let restarted =
        device(&restart_dir, MACHINE_ID, INSTALLATION_ID, own.clock.now_ms(), Arc::new(|_| {}), 3);
    restarted.ops.apply_own_deleted_ranges_for_all_keyboards(Arc::new(|_| false)).await;
    restarted.ops.recorder().run_on_flush_chain(async {}).await;
    answers.insert("rebuilt", answer_calls(&restarted, &calls).await);
    answers.insert("rebuiltTables", tables(&restart_dir));

    std::fs::create_dir_all(&out).unwrap();
    std::fs::write(out.join("answers.json"), pipette_js_json::stringify(&Value::Object(answers))).unwrap();
}
