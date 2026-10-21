// SPDX-License-Identifier: GPL-2.0-or-later
//! The data operations' behaviors the recorded scenarios (ts_data_ops.rs)
//! do not reach: the cache rebuild
//! from scratch and of an old schema, the apply of this device's own
//! deleted ranges while a reset holds the keyboard or a day file cannot be
//! read, and the startup hook.

#![allow(clippy::unwrap_used)]

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use common::{ManualTimer, table_rows};
use pipette_entry_store::{Clock, FixedClock, RandomUuid, SequenceIds, WriteLocks};
use pipette_typing_analytics::cache_rebuild::rebuild_cache_from_master_files;
use pipette_typing_analytics::db_actor::db_path;
use pipette_typing_analytics::deleted_ranges::DeletedRangeEntry;
use pipette_typing_analytics::fingerprint::OsInfo;
use pipette_typing_analytics::jsonl::{deleted_ranges_applied_path, device_day_jsonl_path};
use pipette_typing_analytics::{
    DataOps, MachineIdentity, Recorder, RecorderDeps, TypingAnalytics, rebuild_from_master_files,
};
use pipette_typing_analytics_db::{DATA_TABLE_NAMES, DeleteRange, SCHEMA_VERSION, TypingAnalyticsDb};
use tempfile::TempDir;

const UID: &str = "0xAABB";
const INSTALLATION_ID: &str = "0f1e2d3c-4b5a-4697-8877-665544332211";
const DAY: &str = "2026-04-14";
/// 2026-04-14 12:00 UTC.
const T: i64 = 1_776_168_000_000;
const MINUTE: i64 = 60_000;

fn own_hash() -> String {
    pipette_sync_format::machine_hash("machine", INSTALLATION_ID)
}

/// A day file of `hash` with a minute-stats row at each of `minutes`.
fn day_text(hash: &str, minutes: &[i64]) -> String {
    let mut text = format!(
        r#"{{"id":"s","kind":"scope","updated_at":1,"payload":{{"id":"sc-{hash}","machineHash":"{hash}","osPlatform":"linux","osRelease":"6.8.0","osArch":"x64","keyboardUid":"{UID}","keyboardVendorId":1,"keyboardProductId":2,"keyboardProductName":"K"}}}}"#
    );
    text.push('\n');
    for minute in minutes {
        text.push_str(&format!(
            r#"{{"id":"m{minute}","kind":"minute-stats","updated_at":1,"payload":{{"scopeId":"sc-{hash}","minuteTs":{minute},"keystrokes":3,"activeMs":1,"intervalAvgMs":null,"intervalMinMs":null,"intervalP25Ms":null,"intervalP50Ms":null,"intervalP75Ms":null,"intervalMaxMs":null}}}}"#
        ));
        text.push('\n');
    }
    text
}

fn write_day(user_data: &Path, hash: &str, minutes: &[i64]) -> PathBuf {
    let path = device_day_jsonl_path(user_data, UID, hash, DAY);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, day_text(hash, minutes)).unwrap();
    path
}

fn analytics(user_data: &Path, clock: Arc<FixedClock>) -> Arc<TypingAnalytics> {
    let identity = MachineIdentity::new(
        user_data,
        Arc::new(SequenceIds::new([INSTALLATION_ID])),
        Box::new(|| Ok("machine".into())),
    );
    Arc::new(TypingAnalytics::new(user_data, identity, clock.clone(), rebuild_from_master_files(clock)))
}

fn ops(analytics: Arc<TypingAnalytics>, clock: Arc<FixedClock>) -> Arc<DataOps> {
    let deps = RecorderDeps {
        ids: Arc::new(RandomUuid),
        os: OsInfo { platform: "linux".into(), release: "6.8.0".into(), arch: "x64".into() },
        timer: Arc::new(ManualTimer::new(clock)),
        notify: Arc::new(|_| {}),
        app_name: Arc::new(|| None),
    };
    let recorder = Recorder::new(analytics, deps, &tokio::runtime::Handle::current());
    Arc::new(DataOps::new(recorder, Arc::new(WriteLocks::new()), Arc::new(RandomUuid)))
}

