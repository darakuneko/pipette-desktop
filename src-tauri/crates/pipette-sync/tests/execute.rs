// SPDX-License-Identifier: GPL-2.0-or-later
//! Full passes (`SyncExecutor`) on the in-memory Drive (the sync lock,
//! merge-based sync, partial failures, the result, the scopes, the
//! password-check, the typing-analytics reconcile) and what a pass leaves
//! behind: the pending units, the revisions recorded as handled, the progress
//! and the flush it asks for.

#![allow(clippy::unwrap_used, clippy::panic)]

mod execute_harness;
mod preflight_harness;

use std::sync::atomic::Ordering;
use std::time::Duration;

use execute_harness::{Options, PASSWORD, World, favorite_bundle, seed_favorites, write};
use pipette_drive::fake::DriveOp;
use pipette_sync::execute::{POLL_INTERVAL, SkipReason, SyncExecuteResult};
use pipette_sync::password::guard::SyncBlockReason;
use pipette_sync::preflight::PreflightError;
use pipette_sync::scope::SyncScope;
use pipette_sync_format::crypto::encrypt;
use pipette_sync_format::drive_names::drive_file_name;
use pipette_sync_runtime::{SyncCredentialFailureReason, SyncDirection, SyncStatus};
use preflight_harness::Stored;

const T: &str = "2025-01-01T00:00:00.000Z";
const UID: &str = "0xDEAD";

fn kb(uid: &str) -> SyncScope {
    SyncScope::Keyboard(uid.to_owned())
}

fn partial(units: &[&str]) -> SyncExecuteResult {
    SyncExecuteResult::Partial(units.iter().map(|u| (*u).to_owned()).collect())
}

/// The ids of the files downloaded, the password-check's left out.
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

// --- The sync lock ---

#[tokio::test]
async fn a_second_pass_while_one_runs_is_busy() {
    let world = World::new().await;
    world.drive.hold(DriveOp::List, Some(None));
    let first = world.download(SyncScope::All);
    let second = async {
        while world.drive.held() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let second = world.download(SyncScope::All).await;
        world.drive.open_gate();
        second
    };
    let (first, second) = tokio::join!(first, second);
    assert_eq!(first, SyncExecuteResult::Completed);
    assert_eq!(second, SyncExecuteResult::Skipped(SkipReason::Busy));
}

#[tokio::test]
async fn a_pass_waits_for_a_holder_that_ends_on_its_own() {
    let world = World::new().await;
    let poll = world.runtime().try_claim_sync_lock(true).unwrap();
    let release = async {
        tokio::time::sleep(Duration::from_millis(30)).await;
        drop(poll);
    };
    let (result, ()) = tokio::join!(world.download(kb(UID)), release);
    assert_eq!(result, SyncExecuteResult::Completed);

    let flush = world.runtime().try_claim_sync_lock(false).unwrap();
    assert_eq!(world.download(kb(UID)).await, SyncExecuteResult::Skipped(SkipReason::Busy));
    drop(flush);
}

#[tokio::test]
async fn the_lock_is_released_after_a_failure() {
    let world = World::new().await;
    world.drive.fail_next(DriveOp::List);
    let err = world.sync(SyncDirection::Download, SyncScope::All).await.unwrap_err();
    assert!(matches!(err, PreflightError::Drive(_)), "{err}");
    let last = world.last_progress();
    assert_eq!((last.status, last.failed_units), (SyncStatus::Error, None));
    assert!(last.message.unwrap().starts_with("Drive list failed: 400"));
    assert!(!world.runtime().is_syncing());
    assert_eq!(world.download(SyncScope::All).await, SyncExecuteResult::Completed);
}

// --- Skips and the result ---

#[tokio::test]
async fn a_pass_without_credentials_is_skipped_with_the_reason() {
    let world = World::new().await;
    world.sign_in.0.store(false, Ordering::SeqCst);
    let unauthenticated = SkipReason::Credential(SyncCredentialFailureReason::Unauthenticated);
    assert_eq!(world.download(SyncScope::All).await, SyncExecuteResult::Skipped(unauthenticated));
    let last = world.last_progress();
    assert_eq!(last.reason, Some(SyncCredentialFailureReason::Unauthenticated));
    assert_eq!(last.message.as_deref(), Some("sync.readiness.unauthenticated"));

    world.sign_in.0.store(true, Ordering::SeqCst);
    world.passwords.set(Stored::None);
    let none = SkipReason::Credential(SyncCredentialFailureReason::NoPasswordFile);
    assert_eq!(world.upload(SyncScope::All).await, SyncExecuteResult::Skipped(none));
    assert!(world.requests().is_empty());
}

