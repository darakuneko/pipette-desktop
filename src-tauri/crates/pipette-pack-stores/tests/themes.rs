// SPDX-License-Identifier: GPL-2.0-or-later
//! The theme pack store, from the tests of
//! src/main/__tests__/theme-pack-store.test.ts that cover what this crate
//! does (the sync merge and the garbage collection are not here). The
//! checks of `validateThemePack` run in the page, so the packs here are
//! only as complete as the store reads them.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use common::{Harness, ms};
use pipette_entry_store::Entry;
use pipette_js_json::{JsString, Object, Value};
use pipette_pack_stores::theme::{
    Cached, SaveThemeInput, THEME_PACKS, delete_pack, get_pack, has_active_name, list_all_metas, list_metas,
    rename_pack, reorder_active, save_pack, set_hub_post_id,
};
use pipette_pack_stores::{ErrorCode, Field};

fn js(text: &str) -> JsString {
    JsString::from(text)
}

fn pack(name: &str, version: &str) -> Value {
    let mut pack = Object::new();
    pack.insert("name", name.into());
    pack.insert("version", version.into());
    pack.insert("colorScheme", "dark".into());
    pack.insert("colors", Object::new().into());
    Value::Object(pack)
}

fn input(name: &str) -> SaveThemeInput {
    SaveThemeInput { pack: Some(pack(name, "1.0.0")), ..SaveThemeInput::default() }
}

fn save(h: &Harness, name: &str) -> Entry {
    save_pack(&h.ctx, input(name)).unwrap()
}

fn id_of(meta: &Entry) -> JsString {
    meta.id().unwrap().clone()
}

fn field(meta: &Entry, key: &str) -> Option<String> {
    meta.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn names(metas: &[Entry]) -> Vec<String> {
    metas.iter().map(|m| field(m, "name").unwrap()).collect()
}

#[test]
fn a_save_writes_the_meta_and_the_body_and_reports_both() {
    let h = Harness::new();
    let meta = save(&h, "Nord");
    let id = id_of(&meta);
    assert_eq!(field(&meta, "name").as_deref(), Some("Nord"));
    assert_eq!(field(&meta, "version").as_deref(), Some("1.0.0"));
    assert_eq!(field(&meta, "filename"), Some(format!("packs/{}.json", id.to_string_lossy())));
    assert!(field(&meta, "savedAt").is_some() && field(&meta, "updatedAt").is_some());
    assert_eq!(h.notified(), [format!("themes/packs/{}", id.to_string_lossy()), "themes/index".to_owned()]);
    let body = h.read(&format!("sync/themes/packs/{}.json", id.to_string_lossy()));
    assert!(body.starts_with("{\n  \"name\": \"Nord\",\n  \"version\": \"1.0.0\""), "{body}");
}

#[test]
fn a_save_of_the_same_name_overwrites_the_live_pack() {
    let h = Harness::new();
    let first = save(&h, "Dracula");
    let second = save_pack(
        &h.ctx,
        SaveThemeInput { pack: Some(pack(" dracula ", "2.0.0")), ..SaveThemeInput::default() },
    )
    .unwrap();
    assert_eq!(id_of(&second), id_of(&first));
    assert_eq!(field(&second, "version").as_deref(), Some("2.0.0"));
    assert_eq!(field(&second, "name").as_deref(), Some("Dracula"));
    assert_eq!(list_metas(&h.ctx).unwrap().len(), 1);
}

#[test]
fn a_save_over_an_explicit_id_keeps_the_live_name() {
    let h = Harness::new();
    let first = save(&h, "Solarized");
    let second = save_pack(
        &h.ctx,
        SaveThemeInput {
            id: Some(id_of(&first)),
            pack: Some(pack("Solarized Updated", "2.0.0")),
            ..SaveThemeInput::default()
        },
    )
    .unwrap();
    assert_eq!(id_of(&second), id_of(&first));
    assert_eq!(field(&second, "name").as_deref(), Some("Solarized"));
    assert_eq!(field(&second, "version").as_deref(), Some("2.0.0"));
}

#[test]
fn a_pack_without_a_name_or_a_version_is_refused() {
    let h = Harness::new();
    for raw in [None, Some(Value::Null), Some(pack(" ", "1.0.0")), Some(pack("Name", ""))] {
        let err = save_pack(&h.ctx, SaveThemeInput { pack: raw, ..SaveThemeInput::default() }).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidFile);
    }
    assert!(h.notified().is_empty());
}

