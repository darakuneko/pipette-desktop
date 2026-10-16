// SPDX-License-Identifier: GPL-2.0-or-later
//! The Analyze sync (`AnalyticsSync`) and the lazy fetch of another
//! device's day (`RemoteTyping`) on the in-memory Drive: the
//! `executeAnalyticsSync` and `fetchRemoteTypingDay` cases of
//! src/main/__tests__/sync-service.test.ts. Neither takes the sync lock:
//! what keeps them from a reset, a password change and a switch of
//! accounts, and what they share with a pass (the locks of a unit and the
//! files remembered as created).

#![allow(clippy::unwrap_used, clippy::panic)]

mod execute_harness;
mod preflight_harness;

use std::time::Duration;

use execute_harness::{Options, World, write};
use pipette_drive::fake::DriveOp;
use pipette_sync::analytics::{AnalyticsSync, AnalyticsSyncDeps};
use pipette_sync::execute::SyncExecuteResult;
use pipette_sync::scope::SyncScope;
use pipette_sync::typing_remote::RemoteTyping;
use pipette_sync_format::drive_names::drive_file_name;
use pipette_typing_analytics::ResetKeyboards;

const UID: &str = "0xDEAD";
const REMOTE: &str = "remote-hash";
const DAY: &str = "2026-04-18";

struct Entry {
    world: World,
    analytics: AnalyticsSync,
    remote: RemoteTyping,
}

async fn entry_with(options: Options, seed: impl FnOnce(&std::path::Path)) -> Entry {
    let world = World::with(options, seed).await;
    let analytics = AnalyticsSync::new(AnalyticsSyncDeps {
        preflight: world.preflight.clone(),
        units: world.units.clone(),
        hooks: world.hooks.clone(),
    });
    let remote = RemoteTyping::new(world.preflight.clone(), world.units.clone());
    world.requests();
    Entry { world, analytics, remote }
}

async fn entry() -> Entry {
    entry_with(Options::default(), |_| {}).await
}

fn uids(uids: &[&str]) -> ResetKeyboards {
    ResetKeyboards::Uids(uids.iter().map(|uid| (*uid).to_owned()).collect())
}

fn day_unit(hash: &str, day: &str) -> String {
    format!("keyboards/{UID}/devices/{hash}/days/{day}")
}

fn ranges_unit(hash: &str) -> String {
    format!("keyboards/{UID}/devices/{hash}/deleted-ranges")
}

/// A day file of `hash` with one scope row for [`UID`].
fn day_text(hash: &str) -> String {
    let scope = format!("{hash}|linux|{UID}");
    serde_json::json!({
        "id": format!("scope|{scope}"), "kind": "scope", "updated_at": 1000,
        "payload": {
            "id": scope, "machineHash": hash, "osPlatform": "linux", "osRelease": "6.8.0", "osArch": "x64",
            "keyboardUid": UID, "keyboardVendorId": 1, "keyboardProductId": 2, "keyboardProductName": "Pipette",
        },
    })
    .to_string()
        + "\n"
}

fn day_bundle(hash: &str, day: &str) -> String {
    serde_json::json!({
        "type": "typing-analytics-device", "key": format!("{UID}|{hash}|{day}"),
        "index": { "uid": UID, "entries": [] }, "files": { "data.jsonl": day_text(hash) },
    })
    .to_string()
}

fn ranges_bundle(hash: &str, ids: &[&str]) -> String {
    let entries: Vec<_> = ids
        .iter()
        .map(|id| serde_json::json!({ "id": id, "startMs": 0, "endMs": 60_000, "cutoffMs": 60_000 }))
        .collect();
    let file = serde_json::json!({ "version": 1, "entries": entries }).to_string();
    serde_json::json!({
        "type": "typing-deleted-ranges", "key": format!("{UID}|{hash}"),
        "index": { "uid": UID, "entries": [] }, "files": { "deleted-ranges.json": file },
    })
    .to_string()
}

/// The ids downloaded, the password-check's left out.
fn downloads(requests: &[String], world: &World) -> Vec<String> {
    let checks: Vec<String> = world
        .drive
        .inner
        .files()
        .into_iter()
        .filter(|f| f.file.name == "password-check.enc")
        .map(|f| f.file.id)
        .collect();
    requests
        .iter()
        .filter_map(|r| r.strip_prefix("download:"))
        .filter(|id| !checks.iter().any(|c| c == id))
        .map(str::to_owned)
        .collect()
}

