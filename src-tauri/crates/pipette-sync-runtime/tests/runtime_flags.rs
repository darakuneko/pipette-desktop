// SPDX-License-Identifier: GPL-2.0-or-later
//! The password change, the token switch, the quit, the waits for the
//! holder of the sync lock and the memory the clones share.

#![allow(clippy::unwrap_used)]

use std::time::Duration;

use pipette_sync_runtime::runtime::DELETE_BUSY_MESSAGE;
use pipette_sync_runtime::{RemoteRevision, ResetKeyboards, SyncRuntime};
use tokio::time::Instant;

#[tokio::test]
async fn a_password_change_holds_the_lock_and_blocks_the_lock_free_writers() {
    let runtime = SyncRuntime::new();
    let run = runtime.try_start_password_change().unwrap();
    assert!(runtime.is_syncing() && !runtime.holder_is_waitable());
    assert!(runtime.password_change_running());
    assert!(runtime.lock_free_writer_blocked("a"));
    assert!(runtime.try_start_analytics_sync("a").is_none());
    assert!(runtime.try_start_remote_day_fetch("a").is_none());
    assert!(runtime.try_start_password_change().is_none());
    drop(run);
    assert!(!runtime.is_syncing() && !runtime.password_change_running());
    assert!(!runtime.lock_free_writer_blocked("a"));
    assert!(runtime.try_start_analytics_sync("a").is_some());
}

#[tokio::test]
async fn a_password_change_does_not_start_alongside_other_sync_work() {
    let runtime = SyncRuntime::new();
    let pass = runtime.try_claim_sync_lock(true).unwrap();
    assert!(runtime.sync_work_running());
    assert!(runtime.try_start_password_change().is_none());
    drop(pass);

    let writer = runtime.try_start_remote_day_fetch("a").unwrap();
    assert!(runtime.sync_work_running());
    assert!(runtime.try_start_password_change().is_none());
    drop(writer);

    let switch = runtime.try_begin_account_switch().unwrap();
    assert!(!runtime.sync_work_running());
    assert!(runtime.try_start_password_change().is_none());
    drop(switch);
    assert!(runtime.try_start_password_change().is_some());
}

#[tokio::test(start_paused = true)]
async fn waits_for_the_password_change_to_end() {
    let runtime = SyncRuntime::new();
    // At once when none runs.
    runtime.password_change_ended().await;
    let run = runtime.try_start_password_change().unwrap();
    let ender = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(4)).await;
        drop(run);
    });
    let started = Instant::now();
    runtime.password_change_ended().await;
    assert_eq!(started.elapsed(), Duration::from_secs(4));
    ender.await.unwrap();
    // The lock is released before the run ends.
    assert!(!runtime.is_syncing());
}

#[tokio::test]
async fn one_account_switch_at_a_time_blocks_the_lock_free_writers() {
    let runtime = SyncRuntime::new();
    let switch = runtime.try_begin_account_switch().unwrap();
    assert!(runtime.account_switching());
    assert!(runtime.try_begin_account_switch().is_none());
    assert!(runtime.lock_free_writer_blocked("a"));
    assert!(runtime.try_start_analytics_sync("a").is_none());
    // The switch is no lock: other work may still take it.
    assert!(!runtime.is_syncing());
    drop(switch);
    assert!(!runtime.account_switching() && !runtime.lock_free_writer_blocked("a"));
}

#[tokio::test]
async fn a_reset_blocks_only_the_writers_of_its_keyboards() {
    let runtime = SyncRuntime::new();
    let keyboards = ResetKeyboards::Uids(vec!["a".into()]);
    let blocked = runtime
        .with_reset_lock(&keyboards, DELETE_BUSY_MESSAGE, async {
            (runtime.lock_free_writer_blocked("a"), runtime.lock_free_writer_blocked("b"))
        })
        .await
        .unwrap();
    assert_eq!(blocked, (true, false));
}

#[tokio::test(start_paused = true)]
async fn claims_the_lock_when_the_holder_and_the_writers_are_done() {
    let runtime = SyncRuntime::new();
    let pass = runtime.try_claim_sync_lock(false).unwrap();
    let writer = runtime.try_start_analytics_sync("a").unwrap();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(2)).await;
        drop(pass);
        tokio::time::sleep(Duration::from_secs(3)).await;
        drop(writer);
    });
    let started = Instant::now();
    let claim = runtime.claim_sync_lock_when_idle_by(started + Duration::from_secs(30)).await;
    assert!(claim.idle);
    assert!(claim.lock.is_some() && runtime.holder_is_waitable());
    let waited = started.elapsed();
    assert!(waited >= Duration::from_secs(5) && waited < Duration::from_secs(6), "{waited:?}");
    drop(claim);
    assert!(!runtime.is_syncing());
}

#[tokio::test(start_paused = true)]
async fn reports_a_holder_or_a_writer_that_outlasts_the_deadline() {
    let runtime = SyncRuntime::new();
    let pass = runtime.try_claim_sync_lock(false).unwrap();
    let claim = runtime.claim_sync_lock_when_idle_by(Instant::now() + Duration::from_secs(1)).await;
    assert!(claim.lock.is_none() && !claim.idle);
    drop(pass);

    let _writer = runtime.try_start_remote_day_fetch("a").unwrap();
    let claim = runtime.claim_sync_lock_when_idle_by(Instant::now() + Duration::from_secs(1)).await;
    // The lock is held, for the caller to release.
    assert!(claim.lock.is_some() && !claim.idle);
    assert!(runtime.is_syncing());
}

#[tokio::test(start_paused = true)]
async fn waits_for_the_pass_in_flight() {
    let runtime = SyncRuntime::new();
    assert!(runtime.in_flight_pass().is_none());
    let pass = runtime.try_claim_sync_lock(true).unwrap();
    let in_flight = runtime.in_flight_pass().unwrap();
    assert!(in_flight.waitable());
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(3)).await;
        drop(pass);
    });
    let started = Instant::now();
    in_flight.released().await;
    assert_eq!(started.elapsed(), Duration::from_secs(3));
    let _flush = runtime.try_claim_sync_lock(false).unwrap();
    assert!(!runtime.in_flight_pass().unwrap().waitable());
}

#[tokio::test(start_paused = true)]
async fn quitting_is_for_good_and_wakes_the_waiters() {
    let runtime = SyncRuntime::new();
    assert!(!runtime.is_quitting());
    let waiter = runtime.clone();
    let waiting = tokio::spawn(async move { waiter.quitting().await });
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(!waiting.is_finished());
    runtime.set_quitting();
    waiting.await.unwrap();
    assert!(runtime.is_quitting());
    runtime.set_quitting();
    assert!(runtime.is_quitting());
    runtime.quitting().await;
}

#[test]
fn the_clones_share_the_memory() {
    let runtime = SyncRuntime::new();
    let clone = runtime.clone();
    clone.remote().record("a.enc", RemoteRevision { id: "1".into(), modified_time: "t".into() });
    clone.remote().remember_created_file("a.enc", "1");
    clone.credentials().forget_sync_format_marker();
    assert!(runtime.remote().is_known("a.enc", "1", "t"));
    assert_eq!(runtime.remote().created_file_id("a.enc").as_deref(), Some("1"));
    assert_eq!(runtime.credentials().sync_format().generation, 1);
    // A new runtime starts empty.
    assert!(!SyncRuntime::new().remote().is_known("a.enc", "1", "t"));
}