#[tokio::test]
async fn a_blocked_pass_is_skipped_before_and_after_the_listing() {
    let world = World::new().await;
    world.write("local/auth/sync-password-change.json", "not json");
    world.preflight.forget_change_state_cache();
    let local = SkipReason::Blocked(SyncBlockReason::BlockedLocal);
    assert_eq!(world.download(SyncScope::All).await, SyncExecuteResult::Skipped(local));
    assert!(world.requests().is_empty());
    assert_eq!(world.last_progress().message.as_deref(), Some("sync.passwordChange.blockedLocal"));

    std::fs::remove_file(world.root.join("local/auth/sync-password-change.json")).unwrap();
    world.preflight.forget_change_state_cache();
    world.drive.seed("password-change-lock.json", "{}").await;
    let other = SkipReason::Blocked(SyncBlockReason::BlockedByOtherDevice);
    assert_eq!(world.upload(SyncScope::All).await, SyncExecuteResult::Skipped(other));
    assert_eq!(world.requests(), ["list:*"]);
}

#[tokio::test]
async fn a_completed_pass_reports_start_and_end() {
    let world = World::new().await;
    world.seed_unit("favorites/macro", &favorite_bundle("macro", &["a"], T)).await;
    assert_eq!(world.download(SyncScope::All).await, SyncExecuteResult::Completed);
    assert_eq!(
        world.statuses(),
        ["syncing: Starting sync...", "syncing favorites/macro 1/1", "success: Sync complete"]
    );
}

// --- Downloads ---

#[tokio::test]
async fn a_download_merges_both_sides_and_uploads_what_drive_lacks() {
    let world = World::with(Options::default(), |root| seed_favorites(root, "tapDance", &["1"], T)).await;
    let file = world.seed_unit("favorites/tapDance", &favorite_bundle("tapDance", &["r1"], T)).await;
    world.requests();

    assert_eq!(world.download(SyncScope::All).await, SyncExecuteResult::Completed);

    let requests = world.requests();
    assert!(requests.contains(&format!("download:{}", file.id)), "{requests:?}");
    assert!(requests.contains(&format!("update:{}", file.id)), "{requests:?}");
    let index: serde_json::Value =
        serde_json::from_str(&world.read("sync/favorites/tapDance/index.json").unwrap()).unwrap();
    let mut ids: Vec<&str> =
        index["entries"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap()).collect();
    ids.sort_unstable();
    assert_eq!(ids, ["1", "r1"]);
    assert!(world.is_known("favorites/tapDance"));
    assert_eq!(world.applied.0.lock().unwrap().as_slice(), ["favorites/tapDance"]);
}

#[tokio::test]
async fn a_converged_download_uploads_nothing() {
    let world = World::with(Options::default(), |root| seed_favorites(root, "macro", &["a"], T)).await;
    world.seed_unit("favorites/macro", &favorite_bundle("macro", &["a"], T)).await;
    world.requests();
    assert_eq!(world.download(SyncScope::All).await, SyncExecuteResult::Completed);
    assert!(world.requests().iter().all(|r| !r.starts_with("update:") && !r.starts_with("create:")));
}

#[tokio::test]
async fn a_failed_download_is_partial_and_left_unrecorded() {
    let world = World::new().await;
    world.seed_unit("favorites/tapDance", &favorite_bundle("tapDance", &["a"], T)).await;
    world.seed_unit("favorites/macro", "not json").await;

    assert_eq!(world.download(SyncScope::Favorites).await, partial(&["favorites/macro"]));

    let last = world.last_progress();
    assert_eq!(last.status, SyncStatus::Partial);
    assert_eq!(last.message.as_deref(), Some("1 sync unit(s) failed"));
    assert_eq!(last.failed_units, Some(vec!["favorites/macro".to_owned()]));
    assert!(world.statuses().iter().any(|s| s.starts_with("error favorites/macro: ")));
    assert!(world.is_known("favorites/tapDance"));
    assert!(!world.is_known("favorites/macro"));
}

