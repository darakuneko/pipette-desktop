// SPDX-License-Identifier: GPL-2.0-or-later
//! The trash screen's actions (trash::manual), the cases of
//! src/main/sync/__tests__/sync-trash-manual.test.ts and of the trash
//! handlers in sync-ipc.test.ts, on the in-memory Drive.

#![allow(clippy::unwrap_used, clippy::panic)]

mod preflight_harness;
mod reset_harness;

use std::sync::atomic::Ordering;

use pipette_drive::trash_names::TRASH_QUARANTINE_MS;
use pipette_sync::data_error::DataError;
use pipette_sync::trash::manual::{
    SyncTrashFile, TRASH_NOT_FOUND_MESSAGE, TRASH_NOT_RESTORABLE_MESSAGE, TrashDeleteResult, delete_trash,
    delete_trash_files, list_trash_files, restore_trash, restore_trash_file, trash_file_keyboards,
};
use pipette_sync_runtime::ResetKeyboards;
use reset_harness::{NOW, World, refused};

const NAME: &str = "favorites_macro.enc";
const SETTINGS: &str = "keyboards_uid1_settings.enc";
const OWN_DAY: &str = "keyboards_uid1_devices_hash-own_days_2026-10-01.enc";

fn world() -> World {
    World::new(|_| {})
}

fn modified_ms(world: &World, id: &str) -> i64 {
    pipette_time::parse_date_time_string(&world.file(id).modified_time).unwrap()
}

fn name_of(world: &World, id: &str) -> String {
    world.file(id).name
}

fn is_trash(name: &str) -> bool {
    name.contains(".trash.")
}

async fn err<T: std::fmt::Debug>(result: impl std::future::Future<Output = Result<T, DataError>>) -> String {
    result.await.unwrap_err().to_string()
}

#[tokio::test]
async fn lists_trash_files_from_one_listing_the_most_recently_moved_first() {
    let w = world();
    w.add(NAME).await;
    let older = w.add_trash(NAME, 1000).await;
    let newer = w.add_trash(SETTINGS, 2000).await;
    w.add(&format!("{NAME}.trash.1.2.someone-else")).await;
    *w.hooked.lists.lock().unwrap() = 0;

    let files = list_trash_files(&w.trash_env(NOW)).await.unwrap();

    assert_eq!(files.len(), 2);
    assert_eq!(files[0].file_id, newer.id);
    assert_eq!(
        files[1],
        SyncTrashFile {
            file_id: older.id.clone(),
            original_name: NAME.into(),
            sync_unit: Some("favorites/macro".into()),
            // The modifiedTime it was created with (the fake Drive's second
            // tick), before it was moved.
            updated_at: 1_767_225_601_000,
            expires_at: 1000 + TRASH_QUARANTINE_MS,
            restorable: true,
        }
    );
    assert_eq!(files[0].sync_unit.as_deref(), Some("keyboards/uid1/settings"));
    assert_eq!(files[0].expires_at, 2000 + TRASH_QUARANTINE_MS);
    assert_eq!(*w.hooked.lists.lock().unwrap(), 1);
}

#[tokio::test]
async fn marks_this_machines_own_typing_days_as_not_restorable() {
    let w = world();
    let own = w.add_trash(OWN_DAY, 1000).await;
    let other = w.add_trash("keyboards_uid1_devices_hash-other_days_2026-10-01.enc", 1000).await;

    let files = list_trash_files(&w.trash_env(NOW)).await.unwrap();

    let restorable = |id: &str| files.iter().find(|f| f.file_id == id).unwrap().restorable;
    assert!(!restorable(&own.id));
    assert!(restorable(&other.id));
}

#[tokio::test]
async fn is_refused_with_a_readiness_key_without_credentials_before_listing_drive() {
    let w = world();
    w.sign_in.0.store(false, Ordering::SeqCst);
    let env = w.trash_env(NOW);

    let refusal = list_trash_files(&env).await.unwrap_err();
    assert_eq!(refusal.to_string(), "sync.readiness.unauthenticated");
    assert_eq!(refusal.reason(), Some("unauthenticated"));
    assert_eq!(err(restore_trash_file(&env, "x")).await, "sync.readiness.unauthenticated");
    assert_eq!(err(delete_trash_files(&env, &["x".into()])).await, "sync.readiness.unauthenticated");
    assert_eq!(err(trash_file_keyboards(&env, &["x".into()])).await, "sync.readiness.unauthenticated");
    assert_eq!(*w.hooked.lists.lock().unwrap(), 0);
}

