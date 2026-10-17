// SPDX-License-Identifier: GPL-2.0-or-later
//! Trigger B (polling.rs), the polling cases of
//! src/main/__tests__/sync-service.test.ts on the in-memory Drive. Time is
//! paused once the world is built.

#![allow(clippy::unwrap_used, clippy::panic)]

mod execute_harness;
mod preflight_harness;
mod trigger_harness;

use std::time::Duration;

use execute_harness::{Options, World, favorite_bundle};
use pipette_drive::DriveApi;
use pipette_drive::fake::DriveOp;
use pipette_sync::execute::POLL_INTERVAL;
use pipette_sync::polling::STARTUP_POLL_DELAY;
use pipette_sync_format::drive_names::drive_file_name;
use pipette_sync_runtime::{SyncDirection, SyncStatus};
use preflight_harness::Stored;
use trigger_harness::{advance, tick, until, until_held};

const T: &str = "2026-10-01T00:00:00.000Z";

fn settings_bundle(uid: &str) -> String {
    serde_json::json!({
        "type": "settings", "key": uid, "index": { "uid": uid, "entries": [] },
        "files": { "pipette_settings.json": format!("{{\"theme\":\"remote\",\"_updatedAt\":\"{T}\"}}") },
    })
    .to_string()
}

/// A world with the local keyboard kbA; time is paused from here on.
async fn world() -> World {
    let world = World::with(Options::default(), |root| {
        execute_harness::write(root, "sync/keyboards/kbA/pipette_settings.json", "{\"theme\":\"local\"}");
    })
    .await;
    tokio::time::pause();
    world
}

/// The full listings among `requests`.
fn passes(requests: &[String]) -> usize {
    requests.iter().filter(|r| *r == "list:*").count()
}

/// The names of the files downloaded among `requests`, the password-check
/// aside.
fn downloads(world: &World, requests: &[String]) -> Vec<String> {
    let files = world.drive.inner.files();
    requests
        .iter()
        .filter_map(|r| r.strip_prefix("download:"))
        .filter_map(|id| files.iter().find(|f| f.file.id == id).map(|f| f.file.name.clone()))
        .filter(|name| name != "password-check.enc")
        .collect()
}