#[tokio::test]
async fn a_download_merges_one_copy_of_a_duplicated_unit() {
    let world = World::new().await;
    world.seed_unit("favorites/macro", &favorite_bundle("macro", &["old"], T)).await;
    let newer = world.seed_unit("favorites/macro", &favorite_bundle("macro", &["new"], T)).await;
    world.requests();
    assert_eq!(world.download(SyncScope::All).await, SyncExecuteResult::Completed);
    assert_eq!(downloads(&world.requests(), &world), [newer.id]);
}

#[tokio::test]
async fn the_scopes_take_their_units() {
    let world = World::with(Options::default(), |root| {
        std::fs::create_dir_all(root.join("sync/keyboards/0xLocal")).unwrap();
    })
    .await;
    let fav = world.seed_unit("favorites/tapDance", &favorite_bundle("tapDance", &["a"], T)).await;
    let local = world.seed_unit("keyboards/0xLocal/settings", &settings_bundle("0xLocal")).await;
    let remote_only = world.seed_unit("keyboards/0xRemote/settings", &settings_bundle("0xRemote")).await;
    let day = world.seed_unit("keyboards/0xLocal/devices/other/days/2026-04-19", &day_bundle()).await;
    let runs = world.seed_unit("keyboards/0xLocal/runs", &empty_index_bundle("run-log", "0xLocal")).await;
    let labels = world.seed_unit("key-labels", &empty_index_bundle("key-label", "key-labels")).await;
    world.requests();

    let taken = |scope: SyncScope| {
        let world = &world;
        async move {
            world.download(scope).await;
            let mut ids = downloads(&world.requests(), world);
            ids.sort();
            ids
        }
    };
    let sorted = |ids: &[&String]| {
        let mut ids: Vec<String> = ids.iter().map(|id| (*id).clone()).collect();
        ids.sort();
        ids
    };
    assert_eq!(taken(SyncScope::Favorites).await, sorted(&[&fav.id, &labels.id]));
    assert_eq!(
        taken(kb("0xLocal")).await,
        sorted(&[&local.id, &day.id, &runs.id, &labels.id]),
        "a keyboard scope takes the analytics days and the run logs"
    );
    assert_eq!(
        taken(SyncScope::FavoritesAndKeyboard("0xLocal".into())).await,
        sorted(&[&fav.id, &local.id, &labels.id]),
        "the connect-time scope leaves them"
    );
    assert_eq!(taken(SyncScope::Packs).await, Vec::<String>::new());
    assert_eq!(
        taken(SyncScope::All).await,
        sorted(&[&fav.id, &local.id, &day.id, &runs.id, &labels.id]),
        "'all' leaves a keyboard with no local directory"
    );
    assert!(world.read("sync/keyboards/0xRemote/pipette_settings.json").is_none());
    assert_eq!(taken(kb("0xRemote")).await, sorted(&[&remote_only.id, &labels.id]));
    assert!(world.read("sync/keyboards/0xRemote/pipette_settings.json").is_some());
}

fn settings_bundle(uid: &str) -> String {
    let settings = serde_json::json!({ "theme": "dark", "_updatedAt": T }).to_string();
    serde_json::json!({
        "type": "settings", "key": uid, "index": { "uid": uid, "entries": [] },
        "files": { "pipette_settings.json": settings },
    })
    .to_string()
}

fn empty_index_bundle(kind: &str, key: &str) -> String {
    serde_json::json!({ "type": kind, "key": key, "index": { "entries": [] }, "files": {} }).to_string()
}

/// A day of another device with no rows, so its merge does not reach the
/// cache.
fn day_bundle() -> String {
    serde_json::json!({
        "type": "typing-analytics-device", "key": "x", "index": { "entries": [] }, "files": { "data.jsonl": "\n" },
    })
    .to_string()
}

#[tokio::test]
async fn a_scoped_download_records_only_the_units_it_merged() {
    let world = World::with(Options::default(), |root| {
        std::fs::create_dir_all(root.join("sync/keyboards/0x1234")).unwrap();
    })
    .await;
    world.seed_unit("favorites/tapDance", &favorite_bundle("tapDance", &["a"], T)).await;
    world.seed_unit("keyboards/0x1234/settings", &settings_bundle("0x1234")).await;
    world.download(SyncScope::Favorites).await;
    assert!(world.is_known("favorites/tapDance"));
    assert!(!world.is_known("keyboards/0x1234/settings"));
}

