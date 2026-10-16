// SPDX-License-Identifier: GPL-2.0-or-later
//! The password change on the in-memory Drive beyond the TypeScript
//! recording: a change interrupted at any Drive write is finished by the
//! next launch and never leaves a file neither password opens; the run
//! stops starting work once the app quits and ends only after the started
//! work; the refusals while other sync work runs; two machines on one
//! Drive; a peer writing with the old key between passes; and a change the
//! Electron build left behind.

#![allow(clippy::unwrap_used, clippy::panic)]

mod password_change_harness;

use password_change_harness::{Action, Machine, MachineOptions, World, WriteFailure};
use pipette_sync::password::change::{PasswordChangeRecovery, PasswordChangeStatus, PasswordChangeTuning};
use pipette_sync::password::change_error::{ChangeErrorKey, PasswordChangeError};
use pipette_sync::password::guard::SyncBlockReason;
use pipette_sync::password::state::{ChangeKeysFailure, ChangeStep, ChangeTarget};
use pipette_sync::preflight::PreflightError;
use pipette_sync_format::drive_names::{PASSWORD_CHANGE_LOCK_FILE, is_data_file_name};

const UNITS: [&str; 3] = ["favorites/macro", "keyboards/kb1/settings", "key-labels"];

fn options(chunk_size: usize, concurrency: usize) -> MachineOptions {
    MachineOptions {
        tuning: PasswordChangeTuning { chunk_size, concurrency, ..PasswordChangeTuning::default() },
        ..MachineOptions::default()
    }
}

/// A Drive on `old`: the password-check, the units and a second copy of
/// the first unit.
async fn seed_old(world: &World) {
    world.seed_password_check("old").await;
    for unit in UNITS {
        world.seed_data(unit, "old").await;
    }
    world.seed_data(UNITS[0], "old").await;
}

/// The password each data file and the password-check open with.
async fn openers(world: &World) -> Vec<(String, Option<String>)> {
    let mut openers = Vec::new();
    for stored in world.drive.inner.files() {
        let name = &stored.file.name;
        if is_data_file_name(name) || name == "password-check.enc" {
            openers.push((name.clone(), world.opener(&stored.file.id, &["old", "new"]).await));
        }
    }
    openers
}

fn lock_count(world: &World) -> usize {
    world.drive.inner.files().iter().filter(|stored| stored.file.name == PASSWORD_CHANGE_LOCK_FILE).count()
}

/// What must hold whenever a change has stopped: every file opens with the
/// old or the new password; while the state is past `locking` both keys
/// are kept; without a state, Drive is wholly on the stored password and
/// no lock of ours is left.
async fn assert_recoverable(world: &World, machine: &Machine, at: &str) {
    let openers = openers(world).await;
    for (name, opener) in &openers {
        assert!(opener.is_some(), "{at}: {name} opens with neither password");
    }
    match machine.state_file() {
        Some(state) if !state.contains("\"step\":\"locking\"") => {
            assert_eq!(machine.keys_summary().await, "old>new", "{at}: the keys of {state}");
        }
        Some(_) => {}
        None => {
            let stored = machine.passwords.get().unwrap();
            for (name, opener) in &openers {
                assert_eq!(opener.as_deref(), Some(stored.as_str()), "{at}: {name} without a change");
            }
            assert_eq!(lock_count(world), 0, "{at}: a lock without a change");
        }
    }
}

/// Finishes whatever the last run left, as the next launch and the user
/// would: the startup recovery, then a resume, or a new start when the
/// change was forgotten before it began.
async fn finish(world: &World, machine: &Machine, at: &str) -> Machine {
    let machine = world.restart(machine, options(1, 1));
    let recovery = machine.change.recover_on_startup().await;
    assert_ne!(recovery, PasswordChangeRecovery::Failed, "{at}");
    for _ in 0..3 {
        match machine.state_file() {
            Some(_) => machine.change.resume().await.unwrap_or_else(|err| panic!("{at}: resume: {err}")),
            None if machine.passwords.get().as_deref() == Some("old") => {
                machine.change.start("new").await.unwrap_or_else(|err| panic!("{at}: start: {err}"))
            }
            None => break,
        }
    }
    machine
}