fn live_minutes(user_data: &Path) -> i64 {
    rusqlite::Connection::open(db_path(user_data))
        .unwrap()
        .query_row("SELECT COUNT(*) FROM typing_minute_stats WHERE is_deleted = 0", [], |r| r.get(0))
        .unwrap()
}

#[tokio::test]
async fn a_rebuild_starts_from_a_clean_slate_and_needs_no_sync_tree() {
    let dir = TempDir::new().unwrap();
    let clock = Arc::new(FixedClock::new(T));
    let ready = analytics(dir.path(), clock.clone()).ready().await.unwrap();
    let rebuild = |ready: Arc<pipette_typing_analytics::Ready>| {
        let (user_data, clock): (PathBuf, Arc<dyn Clock>) = (dir.path().to_path_buf(), clock.clone());
        tokio::task::spawn_blocking(move || {
            rebuild_cache_from_master_files(&ready.db, &user_data, &ready.machine_hash, &clock).unwrap()
        })
    };
    let empty = rebuild(ready.clone()).await.unwrap();
    assert_eq!(empty.jsonl_files_read, 0);

    write_day(dir.path(), &own_hash(), &[T, T + MINUTE]);
    let first = rebuild(ready.clone()).await.unwrap();
    let tables = |path: &Path| {
        let conn = rusqlite::Connection::open(db_path(path)).unwrap();
        DATA_TABLE_NAMES.iter().map(|table| table_rows(&conn, table)).collect::<Vec<_>>()
    };
    let rows = tables(dir.path());
    let second = rebuild(ready).await.unwrap();
    assert_eq!(first, second);
    assert_eq!(first.rows.minute_stats, 2);
    assert_eq!(tables(dir.path()), rows);
}