#[tokio::test]
async fn the_password_check_is_validated_again_only_for_all() {
    let world = World::new().await;
    let check = world.drive.inner.files()[0].file.id.clone();
    world.download(SyncScope::All).await;
    world.requests();
    world.download(SyncScope::Favorites).await;
    assert!(!world.requests().contains(&format!("download:{check}")));
    world.download(SyncScope::All).await;
    assert!(world.requests().contains(&format!("download:{check}")));

    // A password the check does not open stops the pass.
    world.passwords.set(Stored::Readable("other".into()));
    let err = world.sync(SyncDirection::Upload, SyncScope::Favorites).await.unwrap_err();
    assert_eq!(err, PreflightError::PasswordMismatch);
    assert_eq!(world.last_progress().message.as_deref(), Some("sync.passwordMismatch"));
}

#[tokio::test]
async fn a_download_of_all_names_the_keyboards_the_names_lack() {
    let world = World::new().await;
    *world.account.0.lock().unwrap() = Some("sub-a".into());
    world.download(kb(UID)).await;
    assert_eq!(world.backfill.calls.load(Ordering::SeqCst), 0);
    world.download(SyncScope::All).await;
    assert_eq!(world.backfill.calls.load(Ordering::SeqCst), 1);
    assert!(world.pending_units().is_empty());

    world.backfill.resolves.store(2, Ordering::SeqCst);
    world.download(SyncScope::All).await;
    assert_eq!(world.pending_units(), ["meta/keyboard-names"]);
    assert_eq!(world.hooks.0.lock().unwrap().as_slice(), ["flush None"]);
    assert_eq!(world.pending.owner().map(|o| o.to_string_lossy().into_owned()).as_deref(), Some("sub-a"));
}