#[tokio::test]
async fn a_first_poll_merges_what_this_device_takes_and_records_the_rest() {
    let world = world().await;
    world.seed_unit("favorites/tapDance", &favorite_bundle("tapDance", &["r1"], T)).await;
    world.seed_unit("keyboards/kbA/settings", &settings_bundle("kbA")).await;
    world.seed_unit("keyboards/kbB/settings", &settings_bundle("kbB")).await;
    world.seed_unit("keyboards/kbA/devices/other1/days/2026-10-14", "{}").await;
    world.seed_unit("keyboards/kbA/runs", "{}").await;
    // A bundle that never merges: its revision is recorded.
    world.drive.seed("favorites_combo.enc", r#"{"index":{"entries":5}}"#).await;
    let triggers = world.triggers(true);

    triggers.poller().poll_for_remote_changes().await;

    let requests = world.requests();
    let mut merged = downloads(&world, &requests);
    merged.sort();
    assert_eq!(merged, ["favorites_combo.enc", "favorites_tapDance.enc", "keyboards_kbA_settings.enc"]);
    assert!(world.read("sync/favorites/tapDance/index.json").is_some());
    let reported: Vec<(SyncDirection, SyncStatus, Option<String>)> =
        world.progress.lock().unwrap().iter().map(|p| (p.direction, p.status, p.sync_unit.clone())).collect();
    assert!(reported.contains(&(
        SyncDirection::Download,
        SyncStatus::Success,
        Some("favorites/tapDance".into())
    )));
    assert!(!reported.iter().any(|(_, status, _)| *status == SyncStatus::Error), "a poll reports no failure");
    // Every listed file is known now: the merged ones, those left alone and
    // the malformed one.
    for name in world.drive.names() {
        let file = world.drive.inner.files().into_iter().find(|f| f.file.name == name).unwrap().file;
        assert!(world.runtime().remote().is_known(&name, &file.id, &file.modified_time), "{name}");
    }

    triggers.poller().poll_for_remote_changes().await;
    let requests = world.requests();
    assert_eq!(passes(&requests), 1);
    assert!(downloads(&world, &requests).is_empty(), "{requests:?}");
}

#[tokio::test]
async fn a_new_revision_is_merged_by_the_next_poll() {
    let world = world().await;
    let file = world.seed_unit("favorites/tapDance", &favorite_bundle("tapDance", &["r1"], T)).await;
    let triggers = world.triggers(true);
    triggers.poller().poll_for_remote_changes().await;
    world.requests();

    world.drive.inner.update(file.id, favorite_bundle("tapDance", &["r1", "r2"], T)).await.unwrap();
    triggers.poller().poll_for_remote_changes().await;
    assert_eq!(downloads(&world, &world.requests()), [drive_file_name("favorites/tapDance")]);
    assert!(world.read("sync/favorites/tapDance/tapDance_r2.json").is_some());
}

#[tokio::test]
async fn a_poll_does_nothing_while_the_lock_is_held() {
    let world = world().await;
    let triggers = world.triggers(true);
    let _pass = world.runtime().try_claim_sync_lock(false).unwrap();
    triggers.poller().poll_for_remote_changes().await;
    assert!(world.requests().is_empty());
}

#[tokio::test]
async fn a_blocked_poll_reports_it_and_a_credential_failure_is_silent() {
    let world = world().await;
    let triggers = world.triggers(true);
    world.passwords.set(Stored::DecryptFailed);
    triggers.poller().poll_for_remote_changes().await;
    assert!(world.requests().is_empty());
    assert!(world.progress.lock().unwrap().is_empty());

    world.write("local/auth/sync-password-change.json", "not json");
    world.preflight.forget_change_state_cache();
    triggers.poller().poll_for_remote_changes().await;
    let progress = world.progress.lock().unwrap().clone();
    assert_eq!(progress.len(), 1);
    assert_eq!((progress[0].direction, progress[0].status), (SyncDirection::Download, SyncStatus::Error));
    assert!(progress[0].message.as_deref().unwrap().starts_with("sync."));
}

#[tokio::test]
async fn polling_at_launch_runs_a_delayed_first_pass_and_then_every_interval() {
    let world = world().await;
    let triggers = world.triggers(true);
    triggers.start();
    assert!(triggers.poller().is_polling());
    advance(&world, STARTUP_POLL_DELAY - Duration::from_millis(2)).await;
    assert_eq!(passes(&world.requests()), 0);
    advance(&world, Duration::from_millis(1)).await;
    until(|| !triggers.poller().pass_running()).await;
    assert_eq!(passes(&world.requests()), 1);

    advance(&world, POLL_INTERVAL - STARTUP_POLL_DELAY).await;
    until(|| !triggers.poller().pass_running()).await;
    assert_eq!(passes(&world.requests()), 1, "the interval keeps its own schedule");

    triggers.signed_out();
    advance(&world, POLL_INTERVAL * 2).await;
    assert_eq!(passes(&world.requests()), 0);
}

#[tokio::test]
async fn polling_does_not_start_with_auto_sync_off() {
    let world = world().await;
    let triggers = world.triggers(false);
    triggers.start();
    triggers.poller().start_polling_if_auto_sync();
    assert!(!triggers.poller().is_polling());
    triggers.credentials_ready();
    assert!(!triggers.poller().is_polling());
}

#[tokio::test]
async fn the_first_pass_waits_for_a_holder_of_the_lock() {
    let world = world().await;
    let triggers = world.triggers(true);
    let pass = world.runtime().try_claim_sync_lock(false).unwrap();
    triggers.start();
    tick(STARTUP_POLL_DELAY).await;
    tick(Duration::from_secs(60)).await;
    assert_eq!(passes(&world.requests()), 0);

    drop(pass);
    until(|| triggers.poller().pass_running()).await;
    until(|| !triggers.poller().pass_running()).await;
    assert_eq!(passes(&world.requests()), 1);
}

#[tokio::test]
async fn stopping_drops_a_first_pass_still_waiting() {
    let world = world().await;
    let triggers = world.triggers(true);
    let pass = world.runtime().try_claim_sync_lock(false).unwrap();
    triggers.start();
    tick(STARTUP_POLL_DELAY).await;
    triggers.poller().stop_polling();
    drop(pass);
    advance(&world, Duration::from_secs(1)).await;
    assert!(!triggers.poller().pass_running());
    assert!(world.requests().is_empty());
}

#[tokio::test]
async fn a_tick_while_the_last_pass_runs_starts_nothing() {
    let world = world().await;
    let triggers = world.triggers(true);
    triggers.poller().start_polling(None);
    world.drive.hold(DriveOp::List, Some(None));
    tick(POLL_INTERVAL).await;
    until_held(&world).await;
    tick(POLL_INTERVAL).await;
    assert_eq!(world.drive.held(), 1);
    world.drive.open_gate();
    until(|| !triggers.poller().pass_running()).await;
    assert_eq!(passes(&world.requests()), 1);
}

#[tokio::test]
async fn a_download_starts_polling_when_auto_sync_is_on() {
    let world = world().await;
    let triggers = world.triggers(true);
    pipette_sync::execute::PassHooks::start_polling_if_auto_sync(&triggers);
    assert!(triggers.poller().is_polling());
}
