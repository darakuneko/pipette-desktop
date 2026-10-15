// SPDX-License-Identifier: GPL-2.0-or-later
//! The favorite store's behaviour, from the specs of the TypeScript store
//! (src/main/__tests__/favorite-store*.test.ts).

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::fs;
use std::sync::Arc;

use common::{Harness, T0, id, ms};
use pipette_js_json::{JsString, Value};
use pipette_keyboard_stores::{
    FavoriteError, FavoriteImport, FavoriteType, ImportCounts, delete_favorite, import_favorites,
    list_favorites, load_favorite, read_favorites_for_export, rename_favorite, save_favorite,
    set_favorite_hub_post_id, set_favorite_hub_private,
};

const TD: FavoriteType = FavoriteType::TapDance;

fn labels(h: &Harness, ty: FavoriteType) -> Vec<String> {
    list_favorites(&h.ctx, ty)
        .unwrap()
        .iter()
        .map(|e| e.get("label").unwrap().as_str().unwrap().to_owned())
        .collect()
}

fn index(h: &Harness, ty: FavoriteType) -> Value {
    let path = h.user_data().join(format!("sync/favorites/{}/index.json", ty.name()));
    pipette_js_json::parse(&fs::read_to_string(path).unwrap()).unwrap()
}

fn first_entry_field(h: &Harness, ty: FavoriteType, key: &str) -> Option<Value> {
    let index = index(h, ty);
    let Some(Value::Array(entries)) = index.as_object().unwrap().get("entries").cloned() else { panic!() };
    entries[0].as_object().unwrap().get(key).cloned()
}

fn import(label: &str, saved_at: &str, body: &str) -> FavoriteImport {
    FavoriteImport { label: label.into(), saved_at: saved_at.into(), body: body.into() }
}

#[test]
fn types_are_the_five_favorite_types() {
    for ty in FavoriteType::ALL {
        assert_eq!(FavoriteType::parse(ty.name()).unwrap(), ty);
        assert_eq!(ty.sync_unit(), format!("favorites/{}", ty.name()));
    }
    for name in ["", "qmkSettings", "tapdance", "../x", "constructor"] {
        assert!(matches!(FavoriteType::parse(name), Err(FavoriteError::InvalidType)), "{name}");
    }
    assert_eq!(FavoriteError::InvalidType.to_string(), "Error: Invalid favorite type");
}

#[test]
fn a_save_writes_the_body_and_lists_newest_first() {
    let h = Harness::new();
    assert!(list_favorites(&h.ctx, TD).unwrap().is_empty());
    let json = r#"{"type":"tapDance","data":{"onTap":4}}"#;
    let first = save_favorite(&h.ctx, TD, json, "First").unwrap();
    save_favorite(&h.ctx, TD, "{}", "Second").unwrap();

    assert_eq!(first.id().unwrap().as_str(), Some(id(1).as_str()));
    let filename = first.filename().unwrap().to_string_lossy().into_owned();
    assert_eq!(filename, format!("tapDance_2026-10-16T12-00-00.000Z_{}.json", id(1)));
    assert_eq!(first.get("savedAt").unwrap().as_str(), Some(T0));
    assert_eq!(first.updated_at().unwrap().as_str(), Some(T0));
    let body = fs::read_to_string(h.user_data().join("sync/favorites/tapDance").join(&filename)).unwrap();
    assert_eq!(body, json);
    assert_eq!(labels(&h, TD), ["Second", "First"]);
    assert_eq!(load_favorite(&h.ctx, TD, &id(1)).unwrap(), json);
    assert_eq!(h.notified(), ["favorites/tapDance", "favorites/tapDance"]);
}

#[test]
fn types_keep_their_own_entries() {
    let h = Harness::new();
    save_favorite(&h.ctx, TD, "{}", "TD").unwrap();
    save_favorite(&h.ctx, FavoriteType::Macro, "{}", "Macro").unwrap();
    assert_eq!(labels(&h, TD), ["TD"]);
    assert_eq!(labels(&h, FavoriteType::Macro), ["Macro"]);
    assert!(list_favorites(&h.ctx, FavoriteType::Combo).unwrap().is_empty());
    assert!(matches!(load_favorite(&h.ctx, FavoriteType::Macro, &id(1)), Err(FavoriteError::NotFound)));
}

#[test]
fn rename_moves_the_name_clock_and_updated_at() {
    let h = Harness::new();
    save_favorite(&h.ctx, TD, "{}", "Old").unwrap();
    h.clock.set(ms(T0) + 5_000);
    rename_favorite(&h.ctx, TD, &id(1), "New").unwrap();
    assert_eq!(labels(&h, TD), ["New"]);
    assert_eq!(first_entry_field(&h, TD, "updatedAt").unwrap().as_str(), Some("2026-10-16T12:00:05.000Z"));
    assert!(matches!(rename_favorite(&h.ctx, TD, "bad-id", "x"), Err(FavoriteError::NotFound)));
}