#[tokio::test]
async fn a_launch_on_an_old_schema_rebuilds_inside_the_migration() {
    let dir = TempDir::new().unwrap();
    write_day(dir.path(), &own_hash(), &[T, T + MINUTE, T + 2 * MINUTE]);
    // A cache of the schema before the v6 migration, which drops tables,
    // with an up-to-date sync state: only the migration asks for a rebuild.
    std::fs::create_dir_all(dir.path().join("local")).unwrap();
    drop(TypingAnalyticsDb::open(&db_path(dir.path())).unwrap());
    rusqlite::Connection::open(db_path(dir.path()))
        .unwrap()
        .execute("UPDATE typing_analytics_meta SET value = '5' WHERE key = 'schema_version'", [])
        .unwrap();
    std::fs::write(dir.path().join("local/installation-id"), format!("{INSTALLATION_ID}\n")).unwrap();
    let state = pipette_typing_analytics::TypingSyncState::empty(&own_hash());
    pipette_typing_analytics::sync_state::save_sync_state(dir.path(), &state).unwrap();

    let clock = Arc::new(FixedClock::new(T));
    let ready = analytics(dir.path(), clock).ready().await.unwrap();
    drop(ready);
    let synced = pipette_typing_analytics::sync_state::load_sync_state(dir.path()).unwrap();
    assert_eq!(synced.last_synced_at, T as f64);
    assert_eq!(live_minutes(dir.path()), 3);
    let version: String = rusqlite::Connection::open(db_path(dir.path()))
        .unwrap()
        .query_row("SELECT value FROM typing_analytics_meta WHERE key = 'schema_version'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION.to_string());
}

fn range(id: &str, start_ms: i64, end_ms: i64) -> DeletedRangeEntry {
    DeletedRangeEntry { id: id.into(), range: DeleteRange { start_ms, end_ms, cutoff_ms: end_ms } }
}

#[tokio::test]
async fn nothing_is_applied_while_a_reset_holds_the_keyboard_even_from_the_queue() {
    let dir = TempDir::new().unwrap();
    let clock = Arc::new(FixedClock::new(T + 10 * MINUTE));
    let day = write_day(dir.path(), &own_hash(), &[T, T + MINUTE]);
    let analytics = analytics(dir.path(), clock.clone());
    analytics.ready().await.unwrap();
    let before = std::fs::read(&day).unwrap();
    let ops = ops(analytics, clock);

    let holds = Arc::new(AtomicBool::new(true));
    let held = holds.clone();
    let reset = Arc::new(move |_: &str| held.load(Ordering::SeqCst));
    ops.apply_own_deleted_ranges(UID, vec![range("a", T, T + MINUTE)], reset.clone()).await.unwrap();

    // Free when queued, held when the task starts.
    holds.store(false, Ordering::SeqCst);
    let (release, released) = tokio::sync::oneshot::channel::<()>();
    let blocker = ops.recorder().run_on_flush_chain(async move {
        let _ = released.await;
    });
    let apply = {
        let ops = ops.clone();
        tokio::spawn(async move {
            ops.apply_own_deleted_ranges(UID, vec![range("a", T, T + MINUTE)], reset).await
        })
    };
    tokio::task::yield_now().await;
    holds.store(true, Ordering::SeqCst);
    release.send(()).unwrap();
    blocker.await;
    apply.await.unwrap().unwrap();

    assert_eq!(std::fs::read(&day).unwrap(), before);
    assert!(!deleted_ranges_applied_path(dir.path(), UID, &own_hash()).exists());
}

#[cfg(unix)]
#[tokio::test]
async fn a_failed_apply_records_nothing_and_the_next_one_applies() {
    use std::os::unix::fs::PermissionsExt;

    use pipette_typing_analytics::deleted_ranges::read_applied_ids;

    let dir = TempDir::new().unwrap();
    let clock = Arc::new(FixedClock::new(T + 10 * MINUTE));
    let day = write_day(dir.path(), &own_hash(), &[T, T + MINUTE]);
    let analytics = analytics(dir.path(), clock.clone());
    analytics.ready().await.unwrap();
    let ops = ops(analytics, clock);
    let never = Arc::new(|_: &str| false);
    let entries = vec![range("a", T, T + MINUTE)];
    let applied = deleted_ranges_applied_path(dir.path(), UID, &own_hash());

    std::fs::set_permissions(&day, std::fs::Permissions::from_mode(0o000)).unwrap();
    let unreadable = std::fs::File::open(&day).is_err();
    let failed = ops.apply_own_deleted_ranges(UID, entries.clone(), never.clone()).await;
    std::fs::set_permissions(&day, std::fs::Permissions::from_mode(0o644)).unwrap();
    // A process that may read any file (root) cannot fail this way.
    if unreadable {
        assert!(failed.is_err());
        assert!(!applied.exists());
    }

    ops.apply_own_deleted_ranges(UID, entries.clone(), never.clone()).await.unwrap();
    assert_eq!(read_applied_ids(&applied).len(), 1);
    assert_eq!(live_minutes(dir.path()), 1);
    let written = std::fs::read(&day).unwrap();
    ops.apply_own_deleted_ranges(UID, entries, never).await.unwrap();
    assert_eq!(std::fs::read(&day).unwrap(), written);
}

#[tokio::test]
async fn the_initialized_hook_runs_after_each_initialization_that_succeeds() {
    let dir = TempDir::new().unwrap();
    std::fs::create_dir_all(db_path(dir.path())).unwrap();
    let analytics = analytics(dir.path(), Arc::new(FixedClock::new(T)));
    let runs = Arc::new(AtomicUsize::new(0));
    let counted = runs.clone();
    analytics.on_initialized(Box::new(move || {
        counted.fetch_add(1, Ordering::SeqCst);
    }));
    assert!(analytics.ready().await.is_err());
    assert_eq!(runs.load(Ordering::SeqCst), 0);
    std::fs::remove_dir(db_path(dir.path())).unwrap();
    analytics.ready().await.unwrap();
    analytics.ready().await.unwrap();
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}