#[tokio::test]
async fn a_download_of_all_names_a_keyboard_from_its_snapshots_on_drive() {
    let world = World::with(Options { store_backfill: true, ..Options::default() }, |_| {}).await;
    *world.account.0.lock().unwrap() = Some("sub-a".into());
    // A keyboard with no local directory: the download of 'all' skips its
    // units, so the backfill opens its snapshots bundle on Drive.
    let unit = format!("keyboards/{UID}/snapshots");
    let filename = "Remote Board_2026-04-16T10-00-00.000Z.pipette";
    let bundle = format!(
        r#"{{"type":"layout","key":"{UID}","index":{{"uid":"{UID}","entries":[{{"id":"s","label":"","filename":"{filename}","savedAt":"{T}"}}]}},"files":{{}}}}"#
    );
    let envelope = encrypt(&bundle, PASSWORD, &unit).unwrap();
    world.drive.seed(&drive_file_name(&unit), &serde_json::to_string(&envelope).unwrap()).await;

    assert_eq!(world.download(SyncScope::All).await, SyncExecuteResult::Completed);

    let names = world.read("sync/meta/keyboard-names.json").unwrap();
    let names: serde_json::Value = serde_json::from_str(&names).unwrap();
    let entries = names["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1, "{names}");
    assert_eq!(entries[0]["uid"], UID);
    assert_eq!(entries[0]["deviceName"], "Remote Board");
    assert!(world.applied.0.lock().unwrap().iter().any(|unit| unit == "meta/keyboard-names"));
    assert_eq!(world.pending_units(), ["meta/keyboard-names"]);
    assert_eq!(world.hooks.0.lock().unwrap().as_slice(), ["flush None"]);
    assert_eq!(world.pending.owner().map(|o| o.to_string_lossy().into_owned()).as_deref(), Some("sub-a"));

    // A keyboard the names already have is not named again.
    let generation = world.pending.pending_generation_of("meta/keyboard-names");
    world.pending.settle("meta/keyboard-names", generation);
    world.hooks.0.lock().unwrap().clear();
    world.download(SyncScope::All).await;
    assert!(world.pending_units().is_empty());
    assert!(world.hooks.0.lock().unwrap().is_empty());
}

// --- Uploads ---

#[tokio::test]
async fn an_upload_lists_drive_once_and_settles_what_it_sent() {
    let world = World::with(Options::default(), |root| {
        seed_favorites(root, "tapDance", &["1"], T);
        seed_favorites(root, "macro", &["2"], T);
    })
    .await;
    world.pending.notify_change("favorites/tapDance");
    world.pending.notify_change("keyboards/0x1234/settings");
    world.requests();

    assert_eq!(world.upload(SyncScope::Favorites).await, SyncExecuteResult::Completed);

    let requests = world.requests();
    assert_eq!(requests.iter().filter(|r| r.starts_with("list:")).count(), 1, "{requests:?}");
    let mut created: Vec<&String> = requests.iter().filter(|r| r.starts_with("create:")).collect();
    created.sort();
    assert_eq!(created, ["create:favorites_macro.enc", "create:favorites_tapDance.enc"]);
    assert_eq!(world.pending_units(), ["keyboards/0x1234/settings"]);
    assert_eq!(world.pending_events.lock().unwrap().last(), Some(&true));
    assert!(world.hooks.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_failed_upload_stays_pending_for_the_account_the_pass_ran_as() {
    let world = World::with(Options { concurrency: 1, ..Options::default() }, |root| {
        seed_favorites(root, "tapDance", &["1"], T);
        seed_favorites(root, "macro", &["2"], T);
    })
    .await;
    *world.account.0.lock().unwrap() = Some("sub-a".into());
    world.pending.notify_change("favorites/macro");
    // The passes send the favorites in their fixed order, tapDance before macro.
    world.drive.fail_next(DriveOp::Create);

    assert_eq!(world.upload(SyncScope::All).await, partial(&["favorites/tapDance"]));

    assert_eq!(world.pending_units(), ["favorites/tapDance"]);
    assert_eq!(world.hooks.0.lock().unwrap().as_slice(), [format!("flush {:?}", Some(POLL_INTERVAL))]);
    assert!(world.is_known("favorites/macro"));

    // Another account signed in: its pass holds the unit for "sub-a" and
    // marks its own failure pending for itself.
    world.drive.fail_next(DriveOp::Create);
    *world.account.0.lock().unwrap() = Some("sub-b".into());
    assert_eq!(world.upload(SyncScope::All).await, partial(&["favorites/tapDance"]));
    assert_eq!(world.pending_units(), ["favorites/tapDance"]);
    let held: Vec<String> =
        world.pending.held().into_iter().map(|(sub, _)| sub.to_string_lossy().into_owned()).collect();
    assert_eq!(held, ["sub-a"]);
}

#[tokio::test]
async fn a_unit_changed_during_the_pass_stays_pending() {
    let world = World::with(Options::default(), |root| seed_favorites(root, "macro", &["a"], T)).await;
    world.pending.notify_change("favorites/macro");
    world.drive.hold(DriveOp::Create, None);
    let pass = world.upload(SyncScope::All);
    let change = async {
        while world.drive.held() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        world.pending.notify_change("favorites/macro");
        world.drive.open_gate();
    };
    let (result, ()) = tokio::join!(pass, change);
    assert_eq!(result, SyncExecuteResult::Completed);
    assert_eq!(world.pending_units(), ["favorites/macro"]);
}

#[tokio::test]
async fn an_upload_records_its_own_revision_only() {
    let world = World::with(Options::default(), |root| seed_favorites(root, "macro", &["a", "b"], T)).await;
    world.seed_unit("favorites/macro", &favorite_bundle("macro", &["a"], T)).await;
    world.upload(SyncScope::All).await;
    assert!(world.is_known("favorites/macro"));
    // Another device writes after the upload: that revision is not known.
    let id =
        world.drive.inner.files().into_iter().find(|f| f.file.name == "favorites_macro.enc").unwrap().file.id;
    world.drive.rewrite_password_check(&id, "x").await;
    assert!(!world.is_known("favorites/macro"));
}

// --- The typing analytics of this device ---

fn own_day(world: &World, day: &str) -> String {
    format!("keyboards/{UID}/devices/{}/days/{day}", world.own_hash())
}

fn state(world: &World, uploaded: &[&str], reconciled: Option<u64>) -> String {
    let key = format!("{UID}|{}", world.own_hash());
    serde_json::json!({
        "_rev": 3, "my_device_id": world.own_hash(),
        "uploaded": { key.clone(): uploaded }, "reconciled_at": { key: reconciled }, "last_synced_at": 5000,
    })
    .to_string()
}

fn sync_state(world: &World) -> serde_json::Value {
    let path = pipette_typing_analytics::sync_state::sync_state_path(&world.root);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn save_state(world: &World, text: &str) {
    let path = pipette_typing_analytics::sync_state::sync_state_path(&world.root);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

#[tokio::test]
async fn an_upload_reconciles_first_and_lists_again_only_when_drive_changed() {
    let world = World::new().await;
    save_state(&world, &state(&world, &["2026-04-18"], Some(5000)));
    world.seed_unit(&own_day(&world, "2026-04-18"), "{}").await;
    world.requests();

    assert_eq!(world.upload(SyncScope::All).await, SyncExecuteResult::Completed);

    let requests = world.requests();
    assert_eq!(requests.iter().filter(|r| r.starts_with("list:")).count(), 2, "{requests:?}");
    assert!(requests.iter().any(|r| r.starts_with("delete:")), "{requests:?}");
    assert!(world.drive.names().iter().all(|n| !n.contains("_days_")));
    let key = format!("{UID}|{}", world.own_hash());
    assert_eq!(sync_state(&world)["uploaded"][&key], serde_json::json!([]));

    // Nothing to reconcile: one listing.
    world.upload(SyncScope::All).await;
    assert_eq!(world.requests().iter().filter(|r| r.starts_with("list:")).count(), 1);
}

#[tokio::test]
async fn a_new_own_day_is_uploaded_and_recorded_once() {
    let world = World::new().await;
    save_state(&world, &state(&world, &[], Some(5000)));
    let text = day_text(&world.own_hash());
    write(&world.root, &format!("sync/keyboards/{UID}/devices/{}/2026-04-18.jsonl", world.own_hash()), &text);
    let ready = world.ops.analytics().ready().await.unwrap();
    ready.db.call(move |db| db.apply_day_jsonl(&text)).await.unwrap().unwrap();
    world.requests();

    world.upload(SyncScope::All).await;
    let name = format!("keyboards_{UID}_devices_{}_days_2026-04-18.enc", world.own_hash());
    assert!(world.requests().contains(&format!("create:{name}")));
    world.upload(SyncScope::All).await;
    let requests = world.requests();
    assert!(!requests.iter().any(|r| r.starts_with("update:")), "unchanged, not sent again: {requests:?}");
    assert!(downloads(&requests, &world).is_empty(), "an own day is never downloaded");
    let key = format!("{UID}|{}", world.own_hash());
    assert_eq!(sync_state(&world)["uploaded"][&key], serde_json::json!(["2026-04-18"]));
}

#[tokio::test]
async fn an_upload_before_the_analytics_start_still_uploads_the_own_days() {
    // No sync_state.json and nothing has started the typing analytics: the
    // pass's reconcile writes the state, so the analytics must start (and
    // rebuild the cache from the day file) before it.
    let world = World::new().await;
    let text = day_text(&world.own_hash());
    write(&world.root, &format!("sync/keyboards/{UID}/devices/{}/2026-04-18.jsonl", world.own_hash()), &text);
    world.requests();

    assert_eq!(world.upload(SyncScope::All).await, SyncExecuteResult::Completed);
    let name = format!("keyboards_{UID}_devices_{}_days_2026-04-18.enc", world.own_hash());
    let requests = world.requests();
    assert!(requests.contains(&format!("create:{name}")), "{requests:?}");
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

#[tokio::test]
async fn an_own_day_on_drive_without_a_local_file_is_left_by_a_download() {
    let world = World::with(Options::default(), |root| {
        std::fs::create_dir_all(root.join(format!("sync/keyboards/{UID}"))).unwrap();
    })
    .await;
    world.seed_unit(&own_day(&world, "2026-04-18"), "{}").await;
    world.requests();
    assert_eq!(world.download(kb(UID)).await, SyncExecuteResult::Completed);
    let requests = world.requests();
    assert!(downloads(&requests, &world).is_empty());
    assert!(requests.iter().all(|r| !r.starts_with("create:") && !r.starts_with("update:")), "{requests:?}");
}