#[test]
fn hub_fields_are_set_inherited_or_cleared() {
    let h = Harness::new();
    let first = save_pack(
        &h.ctx,
        SaveThemeInput {
            hub_post_id: Field::Set(js("hub-1")),
            hub_updated_at: Field::Set(js("2026-01-15T10:00:00.000Z")),
            uploader_name: Field::Set(js("alice")),
            ..input("Hub Theme")
        },
    )
    .unwrap();
    assert_eq!(field(&first, "hubPostId").as_deref(), Some("hub-1"));
    assert_eq!(field(&first, "hubUpdatedAt").as_deref(), Some("2026-01-15T10:00:00.000Z"));
    let id = Some(id_of(&first));

    let inherited = save_pack(&h.ctx, SaveThemeInput { id: id.clone(), ..input("Hub Theme") }).unwrap();
    assert_eq!(field(&inherited, "hubPostId").as_deref(), Some("hub-1"));
    assert_eq!(field(&inherited, "uploaderName").as_deref(), Some("alice"));

    let cleared = save_pack(
        &h.ctx,
        SaveThemeInput {
            id,
            hub_post_id: Field::Clear,
            hub_updated_at: Field::Set(js(" ")),
            uploader_name: Field::Set(js("")),
            ..input("Hub Theme")
        },
    )
    .unwrap();
    for key in ["hubPostId", "hubUpdatedAt", "uploaderName"] {
        assert_eq!(cleared.get(key), None, "{key}");
    }
}

#[test]
fn an_empty_hub_post_id_is_not_written() {
    let h = Harness::new();
    let meta =
        save_pack(&h.ctx, SaveThemeInput { hub_post_id: Field::Set(js("")), ..input("Empty") }).unwrap();
    assert_eq!(meta.get("hubPostId"), None);
}

#[test]
fn a_save_keeps_the_first_saved_at() {
    let h = Harness::new();
    let first = save(&h, "Keep SavedAt");
    h.clock.set(ms("2026-10-17T00:00:00.000Z"));
    let second = save(&h, "Keep SavedAt");
    assert_eq!(field(&second, "savedAt"), field(&first, "savedAt"));
    assert_ne!(field(&second, "updatedAt"), field(&first, "updatedAt"));
}

#[test]
fn a_save_under_another_id_with_a_live_name_is_a_duplicate() {
    let h = Harness::new();
    save(&h, "UniqueA");
    let err = save_pack(&h.ctx, SaveThemeInput { id: Some(js("different-explicit-id")), ..input("UniqueA") })
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::DuplicateName);
    assert_eq!(err.message, "A theme pack with the same name already exists");
}

#[test]
fn a_save_brings_a_deleted_pack_back() {
    let h = Harness::new();
    let id = id_of(&save(&h, "Phoenix"));
    delete_pack(&h.ctx, &id).unwrap();
    let revived =
        save_pack(&h.ctx, SaveThemeInput { id: Some(id.clone()), ..input("Phoenix Reborn") }).unwrap();
    assert!(!revived.is_deleted());
    assert_eq!(field(&revived, "name").as_deref(), Some("Phoenix Reborn"));
}