#[test]
fn delete_tombstones_the_entry_and_keeps_its_body() {
    let h = Harness::new();
    let saved = save_favorite(&h.ctx, TD, "{}", "Gone").unwrap();
    delete_favorite(&h.ctx, TD, &id(1)).unwrap();

    assert!(list_favorites(&h.ctx, TD).unwrap().is_empty());
    let path = h
        .user_data()
        .join("sync/favorites/tapDance")
        .join(saved.filename().unwrap().to_string_lossy().as_ref());
    assert_eq!(fs::read_to_string(path).unwrap(), "{}");
    assert!(first_entry_field(&h, TD, "deletedAt").is_some());
    assert!(matches!(load_favorite(&h.ctx, TD, &id(1)), Err(FavoriteError::Deleted)));
    assert!(matches!(delete_favorite(&h.ctx, TD, "bad-id"), Err(FavoriteError::NotFound)));
    assert_eq!(FavoriteError::Deleted.to_string(), "Entry has been deleted");
}

#[test]
fn a_corrupt_index_reads_as_empty() {
    let h = Harness::new();
    h.write("sync/favorites/tapDance/index.json", "not json!!!");
    assert!(list_favorites(&h.ctx, TD).unwrap().is_empty());
}

#[test]
fn a_stored_filename_cannot_leave_the_type_directory() {
    let h = Harness::new();
    h.write(
        "sync/favorites/tapDance/index.json",
        r#"{"type":"tapDance","entries":[{"id":"evil","label":"x","savedAt":"2026-01-01T00:00:00.000Z","filename":"../../secret.json"}]}"#,
    );
    h.write("sync/secret.json", "secret");
    let err = load_favorite(&h.ctx, TD, "evil").unwrap_err();
    assert_eq!(err.to_string(), "Error: Invalid filename");
}

