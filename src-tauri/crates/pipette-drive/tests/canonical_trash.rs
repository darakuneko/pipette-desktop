// SPDX-License-Identifier: GPL-2.0-or-later
//! The choice between copies and the trash names give the recorded golden
//! results on the tables of tests/fixtures/canonical_trash.json, and the
//! moves to the trash.

#![allow(clippy::unwrap_used)]

mod common;

use std::sync::{Arc, Mutex};

use common::TestEnv;
use pipette_drive::canonical::{Listing, is_newer_copy};
use pipette_drive::client::{BulkOutcome, DriveClient};
use pipette_drive::fake::{DriveOp, Fault, InMemoryDrive};
use pipette_drive::trash_names::{
    TRASH_QUARANTINE_MS, TrashInfo, is_trash_expired, parse_trash_file, trash_file_name,
};
use pipette_drive::{DriveApi, DriveFile};
use serde_json::{Value, json};

const TABLES: &str = include_str!("fixtures/canonical_trash.json");

fn tables() -> Value {
    serde_json::from_str(TABLES).unwrap()
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap().to_owned()
}

fn drive_file(value: &Value) -> DriveFile {
    DriveFile {
        id: text(value, "id"),
        name: text(value, "name"),
        modified_time: text(value, "modifiedTime"),
        created_time: None,
    }
}

fn ids(files: &[&DriveFile]) -> Value {
    json!(files.iter().map(|file| file.id.as_str()).collect::<Vec<_>>())
}

fn trash_json(trash: &TrashInfo) -> Value {
    json!({
        "originalName": trash.original_name,
        "renamedAtMs": trash.renamed_at_ms,
        "preModifiedMs": trash.pre_modified_ms,
    })
}

#[test]
fn chooses_the_recorded_copies() {
    let tables = tables();
    for case in tables["canonical"].as_array().unwrap() {
        let listing = Listing::new(case["files"].as_array().unwrap().iter().map(drive_file).collect());
        assert_eq!(ids(&listing.canonical_files()), case["canonicalFiles"]);
        assert_eq!(json!(listing.duplicated_names()), case["duplicatedNames"]);
        assert_eq!(json!(listing.names_with_trash()), case["namesWithTrash"]);
        for by_name in case["byName"].as_array().unwrap() {
            let name = text(by_name, "name");
            assert_eq!(
                json!(listing.pick_canonical(&name).map(|file| &file.id)),
                by_name["pickCanonical"],
                "{name}"
            );
            assert_eq!(ids(&listing.files_named(&name)), by_name["filesNamed"], "{name}");
            let trash: Vec<Value> = listing
                .trash_copies_of(&name)
                .iter()
                .map(|copy| json!({ "id": copy.file.id, "trash": trash_json(copy.trash) }))
                .collect();
            assert_eq!(json!(trash), by_name["trashCopiesOf"], "{name}");
            assert_eq!(ids(&listing.files_named_with_trash(&name)), by_name["filesNamedWithTrash"], "{name}");
        }
    }
}

#[test]
fn ranks_copies_as_is_newer_copy_does() {
    let ms = |value: &Value| value.as_f64().unwrap_or(f64::NEG_INFINITY);
    for case in tables()["isNewerCopy"].as_array().unwrap() {
        let newer = is_newer_copy(ms(&case["aMs"]), &text(case, "aId"), ms(&case["bMs"]), &text(case, "bId"));
        assert_eq!(json!(newer), case["newer"], "{case}");
    }
}

#[test]
fn names_trash_files_as_recorded() {
    let tables = tables();
    assert_eq!(tables["trashQuarantineMs"].as_i64(), Some(TRASH_QUARANTINE_MS));
    for case in tables["trashFileName"].as_array().unwrap() {
        let name = trash_file_name(&drive_file(case), case["renamedAtMs"].as_i64().unwrap());
        assert_eq!(json!(name), case["trashName"], "{case}");
    }
    for case in tables["parseTrashFile"].as_array().unwrap() {
        let trash = parse_trash_file(&text(case, "id"), &text(case, "name"));
        assert_eq!(trash.as_ref().map_or(Value::Null, trash_json), case["trash"], "{case}");
    }
    for case in tables["isTrashExpired"].as_array().unwrap() {
        let trash = TrashInfo {
            original_name: "a.enc".into(),
            renamed_at_ms: case["renamedAtMs"].as_i64().unwrap(),
            pre_modified_ms: 0,
        };
        assert_eq!(
            json!(is_trash_expired(&trash, case["nowMs"].as_i64().unwrap())),
            case["expired"],
            "{case}"
        );
    }
}

