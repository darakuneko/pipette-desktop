// SPDX-License-Identifier: GPL-2.0-or-later
//! Trigger A and the sync's part of the quit (flush.rs, triggers.rs) on the
//! in-memory Drive. Time is paused once the world is built, so each timer is
//! checked to the millisecond.

#![allow(clippy::unwrap_used, clippy::panic)]

mod execute_harness;
mod preflight_harness;
mod trigger_harness;

use std::time::Duration;

use execute_harness::{Options, World, seed_favorites};
use pipette_drive::fake::{DriveOp, Fault};
use pipette_sync::execute::POLL_INTERVAL;
use pipette_sync::flush::DEBOUNCE;
use pipette_sync::triggers::SyncTriggers;
use pipette_sync_runtime::SyncStatus;
use preflight_harness::Stored;
use trigger_harness::{advance, until_held};

const T: &str = "2026-10-01T00:00:00.000Z";
const MACRO: &str = "favorites/macro";
const TAP: &str = "favorites/tapDance";

/// A world with local favorites of macro and tapDance; time is paused from
/// here on.
async fn world_with(options: Options) -> World {
    let world = World::with(options, |root| {
        seed_favorites(root, "macro", &["a"], T);
        seed_favorites(root, "tapDance", &["t"], T);
    })
    .await;
    tokio::time::pause();
    world
}

async fn world() -> World {
    world_with(Options::default()).await
}

/// How many uploads of `unit`'s Drive file were created or updated.
fn uploads(world: &World, requests: &[String], unit: &str) -> usize {
    let name = pipette_sync_format::drive_names::drive_file_name(unit);
    let ids: Vec<String> =
        world.drive.inner.files().into_iter().filter(|f| f.file.name == name).map(|f| f.file.id).collect();
    requests
        .iter()
        .filter(|r| {
            r.strip_prefix("create:") == Some(name.as_str())
                || ids.iter().any(|id| **r == format!("update:{id}"))
        })
        .count()
}

fn statuses(world: &World) -> Vec<(SyncStatus, Option<String>)> {
    world.progress.lock().unwrap().iter().map(|p| (p.status, p.message.clone())).collect()
}

fn notify(triggers: &SyncTriggers, unit: &str) {
    triggers.notify_change(unit);
}

// --- The timer ---

#[tokio::test]
async fn each_change_pushes_the_flush_out_by_the_full_debounce() {
    let world = world().await;
    let triggers = world.triggers(false);
    notify(&triggers, MACRO);
    assert_eq!(triggers.flusher().due_in(), Some(DEBOUNCE));
    tokio::time::advance(Duration::from_secs(4)).await;
    assert_eq!(triggers.flusher().due_in(), Some(DEBOUNCE - Duration::from_secs(4)));
    notify(&triggers, MACRO);
    assert_eq!(triggers.flusher().due_in(), Some(DEBOUNCE));
}

#[tokio::test]
async fn a_scheduled_flush_keeps_an_earlier_timer_and_replaces_a_later_one() {
    let world = world().await;
    let triggers = world.triggers(false);
    triggers.flusher().schedule_flush_if_pending(DEBOUNCE);
    assert_eq!(triggers.flusher().due_in(), None, "nothing is pending");

    world.pending.notify_change(MACRO);
    triggers.flusher().schedule_flush_if_pending(POLL_INTERVAL);
    assert_eq!(triggers.flusher().due_in(), Some(POLL_INTERVAL));
    triggers.flusher().schedule_flush_if_pending(DEBOUNCE);
    assert_eq!(triggers.flusher().due_in(), Some(DEBOUNCE));
    triggers.flusher().schedule_flush_if_pending(POLL_INTERVAL);
    assert_eq!(triggers.flusher().due_in(), Some(DEBOUNCE));

    world.runtime().set_quitting();
    triggers.flusher().clear_timer();
    triggers.flusher().schedule_flush_if_pending(DEBOUNCE);
    assert_eq!(triggers.flusher().due_in(), None, "nothing is scheduled once the app quits");
}

// --- The flush ---

