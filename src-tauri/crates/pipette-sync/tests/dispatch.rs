// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync of one unit (`UnitSync`) on the in-memory Drive: what is uploaded
//! where, what is recorded as handled (only what a merge or upload finished,
//! SYNC-PROCESS §4), the files this run created, this device's own days, and
//! one upload of a unit at a time.

#![allow(clippy::unwrap_used, clippy::panic)]

mod execute_harness;
mod preflight_harness;

use std::time::Duration;

use execute_harness::{PASSWORD, World, favorite_bundle, seed_favorites};
use pipette_drive::DriveFile;
use pipette_drive::canonical::Listing;
use pipette_drive::fake::DriveOp;
use pipette_sync_format::drive_names::drive_file_name;

const T: &str = "2025-01-01T00:00:00.000Z";
const UID: &str = "0xDEAD";
const DAY: &str = "2026-04-18";

async fn listing(world: &World) -> Listing {
    Listing::new(world.preflight.drive().list_files(None).await.unwrap())
}

/// A listing with its password-check validated, as every entry point does
/// before it writes.
async fn validated_listing(world: &World) -> Listing {
    let generation = world.preflight.sync_format_generation();
    let listing = listing(world).await;
    world.preflight.ensure_password_check_validated(PASSWORD, listing.files(), generation).await.unwrap();
    listing
}

fn own_day_unit(world: &World) -> String {
    format!("keyboards/{UID}/devices/{}/days/{DAY}", world.own_hash())
}

fn write_own_day(world: &World, content: &str) {
    world.write(&format!("sync/keyboards/{UID}/devices/{}/{DAY}.jsonl", world.own_hash()), content);
}

#[tokio::test]
async fn an_upload_creates_the_file_records_it_and_remembers_it() {
    let world = World::new().await;
    seed_favorites(&world.root, "macro", &["a"], T);
    let listing = listing(&world).await;
    world.requests();

    world.units.sync_or_upload("favorites/macro", PASSWORD, &listing).await.unwrap();

    assert_eq!(world.requests(), ["create:favorites_macro.enc"]);
    assert!(world.is_known("favorites/macro"));
    let name = drive_file_name("favorites/macro");
    let created = world.runtime().remote().created_file_id(&name).unwrap();
    assert_eq!(
        created,
        Listing::new(world.preflight.drive().list_files(None).await.unwrap())
            .pick_canonical(&name)
            .unwrap()
            .id
    );
    assert_eq!(
        world.drive_content("favorites/macro").unwrap(),
        favorite_bundle_of(&world, "favorites/macro")
    );
}

/// The bundle the unit's local files make now.
fn favorite_bundle_of(world: &World, unit: &str) -> String {
    pipette_sync::bundle::bundle_plaintext(
        &pipette_sync::bundle::bundle_sync_unit(&world.ctx, unit).unwrap().unwrap(),
    )
}

#[tokio::test]
async fn a_converged_merge_records_the_merged_revision_and_uploads_nothing() {
    let world = World::new().await;
    seed_favorites(&world.root, "macro", &["a"], T);
    let file = world.seed_unit("favorites/macro", &favorite_bundle("macro", &["a"], T)).await;
    let listing = listing(&world).await;
    world.requests();

    world.units.sync_or_upload("favorites/macro", PASSWORD, &listing).await.unwrap();

    assert_eq!(world.requests(), [format!("download:{}", file.id)]);
    assert!(world.runtime().remote().is_known("favorites_macro.enc", &file.id, &file.modified_time));
    assert_eq!(world.runtime().remote().created_file_id("favorites_macro.enc"), None);
}

#[tokio::test]
async fn a_merge_that_drive_lacks_uploads_to_the_merged_file_and_records_the_upload() {
    let world = World::new().await;
    seed_favorites(&world.root, "macro", &["a", "b"], T);
    let file = world.seed_unit("favorites/macro", &favorite_bundle("macro", &["a"], T)).await;
    let listing = listing(&world).await;
    world.requests();

    world.units.sync_or_upload("favorites/macro", PASSWORD, &listing).await.unwrap();

    assert_eq!(world.requests(), [format!("download:{}", file.id), format!("update:{}", file.id)]);
    // The upload's own revision, not the one downloaded.
    assert!(!world.runtime().remote().is_known("favorites_macro.enc", &file.id, &file.modified_time));
    assert!(world.is_known("favorites/macro"));
    assert_eq!(world.runtime().remote().created_file_id("favorites_macro.enc"), None);
}