async fn until_held(world: &World) {
    while world.drive.held() == 0 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

// --- What keeps them from starting ---

#[tokio::test]
async fn neither_starts_for_a_keyboard_a_reset_holds() {
    let e = entry().await;
    let runtime = e.world.runtime().clone();
    let checked = runtime
        .with_reset_lock(&uids(&[UID]), "busy", async {
            assert!(!e.analytics.execute_analytics_sync(UID).await);
            assert!(!e.remote.fetch_remote_typing_day(UID, REMOTE, DAY).await.unwrap());
            assert!(e.world.requests().is_empty());
            // Another keyboard's run.
            assert!(e.analytics.execute_analytics_sync("0xBEEF").await);
            assert!(!e.remote.fetch_remote_typing_day("0xBEEF", REMOTE, DAY).await.unwrap());
            assert!(!e.world.requests().is_empty());
        })
        .await;
    assert!(checked.is_ok());

    let checked = runtime
        .with_reset_lock(&ResetKeyboards::All, "busy", async {
            assert!(!e.analytics.execute_analytics_sync("0xBEEF").await);
            assert!(e.world.requests().is_empty());
        })
        .await;
    assert!(checked.is_ok());
    assert!(!runtime.lock_free_writer_running(&ResetKeyboards::All));
}

#[tokio::test]
async fn neither_starts_while_a_password_change_or_a_switch_of_accounts_runs() {
    let e = entry().await;
    let runtime = e.world.runtime().clone();
    let change = runtime.try_start_password_change().unwrap();
    assert!(!e.remote.fetch_remote_typing_day(UID, REMOTE, DAY).await.unwrap());
    assert!(!e.analytics.execute_analytics_sync(UID).await);
    drop(change);

    let switch = runtime.try_begin_account_switch().unwrap();
    assert!(!e.analytics.execute_analytics_sync(UID).await);
    assert!(!e.remote.fetch_remote_typing_day(UID, REMOTE, DAY).await.unwrap());
    drop(switch);
    assert!(e.world.requests().is_empty());
    assert!(!runtime.lock_free_writer_running(&ResetKeyboards::All));
}

#[tokio::test]
async fn a_second_analytics_sync_of_a_keyboard_does_not_start_while_one_runs() {
    let e = entry().await;
    e.world.drive.hold(DriveOp::List, None);
    let first = e.analytics.execute_analytics_sync(UID);
    let second = async {
        until_held(&e.world).await;
        let second = e.analytics.execute_analytics_sync(UID);
        let other = e.analytics.execute_analytics_sync("0xBEEF");
        let refused = second.await;
        e.world.drive.open_gate();
        (refused, other.await)
    };
    let (first, (second, other)) = tokio::join!(first, second);
    assert!(first);
    assert!(!second);
    assert!(other);
}

#[tokio::test]
async fn an_analytics_sync_runs_while_a_pass_holds_the_sync_lock() {
    let e = entry().await;
    let flush = e.world.runtime().try_claim_sync_lock(false).unwrap();
    assert!(e.analytics.execute_analytics_sync(UID).await);
    drop(flush);
}

#[tokio::test]
async fn a_reset_of_its_keyboard_is_refused_while_a_fetch_waits_on_drive() {
    let e = entry().await;
    let runtime = e.world.runtime().clone();
    e.world.drive.hold(DriveOp::List, Some(None));
    let fetch = e.remote.fetch_remote_typing_day(UID, REMOTE, DAY);
    let resets = async {
        until_held(&e.world).await;
        let refused = runtime.with_reset_lock(&uids(&[UID]), "busy", async {}).await.is_err();
        let all_refused = runtime.with_reset_lock(&ResetKeyboards::All, "busy", async {}).await.is_err();
        let other = runtime.with_reset_lock(&uids(&["0xBEEF"]), "busy", async {}).await.is_ok();
        e.world.drive.open_gate();
        (refused, all_refused, other)
    };
    let (fetched, (refused, all_refused, other)) = tokio::join!(fetch, resets);
    assert!(!fetched.unwrap(), "Drive has no such day");
    assert!(refused && all_refused && other);
    assert!(!runtime.lock_free_writer_running(&ResetKeyboards::All));
}

#[tokio::test]
async fn a_fetch_whose_listing_fails_is_no_longer_counted() {
    let e = entry().await;
    e.world.drive.fail_next(DriveOp::List);
    let err = e.remote.fetch_remote_typing_day(UID, REMOTE, DAY).await.unwrap_err();
    assert!(err.to_string().starts_with("Drive list failed: 400"), "{err}");
    assert!(!e.world.runtime().lock_free_writer_running(&ResetKeyboards::All));
}

// --- The Analyze sync ---

#[tokio::test]
async fn an_own_day_on_drive_is_uploaded_once_in_place_and_never_downloaded() {
    let e = entry_with(Options::default(), |_| {}).await;
    let own = e.world.own_hash();
    write(&e.world.root, &format!("sync/keyboards/{UID}/devices/{own}/{DAY}.jsonl"), &day_text(&own));
    let seeded = e.world.seed_unit(&day_unit(&own, DAY), "{}").await;
    e.world.requests();

    assert!(e.analytics.execute_analytics_sync(UID).await);

    let requests = e.world.requests();
    assert_eq!(
        requests.iter().filter(|r| r.starts_with("update:") || r.starts_with("create:")).collect::<Vec<_>>(),
        [&format!("update:{}", seeded.id)]
    );
    assert!(downloads(&requests, &e.world).is_empty(), "{requests:?}");
}

#[tokio::test]
async fn a_duplicated_remote_day_is_merged_once_from_the_newest_copy() {
    let e = entry().await;
    let unit = day_unit(REMOTE, DAY);
    e.world.seed_unit(&unit, &day_bundle(REMOTE, DAY)).await;
    let newer = e.world.seed_unit(&unit, &day_bundle(REMOTE, DAY)).await;
    e.world.requests();

    assert!(e.analytics.execute_analytics_sync(UID).await);

    assert_eq!(downloads(&e.world.requests(), &e.world), [newer.id]);
    assert!(e.world.read(&format!("sync/keyboards/{UID}/devices/{REMOTE}/{DAY}.jsonl")).is_some());
}

#[tokio::test]
async fn it_merges_another_devices_ranges_and_uploads_a_local_ranges_file() {
    let e = entry_with(Options::default(), |root| {
        let file = r#"{"version":1,"entries":[{"id":"r2","startMs":0,"endMs":60000,"cutoffMs":60000}]}"#;
        write(root, &format!("sync/keyboards/{UID}/devices/third-hash/deleted-ranges.json"), file);
    })
    .await;
    e.world.seed_unit(&ranges_unit(REMOTE), &ranges_bundle(REMOTE, &["r1"])).await;
    e.world.requests();

    assert!(e.analytics.execute_analytics_sync(UID).await);

    let merged = e.world.read(&format!("sync/keyboards/{UID}/devices/{REMOTE}/deleted-ranges.json")).unwrap();
    assert!(merged.contains("\"r1\""), "{merged}");
    let creates: Vec<String> = e
        .world
        .requests()
        .into_iter()
        .filter(|r| r.starts_with("create:") || r.starts_with("update:"))
        .collect();
    assert_eq!(creates, [format!("create:{}", drive_file_name(&ranges_unit("third-hash")))]);
    assert_eq!(e.world.hooks.1.load(std::sync::atomic::Ordering::SeqCst), 1, "the own ranges' apply");
}

#[tokio::test]
async fn an_analytics_sync_and_a_pass_that_both_list_no_file_for_today_create_it_once() {
    let e = entry().await;
    let own = e.world.own_hash();
    write(&e.world.root, &format!("sync/keyboards/{UID}/devices/{own}/{DAY}.jsonl"), &day_text(&own));
    let text = day_text(&own);
    let ready = e.world.ops.analytics().ready().await.unwrap();
    ready.db.call(move |db| db.apply_day_jsonl(&text)).await.unwrap().unwrap();
    e.world.requests();

    e.world.drive.hold(DriveOp::Create, None);
    let analytics = e.analytics.execute_analytics_sync(UID);
    let pass = async {
        until_held(&e.world).await;
        let pass = e.world.upload(SyncScope::Keyboard(UID.to_owned()));
        let open = async {
            // The pass waits on the unit's upload lock while the create is held.
            tokio::time::sleep(Duration::from_millis(50)).await;
            e.world.drive.open_gate();
        };
        tokio::join!(pass, open).0
    };
    let (synced, passed) = tokio::join!(analytics, pass);
    assert!(synced);
    assert_eq!(passed, SyncExecuteResult::Completed);
    let name = drive_file_name(&day_unit(&own, DAY));
    assert_eq!(e.world.drive.names().iter().filter(|n| **n == name).count(), 1);
    let requests = e.world.requests();
    let writes: Vec<&String> = requests
        .iter()
        .filter(|r| r.starts_with(&format!("create:{name}")) || r.starts_with("update:"))
        .collect();
    assert_eq!(writes.len(), 2, "{requests:?}");
    assert!(writes[1].starts_with("update:"), "{requests:?}");
}

// --- The fetch of another device's day ---

#[tokio::test]
async fn a_fetch_merges_the_devices_ranges_before_its_day_and_once_per_revision() {
    let e = entry().await;
    let day = e.world.seed_unit(&day_unit(REMOTE, DAY), &day_bundle(REMOTE, DAY)).await;
    let ranges = e.world.seed_unit(&ranges_unit(REMOTE), &ranges_bundle(REMOTE, &["r1"])).await;
    e.world.requests();

    assert!(e.remote.fetch_remote_typing_day(UID, REMOTE, DAY).await.unwrap());
    assert_eq!(downloads(&e.world.requests(), &e.world), [ranges.id.clone(), day.id.clone()]);
    assert!(e.world.read(&format!("sync/keyboards/{UID}/devices/{REMOTE}/{DAY}.jsonl")).is_some());

    // Known and local: only the day.
    assert!(e.remote.fetch_remote_typing_day(UID, REMOTE, DAY).await.unwrap());
    assert_eq!(downloads(&e.world.requests(), &e.world), std::slice::from_ref(&day.id));

    // Known but no local file (a poll records keyboards it leaves alone):
    // merged again.
    std::fs::remove_file(
        e.world.root.join(format!("sync/keyboards/{UID}/devices/{REMOTE}/deleted-ranges.json")),
    )
    .unwrap();
    assert!(e.remote.fetch_remote_typing_day(UID, REMOTE, DAY).await.unwrap());
    assert_eq!(downloads(&e.world.requests(), &e.world), [ranges.id, day.id]);
}

#[tokio::test]
async fn a_fetch_does_not_download_the_day_when_the_ranges_merge_fails() {
    let e = entry().await;
    let day = e.world.seed_unit(&day_unit(REMOTE, DAY), &day_bundle(REMOTE, DAY)).await;
    e.world.seed_unit(&ranges_unit(REMOTE), &ranges_bundle(REMOTE, &["r1"])).await;
    // Another keyboard's sync validates the password-check, so the next
    // download is the ranges'.
    assert!(e.analytics.execute_analytics_sync("0xBEEF").await);
    e.world.requests();
    e.world.drive.fail_next(DriveOp::Download);

    let err = e.remote.fetch_remote_typing_day(UID, REMOTE, DAY).await.unwrap_err();

    assert!(err.to_string().starts_with("Drive download failed: 400"), "{err}");
    assert!(!downloads(&e.world.requests(), &e.world).contains(&day.id));
}

#[tokio::test]
async fn a_fetch_of_this_devices_day_downloads_it_and_writes_nothing() {
    let e = entry().await;
    let own = e.world.own_hash();
    e.world.seed_unit(&day_unit(&own, DAY), &day_bundle(&own, DAY)).await;

    assert!(e.remote.fetch_remote_typing_day(UID, &own, DAY).await.unwrap());
    assert!(e.world.read(&format!("sync/keyboards/{UID}/devices/{own}/{DAY}.jsonl")).is_none());
}

#[tokio::test]
async fn the_reads_find_nothing_signed_out_and_send_nothing() {
    let e = entry().await;
    e.world.seed_unit(&day_unit(REMOTE, DAY), &day_bundle(REMOTE, DAY)).await;
    e.world.sign_in.0.store(false, std::sync::atomic::Ordering::SeqCst);
    e.world.requests();

    assert!(!e.remote.has_any_remote_typing_data().await.unwrap());
    assert!(e.remote.list_remote_typing_hashes(UID).await.unwrap().is_empty());
    assert!(e.remote.list_remote_typing_days(UID, REMOTE).await.unwrap().is_empty());
    assert!(!e.remote.fetch_remote_typing_day(UID, REMOTE, DAY).await.unwrap());
    assert_eq!(e.remote.remote_data_file_names().await.unwrap(), None);
    assert!(!e.analytics.execute_analytics_sync(UID).await);
    assert!(e.world.requests().is_empty());
}

#[tokio::test]
async fn the_import_sees_the_data_files_only() {
    let e = entry().await;
    let unit = day_unit(REMOTE, DAY);
    e.world.seed_unit(&unit, &day_bundle(REMOTE, DAY)).await;
    let names = e.remote.remote_data_file_names().await.unwrap().unwrap();
    assert_eq!(names.into_iter().collect::<Vec<_>>(), [drive_file_name(&unit)]);
}
