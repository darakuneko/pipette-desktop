// SPDX-License-Identifier: GPL-2.0-or-later
//! The behaviors of the typing-analytics merges and the own-hash reconcile that
//! the recorded scenarios (ts_analytics_merge.rs) do not reach: the waits on
//! the flush chain and the store lock, concurrent writers of a deleted-ranges
//! file, refused unit names, a state of revision 1 and a state that cannot be
//! saved.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use common::{Harness, NoWaits};
use pipette_drive::DriveApi;
use pipette_drive::canonical::Listing;
use pipette_drive::client::DriveClient;
use pipette_drive::fake::InMemoryDrive;
use pipette_entry_store::FixedClock;
use pipette_js_json::{Value, parse};
use pipette_sync::merge::{MergeError, merge_analytics_unit};
use pipette_sync::typing_remote::reconcile_own_hash_typing_analytics;
use pipette_sync_format::drive_names::drive_file_name;
use pipette_sync_format::machine_hash;
use pipette_typing_analytics::deleted_ranges::{
    DeletedRangeEntry, read_applied_ids, read_deleted_ranges, union_deleted_ranges, update_deleted_ranges,
};
use pipette_typing_analytics::jsonl::deleted_ranges_applied_path;
use pipette_typing_analytics::sync_state::{load_sync_state, sync_state_path};
use pipette_typing_analytics_db::DeleteRange;
use tokio::sync::oneshot;

const MACHINE: &str = "machine";
const INSTALLATION_ID: &str = "0f1e2d3c-4b5a-4697-8877-665544332211";
const UID: &str = "kb1";
const REMOTE: &str = "remote-hash";
const NOW: i64 = 1_792_108_800_000;

fn own_hash() -> String {
    machine_hash(MACHINE, INSTALLATION_ID)
}

fn harness(root: &Path) -> Harness {
    std::fs::create_dir_all(root.join("local")).unwrap();
    std::fs::write(root.join("local/installation-id"), INSTALLATION_ID).unwrap();
    let state = pipette_typing_analytics::TypingSyncState::empty(&own_hash());
    pipette_typing_analytics::sync_state::save_sync_state(root, &state).unwrap();
    Harness::new(root, MACHINE, NOW)
}

fn ranges_unit(hash: &str) -> String {
    format!("keyboards/{UID}/devices/{hash}/deleted-ranges")
}