#[tokio::test]
async fn a_failed_merge_records_nothing() {
    let world = World::new().await;
    let file = world.seed_unit("favorites/macro", "not json").await;
    let listing = listing(&world).await;

    let err = world
        .units
        .merge_with_remote(&file_of(&listing, &file.id), "favorites/macro", PASSWORD, Some(&listing))
        .await;

    assert!(err.is_err());
    assert!(!world.is_known("favorites/macro"));
    let malformed = world.seed_unit("favorites/combo", r#"{"index":{"entries":7},"files":{}}"#).await;
    let listing = Listing::new(world.preflight.drive().list_files(None).await.unwrap());
    let err = world
        .units
        .merge_with_remote(&file_of(&listing, &malformed.id), "favorites/combo", PASSWORD, Some(&listing))
        .await
        .unwrap_err();
    assert!(err.is_malformed(), "{err}");
    assert!(!world.is_known("favorites/combo"));
}

fn file_of(listing: &Listing, id: &str) -> DriveFile {
    listing.files().iter().find(|f| f.id == id).cloned().unwrap()
}

#[tokio::test]
async fn an_own_day_is_uploaded_in_place_and_recorded_as_uploaded() {
    let world = World::new().await;
    write_own_day(&world, "{\"id\":\"x\"}\n");
    let unit = own_day_unit(&world);
    let file = world.seed_unit(&unit, "older").await;
    let listing = validated_listing(&world).await;
    world.requests();

    world.units.sync_or_upload(&unit, PASSWORD, &listing).await.unwrap();
    // The same listing, as the upload of a pass after its download: it
    // shows the revision before the upload.
    world.units.sync_or_upload(&unit, PASSWORD, &listing).await.unwrap();

    assert_eq!(world.requests(), [format!("update:{}", file.id)]);
    assert!(world.is_known(&unit));
    let state: serde_json::Value = serde_json::from_str(&sync_state_text(&world)).unwrap();
    assert_eq!(state["uploaded"][format!("{UID}|{}", world.own_hash())], serde_json::json!([DAY]));
}

/// Uploads the own day once.
async fn upload_own_day_once(world: &World) -> String {
    write_own_day(world, "{\"id\":\"x\"}\n");
    let unit = own_day_unit(world);
    world.seed_unit(&unit, "older").await;
    world.units.sync_or_upload(&unit, PASSWORD, &validated_listing(world).await).await.unwrap();
    unit
}

/// A validated listing of Drive now, its own requests forgotten.
async fn fresh_listing(world: &World) -> Listing {
    let listing = validated_listing(world).await;
    world.requests();
    listing
}

fn day_upload_entry(world: &World) -> serde_json::Value {
    let state: serde_json::Value = serde_json::from_str(&sync_state_text(world)).unwrap();
    state["day_uploads"][format!("{UID}|{}", world.own_hash())][DAY].clone()
}

#[tokio::test]
async fn an_unchanged_own_day_is_not_sent_again() {
    let world = World::new().await;
    let unit = upload_own_day_once(&world).await;
    let entry = day_upload_entry(&world);
    assert_eq!(entry["format"], serde_json::json!(pipette_sync::format::SYNC_FORMAT_VERSION));

    world.units.sync_or_upload(&unit, PASSWORD, &fresh_listing(&world).await).await.unwrap();

    assert_eq!(world.requests(), Vec::<String>::new());
    assert!(world.is_known(&unit));
    assert_eq!(day_upload_entry(&world), entry);
}

#[tokio::test]
async fn an_own_day_with_a_new_line_is_sent_again() {
    let world = World::new().await;
    let unit = upload_own_day_once(&world).await;
    write_own_day(&world, "{\"id\":\"x\"}\n{\"id\":\"y\"}\n");
    let listing = fresh_listing(&world).await;
    let file = listing.pick_canonical(&drive_file_name(&unit)).unwrap().clone();

    world.units.sync_or_upload(&unit, PASSWORD, &listing).await.unwrap();

    assert_eq!(world.requests(), [format!("update:{}", file.id)]);
    assert!(world.drive_content(&unit).unwrap().contains("\\\"y\\\""));
}

#[tokio::test]
async fn an_own_day_is_sent_again_under_another_password_check() {
    let world = World::new().await;
    let unit = upload_own_day_once(&world).await;
    let listing_before = listing(&world).await;
    let check = listing_before.pick_canonical("password-check.enc").unwrap().id.clone();
    let day = listing_before.pick_canonical(&drive_file_name(&unit)).unwrap().id.clone();
    world.drive.rewrite_password_check(&check, PASSWORD).await;

    world.units.sync_or_upload(&unit, PASSWORD, &fresh_listing(&world).await).await.unwrap();

    assert_eq!(world.requests(), [format!("update:{day}")]);
}

fn sync_state_text(world: &World) -> String {
    let path = pipette_typing_analytics::sync_state::sync_state_path(&world.root);
    std::fs::read_to_string(path).unwrap()
}

#[tokio::test]
async fn an_own_day_with_a_hostile_uid_is_refused_before_any_request() {
    let world = World::new().await;
    let unit = format!("keyboards/../devices/{}/days/{DAY}", world.own_hash());
    let file = DriveFile {
        id: "hostile".into(),
        name: drive_file_name(&unit),
        modified_time: T.into(),
        created_time: None,
        version: None,
    };
    world.requests();

    let err = world.units.sync_or_upload(&unit, PASSWORD, &Listing::new(vec![file])).await.unwrap_err();

    assert!(err.is_malformed());
    assert!(world.requests().is_empty());
}

#[tokio::test]
async fn a_remembered_file_that_is_gone_is_created_again_and_remembered() {
    let world = World::new().await;
    write_own_day(&world, "{\"id\":\"x\"}\n");
    let unit = own_day_unit(&world);
    let name = drive_file_name(&unit);
    world.runtime().remote().remember_created_file(&name, "stale-id");
    world.requests();

    world.units.sync_or_upload(&unit, PASSWORD, &Listing::new(Vec::new())).await.unwrap();

    assert_eq!(world.requests(), ["update:stale-id", &format!("create:{name}")]);
    let created = world.runtime().remote().created_file_id(&name).unwrap();
    assert_ne!(created, "stale-id");
    assert!(world.is_known(&unit));
}

#[tokio::test]
async fn a_remembered_file_renamed_to_trash_is_not_written_to() {
    let world = World::new().await;
    write_own_day(&world, "{\"id\":\"x\"}\n");
    let unit = own_day_unit(&world);
    let name = drive_file_name(&unit);
    world.runtime().remote().remember_created_file(&name, "trashed-id");
    let trashed = DriveFile {
        id: "trashed-id".into(),
        name: format!("{name}.trash.1.2.trashed-id"),
        modified_time: T.into(),
        created_time: None,
        version: None,
    };
    world.requests();

    world.units.sync_or_upload(&unit, PASSWORD, &Listing::new(vec![trashed])).await.unwrap();

    assert_eq!(world.requests(), [format!("create:{name}")]);
    assert_ne!(world.runtime().remote().created_file_id(&name).as_deref(), Some("trashed-id"));
}

#[tokio::test]
async fn a_listed_copy_is_updated_in_place_the_newest_of_duplicates() {
    let world = World::new().await;
    write_own_day(&world, "{\"id\":\"x\"}\n");
    let unit = own_day_unit(&world);
    let name = drive_file_name(&unit);
    world.drive.seed(&name, "old").await;
    let newer = world.drive.seed(&name, "new").await;
    world.runtime().remote().remember_created_file(&name, "remembered-id");
    let listing = listing(&world).await;
    world.requests();

    world.units.sync_or_upload(&unit, PASSWORD, &listing).await.unwrap();

    assert_eq!(world.requests(), [format!("update:{}", newer.id)]);
}

#[tokio::test]
async fn a_merge_of_duplicates_downloads_the_newest_copy_only() {
    let world = World::new().await;
    world.seed_unit("favorites/macro", &favorite_bundle("macro", &["old"], T)).await;
    let newer = world.seed_unit("favorites/macro", &favorite_bundle("macro", &["new"], T)).await;
    let listing = listing(&world).await;
    world.requests();

    world.units.sync_or_upload("favorites/macro", PASSWORD, &listing).await.unwrap();

    assert_eq!(world.requests(), [format!("download:{}", newer.id)]);
    assert!(world.read("sync/favorites/macro/macro_new.json").is_some());
    assert!(world.read("sync/favorites/macro/macro_old.json").is_none());
}

#[tokio::test]
async fn an_upload_whose_answer_was_lost_is_not_recorded() {
    let world = World::new().await;
    seed_favorites(&world.root, "macro", &["a"], T);
    world.drive.inner.lose_answers(DriveOp::Create, 1);
    let empty = listing(&world).await;

    assert!(world.units.sync_or_upload("favorites/macro", PASSWORD, &empty).await.is_err());

    // Drive took it; nothing records it, so the next pass merges it.
    let name = drive_file_name("favorites/macro");
    let listing = listing(&world).await;
    let file = listing.pick_canonical(&name).unwrap().clone();
    assert!(!world.runtime().remote().is_known(&name, &file.id, &file.modified_time));
    world.requests();
    world.units.sync_or_upload("favorites/macro", PASSWORD, &listing).await.unwrap();
    assert_eq!(world.requests(), [format!("download:{}", file.id)]);
    assert!(world.runtime().remote().is_known(&name, &file.id, &file.modified_time));
}

#[tokio::test]
async fn uploads_of_one_unit_run_one_after_the_other() {
    let world = World::new().await;
    write_own_day(&world, "{\"id\":\"line-a\"}\n");
    let unit = own_day_unit(&world);
    let empty = Listing::new(Vec::new());
    world.drive.hold(DriveOp::Create, None);

    let first = world.units.sync_or_upload(&unit, PASSWORD, &empty);
    let second = async {
        while world.drive.held() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let second = world.units.sync_or_upload(&unit, PASSWORD, &empty);
        let later = async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            write_own_day(&world, "{\"id\":\"line-a\"}\n{\"id\":\"line-b\"}\n");
            world.drive.open_gate();
        };
        tokio::join!(second, later).0
    };
    let (first, second) = tokio::join!(first, second);
    first.unwrap();
    second.unwrap();

    let name = drive_file_name(&unit);
    let files: Vec<_> = world.drive.inner.files().into_iter().filter(|f| f.file.name == name).collect();
    assert_eq!(files.len(), 1, "the second upload updates the file the first created");
    assert!(String::from_utf8_lossy(&files[0].content).contains("line-b"));
}