/// Runs a change on a fresh Drive whose `nth` write fails as `failure`
/// (`None`: no failure), checks what it left, finishes it as the next
/// launch would and checks the end. Returns how many writes the first run
/// sent and whether the failure happened.
async fn interrupted_change(failure: Option<(u32, WriteFailure)>) -> (u64, bool) {
    let at = format!("{failure:?}");
    let world = World::new();
    let machine = world.machine("pc", options(1, 1));
    machine.passwords.set(Some("old"));
    seed_old(&world).await;
    if let Some((nth, failure)) = failure {
        world.drive.fail_write(nth, failure);
    }
    let writes_before = world.drive.writes();
    let first = machine.change.start("new").await;
    let writes = world.drive.writes() - writes_before;
    let failed = failure.is_some() && !world.drive.write_failure_pending();
    if !failed {
        first.unwrap_or_else(|err| panic!("{at}: {err}"));
    }
    assert_recoverable(&world, &machine, &at).await;

    let machine = finish(&world, &machine, &at).await;
    assert_eq!(machine.state_file(), None, "{at}");
    assert_eq!(machine.keys_summary().await, "noPasswordFile", "{at}");
    assert_eq!(machine.passwords.get().as_deref(), Some("new"), "{at}");
    for (name, opener) in openers(&world).await {
        assert_eq!(opener.as_deref(), Some("new"), "{at}: {name}");
    }
    assert_eq!(lock_count(&world), 0, "{at}");
    (writes, failed)
}

#[tokio::test]
async fn a_change_stopped_at_any_drive_write_is_finished_by_the_next_launch() {
    let (writes, _) = interrupted_change(None).await;
    assert!(writes >= 8, "the lock, the marker, a rename, four files, the password-check, the release");
    let writes = u32::try_from(writes).unwrap();
    let runs = [WriteFailure::Refused, WriteFailure::AnswerLost]
        .into_iter()
        .flat_map(|failure| (1..=writes).map(move |nth| interrupted_change(Some((nth, failure)))));
    for (writes, failed) in futures_util::future::join_all(runs).await {
        assert!(failed && writes > 0);
    }
}

#[tokio::test]
async fn quitting_starts_no_more_files_and_the_run_ends_after_the_started_ones() {
    let world = World::new();
    let machine = world.machine("pc", options(50, 3));
    machine.passwords.set(Some("old"));
    world.seed_password_check("old").await;
    for index in 0..6 {
        world.seed_data(&format!("favorites/f{index}"), "old").await;
    }
    // Every download waits a turn, so each lane starts its file before the
    // first one ends.
    world.drive.yield_downloads(true);
    world.drive.after_updates(1, Action::Quit);
    assert_eq!(
        machine.change.start("new").await,
        Err(PasswordChangeError::Change(ChangeErrorKey::Interrupted))
    );
    assert!(!machine.runtime.is_syncing() && !machine.runtime.password_change_running());
    let converted =
        openers(&world).await.iter().filter(|(_, opener)| opener.as_deref() == Some("new")).count();
    assert_eq!(converted, 3, "the three started files end; no other starts");
    assert!(machine.state_file().unwrap().contains("\"step\":\"reencrypting\""));
    assert_recoverable(&world, &machine, "quit").await;

    let machine = finish(&world, &machine, "quit").await;
    assert_eq!(machine.passwords.get().as_deref(), Some("new"));
}

#[tokio::test]
async fn nothing_starts_while_other_sync_work_runs_or_tokens_switch() {
    let world = World::new();
    let machine = world.machine("pc", MachineOptions::default());
    machine.passwords.set(Some("old"));
    seed_old(&world).await;
    let refused = Err(PasswordChangeError::Refused);

    let writer = machine.runtime.try_start_analytics_sync("kb").unwrap();
    world.drive.take_events();
    assert_eq!(machine.change.start("new").await, refused);
    assert_eq!(machine.change.abandon().await, refused);
    assert_eq!(machine.change.release_locks().await, Err(PasswordChangeError::ReleaseBusy));
    drop(writer);

    let switch = machine.runtime.try_begin_account_switch().unwrap();
    assert_eq!(machine.change.start("new").await, refused);
    machine.write_state_file(Some(
        r#"{"version":1,"target":"new","step":"locking","lockId":"l","startedAt":1}"#,
    ));
    assert_eq!(machine.change.recover_on_startup().await, PasswordChangeRecovery::Busy);
    drop(switch);

    let pass = machine.runtime.try_claim_sync_lock(true).unwrap();
    assert_eq!(machine.change.recover_on_startup().await, PasswordChangeRecovery::Busy);
    drop(pass);
    assert_eq!(world.drive.take_events(), Vec::<String>::new(), "no Drive request while refused");
    assert_eq!(machine.change.recover_on_startup().await, PasswordChangeRecovery::Abandoned);
}