#[test]
fn get_answers_the_live_pack_with_the_meta_name() {
    let h = Harness::new();
    let id = id_of(&save(&h, "Readable"));
    rename_pack(&h.ctx, &id, &js("Renamed")).unwrap();
    let record = get_pack(&h.ctx, &id).unwrap();
    let Some(Value::Object(pack)) = record.get("pack") else { panic!() };
    assert_eq!(pack.get("name"), Some(&Value::from("Renamed")));
    assert_eq!(pack.get("colorScheme"), Some(&Value::from("dark")));

    let not_found = |id: &str| get_pack(&h.ctx, &js(id)).unwrap_err();
    assert_eq!(not_found("missing").message, "Theme pack not found");
    assert_eq!(not_found("../x").message, "Invalid pack id");
    delete_pack(&h.ctx, &id).unwrap();
    assert_eq!(get_pack(&h.ctx, &id).unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn lists_leave_out_or_keep_the_tombstones() {
    let h = Harness::new();
    assert!(list_metas(&h.ctx).unwrap().is_empty());
    save(&h, "Alpha");
    let beta = id_of(&save(&h, "Beta"));
    save(&h, "Gamma");
    delete_pack(&h.ctx, &beta).unwrap();
    assert_eq!(names(&list_metas(&h.ctx).unwrap()), ["Alpha", "Gamma"]);
    let all = list_all_metas(&h.ctx).unwrap();
    assert_eq!(names(&all), ["Alpha", "Beta", "Gamma"]);
    assert!(all[1].is_deleted());
}

#[test]
fn a_rename_checks_the_name_and_changes_the_meta_only() {
    let h = Harness::new();
    let id = id_of(&save(&h, "Original"));
    let other = id_of(&save(&h, "Other"));
    let body = h.read(&format!("sync/themes/packs/{}.json", id.to_string_lossy()));
    h.clear_notified();

    let renamed = rename_pack(&h.ctx, &id, &js("  New Name  ")).unwrap();
    assert_eq!(field(&renamed, "name").as_deref(), Some("New Name"));
    assert_eq!(h.read(&format!("sync/themes/packs/{}.json", id.to_string_lossy())), body);
    assert_eq!(h.notified(), ["themes/index"]);

    assert_eq!(rename_pack(&h.ctx, &id, &js("OTHER")).unwrap_err().code, ErrorCode::DuplicateName);
    assert!(rename_pack(&h.ctx, &other, &js("other")).is_ok());
    assert_eq!(rename_pack(&h.ctx, &id, &js("   ")).unwrap_err().message, "Name must not be empty");
    assert_eq!(
        rename_pack(&h.ctx, &id, &js(&"x".repeat(65))).unwrap_err().message,
        "Name must be at most 64 characters"
    );
    assert_eq!(rename_pack(&h.ctx, &js("missing"), &js("x")).unwrap_err().code, ErrorCode::NotFound);
    delete_pack(&h.ctx, &id).unwrap();
    assert_eq!(rename_pack(&h.ctx, &id, &js("Again")).unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn a_delete_tombstones_the_meta_and_keeps_the_body() {
    let h = Harness::new();
    let id = id_of(&save(&h, "To Delete"));
    h.clear_notified();
    delete_pack(&h.ctx, &id).unwrap();
    assert!(list_metas(&h.ctx).unwrap().is_empty());
    assert!(h.path(&format!("sync/themes/packs/{}.json", id.to_string_lossy())).exists());
    assert_eq!(h.notified(), [format!("themes/packs/{}", id.to_string_lossy()), "themes/index".to_owned()]);
    assert_eq!(delete_pack(&h.ctx, &js("missing")).unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn hub_links_set_keep_and_drop_the_cached_fields() {
    let h = Harness::new();
    let id = id_of(&save(&h, "Linked"));
    let set = |post: Option<&str>, uploader: Cached, updated: Cached| {
        set_hub_post_id(&h.ctx, &id, post.map(js).as_ref(), uploader, updated).unwrap()
    };
    let uploaded = set(
        Some("  hub-1  "),
        Cached::Set(Some(js("alice"))),
        Cached::Set(Some(js("2026-05-01T00:00:00.000Z"))),
    );
    assert_eq!(field(&uploaded, "hubPostId").as_deref(), Some("hub-1"));
    assert_eq!(field(&uploaded, "uploaderName").as_deref(), Some("alice"));

    let updated = set(Some("hub-1"), Cached::Keep, Cached::Set(Some(js("2026-06-01T00:00:00.000Z"))));
    assert_eq!(field(&updated, "uploaderName").as_deref(), Some("alice"));
    assert_eq!(field(&updated, "hubUpdatedAt").as_deref(), Some("2026-06-01T00:00:00.000Z"));

    let detached = set(None, Cached::Keep, Cached::Keep);
    assert_eq!(detached.get("hubPostId"), None);
    assert_eq!(detached.get("hubUpdatedAt"), None);
    assert_eq!(field(&detached, "uploaderName").as_deref(), Some("alice"));
    assert_eq!(set(Some(" "), Cached::Keep, Cached::Keep).get("hubPostId"), None);

    let err =
        set_hub_post_id(&h.ctx, &js("missing"), Some(&js("p")), Cached::Keep, Cached::Keep).unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

#[test]
fn has_active_name_ignores_case_the_excluded_id_and_tombstones() {
    let h = Harness::new();
    let id = id_of(&save(&h, "Monokai"));
    assert!(has_active_name(&h.ctx, &js(" monokai "), None).unwrap());
    assert!(!has_active_name(&h.ctx, &js("Other"), None).unwrap());
    assert!(!has_active_name(&h.ctx, &js("Monokai"), Some(&id)).unwrap());
    assert!(has_active_name(&h.ctx, &js("Monokai"), Some(&js("someone-else"))).unwrap());
    delete_pack(&h.ctx, &id).unwrap();
    assert!(!has_active_name(&h.ctx, &js("Monokai"), None).unwrap());
}

#[test]
fn reorder_puts_the_listed_live_packs_first_and_keeps_the_rest_behind() {
    let h = Harness::new();
    let a = id_of(&save(&h, "A"));
    let b = id_of(&save(&h, "B"));
    let c = id_of(&save(&h, "C"));
    save(&h, "Unlisted");
    delete_pack(&h.ctx, &b).unwrap();
    reorder_active(&h.ctx, &[c.clone(), b, a]).unwrap();
    assert_eq!(names(&list_all_metas(&h.ctx).unwrap()), ["C", "A", "B", "Unlisted"]);
}

#[test]
fn reorder_moves_no_clock_and_reports_nothing() {
    let h = Harness::new();
    let a = save(&h, "A");
    let b = save(&h, "B");
    h.clock.set(ms("2026-10-16T13:00:00.000Z"));
    h.clear_notified();
    reorder_active(&h.ctx, &[id_of(&b), id_of(&a)]).unwrap();
    assert!(h.notified().is_empty());
    assert_eq!(list_metas(&h.ctx).unwrap(), [b, a]);
}

#[test]
fn the_store_keeps_its_files_under_sync_themes() {
    let h = Harness::new();
    assert_eq!(THEME_PACKS.index_unit(), "themes/index");
    assert!(THEME_PACKS.pack_path(&h.ctx, &js("../evil")).is_none());
    assert!(THEME_PACKS.pack_path(&h.ctx, &js("")).is_none());
    assert_eq!(
        THEME_PACKS.pack_path(&h.ctx, &js("abc-123_x")),
        Some(h.path("sync/themes/packs/abc-123_x.json"))
    );
}