#[tokio::test]
async fn uploads_of_two_days_at_once_both_reach_the_upload_bookkeeping() {
    const OTHER_DAY: &str = "2026-04-19";
    let world = World::new().await;
    write_own_day(&world, "{\"id\":\"x\"}\n");
    world.write(
        &format!("sync/keyboards/{UID}/devices/{}/{OTHER_DAY}.jsonl", world.own_hash()),
        "{\"id\":\"y\"}\n",
    );
    let other_unit = format!("keyboards/{UID}/devices/{}/days/{OTHER_DAY}", world.own_hash());
    let unit = own_day_unit(&world);
    let empty = Listing::new(Vec::new());
    // Both uploads reach Drive before either records its day, so the two
    // records run at once.
    world.drive.hold(DriveOp::Create, None);
    let release = async {
        while world.drive.held() < 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        world.drive.open_gate();
    };

    let (first, second, ()) = tokio::join!(
        world.units.sync_or_upload(&unit, PASSWORD, &empty),
        world.units.sync_or_upload(&other_unit, PASSWORD, &empty),
        release,
    );
    first.unwrap();
    second.unwrap();

    let state: serde_json::Value = serde_json::from_str(&sync_state_text(&world)).unwrap();
    assert_eq!(state["uploaded"][format!("{UID}|{}", world.own_hash())], serde_json::json!([DAY, OTHER_DAY]));
}