#[tokio::test]
async fn another_machine_waits_for_the_change_and_then_re_enters_the_new_password() {
    let world = World::new();
    let changer = world.machine("a", options(1, 1));
    let other = world.machine(
        "b",
        MachineOptions { machine_hash: "other-hash".into(), first_lock_id: 1000, ..options(1, 1) },
    );
    changer.passwords.set(Some("old"));
    other.passwords.set(Some("old"));
    seed_old(&world).await;
    world.drive.set_quit_target(changer.runtime.clone());
    world.drive.after_updates(2, Action::Quit);
    assert!(changer.change.start("new").await.is_err());

    assert_eq!(
        other.preflight.assert_sync_allowed(None).await,
        Err(PreflightError::Blocked(SyncBlockReason::BlockedByOtherDevice))
    );
    let status = other.change.lock_status().await.unwrap().unwrap();
    assert_eq!((status.started_at.as_deref(), status.own_machine), (Some("2026-10-16T00:00:00.000Z"), false));
    assert_eq!(other.change.status().await, PasswordChangeStatus::None);
    assert_eq!(
        changer.preflight.assert_sync_allowed(None).await,
        Err(PreflightError::Blocked(SyncBlockReason::BlockedLocal))
    );

    let changer = finish(&world, &changer, "two machines").await;
    assert_eq!(changer.passwords.get().as_deref(), Some("new"));
    other.preflight.assert_sync_allowed(None).await.unwrap();
    let generation = other.preflight.sync_format_generation();
    let listing = other.preflight.drive().list_files(None).await.unwrap();
    assert_eq!(
        other.preflight.ensure_password_check_validated("old", &listing, generation).await,
        Err(PreflightError::PasswordMismatch)
    );
    other.preflight.replace_password_and_validate("new").await.unwrap();
    assert_eq!(other.passwords.get().as_deref(), Some("new"));
}

#[tokio::test]
async fn of_two_machines_changing_at_once_one_wins_and_drive_stays_on_one_password() {
    let world = World::new();
    let a = world.machine("a", options(50, 3));
    let b = world.machine(
        "b",
        MachineOptions { machine_hash: "b-hash".into(), first_lock_id: 1000, ..options(50, 3) },
    );
    for machine in [&a, &b] {
        machine.passwords.set(Some("old"));
    }
    seed_old(&world).await;
    let (ra, rb) = tokio::join!(a.change.start("new-a"), b.change.start("new-b"));
    let lost = |result: &Result<(), PasswordChangeError>| {
        matches!(result, Err(PasswordChangeError::Change(ChangeErrorKey::Locked | ChangeErrorKey::Lost)))
    };
    let (winner, loser) = match (&ra, &rb) {
        (Ok(()), result) if lost(result) => ("new-a", &b),
        (result, Ok(())) if lost(result) => ("new-b", &a),
        other => panic!("one change wins and the other stops: {other:?}"),
    };
    assert_eq!(loser.state_file(), None);
    assert_eq!(loser.keys_summary().await, "noPasswordFile");
    assert_eq!(lock_count(&world), 0);
    for stored in world.drive.inner.files() {
        let name = &stored.file.name;
        if is_data_file_name(name) || name == "password-check.enc" {
            let opener = world.opener(&stored.file.id, &["old", "new-a", "new-b"]).await;
            assert_eq!(opener.as_deref(), Some(winner), "{name}");
        }
    }
}