#[test]
fn a_trash_name_round_trips_and_maps_to_no_sync_unit() {
    use pipette_sync_format::drive_names::{is_data_file_name, sync_unit_from_file_name};
    for name in [
        "favorites_macro.enc",
        "keyboards_0x1_settings.enc",
        "keyboards_0x1_devices_h1_days_2026-10-01.enc",
        "i18n_packs_p1.enc",
        "key-labels.enc",
    ] {
        let file = DriveFile {
            id: "id1".into(),
            name: name.into(),
            modified_time: "2026-10-01T00:00:00.000Z".into(),
            created_time: None,
        };
        let trash_name = trash_file_name(&file, 1).unwrap();
        assert_eq!(sync_unit_from_file_name(&trash_name), None);
        assert!(is_data_file_name(&trash_name));
        assert_eq!(parse_trash_file("id1", name), None);
        assert_eq!(parse_trash_file("id1", &trash_name).unwrap().original_name, name);
    }
}

fn client(drive: Arc<InMemoryDrive>) -> DriveClient {
    DriveClient::new(drive, TestEnv::new(0, 0.0))
}

async fn seed(drive: &InMemoryDrive, names: &[&str]) -> Vec<DriveFile> {
    for name in names {
        drive.create((*name).to_owned(), "{}".to_owned()).await.unwrap();
    }
    drive.files().into_iter().map(|stored| DriveFile { created_time: None, ..stored.file }).collect()
}

#[tokio::test]
async fn moves_files_to_the_trash_and_forgets_their_created_ids() {
    let drive = Arc::new(InMemoryDrive::new());
    let files = seed(&drive, &["favorites_macro.enc", "favorites_macro.enc"]).await;
    let forgotten = Mutex::new(Vec::new());
    let outcome = client(Arc::clone(&drive))
        .move_files_to_trash(&files, 77, &|id| forgotten.lock().unwrap().push(id.to_owned()))
        .await;

    assert_eq!(outcome, BulkOutcome { attempted: 2, failed: 0, first_error: None });
    assert_eq!(*forgotten.lock().unwrap(), ["fake-1", "fake-2"]);
    let names: Vec<String> = drive.files().into_iter().map(|stored| stored.file.name).collect();
    // The modifiedTime before the rename: 2026-01-01T00:00:00Z and :01.
    assert_eq!(
        names,
        [
            "favorites_macro.enc.trash.77.1767225600000.fake-1",
            "favorites_macro.enc.trash.77.1767225601000.fake-2"
        ]
    );
    let listing = Listing::new(drive.files().into_iter().map(|stored| stored.file).collect());
    assert_eq!(listing.trash_copies_of("favorites_macro.enc").len(), 2);
    assert_eq!(listing.pick_canonical("favorites_macro.enc"), None);
}

#[tokio::test]
async fn reports_a_failed_rename_without_stopping_the_others() {
    let drive = Arc::new(InMemoryDrive::new());
    let mut files = seed(&drive, &["favorites_macro.enc", "favorites_combo.enc"]).await;
    // An id a trash name cannot carry is left alone and not counted; a
    // file already gone counts as moved.
    files.push(DriveFile { id: "bad.id".into(), ..files[0].clone() });
    files.push(DriveFile { id: "gone".into(), ..files[0].clone() });
    drive.inject(Fault { only: Some(DriveOp::Rename), ..Fault::with_status(400) });

    let outcome = client(Arc::clone(&drive)).move_files_to_trash(&files, 1, &|_| {}).await;

    assert_eq!(outcome.attempted, 3);
    assert_eq!(outcome.failed, 1);
    assert!(outcome.first_error.unwrap().starts_with("Drive rename failed: 400 "));
    let trash = drive.files().iter().filter(|stored| stored.file.name.contains(".trash.")).count();
    assert_eq!(trash, 1);
}