#[tokio::test]
async fn an_upload_whose_bookkeeping_failed_is_not_recorded_and_is_sent_again() {
    let world = World::new().await;
    write_own_day(&world, "{\"id\":\"x\"}\n");
    let unit = own_day_unit(&world);
    let name = drive_file_name(&unit);
    // A directory where `sync_state.json` goes: it cannot be written.
    let blocked = pipette_typing_analytics::sync_state::sync_state_path(&world.root);
    std::fs::create_dir_all(blocked.join("in-the-way")).unwrap();
    world.requests();

    assert!(world.units.sync_or_upload(&unit, PASSWORD, &Listing::new(Vec::new())).await.is_err());

    assert_eq!(world.requests(), [format!("create:{name}")]);
    assert!(!world.is_known(&unit), "the next pass sees the file as changed");
    let created = world.runtime().remote().created_file_id(&name).unwrap();

    std::fs::remove_dir_all(&blocked).unwrap();
    let listing = listing(&world).await;
    world.requests();
    world.units.sync_or_upload(&unit, PASSWORD, &listing).await.unwrap();

    assert_eq!(world.requests(), [format!("update:{created}")]);
    assert!(world.is_known(&unit));
    let state: serde_json::Value = serde_json::from_str(&sync_state_text(&world)).unwrap();
    assert_eq!(state["uploaded"][format!("{UID}|{}", world.own_hash())], serde_json::json!([DAY]));
}