#[tokio::test]
async fn the_debounced_flush_uploads_and_settles_the_units() {
    let world = world().await;
    let triggers = world.triggers(true);
    notify(&triggers, MACRO);
    advance(&world, DEBOUNCE - Duration::from_millis(2)).await;
    assert!(world.pending.has_pending_changes(), "not before the debounce");

    advance(&world, Duration::from_millis(1)).await;
    let requests = world.requests();
    assert_eq!(uploads(&world, &requests, MACRO), 1);
    assert!(!world.pending.has_pending_changes());
    assert_eq!(triggers.flusher().due_in(), None);
    assert_eq!(
        statuses(&world),
        [
            (SyncStatus::Syncing, Some("Auto-sync starting...".into())),
            (SyncStatus::Success, Some("Sync complete".into()))
        ]
    );
}

#[tokio::test]
async fn a_unit_changed_during_the_pass_goes_out_after_the_debounce() {
    let world = world().await;
    let triggers = world.triggers(true);
    world.pending.notify_change(MACRO);
    world.drive.hold(DriveOp::Create, None);
    let change = async {
        until_held(&world).await;
        notify(&triggers, MACRO);
        notify(&triggers, TAP);
        world.drive.open_gate();
    };
    tokio::join!(triggers.flush_pending(), change);
    assert_eq!(world.pending_units(), [MACRO, TAP]);
    assert_eq!(triggers.flusher().due_in(), Some(DEBOUNCE));

    let before = world.requests();
    assert_eq!(uploads(&world, &before, MACRO), 1);
    advance(&world, DEBOUNCE).await;
    assert!(!world.pending.has_pending_changes());
    // The macro unit is merged with the copy it uploaded (nothing new to
    // send), the tapDance unit uploaded.
    assert_eq!(uploads(&world, &world.requests(), TAP), 1);
}

#[tokio::test]
async fn units_that_failed_are_tried_again_after_the_polling_interval() {
    let world = world().await;
    let triggers = world.triggers(true);
    world.pending.notify_change(MACRO);
    world.drive.inner.inject(Fault { only: Some(DriveOp::Create), ..Fault::with_status(400) });
    triggers.flush_pending().await;
    assert_eq!(world.pending_units(), [MACRO]);
    assert_eq!(triggers.flusher().due_in(), Some(POLL_INTERVAL));
    assert_eq!(statuses(&world).last().unwrap(), &(SyncStatus::Error, Some("Some sync units failed".into())));

    advance(&world, POLL_INTERVAL - DEBOUNCE).await;
    assert!(world.pending.has_pending_changes());
    advance(&world, DEBOUNCE - Duration::from_millis(1)).await;
    assert!(!world.pending.has_pending_changes());
    assert_eq!(triggers.flusher().due_in(), None);
}

#[tokio::test]
async fn auto_sync_off_keeps_the_units_until_it_is_turned_on() {
    let world = world().await;
    let triggers = world.triggers(false);
    world.pending.notify_change(MACRO);
    triggers.flush_pending().await;
    assert!(world.pending.has_pending_changes());
    assert_eq!(triggers.flusher().due_in(), None);
    assert!(world.requests().is_empty());

    triggers.set_auto_sync(true);
    assert_eq!(triggers.flusher().due_in(), Some(DEBOUNCE));
    assert!(triggers.poller().is_polling());
    advance(&world, DEBOUNCE).await;
    assert!(!world.pending.has_pending_changes());

    triggers.set_auto_sync(false);
    assert!(!triggers.poller().is_polling());
}

#[tokio::test]
async fn credential_failures_that_can_clear_up_are_tried_again() {
    for (stored, signed_in, retried) in [
        (Stored::DecryptFailed, true, true),
        (Stored::KeystoreUnavailable, true, true),
        (Stored::None, true, false),
        (Stored::Readable(execute_harness::PASSWORD.into()), false, false),
    ] {
        let world = world().await;
        let triggers = world.triggers(true);
        world.passwords.set(stored.clone());
        world.sign_in.0.store(signed_in, std::sync::atomic::Ordering::SeqCst);
        world.pending.notify_change(MACRO);
        triggers.flush_pending().await;
        assert!(world.pending.has_pending_changes());
        assert!(world.requests().is_empty(), "{stored:?}");
        assert_eq!(triggers.flusher().due_in(), retried.then_some(POLL_INTERVAL), "{stored:?} {signed_in}");
        tokio::time::resume();
    }
}