#[tokio::test]
async fn is_refused_by_the_sync_guards() {
    let w = world();
    w.local_password_change();
    assert_eq!(err(list_trash_files(&w.trash_env(NOW))).await, "sync.passwordChange.blockedLocal");
    assert_eq!(*w.hooked.lists.lock().unwrap(), 0);

    let w = world();
    w.add("password-change-lock.json").await;
    assert_eq!(err(list_trash_files(&w.trash_env(NOW))).await, "sync.passwordChange.blockedByOtherDevice");
}

#[tokio::test]
async fn restore_swaps_every_current_copy_to_trash_then_renames_the_chosen_one_back() {
    let w = world();
    let live1 = w.add(NAME).await;
    let live2 = w.add(NAME).await;
    let pick = w.add_trash(NAME, 1000).await;
    let live1_modified = modified_ms(&w, &live1.id);

    restore_trash_file(&w.trash_env(NOW), &pick.id).await.unwrap();

    assert_eq!(name_of(&w, &pick.id), NAME);
    assert_eq!(name_of(&w, &live1.id), format!("{NAME}.trash.{NOW}.{live1_modified}.{}", live1.id));
    assert!(is_trash(&name_of(&w, &live2.id)));
}

#[tokio::test]
async fn restores_a_name_that_has_no_current_copy() {
    let w = world();
    let pick = w.add_trash(NAME, 1000).await;

    restore_trash_file(&w.trash_env(NOW), &pick.id).await.unwrap();

    assert_eq!(w.names(), vec![(pick.id, NAME.to_owned())]);
}

#[tokio::test]
async fn restore_is_refused_when_the_file_is_no_longer_a_trash_file() {
    let w = world();
    // The poll renamed it back after the screen listed it.
    let pick = w.add(NAME).await;
    let before = w.names();

    assert_eq!(err(restore_trash_file(&w.trash_env(NOW), &pick.id)).await, TRASH_NOT_FOUND_MESSAGE);
    assert_eq!(err(restore_trash_file(&w.trash_env(NOW), "gone")).await, TRASH_NOT_FOUND_MESSAGE);
    assert_eq!(w.names(), before);
}

#[tokio::test]
async fn restore_stops_before_renaming_back_when_a_current_copy_cannot_be_moved() {
    let w = world();
    let live = w.add(NAME).await;
    let pick = w.add_trash(NAME, 1000).await;
    let live_id = live.id.clone();
    *w.hooked.before_rename.lock().unwrap() = Some(Box::new(move |_, id, _| (id == live_id).then(refused)));

    let refusal = err(restore_trash_file(&w.trash_env(NOW), &pick.id)).await;

    assert!(refusal.starts_with("Failed to move 1 of 1 files to trash"), "{refusal}");
    assert_eq!(name_of(&w, &live.id), NAME);
    assert!(is_trash(&name_of(&w, &pick.id)));
}

#[tokio::test]
async fn restore_refuses_this_machines_own_typing_day() {
    let w = world();
    let own = w.add_trash(OWN_DAY, 1000).await;
    let before = w.names();

    let refusal = w
        .runtime
        .with_reset_lock(
            &ResetKeyboards::Uids(vec!["uid1".into()]),
            "busy",
            restore_trash_file(&w.trash_env(NOW), &own.id),
        )
        .await
        .unwrap();

    assert_eq!(refusal.unwrap_err().to_string(), TRASH_NOT_RESTORABLE_MESSAGE);
    assert_eq!(w.names(), before);
}