fn ranges_bundle(ids: &[&str]) -> Value {
    let entries: Vec<String> =
        ids.iter().map(|id| format!(r#"{{"id":"{id}","startMs":0,"endMs":50,"cutoffMs":100}}"#)).collect();
    let file = format!(r#"{{"version":1,"entries":[{}]}}"#, entries.join(","));
    let mut bundle = pipette_js_json::Object::new();
    bundle.insert(
        "files",
        Value::Object([("deleted-ranges.json", Value::from(file.as_str()))].into_iter().collect()),
    );
    Value::Object(bundle)
}

fn entry(id: &str) -> DeletedRangeEntry {
    DeletedRangeEntry { id: id.into(), range: DeleteRange { start_ms: 0, end_ms: 50, cutoff_ms: 100 } }
}

fn local_ids(root: &Path, hash: &str) -> Vec<String> {
    read_deleted_ranges(root, UID, hash)
        .unwrap()
        .iter()
        .map(|e| e.id.to_string_lossy().into_owned())
        .collect()
}

#[tokio::test]
async fn an_own_merge_returns_while_the_flush_chain_is_busy_and_applies_once_it_frees_up() {
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(dir.path());
    let (release, released) = oneshot::channel::<()>();
    let blocker = harness.ops.recorder().run_on_flush_chain(async move {
        released.await.unwrap();
    });
    let own = own_hash();
    let (env, unit, bundle) = (harness.env(), ranges_unit(&own), ranges_bundle(&["a"]));
    let merge = merge_analytics_unit(&env, &unit, &bundle, &own);
    let mut merged = tokio::time::timeout(Duration::from_secs(5), merge).await.unwrap().unwrap();
    let record = deleted_ranges_applied_path(dir.path(), UID, &own);
    assert!(!record.exists());
    release.send(()).unwrap();
    blocker.await;
    merged.own_apply.take().unwrap().await.unwrap();
    assert_eq!(read_applied_ids(&record).len(), 1);
}

#[tokio::test]
async fn a_merge_waits_for_a_holder_of_the_store_lock() {
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(dir.path());
    let locks = harness.ctx.shared_locks();
    let unit = ranges_unit(REMOTE);
    let (held_tx, held_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let holder = {
        let unit = unit.clone();
        std::thread::spawn(move || {
            locks.with_write_lock(&unit, || {
                held_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            });
        })
    };
    held_rx.recv().unwrap();
    let env = harness.env();
    let bundle = ranges_bundle(&["a"]);
    let merge = merge_analytics_unit(&env, &unit, &bundle, "own");
    tokio::pin!(merge);
    assert!(tokio::time::timeout(Duration::from_millis(50), &mut merge).await.is_err());
    release_tx.send(()).unwrap();
    holder.join().unwrap();
    let merged = tokio::time::timeout(Duration::from_secs(5), merge).await.unwrap().unwrap();
    assert!(!merged.remote_needs_update);
    assert_eq!(local_ids(dir.path(), REMOTE), ["a"]);
}

#[tokio::test]
async fn a_merge_and_a_local_update_both_keep_their_entries() {
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(dir.path());
    let (locks, root) = (harness.ctx.shared_locks(), dir.path().to_path_buf());
    let local = tokio::task::spawn_blocking(move || {
        update_deleted_ranges(&locks, &root, UID, REMOTE, |local| union_deleted_ranges(&local, &[entry("z")]))
    });
    let bundle = ranges_bundle(&["a"]);
    merge_analytics_unit(&harness.env(), &ranges_unit(REMOTE), &bundle, "own").await.unwrap();
    local.await.unwrap().unwrap();
    let mut ids = local_ids(dir.path(), REMOTE);
    ids.sort();
    assert_eq!(ids, ["a", "z"]);
}

#[tokio::test]
async fn unit_names_that_are_not_safe_paths_or_not_analytics_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let harness = harness(dir.path());
    let env = harness.env();
    let day = parse(r#"{"files":{"data.jsonl":"{}\n"}}"#).unwrap();
    for unit in ["keyboards/../devices/h/days/2026-10-14", "keyboards/kb1/devices/../days/2026-10-14"] {
        assert!(
            matches!(merge_analytics_unit(&env, unit, &day, "own").await, Err(MergeError::Malformed(_))),
            "{unit}"
        );
    }
    let unit = "keyboards/kb1/devices/../deleted-ranges";
    assert!(matches!(
        merge_analytics_unit(&env, unit, &ranges_bundle(&["a"]), "own").await,
        Err(MergeError::Malformed(_))
    ));
    assert!(!dir.path().join("sync").exists());
    assert!(matches!(
        merge_analytics_unit(&env, "favorites/macro", &day, "own").await,
        Err(MergeError::NotHandled(_))
    ));
}

fn day_name(uid: &str, day: &str) -> String {
    drive_file_name(&format!("keyboards/{uid}/devices/{}/days/{day}", own_hash()))
}

async fn drive_with(names: &[String]) -> (Arc<InMemoryDrive>, DriveClient, Listing) {
    let drive = Arc::new(InMemoryDrive::new());
    for name in names {
        drive.create(name.clone(), "{}".into()).await.unwrap();
    }
    let client = DriveClient::new(drive.clone(), Arc::new(NoWaits));
    let listing = Listing::new(client.list_files(None).await.unwrap());
    (drive, client, listing)
}

#[tokio::test]
async fn a_state_of_revision_1_reconciles_every_keyboard_as_pending() {
    let dir = tempfile::tempdir().unwrap();
    let state =
        format!(r#"{{"_rev":1,"my_device_id":"{}","read_pointers":{{}},"last_synced_at":3}}"#, own_hash());
    std::fs::create_dir_all(sync_state_path(dir.path()).parent().unwrap()).unwrap();
    std::fs::write(sync_state_path(dir.path()), state).unwrap();
    let (drive, client, listing) = drive_with(&[day_name(UID, "2026-10-14")]).await;
    let reconciled = reconcile_own_hash_typing_analytics(
        &client,
        &listing,
        dir.path(),
        &own_hash(),
        &FixedClock::new(NOW),
    )
    .await
    .unwrap();
    assert!(reconciled.mutated);
    assert!(drive.files().is_empty());
    let saved = load_sync_state(dir.path()).unwrap();
    let key = format!("{UID}|{}", own_hash());
    assert_eq!(saved.reconciled_at.as_object().unwrap().get(&key), Some(&Value::Number(NOW as f64)));
    assert_eq!(saved.last_synced_at, NOW as f64);
}

#[tokio::test]
async fn a_state_that_cannot_be_saved_fails_after_the_deletes() {
    let dir = tempfile::tempdir().unwrap();
    // A directory where the state file goes: it can be neither read nor
    // written.
    std::fs::create_dir_all(sync_state_path(dir.path())).unwrap();
    let (drive, client, listing) = drive_with(&[day_name(UID, "2026-10-14")]).await;
    let result = reconcile_own_hash_typing_analytics(
        &client,
        &listing,
        dir.path(),
        &own_hash(),
        &FixedClock::new(NOW),
    )
    .await;
    assert!(result.is_err());
    assert!(drive.files().is_empty());
}
