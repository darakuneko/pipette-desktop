// SPDX-License-Identifier: GPL-2.0-or-later
//! The resets and deletes of synced data (pipette_sync::reset) on the in-memory
//! Drive and a real userData, with the rest of the app as fakes.

#![allow(clippy::unwrap_used, clippy::panic)]

mod preflight_harness;
mod reset_harness;

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use pipette_drive::DriveApi;
use pipette_drive::fake::DriveOp;
use pipette_sync::format::SYNC_FORMAT_VERSION;
use pipette_sync::reset::targets::{KeyboardTargets, LocalResetTargets, SyncResetTargets};
use reset_harness::{Options, World, write};

const META: &str = "sync/meta/keyboard-names.json";

fn meta(entries: &str) -> String {
    format!(r#"{{"type":"keyboard-meta","version":1,"entries":[{entries}]}}"#)
}

fn pending_file(units: &[&str]) -> String {
    let units: Vec<String> = units.iter().map(|unit| format!("\"{unit}\"")).collect();
    format!(r#"{{"version":1,"owner":null,"units":[{}],"held":{{}}}}"#, units.join(","))
}

/// Two keyboards with settings, favorites and the global units, each
/// pending.
fn seed_local(root: &Path) {
    write(root, "sync/keyboards/uid1/pipette_settings.json", "{}");
    write(root, "sync/keyboards/uid2/pipette_settings.json", "{}");
    write(root, "sync/favorites/macro/index.json", "{}");
    write(root, "sync/typing-test-texts/index.json", "{}");
    write(root, "sync/key-labels/index.json", "{}");
    write(root, "sync/i18n/index.json", "{}");
    write(root, "sync/themes/index.json", "{}");
    write(root, META, &meta(r#"{"uid":"uid1","deviceName":"One","updatedAt":"2026-10-01T00:00:00.000Z"}"#));
    write(root, "local/auth/oauth-tokens.enc", "0.4");
    write(root, "local/auth/tauri-sync-password.bin", "tauri");
    write(root, "local/downloads/languages/tatoeba/en.json", "[]");
    write(root, "local/logs/main.log", "log");
    write(
        root,
        "local/sync-pending.json",
        &pending_file(&[
            "keyboards/uid1/settings",
            "keyboards/uid2/settings",
            "favorites/macro",
            "typing-test-texts",
            "key-labels",
            "i18n/index",
            "themes/index",
        ]),
    );
}

fn local_targets(keyboards: bool, favorites: bool, app_settings: bool) -> LocalResetTargets {
    LocalResetTargets { keyboards, favorites, app_settings, i18n_packs: false, theme_packs: false }
}

fn sync_targets(keyboards: KeyboardTargets) -> SyncResetTargets {
    SyncResetTargets {
        keyboards,
        favorites: false,
        i18n_packs: false,
        theme_packs: false,
        key_labels: false,
        typing_test_texts: false,
    }
}

fn names(w: &World) -> Vec<String> {
    let mut names: Vec<String> = w.names().into_iter().map(|(_, name)| name).collect();
    names.sort();
    names
}

// ---- SYNC_DELETE_FILES ----

#[tokio::test]
async fn delete_files_deletes_every_id_in_one_batch_and_reports_failed_deletes() {
    let w = World::new(|_| {});
    let a = w.add("favorites_macro.enc").await;
    let b = w.add("favorites_combo.enc").await;
    w.resets.delete_files(std::slice::from_ref(&a.id)).await.unwrap();
    assert_eq!(names(&w), ["favorites_combo.enc"]);

    w.drive.fail_next(DriveOp::Delete);
    let refusal = w.resets.delete_files(&[b.id.clone(), "gone".into()]).await.unwrap_err().to_string();
    assert!(refusal.starts_with("Failed to delete 1 of 2 files: "), "{refusal}");
    assert!(!w.runtime.is_syncing());
}

#[tokio::test]
async fn delete_files_is_refused_while_a_sync_holds_the_lock_and_by_the_guards() {
    let w = World::new(|_| {});
    let a = w.add("favorites_macro.enc").await;
    {
        let _lock = w.runtime.try_claim_sync_lock(false).unwrap();
        let refusal = w.resets.delete_files(std::slice::from_ref(&a.id)).await.unwrap_err();
        assert_eq!(refusal.to_string(), "sync.deleteBusy");
    }
    w.add(&format!("sync-format-v{}.json", SYNC_FORMAT_VERSION + 1)).await;
    let refusal = w.resets.delete_files(std::slice::from_ref(&a.id)).await.unwrap_err();
    assert_eq!(refusal.to_string(), "sync.updateRequired");
    assert!(names(&w).contains(&"favorites_macro.enc".to_owned()));
    assert!(!w.runtime.is_syncing());
}

// ---- SYNC_RESET_TARGETS ----

#[tokio::test]
async fn reset_targets_delete_every_copy_of_the_exact_name_and_its_trash_and_nothing_else() {
    let w = World::new(seed_local);
    w.add("key-labels.enc").await;
    w.add("key-labels.enc").await;
    w.add_trash("key-labels.enc", 100).await;
    let forged = w.add("key-labels.enc").await;
    w.drive.inner.rename(forged.id.clone(), "key-labels.enc.trash.100.50.fake-1".into()).await.unwrap();
    w.add("key-labels.enc.bak").await;

    let targets = SyncResetTargets { key_labels: true, ..sync_targets(KeyboardTargets::None) };
    w.resets.reset_sync_targets(&targets).await.unwrap();

    assert_eq!(names(&w), ["key-labels.enc.bak", "key-labels.enc.trash.100.50.fake-1"]);
    assert!(!w.pending_units().contains(&"key-labels".to_owned()));
    assert!(w.pending_units().contains(&"typing-test-texts".to_owned()));
}

#[tokio::test]
async fn reset_targets_of_keyboards_delete_their_files_and_tombstone_their_names() {
    let w = World::new(seed_local);
    w.add("keyboards_uid1_settings.enc").await;
    w.add_trash("keyboards_uid1_snapshots.enc", 100).await;
    w.add("keyboards_uid2_settings.enc").await;

    w.resets.reset_sync_targets(&sync_targets(KeyboardTargets::Uids(vec!["uid1".into()]))).await.unwrap();

    assert_eq!(names(&w), ["keyboards_uid2_settings.enc"]);
    let meta = std::fs::read_to_string(w.root.join(META)).unwrap();
    assert!(meta.contains(r#""deletedAt": "2026-10-16T00:00:00.000Z""#), "{meta}");
    assert_eq!(*w.notified.lock().unwrap(), ["meta/keyboard-names"]);
    let units = w.pending_units();
    assert!(!units.contains(&"keyboards/uid1/settings".to_owned()));
    assert!(units.contains(&"keyboards/uid2/settings".to_owned()));
    assert!(units.contains(&"meta/keyboard-names".to_owned()));
    // The local files stay: this reset is of Drive.
    assert!(w.exists("sync/keyboards/uid1/pipette_settings.json"));
}

#[tokio::test]
async fn reset_targets_of_every_keyboard_tombstone_every_name_and_notify_only_when_some_were_active() {
    let w = World::new(seed_local);
    w.add("keyboards_uid1_settings.enc").await;
    w.add("favorites_macro.enc").await;
    w.resets.reset_sync_targets(&sync_targets(KeyboardTargets::All)).await.unwrap();
    assert_eq!(names(&w), ["favorites_macro.enc"]);
    assert_eq!(*w.notified.lock().unwrap(), ["meta/keyboard-names"]);

    w.resets.reset_sync_targets(&sync_targets(KeyboardTargets::All)).await.unwrap();
    assert_eq!(w.notified.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn reset_targets_name_the_targets_whose_delete_failed_and_still_attempt_the_rest() {
    let w = World::new(seed_local);
    w.add("key-labels.enc").await;
    w.add("typing-test-texts.enc").await;
    w.drive.fail_next(DriveOp::Delete);

    let targets =
        SyncResetTargets { key_labels: true, typing_test_texts: true, ..sync_targets(KeyboardTargets::None) };
    let refusal = w.resets.reset_sync_targets(&targets).await.unwrap_err().to_string();

    assert_eq!(refusal, "Failed to delete remote data for: keyLabels");
    assert_eq!(names(&w), ["key-labels.enc"]);
}

#[tokio::test]
async fn reset_targets_are_refused_while_a_password_change_runs_and_cancel_nothing() {
    let w = World::new(seed_local);
    w.add("key-labels.enc").await;
    w.add("password-change-lock.json").await;
    let before = w.pending_units();

    let targets =
        SyncResetTargets { key_labels: true, favorites: true, ..sync_targets(KeyboardTargets::All) };
    let refusal = w.resets.reset_sync_targets(&targets).await.unwrap_err();

    assert_eq!(refusal.to_string(), "sync.passwordChange.blockedByOtherDevice");
    assert_eq!(w.pending_units(), before);
    assert!(names(&w).contains(&"key-labels.enc".to_owned()));
    assert!(!w.runtime.is_syncing() && !w.runtime.reset_holds_keyboard("uid1"));
}

#[tokio::test]
async fn resets_of_a_keyboard_are_refused_while_its_analytics_sync_or_day_fetch_runs() {
    let w = World::new(seed_local);
    let writer = w.runtime.try_start_analytics_sync("uid1").unwrap();
    let busy = |result: Result<(), pipette_sync::data_error::DataError>| result.unwrap_err().to_string();
    let uid1 = sync_targets(KeyboardTargets::Uids(vec!["uid1".into()]));
    assert_eq!(busy(w.resets.reset_sync_targets(&uid1).await), "sync.resetBusy");
    assert_eq!(
        busy(w.resets.reset_sync_targets(&sync_targets(KeyboardTargets::All)).await),
        "sync.resetBusy"
    );
    assert_eq!(busy(w.resets.reset_keyboard_data("uid1").await), "sync.resetBusy");
    assert_eq!(
        busy(w.resets.reset_local_targets(&local_targets(true, false, false)).await),
        "sync.resetBusy"
    );
    assert!(w.exists("sync/keyboards/uid1"));

    // Other keyboards and the global targets run.
    let favorites = SyncResetTargets { favorites: true, ..sync_targets(KeyboardTargets::None) };
    w.resets.reset_sync_targets(&favorites).await.unwrap();
    w.resets.reset_keyboard_data("uid2").await.unwrap();
    w.resets.reset_local_targets(&local_targets(false, true, false)).await.unwrap();
    drop(writer);

    let fetch = w.runtime.try_start_remote_day_fetch("uid1").unwrap();
    assert_eq!(busy(w.resets.reset_keyboard_data("uid1").await), "sync.resetBusy");
    drop(fetch);
}

// ---- RESET_KEYBOARD_DATA ----

#[tokio::test]
async fn reset_keyboard_cancels_cleans_the_analytics_cancels_again_then_removes() {
    let w = World::new(seed_local);
    w.add("keyboards_uid1_settings.enc").await;
    w.add("keyboards_uid2_settings.enc").await;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (sink, pending, root) = (seen.clone(), w.pending.clone(), w.root.clone());
    *w.hooks.probe.lock().unwrap() = Some(Box::new(move |entry| {
        if entry.starts_with("typing:") {
            let units: Vec<String> =
                pending.snapshot_generations().keys().map(|u| u.to_string_lossy().into_owned()).collect();
            sink.lock().unwrap().push((units, root.join("sync/keyboards/uid1").exists()));
            // The cleanup's flush marks the keyboard's units pending.
            pending.notify_change("keyboards/uid1/devices/h/days/2026-10-15");
        }
    }));

    w.resets.reset_keyboard_data("uid1").await.unwrap();

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert!(!seen[0].0.iter().any(|unit| unit.starts_with("keyboards/uid1/")));
    assert!(seen[0].1, "the directory is removed after the cleanup");
    assert_eq!(w.log(), ["typing:uid1"]);
    assert!(!w.exists("sync/keyboards/uid1"));
    assert!(w.exists("sync/keyboards/uid2"));
    assert_eq!(names(&w), ["keyboards_uid2_settings.enc"]);
    let units = w.pending_units();
    assert!(!units.iter().any(|unit| unit.starts_with("keyboards/uid1/")));
    assert!(units.contains(&"meta/keyboard-names".to_owned()));
    assert!(!w.runtime.is_syncing() && !w.runtime.reset_holds_keyboard("uid1"));
}

#[tokio::test]
async fn reset_keyboard_resets_locally_but_skips_drive_when_it_cannot_be_checked_or_needs_a_newer_app() {
    let w = World::new(seed_local);
    w.add("keyboards_uid1_settings.enc").await;
    w.drive.fail_next(DriveOp::List);
    w.resets.reset_keyboard_data("uid1").await.unwrap();
    assert!(!w.exists("sync/keyboards/uid1"));
    assert_eq!(names(&w), ["keyboards_uid1_settings.enc"]);

    let w = World::new(seed_local);
    w.add("keyboards_uid1_settings.enc").await;
    w.add(&format!("sync-format-v{}.json", SYNC_FORMAT_VERSION + 1)).await;
    w.resets.reset_keyboard_data("uid1").await.unwrap();
    assert!(!w.exists("sync/keyboards/uid1"));
    assert!(names(&w).contains(&"keyboards_uid1_settings.enc".to_owned()));
}

#[tokio::test]
async fn reset_keyboard_is_refused_while_a_password_change_is_in_progress() {
    let w = World::new(seed_local);
    w.local_password_change();
    let before = w.pending_units();

    let refusal = w.resets.reset_keyboard_data("uid1").await.unwrap_err();

    assert_eq!(refusal.to_string(), "sync.passwordChange.blockedLocal");
    assert!(w.exists("sync/keyboards/uid1"));
    assert_eq!(w.pending_units(), before);
    assert!(w.log().is_empty());
}

#[tokio::test]
async fn resets_delete_nothing_and_release_the_lock_when_the_pending_state_cannot_be_written() {
    // A pending file that cannot be read at startup is never written.
    let seed = |root: &Path| {
        seed_local(root);
        std::fs::remove_file(root.join("local/sync-pending.json")).unwrap();
        std::fs::create_dir_all(root.join("local/sync-pending.json")).unwrap();
    };
    let unreadable = "The pending sync changes file cannot be read; restart Pipette and try again";
    let w = World::new(seed);
    w.add("keyboards_uid1_settings.enc").await;

    let uid1 = sync_targets(KeyboardTargets::Uids(vec!["uid1".into()]));
    assert_eq!(w.resets.reset_sync_targets(&uid1).await.unwrap_err().to_string(), unreadable);
    assert_eq!(w.resets.reset_keyboard_data("uid1").await.unwrap_err().to_string(), unreadable);
    let all = local_targets(true, true, true);
    assert_eq!(w.resets.reset_local_targets(&all).await.unwrap_err().to_string(), unreadable);

    assert_eq!(names(&w), ["keyboards_uid1_settings.enc"]);
    assert!(w.exists("sync/keyboards/uid1") && w.exists("local/auth/oauth-tokens.enc"));
    assert!(w.log().is_empty());
    assert!(!w.runtime.is_syncing());
}

// ---- RESET_LOCAL_TARGETS ----

#[tokio::test]
async fn reset_local_clears_the_analytics_of_every_local_and_cached_keyboard_then_removes_them() {
    let w = World::new(seed_local);
    *w.hooks.typing_keyboards.lock().unwrap() = Ok(vec!["uid2".into(), "uid3".into()]);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (sink, pending) = (seen.clone(), w.pending.clone());
    *w.hooks.probe.lock().unwrap() = Some(Box::new(move |_| {
        sink.lock().unwrap().push(pending.pending_generation_of("keyboards/uid1/settings"));
        pending.notify_change("keyboards/uid1/devices/h/days/2026-10-15");
    }));

    w.resets.reset_local_targets(&local_targets(true, false, false)).await.unwrap();

    assert_eq!(w.log(), ["typing:uid1", "typing:uid2", "typing:uid3"]);
    assert_eq!(*seen.lock().unwrap(), [0, 0, 0]);
    assert!(!w.exists("sync/keyboards"));
    assert!(!w.pending_units().iter().any(|unit| unit.starts_with("keyboards/")));
    assert!(w.exists("sync/favorites") && w.exists("local/auth"));
}

#[tokio::test]
async fn reset_local_still_removes_the_keyboards_when_an_analytics_cleanup_fails() {
    let w = World::new(seed_local);
    *w.hooks.typing_keyboards.lock().unwrap() = Err("db closed".into());
    *w.hooks.failing_typing_uid.lock().unwrap() = Some("uid1".into());

    w.resets.reset_local_targets(&local_targets(true, false, false)).await.unwrap();

    assert_eq!(w.log(), ["typing:uid1", "typing:uid2"]);
    assert!(!w.exists("sync/keyboards"));
}

#[tokio::test]
async fn reset_local_of_favorites_removes_the_global_content_and_cancels_it_in_one_call() {
    let w = World::new(seed_local);
    let targets = LocalResetTargets { theme_packs: true, ..local_targets(false, true, false) };

    w.resets.reset_local_targets(&targets).await.unwrap();

    for gone in ["sync/favorites", "sync/typing-test-texts", "sync/key-labels", "sync/themes"] {
        assert!(!w.exists(gone), "{gone}");
    }
    assert!(w.exists("sync/i18n") && w.exists("sync/keyboards/uid1"));
    assert_eq!(w.pending_units(), ["i18n/index", "keyboards/uid1/settings", "keyboards/uid2/settings"]);
    assert!(w.log().is_empty(), "no sign-out and no analytics cleanup");
}

#[tokio::test]
async fn reset_local_of_app_settings_is_refused_while_a_local_password_change_exists() {
    let w = World::new(seed_local);
    w.local_password_change();
    let before = w.pending_units();

    let refusal = w.resets.reset_local_targets(&local_targets(true, false, true)).await.unwrap_err();

    assert_eq!(refusal.to_string(), "sync.passwordChange.blockedLocal");
    assert!(w.exists("local/auth/oauth-tokens.enc") && w.exists("sync/keyboards"));
    assert_eq!(w.pending_units(), before);

    // Without app settings the password change is not checked.
    w.resets.reset_local_targets(&local_targets(true, false, false)).await.unwrap();
}

#[tokio::test]
async fn reset_local_signs_out_right_after_the_cancel_and_before_removing_anything() {
    let w = World::new(seed_local);
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (sink, pending, root) = (seen.clone(), w.pending.clone(), w.root.clone());
    *w.hooks.probe.lock().unwrap() = Some(Box::new(move |entry| {
        if entry == "signOutLocked" {
            let present = ["sync/keyboards", "sync/favorites", "local/auth", "local/logs"]
                .iter()
                .all(|path| root.join(path).exists());
            sink.lock().unwrap().push((pending.has_pending_changes(), present));
        }
    }));
    let targets =
        LocalResetTargets { i18n_packs: true, theme_packs: true, ..local_targets(true, true, true) };

    w.resets.reset_local_targets(&targets).await.unwrap();

    assert_eq!(*seen.lock().unwrap(), [(false, true)], "every unit cancelled, nothing removed yet");
    assert_eq!(
        w.log(),
        [
            "signOutLocked",
            "stopPolling",
            "typing:uid1",
            "typing:uid2",
            "clearConfig",
            "forgetKey",
            "clearLogs"
        ]
    );
    for gone in [
        "sync/keyboards",
        "sync/favorites",
        "sync/i18n",
        "sync/themes",
        "local/auth",
        "local/downloads/languages",
        "local/logs",
    ] {
        assert!(!w.exists(gone), "{gone}");
    }
    assert!(w.exists("local/installation-id") && w.exists(META));
}

#[tokio::test]
async fn reset_local_forgets_the_cached_password_change_state_when_it_removes_local_auth() {
    let w = World::new(seed_local);
    // A state file read as absent and cached as such, then written behind
    // the cache: removing `local/auth/` must not leave the cache saying
    // anything about a file that is gone.
    assert!(w.preflight.local_sync_block().await.is_none());
    w.resets.reset_local_targets(&local_targets(false, false, true)).await.unwrap();
    write(&w.root, "local/auth/sync-password-change.json", "{}");
    assert!(w.preflight.local_sync_block().await.is_some());
}

#[tokio::test]
async fn reset_local_removes_nothing_and_keeps_polling_when_the_sign_out_fails() {
    let w = World::new(seed_local);
    *w.hooks.sign_out_error.lock().unwrap() = Some("EACCES: sync-pending.json".into());
    let before = w.pending_units();

    let refusal = w.resets.reset_local_targets(&local_targets(true, true, true)).await.unwrap_err();

    assert_eq!(refusal.to_string(), "EACCES: sync-pending.json");
    assert_eq!(w.log(), ["signOutLocked"]);
    assert!(w.exists("sync/keyboards") && w.exists("sync/favorites") && w.exists("local/auth"));
    assert_eq!(w.pending_units(), before, "the cancelled units are back");
    assert!(!w.runtime.is_syncing());
}

#[tokio::test]
async fn reset_local_keeps_a_unit_saved_during_the_failing_sign_out_when_it_puts_the_cancelled_units_back() {
    let w = World::new(seed_local);
    let tap_dance = w.pending.pending_generation_of("favorites/macro");
    *w.hooks.sign_out_error.lock().unwrap() = Some("EACCES".into());
    let saved = Arc::new(Mutex::new(0));
    let (sink, pending) = (saved.clone(), w.pending.clone());
    *w.hooks.probe.lock().unwrap() = Some(Box::new(move |_| {
        pending.notify_change("favorites/combo");
        *sink.lock().unwrap() = pending.pending_generation_of("favorites/combo");
    }));

    w.resets.reset_local_targets(&local_targets(false, true, true)).await.unwrap_err();

    assert!(w.pending_units().contains(&"favorites/combo".to_owned()));
    assert_eq!(w.pending.pending_generation_of("favorites/combo"), *saved.lock().unwrap());
    assert_eq!(w.pending.pending_generation_of("favorites/macro"), tap_dance);
}

#[tokio::test]
async fn reset_local_without_app_settings_stays_signed_in() {
    let w = World::new(seed_local);
    w.resets.reset_local_targets(&local_targets(false, true, false)).await.unwrap();
    assert!(!w.log().contains(&"signOutLocked".to_owned()));
    assert!(w.exists("local/auth/oauth-tokens.enc"));
}

#[tokio::test]
async fn reset_local_of_app_settings_holds_the_signed_in_accounts_units_for_its_next_sign_in() {
    let options = Options { account: Some(Some("sub-a".into())) };
    let w = World::with(options, seed_local);
    w.sign_in.0.store(true, Ordering::SeqCst);

    w.resets.reset_local_targets(&local_targets(false, false, true)).await.unwrap();

    assert_eq!(w.log(), ["signOutLocked", "signOut", "stopPolling", "clearConfig", "forgetKey", "clearLogs"]);
    // The units were ownerless: the signed-in account claims them, and they
    // are held for it.
    assert!(w.pending_units().is_empty());
    let held = w.pending.held();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0].0.to_string_lossy(), "sub-a");
    assert_eq!(held[0].1.len(), 7);
    assert!(!w.runtime.is_syncing());
}