#[tokio::test]
async fn a_file_written_back_with_the_old_password_between_passes_is_converted_again() {
    let world = World::new();
    let machine = world.machine("pc", options(50, 1));
    machine.passwords.set(Some("old"));
    world.seed_password_check("old").await;
    let first = world.seed_data(UNITS[0], "old").await;
    world.seed_data(UNITS[1], "old").await;
    let stale = world.drive.content(&first.id).unwrap();
    world.drive.after_updates(1, Action::Rewrite(first.id.clone(), String::from_utf8(stale).unwrap()));
    world.drive.take_events();
    machine.change.start("new").await.unwrap();
    let updates =
        world.drive.take_events().iter().filter(|event| **event == format!("update:{}", first.id)).count();
    assert_eq!(updates, 2, "converted in the first pass and again in the second");
    for (name, opener) in openers(&world).await {
        assert_eq!(opener.as_deref(), Some("new"), "{name}");
    }
}

#[tokio::test]
async fn files_that_keep_changing_stop_the_commit_and_keep_the_change() {
    let world = World::new();
    let machine = world.machine(
        "pc",
        MachineOptions {
            tuning: PasswordChangeTuning { chunk_size: 50, concurrency: 1, max_passes: 1 },
            ..MachineOptions::default()
        },
    );
    machine.passwords.set(Some("old"));
    seed_old(&world).await;
    assert_eq!(
        machine.change.start("new").await,
        Err(PasswordChangeError::Change(ChangeErrorKey::NotConverged))
    );
    assert!(machine.state_file().unwrap().contains("\"step\":\"reencrypting\""));
    assert_eq!(machine.passwords.get().as_deref(), Some("old"));
    assert_recoverable(&world, &machine, "not converged").await;
}

/// A userData the Electron build shares (M8): its state file is read as
/// it is, its keys file is not, so the change waits as one whose keys
/// cannot be read and can only be abandoned here; the Electron keys file
/// is left alone.
#[tokio::test]
async fn a_change_the_electron_build_left_reads_as_one_without_keys() {
    let world = World::new();
    let machine = world.machine("pc", MachineOptions::default());
    machine.passwords.set(Some("old"));
    world.seed_password_check("old").await;
    world.seed_data(UNITS[0], "new").await;
    let lock = world.seed_lock("electron-lock", "golden-hash").await;
    machine.write_state_file(Some(&format!(
        r#"{{"version":1,"target":"new","step":"reencrypting","lockId":"electron-lock","lockFileId":"{}","startedAt":1792108800000}}"#,
        lock.id
    )));
    let electron_keys = machine.secrets.auth_dir().join("sync-password-change-keys.enc");
    std::fs::write(&electron_keys, b"safeStorage bytes").unwrap();

    assert_eq!(machine.change.recover_on_startup().await, PasswordChangeRecovery::AwaitingUser);
    assert_eq!(
        machine.change.status().await,
        PasswordChangeStatus::KeysUnavailable {
            reason: ChangeKeysFailure::NoPasswordFile,
            target: ChangeTarget::New,
            step: ChangeStep::Reencrypting,
            started_at: 1_792_108_800_000.0,
        }
    );
    let keys_unavailable = Err(PasswordChangeError::Change(ChangeErrorKey::KeysUnavailable));
    assert_eq!(machine.change.resume().await, keys_unavailable);
    assert_eq!(machine.change.revert().await, keys_unavailable);
    assert_eq!(
        machine.preflight.assert_sync_allowed(None).await,
        Err(PreflightError::Blocked(SyncBlockReason::BlockedLocal))
    );

    machine.change.abandon().await.unwrap();
    assert_eq!(machine.state_file(), None);
    assert_eq!(lock_count(&world), 0);
    assert_eq!(std::fs::read(&electron_keys).unwrap(), b"safeStorage bytes");
    machine.preflight.assert_sync_allowed(None).await.unwrap();
}

/// Keys without a state are left by a start that never wrote its state,
/// unless a change runs: then its state may be written right after the
/// recovery's read, and its keys must stay.
#[tokio::test]
async fn the_startup_recovery_keeps_the_keys_of_a_running_change() {
    let world = World::new();
    let machine = world.machine("pc", MachineOptions::default());
    machine.store_keys("old", "new").await;
    let run = machine.runtime.try_start_password_change().unwrap();
    assert_eq!(machine.change.recover_on_startup().await, PasswordChangeRecovery::None);
    assert_eq!(machine.keys_summary().await, "old>new");
    drop(run);
    assert_eq!(machine.change.recover_on_startup().await, PasswordChangeRecovery::None);
    assert_eq!(machine.keys_summary().await, "noPasswordFile");
}