#[tokio::test]
async fn no_retry_is_scheduled_while_quitting() {
    let world = world().await;
    let triggers = world.triggers(true);
    world.passwords.set(Stored::KeystoreUnavailable);
    world.pending.notify_change(MACRO);
    world.runtime().set_quitting();
    triggers.flush_pending().await;
    assert_eq!(triggers.flusher().due_in(), None);
}

#[tokio::test]
async fn a_change_while_quitting_stays_pending_without_a_timer() {
    let world = world().await;
    let triggers = world.triggers(true);
    world.runtime().set_quitting();
    notify(&triggers, MACRO);
    assert_eq!(triggers.flusher().due_in(), None, "the quit's flush sends it");
    assert!(world.pending.has_pending_changes());
}

#[tokio::test]
async fn failures_before_the_units_are_tried_again_after_the_polling_interval() {
    for fail in ["list", "marker", "password-check"] {
        let world = world_with(Options { marker: fail != "marker", ..Options::default() }).await;
        let triggers = world.triggers(true);
        match fail {
            "list" => world.drive.fail_next(DriveOp::List),
            "marker" => world.drive.fail_next(DriveOp::Create),
            _ => world.drive.inner.inject(Fault { only: Some(DriveOp::Download), ..Fault::with_status(400) }),
        }
        world.pending.notify_change(MACRO);
        triggers.flush_pending().await;
        assert!(world.pending.has_pending_changes(), "{fail}");
        assert_eq!(triggers.flusher().due_in(), Some(POLL_INTERVAL), "{fail}");
        let (status, message) = statuses(&world).last().cloned().unwrap();
        assert_eq!(status, SyncStatus::Error, "{fail}");
        assert!(message.unwrap().starts_with("Drive "), "{fail}");

        advance(&world, POLL_INTERVAL).await;
        assert!(!world.pending.has_pending_changes(), "{fail}");
        tokio::time::resume();
    }
}

#[tokio::test]
async fn a_password_mismatch_waits_for_the_new_password() {
    let world = world().await;
    let triggers = world.triggers(true);
    world.passwords.set(Stored::Readable("other".into()));
    world.pending.notify_change(MACRO);
    triggers.flush_pending().await;
    assert!(world.pending.has_pending_changes());
    assert_eq!(triggers.flusher().due_in(), None);
    assert_eq!(statuses(&world).last().unwrap(), &(SyncStatus::Error, Some("sync.passwordMismatch".into())));

    // Storing the password schedules the flush.
    world.passwords.set(Stored::Readable(execute_harness::PASSWORD.into()));
    triggers.credentials_ready();
    assert_eq!(triggers.flusher().due_in(), Some(DEBOUNCE));
}

#[tokio::test]
async fn a_flush_the_guard_stops_reports_it_and_tries_again() {
    let world = world().await;
    let triggers = world.triggers(true);
    world.write("local/auth/sync-password-change.json", "not json");
    world.preflight.forget_change_state_cache();
    world.pending.notify_change(MACRO);
    triggers.flush_pending().await;
    assert!(world.pending.has_pending_changes());
    assert_eq!(triggers.flusher().due_in(), Some(POLL_INTERVAL));
    let (status, message) = statuses(&world).last().cloned().unwrap();
    assert_eq!(status, SyncStatus::Error);
    assert!(message.unwrap().starts_with("sync."));
    assert!(world.requests().is_empty());
}

#[tokio::test]
async fn units_changed_under_another_account_are_held_for_it() {
    let world = world().await;
    let triggers = world.triggers(true);
    world.pending.adopt_for_account(Some("account-a"));
    world.pending.notify_change(MACRO);
    *world.account.0.lock().unwrap() = Some("account-b".into());
    triggers.flush_pending().await;
    assert!(!world.pending.has_pending_changes());
    let held: Vec<String> =
        world.pending.held().into_iter().map(|(sub, _)| sub.to_string_lossy().into_owned()).collect();
    assert_eq!(held, ["account-a"]);
    assert_eq!(uploads(&world, &world.requests(), MACRO), 0);
}

// --- The sync lock ---