#[test]
fn a_public_post_id_is_trimmed_and_replaces_a_private_link() {
    let h = Harness::new();
    save_favorite(&h.ctx, TD, "{}", "TD").unwrap();
    let link = pipette_js_json::parse(r#"{"id":"p","url":"/u","expiresAt":null}"#).unwrap();
    set_favorite_hub_private(&h.ctx, TD, &id(1), Some(link.clone())).unwrap();
    assert_eq!(first_entry_field(&h, TD, "hubPrivate"), Some(link.clone()));

    h.clock.set(ms(T0) + 1_000);
    set_favorite_hub_post_id(&h.ctx, TD, &id(1), Some("  post-123 ")).unwrap();
    assert_eq!(first_entry_field(&h, TD, "hubPostId").unwrap().as_str(), Some("post-123"));
    assert_eq!(first_entry_field(&h, TD, "hubPrivate"), None);
    assert_eq!(first_entry_field(&h, TD, "updatedAt").unwrap().as_str(), Some("2026-10-16T12:00:01.000Z"));

    set_favorite_hub_private(&h.ctx, TD, &id(1), Some(link.clone())).unwrap();
    assert_eq!(first_entry_field(&h, TD, "hubPostId"), None);
    set_favorite_hub_private(&h.ctx, TD, &id(1), None).unwrap();
    assert_eq!(first_entry_field(&h, TD, "hubPrivate"), None);

    set_favorite_hub_post_id(&h.ctx, TD, &id(1), Some("post-1")).unwrap();
    set_favorite_hub_post_id(&h.ctx, TD, &id(1), Some("   ")).unwrap();
    assert_eq!(first_entry_field(&h, TD, "hubPostId"), None);
    set_favorite_hub_post_id(&h.ctx, TD, &id(1), Some("post-2")).unwrap();
    set_favorite_hub_post_id(&h.ctx, TD, &id(1), None).unwrap();
    assert_eq!(first_entry_field(&h, TD, "hubPostId"), None);

    assert!(matches!(
        set_favorite_hub_post_id(&h.ctx, TD, "missing", Some("p")),
        Err(FavoriteError::NotFound)
    ));
    assert!(matches!(set_favorite_hub_private(&h.ctx, TD, "missing", None), Err(FavoriteError::NotFound)));
    assert!(h.notified().iter().all(|unit| unit == "favorites/tapDance"));
}

#[test]
fn an_export_reads_the_live_favorites_with_readable_bodies() {
    let h = Harness::new();
    save_favorite(&h.ctx, TD, r#"{"a":1}"#, "Kept").unwrap();
    let gone = save_favorite(&h.ctx, TD, r#"{"a":2}"#, "Body gone").unwrap();
    save_favorite(&h.ctx, TD, r#"{"a":3}"#, "Deleted").unwrap();
    delete_favorite(&h.ctx, TD, &id(3)).unwrap();
    let body = h
        .user_data()
        .join("sync/favorites/tapDance")
        .join(gone.filename().unwrap().to_string_lossy().as_ref());
    fs::remove_file(body).unwrap();

    let read = read_favorites_for_export(&h.ctx, TD, None).unwrap();
    let text = pipette_js_json::stringify(&Value::Array(read));
    assert_eq!(text, r#"[{"label":"Kept","savedAt":"2026-10-16T12:00:00.000Z","body":"{\"a\":1}"}]"#);
    assert_eq!(read_favorites_for_export(&h.ctx, TD, Some(&id(1))).unwrap().len(), 1);
    assert!(read_favorites_for_export(&h.ctx, TD, Some(&id(2))).unwrap().is_empty());
    assert!(matches!(read_favorites_for_export(&h.ctx, TD, Some(&id(3))), Err(FavoriteError::NotFound)));
    assert!(matches!(read_favorites_for_export(&h.ctx, TD, Some("nowhere")), Err(FavoriteError::NotFound)));
}

#[test]
fn an_import_skips_live_duplicates_and_keeps_the_exported_save_time() {
    let h = Harness::new();
    let first = [
        import("A", "2026-01-01T00:00:00.000Z", "{\"n\":1}"),
        import("B", "2026-01-02T00:00:00.000Z", "{\"n\":2}"),
    ];
    assert_eq!(import_favorites(&h.ctx, TD, &first).unwrap(), ImportCounts { imported: 2, skipped: 0 });
    assert_eq!(labels(&h, TD), ["B", "A"]);
    assert_eq!(first_entry_field(&h, TD, "savedAt").unwrap().as_str(), Some("2026-01-02T00:00:00.000Z"));
    assert_eq!(first_entry_field(&h, TD, "updatedAt").unwrap().as_str(), Some(T0));

    // A second import of the same file, a repeat within one import, and a
    // tombstone with the same label and time, which does not count.
    delete_favorite(&h.ctx, TD, &id(1)).unwrap();
    let again = [
        import("A", "2026-01-01T00:00:00.000Z", "{\"n\":1}"),
        import("B", "2026-01-02T00:00:00.000Z", "{\"n\":2}"),
        import("C", "2026-01-03T00:00:00.000Z", "{\"n\":3}"),
        import("C", "2026-01-03T00:00:00.000Z", "{\"n\":4}"),
    ];
    assert_eq!(import_favorites(&h.ctx, TD, &again).unwrap(), ImportCounts { imported: 2, skipped: 2 });
    assert_eq!(labels(&h, TD), ["C", "A", "B"]);
    assert_eq!(load_favorite(&h.ctx, TD, &id(4)).unwrap(), "{\"n\":3}");
    assert_eq!(h.notified(), ["favorites/tapDance", "favorites/tapDance", "favorites/tapDance"]);
}

#[test]
fn an_import_of_nothing_new_writes_no_index_and_reports_nothing() {
    let h = Harness::new();
    assert_eq!(import_favorites(&h.ctx, FavoriteType::Combo, &[]).unwrap(), ImportCounts::default());
    assert!(h.user_data().join("sync/favorites/combo").is_dir());
    assert!(!h.user_data().join("sync/favorites/combo/index.json").exists());
    assert!(h.notified().is_empty());
}

#[test]
fn an_imported_label_keeps_a_lone_surrogate() {
    let h = Harness::new();
    let label = JsString::from_utf16(vec![0xd800, u16::from(b'x')]);
    let favorite = FavoriteImport { label: label.clone(), saved_at: "s".into(), body: "{}".into() };
    import_favorites(&h.ctx, TD, &[favorite]).unwrap();
    let text = fs::read_to_string(h.user_data().join("sync/favorites/tapDance/index.json")).unwrap();
    assert!(text.contains(r#""label": "\ud800x""#), "{text}");
    assert_eq!(first_entry_field(&h, TD, "label"), Some(Value::String(label)));
}

#[test]
fn a_rename_racing_a_save_of_the_same_type_both_land() {
    let h = Arc::new(Harness::new());
    save_favorite(&h.ctx, TD, "{}", "Original").unwrap();
    let saver = {
        let h = Arc::clone(&h);
        std::thread::spawn(move || save_favorite(&h.ctx, TD, "{}", "Concurrent").unwrap())
    };
    rename_favorite(&h.ctx, TD, &id(1), "Renamed").unwrap();
    saver.join().unwrap();
    let mut got = labels(&h, TD);
    got.sort();
    assert_eq!(got, ["Concurrent", "Renamed"]);
}