#[tokio::test]
async fn restore_refuses_a_keyboard_file_the_held_lock_does_not_cover() {
    let w = world();
    w.add(SETTINGS).await;
    let pick = w.add_trash(SETTINGS, 1000).await;
    let before = w.names();

    assert_eq!(err(restore_trash_file(&w.trash_env(NOW), &pick.id)).await, "sync.trashBusy");
    assert_eq!(w.names(), before);

    let keyboards = ResetKeyboards::Uids(vec!["uid1".into()]);
    w.runtime
        .with_reset_lock(&keyboards, "busy", restore_trash_file(&w.trash_env(NOW), &pick.id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(name_of(&w, &pick.id), SETTINGS);
}

#[tokio::test]
async fn restore_renames_the_moved_copies_back_when_the_final_rename_fails() {
    let w = world();
    let live = w.add(NAME).await;
    let pick = w.add_trash(NAME, 1000).await;
    let pick_id = pick.id.clone();
    *w.hooked.before_rename.lock().unwrap() =
        Some(Box::new(move |_, id, name| (id == pick_id && name == NAME).then(refused)));

    let refusal = err(restore_trash_file(&w.trash_env(NOW), &pick.id)).await;

    assert!(refusal.contains("Drive rename failed"), "{refusal}");
    assert_eq!(name_of(&w, &live.id), NAME);
    assert!(is_trash(&name_of(&w, &pick.id)));
}

#[tokio::test]
async fn restore_renames_the_moved_copies_back_when_the_file_vanished_before_the_final_rename() {
    let w = world();
    let live = w.add(NAME).await;
    let pick = w.add_trash(NAME, 1000).await;
    let pick_id = pick.id.clone();
    let inner = w.drive.clone();
    *w.hooked.before_rename.lock().unwrap() = Some(Box::new(move |_, id, name| {
        if id == pick_id && name == NAME {
            let inner = inner.clone();
            let id = id.to_owned();
            // The delete answers at once on the in-memory Drive.
            futures_executor_block_on(async move {
                pipette_drive::DriveApi::delete(&inner.inner, id).await.unwrap()
            });
        }
        None
    }));

    assert_eq!(err(restore_trash_file(&w.trash_env(NOW), &pick.id)).await, TRASH_NOT_FOUND_MESSAGE);
    assert_eq!(w.names(), vec![(live.id, NAME.to_owned())]);
}

/// Polls a future the in-memory Drive answers at once.
fn futures_executor_block_on<F: std::future::Future<Output = ()>>(future: F) {
    let waker = std::task::Waker::noop();
    let mut cx = std::task::Context::from_waker(waker);
    let mut future = std::pin::pin!(future);
    assert!(future.as_mut().poll(&mut cx).is_ready(), "the in-memory Drive answers at once");
}

#[tokio::test]
async fn restore_is_refused_by_the_sync_guards_before_anything_is_renamed() {
    let w = world();
    let pick = w.add_trash(NAME, 1000).await;
    w.add("password-change-lock.json").await;
    let before = w.names();

    assert_eq!(
        err(restore_trash_file(&w.trash_env(NOW), &pick.id)).await,
        "sync.passwordChange.blockedByOtherDevice"
    );
    assert_eq!(w.names(), before);
}

#[tokio::test]
async fn delete_deletes_only_ids_that_are_still_trash_files_and_skips_the_rest() {
    let w = world();
    let live = w.add(NAME).await;
    let t1 = w.add_trash(NAME, 1000).await;
    // Listed as trash on the screen, then renamed back by the poll.
    let restored = w.add(NAME).await;

    let result =
        delete_trash_files(&w.trash_env(NOW), &[t1.id.clone(), restored.id.clone(), "gone".into()]).await;

    assert_eq!(
        result.unwrap(),
        TrashDeleteResult { deleted: vec![t1.id], skipped: vec![restored.id.clone(), "gone".into()] }
    );
    assert_eq!(w.names(), vec![(live.id, NAME.to_owned()), (restored.id, NAME.to_owned())]);
}

#[tokio::test]
async fn delete_skips_keyboard_files_the_held_lock_does_not_cover() {
    let w = world();
    let kb = w.add_trash(SETTINGS, 1000).await;
    let fav = w.add_trash(NAME, 1000).await;

    let result = delete_trash_files(&w.trash_env(NOW), &[kb.id.clone(), fav.id.clone()]).await.unwrap();

    assert_eq!(result, TrashDeleteResult { deleted: vec![fav.id], skipped: vec![kb.id] });
}

#[tokio::test]
async fn delete_lists_drive_again_so_a_rename_after_the_screen_loaded_is_seen() {
    let w = world();
    let t1 = w.add_trash(NAME, 1000).await;
    let id = t1.id.clone();
    *w.hooked.before_list.lock().unwrap() = Some(Box::new(move |drive| {
        futures_executor_block_on(async {
            pipette_drive::DriveApi::rename(&drive.inner, id.clone(), NAME.to_owned()).await.unwrap();
        });
    }));

    let result = delete_trash_files(&w.trash_env(NOW), std::slice::from_ref(&t1.id)).await.unwrap();

    assert_eq!(result, TrashDeleteResult { deleted: vec![], skipped: vec![t1.id.clone()] });
    assert_eq!(name_of(&w, &t1.id), NAME);
}

#[tokio::test]
async fn delete_is_refused_by_the_sync_guards_before_anything_is_deleted() {
    let w = world();
    let t1 = w.add_trash(NAME, 1000).await;
    w.add(&format!("sync-format-v{}.json", pipette_sync::format::SYNC_FORMAT_VERSION + 1)).await;

    assert_eq!(
        err(delete_trash_files(&w.trash_env(NOW), std::slice::from_ref(&t1.id))).await,
        "sync.updateRequired"
    );
    assert!(w.names().iter().any(|(id, _)| *id == t1.id));
}

#[tokio::test]
async fn names_the_keyboards_of_the_given_trash_files_and_nothing_for_global_units_or_other_ids() {
    let w = world();
    let kb1 = w.add_trash(SETTINGS, 1000).await;
    let kb2 = w.add_trash("keyboards_uid2_snapshots.enc", 1000).await;
    let fav = w.add_trash(NAME, 1000).await;
    let live = w.add("keyboards_uid3_settings.enc").await;
    let env = w.trash_env(NOW);

    let all = [kb1.id, kb2.id, fav.id.clone(), live.id];
    assert_eq!(trash_file_keyboards(&env, &all).await.unwrap(), ["uid1", "uid2"]);
    assert!(trash_file_keyboards(&env, &[fav.id]).await.unwrap().is_empty());
}

#[tokio::test]
async fn the_actions_are_refused_while_a_sync_holds_the_lock_without_touching_drive() {
    let w = world();
    let pick = w.add_trash(NAME, 1000).await;
    let before = w.names();
    let _lock = w.runtime.try_claim_sync_lock(false).unwrap();

    assert_eq!(err(restore_trash(&w.trash_env(NOW), &pick.id)).await, "sync.trashBusy");
    assert_eq!(err(delete_trash(&w.trash_env(NOW), std::slice::from_ref(&pick.id))).await, "sync.trashBusy");
    assert_eq!(w.names(), before);
}

#[tokio::test]
async fn the_actions_lock_the_keyboards_their_files_belong_to() {
    let w = world();
    w.add(SETTINGS).await;
    let pick = w.add_trash(SETTINGS, 1000).await;
    let fav = w.add_trash(NAME, 1000).await;
    let writer = w.runtime.try_start_analytics_sync("uid1").unwrap();

    assert_eq!(err(restore_trash(&w.trash_env(NOW), &pick.id)).await, "sync.trashBusy");
    assert_eq!(err(delete_trash(&w.trash_env(NOW), std::slice::from_ref(&pick.id))).await, "sync.trashBusy");
    // A global unit's trash is not held up by the keyboard's analytics sync.
    restore_trash(&w.trash_env(NOW), &fav.id).await.unwrap();

    drop(writer);
    restore_trash(&w.trash_env(NOW), &pick.id).await.unwrap();
    assert_eq!(name_of(&w, &pick.id), SETTINGS);
    assert!(!w.runtime.is_syncing());
    assert!(!w.runtime.reset_holds_keyboard("uid1"));
}