#[tokio::test]
async fn a_flush_waits_for_the_running_pass_then_runs() {
    let world = world().await;
    let triggers = world.triggers(true);
    world.pending.notify_change(MACRO);
    let pass = world.runtime().try_claim_sync_lock(true).unwrap();
    let flush = triggers.flush_pending();
    let release = async {
        tokio::time::sleep(Duration::from_secs(30)).await;
        assert!(world.pending.has_pending_changes());
        drop(pass);
    };
    tokio::join!(flush, release);
    assert!(!world.pending.has_pending_changes());
    assert_eq!(triggers.flusher().due_in(), None);
}

#[tokio::test]
async fn a_flush_that_finds_the_lock_held_again_after_waiting_tries_later() {
    let world = world().await;
    let triggers = world.triggers(true);
    world.pending.notify_change(MACRO);
    let first = world.runtime().try_claim_sync_lock(false).unwrap();
    let mut second = None;
    let flush = triggers.flush_pending();
    let hand_over = async {
        tokio::time::sleep(Duration::from_millis(1)).await;
        // Another holder takes the lock as soon as the first lets go.
        drop(first);
        second = world.runtime().try_claim_sync_lock(false);
    };
    tokio::join!(flush, hand_over);
    assert!(second.is_some());
    assert!(world.pending.has_pending_changes());
    assert_eq!(triggers.flusher().due_in(), Some(DEBOUNCE));
}

// --- The quit ---

#[tokio::test]
async fn the_quit_stops_polling_and_the_timer_and_says_whether_there_is_work() {
    let world = world().await;
    let triggers = world.triggers(true);
    triggers.start();
    assert!(triggers.poller().is_polling());
    assert!(!triggers.begin_quit());
    assert!(!triggers.poller().is_polling());
    assert!(world.runtime().is_quitting());

    tokio::time::resume();
    let world = world_with(Options::default()).await;
    let triggers = world.triggers(true);
    notify(&triggers, MACRO);
    assert!(triggers.begin_quit());
    assert_eq!(triggers.flusher().due_in(), None);
}

#[tokio::test]
async fn the_quit_waits_for_the_running_flush_then_flushes_the_rest() {
    let world = world().await;
    let triggers = world.triggers(true);
    world.pending.notify_change(MACRO);
    world.drive.hold(DriveOp::Create, None);
    let running = triggers.flush_pending();
    let quit = async {
        until_held(&world).await;
        notify(&triggers, TAP);
        assert!(triggers.begin_quit());
        let phases = async {
            world.runtime().password_change_ended().await;
            triggers.in_flight_pass_ended().await;
            triggers.flush_pending().await;
        };
        let open = async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            world.drive.open_gate();
        };
        tokio::join!(phases, open);
    };
    tokio::join!(running, quit);
    assert!(!world.pending.has_pending_changes());
    let requests = world.requests();
    assert_eq!((uploads(&world, &requests, MACRO), uploads(&world, &requests, TAP)), (1, 1));
    assert_eq!(triggers.flusher().due_in(), None, "nothing is scheduled while quitting");
}

#[tokio::test]
async fn the_quit_flush_waits_for_the_lock_for_as_long_as_it_is_held() {
    let world = world().await;
    let triggers = world.triggers(true);
    world.pending.notify_change(MACRO);
    let first = world.runtime().try_claim_sync_lock(false).unwrap();
    assert!(triggers.begin_quit());
    let mut second = None;
    let flush = triggers.flush_pending();
    let holders = async {
        tokio::time::sleep(Duration::from_millis(1)).await;
        drop(first);
        second = world.runtime().try_claim_sync_lock(false);
        tokio::time::sleep(Duration::from_secs(10)).await;
        second.take();
    };
    tokio::join!(flush, holders);
    assert!(!world.pending.has_pending_changes());
}

#[tokio::test]
async fn the_quit_deadline_leaves_an_upload_that_never_ends_pending() {
    let world = world().await;
    let triggers = world.triggers(true);
    world.pending.notify_change(MACRO);
    world.drive.hold(DriveOp::Create, None);
    assert!(triggers.begin_quit());
    let phases = async {
        triggers.in_flight_pass_ended().await;
        triggers.flush_pending().await;
    };
    assert!(tokio::time::timeout(Duration::from_secs(30), phases).await.is_err());
    assert_eq!(world.pending_units(), [MACRO]);
}
