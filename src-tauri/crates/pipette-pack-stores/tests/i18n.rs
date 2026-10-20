// SPDX-License-Identifier: GPL-2.0-or-later
//! The language pack store (the sync merge and the garbage collection are
//! not here), and the unattended save of the Hub's update.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::thread;

use common::{Harness, id, ms};
use pipette_entry_store::Entry;
use pipette_js_json::{JsString, Object, Value};
use pipette_pack_stores::i18n::{
    self, BUILTIN_ENGLISH_PACK_ID, Cached, CoverageValues, SavePackInput, delete_pack, get_pack,
    list_all_metas, list_metas, rename_pack, reorder_active, save_pack, set_hub_post_id,
};
use pipette_pack_stores::{ErrorCode, Field};

const ENGLISH: &str = BUILTIN_ENGLISH_PACK_ID;

fn js(text: &str) -> JsString {
    JsString::from(text)
}

fn pack(name: &str) -> Value {
    let mut pack = Object::new();
    pack.insert("name", name.into());
    pack.insert("version", "0.1.0".into());
    let mut common = Object::new();
    common.insert("save", "Save".into());
    pack.insert("common", common.into());
    Value::Object(pack)
}

fn save(h: &Harness, name: &str) -> Entry {
    save_pack(&h.ctx, SavePackInput { pack: Some(pack(name)), ..SavePackInput::default() }).unwrap()
}

fn id_of(meta: &Entry) -> JsString {
    meta.id().unwrap().clone()
}

fn names(metas: &[Entry]) -> Vec<String> {
    metas.iter().map(|m| m.get("name").unwrap().as_str().unwrap().to_owned()).collect()
}

fn ids(metas: &[Entry]) -> Vec<String> {
    metas.iter().map(|m| m.id().unwrap().to_string_lossy().into_owned()).collect()
}

fn string_field(meta: &Entry, key: &str) -> Option<String> {
    meta.get(key).and_then(Value::as_str).map(str::to_owned)
}

#[test]
fn reorder_puts_the_listed_live_packs_first() {
    let h = Harness::new();
    let a = id_of(&save(&h, "Alpha"));
    let b = id_of(&save(&h, "Beta"));
    let c = id_of(&save(&h, "Gamma"));
    reorder_active(&h.ctx, &[c, a, b]).unwrap();
    assert_eq!(names(&list_metas(&h.ctx).unwrap()), ["English", "Gamma", "Alpha", "Beta"]);
}

#[test]
fn reorder_keeps_tombstones_and_unlisted_packs_behind() {
    let h = Harness::new();
    let keep = id_of(&save(&h, "Keep"));
    let removed = id_of(&save(&h, "Remove"));
    save(&h, "Unlisted");
    delete_pack(&h.ctx, &removed).unwrap();
    reorder_active(&h.ctx, std::slice::from_ref(&keep)).unwrap();
    let all = list_all_metas(&h.ctx).unwrap();
    // English is created by the list after the reorder, so it comes first.
    assert_eq!(names(&all), ["English", "Keep", "Remove", "Unlisted"]);
    assert!(all[2].is_deleted());
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
    let metas = list_metas(&h.ctx).unwrap();
    assert_eq!(metas[1..], [b, a]);
}

#[test]
fn a_save_keeps_the_uploader_name_it_is_given() {
    let h = Harness::new();
    let input = SavePackInput {
        pack: Some(pack("Authored")),
        uploader_name: Field::Set(js("alice")),
        ..SavePackInput::default()
    };
    assert_eq!(string_field(&save_pack(&h.ctx, input).unwrap(), "uploaderName").as_deref(), Some("alice"));
    assert_eq!(string_field(&save(&h, "Legacy"), "uploaderName"), None);
}

#[test]
fn hub_links_set_keep_and_drop_the_cached_fields() {
    let h = Harness::new();
    let pack_id = id_of(&save(&h, "Upload Me"));
    let set = |post: Option<&str>, uploader: Cached, updated: Cached| {
        set_hub_post_id(&h.ctx, &pack_id, post.map(js).as_ref(), uploader, updated).unwrap()
    };
    let uploaded =
        set(Some("hub-1"), Cached::Set(Some(js("alice"))), Cached::Set(Some(js("2026-05-01T00:00:00.000Z"))));
    assert_eq!(string_field(&uploaded, "hubPostId").as_deref(), Some("hub-1"));
    assert_eq!(string_field(&uploaded, "uploaderName").as_deref(), Some("alice"));

    let updated = set(Some("hub-1"), Cached::Keep, Cached::Set(Some(js("2026-06-01T00:00:00.000Z"))));
    assert_eq!(string_field(&updated, "uploaderName").as_deref(), Some("alice"));
    assert_eq!(string_field(&updated, "hubUpdatedAt").as_deref(), Some("2026-06-01T00:00:00.000Z"));

    let detached = set(None, Cached::Keep, Cached::Keep);
    assert_eq!(string_field(&detached, "hubPostId"), None);
    assert_eq!(string_field(&detached, "hubUpdatedAt"), None);
    assert_eq!(string_field(&detached, "uploaderName").as_deref(), Some("alice"));

    let cleared = set(Some(" "), Cached::Set(None), Cached::Keep);
    assert_eq!(string_field(&cleared, "hubPostId"), None);
    assert_eq!(string_field(&cleared, "uploaderName"), None);
}

#[test]
fn the_first_list_creates_english_once_and_reports_only_the_index() {
    let h = Harness::new();
    let first = list_metas(&h.ctx).unwrap();
    assert_eq!(ids(&first), [ENGLISH]);
    assert_eq!(string_field(&first[0], "uploaderName").as_deref(), Some("pipette"));
    assert_eq!(first[0].get("enabled"), Some(&Value::Bool(true)));
    assert_eq!(h.notified(), ["i18n/index"]);
    assert_eq!(
        h.read("sync/i18n/packs/builtin-english.json"),
        "{\n  \"name\": \"English\",\n  \"version\": \"0.0.0\"\n}"
    );

    h.clock.set(ms("2027-01-01T00:00:00.000Z"));
    assert_eq!(list_metas(&h.ctx).unwrap(), first);
    assert_eq!(h.notified(), ["i18n/index"]);
}

#[test]
fn english_goes_first_in_an_index_that_has_packs_already() {
    let h = Harness::new();
    save(&h, "Alpha");
    save(&h, "Beta");
    assert_eq!(names(&list_metas(&h.ctx).unwrap()), ["English", "Alpha", "Beta"]);
}

#[test]
fn english_cannot_be_deleted_or_overwritten_but_can_be_renamed_and_moved() {
    let h = Harness::new();
    list_metas(&h.ctx).unwrap();
    assert_eq!(delete_pack(&h.ctx, &js(ENGLISH)).unwrap_err().code, ErrorCode::InvalidName);

    let same_name =
        save_pack(&h.ctx, SavePackInput { pack: Some(pack("english")), ..SavePackInput::default() });
    assert_eq!(same_name.unwrap_err().code, ErrorCode::DuplicateName);
    let by_id =
        SavePackInput { id: Some(js(ENGLISH)), pack: Some(pack("Hacked")), ..SavePackInput::default() };
    assert_eq!(save_pack(&h.ctx, by_id).unwrap_err().code, ErrorCode::InvalidName);
    let english = get_pack(&h.ctx, &js(ENGLISH)).unwrap();
    assert_eq!(
        pipette_js_json::stringify(english.get("pack").unwrap()),
        r#"{"name":"English","version":"0.0.0"}"#
    );

    let a = id_of(&save(&h, "Alpha"));
    reorder_active(&h.ctx, &[a.clone(), js(ENGLISH)]).unwrap();
    assert_eq!(ids(&list_metas(&h.ctx).unwrap()), [a.to_string_lossy().into_owned(), ENGLISH.to_owned()]);

    h.clear_notified();
    rename_pack(&h.ctx, &js(ENGLISH), &js("Renamed English")).unwrap();
    assert_eq!(h.notified(), ["i18n/index"]);
}

#[test]
fn english_gets_its_body_back_when_the_index_has_it_without_one() {
    let h = Harness::new();
    h.write(
        "sync/i18n/index.json",
        r#"{"metas":[{"id":"builtin-english","filename":"packs/builtin-english.json","name":"English","version":"0.0.0","enabled":true,"savedAt":"now","updatedAt":"now"}]}"#,
    );
    assert_eq!(get_pack(&h.ctx, &js(ENGLISH)).unwrap_err().code, ErrorCode::IoError);
    list_metas(&h.ctx).unwrap();
    assert!(get_pack(&h.ctx, &js(ENGLISH)).is_ok());
    assert!(h.notified().is_empty());
}

#[test]
fn overlapping_writes_run_one_at_a_time() {
    let h = Harness::new();
    let a = id_of(&save(&h, "Alpha"));
    let b = id_of(&save(&h, "Beta"));
    thread::scope(|scope| {
        let ctx = &h.ctx;
        let (a1, a2, b1) = (a.clone(), a.clone(), b.clone());
        scope.spawn(move || rename_pack(ctx, &a1, &js("Alpha Renamed")).unwrap());
        scope.spawn(move || reorder_active(ctx, &[b1, a2]).unwrap());
    });
    let metas = list_metas(&h.ctx).unwrap();
    assert!(names(&metas).contains(&"Alpha Renamed".to_owned()));
    let order = ids(&metas);
    let at = |id: &JsString| order.iter().position(|x| *x == id.to_string_lossy()).unwrap();
    assert!(at(&b) < at(&a));
}

#[test]
fn a_rename_changes_the_meta_only() {
    let h = Harness::new();
    let pack_id = id_of(&save(&h, "Lang"));
    let body = format!("sync/i18n/packs/{}.json", pack_id.to_string_lossy());
    let before = h.read(&body);
    h.clear_notified();
    rename_pack(&h.ctx, &pack_id, &js("Renamed")).unwrap();
    assert_eq!(h.read(&body), before);
    assert_eq!(h.notified(), ["i18n/index"]);
    let record = get_pack(&h.ctx, &pack_id).unwrap();
    let Some(Value::Object(shown)) = record.get("pack") else { panic!() };
    assert_eq!(shown.get("name"), Some(&Value::from("Renamed")));
}

#[test]
fn a_save_over_a_renamed_pack_keeps_the_name_and_takes_the_body() {
    let h = Harness::new();
    let pack_id = id_of(&save(&h, "Lang"));
    rename_pack(&h.ctx, &pack_id, &js("Mine")).unwrap();
    let mut body = pack("Lang");
    if let Value::Object(body) = &mut body {
        body.insert("version", "2.0.0".into());
    }
    let input = SavePackInput { id: Some(pack_id), pack: Some(body), ..SavePackInput::default() };
    let again = save_pack(&h.ctx, input).unwrap();
    assert_eq!(string_field(&again, "name").as_deref(), Some("Mine"));
    assert_eq!(string_field(&again, "version").as_deref(), Some("2.0.0"));
}

fn seed(h: &Harness, metas: &str) {
    h.write("sync/i18n/index.json", &format!(r#"{{"metas":[{metas}]}}"#));
    h.write("sync/i18n/packs/p1.json", r#"{"name":"x","version":"1.0.0"}"#);
}

const CLOCKED: &str = r#"{"id":"p1","filename":"packs/p1.json","name":"Pack p1","version":"1.0.0","enabled":true,"savedAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","clocks":{"created":"2026-01-01T00:00:00.000Z","body":"BODY","name":"2026-01-01T00:00:00.000Z","hub":"2026-01-01T00:00:00.000Z","enabled":"2026-01-01T00:00:00.000Z"}}"#;

fn coverage(clock: &str) -> CoverageValues {
    CoverageValues {
        matched_base_version: js("0.2.0"),
        total_keys: 3.0,
        covered_keys: 3.0,
        measured_body_clock: js(clock),
    }
}

#[test]
fn refreshing_the_coverage_moves_no_clock_and_reports_nothing() {
    let h = Harness::new();
    seed(&h, &CLOCKED.replace("BODY", "2026-01-01T00:00:00.000Z"));
    let before = i18n::get_pack(&h.ctx, &js("p1")).unwrap().get("meta").cloned().unwrap();
    let after = i18n::refresh_coverage(&h.ctx, &js("p1"), coverage("2026-01-01T00:00:00.000Z")).unwrap();
    let before = before.as_object().unwrap();
    assert_eq!(after.get("clocks"), before.get("clocks"));
    assert_eq!(after.get("updatedAt"), before.get("updatedAt"));
    assert_eq!(
        pipette_js_json::stringify(after.get("coverage").unwrap()),
        r#"{"totalKeys":3,"coveredKeys":3}"#
    );
    assert!(h.notified().is_empty());
}

#[test]
fn refreshing_the_coverage_of_a_changed_body_writes_nothing() {
    let h = Harness::new();
    seed(&h, &CLOCKED.replace("BODY", "2026-03-01T00:00:00.000Z"));
    let before = h.read("sync/i18n/index.json");
    let refused =
        i18n::refresh_coverage(&h.ctx, &js("p1"), coverage("2026-01-01T00:00:00.000Z")).unwrap_err();
    assert_eq!((refused.code, refused.message.as_str()), (ErrorCode::NotFound, "Language pack body changed"));
    assert_eq!(h.read("sync/i18n/index.json"), before);
}

#[test]
fn a_v1_meta_takes_its_body_clock_from_the_body_file_and_a_waiting_v2_meta_does_not() {
    let h = Harness::new();
    let v1 = r#"{"id":"p1","filename":"packs/p1.json","name":"One","version":"1.0.0","enabled":true,"savedAt":"2026-01-01T00:00:00.000Z"}"#;
    seed(&h, v1);
    let modified = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1_771_000_000_123);
    std::fs::File::options()
        .write(true)
        .open(h.path("sync/i18n/packs/p1.json"))
        .unwrap()
        .set_modified(modified)
        .unwrap();
    let meta = i18n::get_pack(&h.ctx, &js("p1")).unwrap();
    let clocks =
        meta.get("meta").unwrap().as_object().unwrap().get("clocks").unwrap().as_object().unwrap().clone();
    assert_eq!(clocks.get("body"), Some(&Value::from("2026-02-13T16:26:40.123Z")));

    seed(&h, &CLOCKED.replace("BODY", "1970-01-01T00:00:00.000Z"));
    let meta = i18n::get_pack(&h.ctx, &js("p1")).unwrap();
    let clocks =
        meta.get("meta").unwrap().as_object().unwrap().get("clocks").unwrap().as_object().unwrap().clone();
    assert_eq!(clocks.get("body"), Some(&Value::from("1970-01-01T00:00:00.000Z")));
}

fn hub_linked(h: &Harness, name: &str, post: &str) -> JsString {
    let input = SavePackInput {
        pack: Some(pack(name)),
        hub_post_id: Field::Set(js(post)),
        ..SavePackInput::default()
    };
    id_of(&save_pack(&h.ctx, input).unwrap())
}

fn unattended(pack_id: &JsString, post: &str, name: &str) -> SavePackInput {
    SavePackInput {
        id: Some(pack_id.clone()),
        pack: Some(pack(name)),
        hub_post_id: Field::Set(js(post)),
        unattended: true,
        ..SavePackInput::default()
    }
}

#[test]
fn an_unattended_save_updates_only_a_live_pack_still_linked_to_its_post() {
    let h = Harness::new();
    let pack_id = hub_linked(&h, "Hub Pack", "post-1");
    rename_pack(&h.ctx, &pack_id, &js("Mine")).unwrap();
    let enabled_clock = |meta: &Entry| meta.clocks().unwrap().get("enabled").cloned();
    let before = list_metas(&h.ctx).unwrap().into_iter().find(|m| m.id() == Some(&pack_id)).unwrap();

    h.clock.set(ms("2026-10-16T13:00:00.000Z"));
    let updated = save_pack(&h.ctx, unattended(&pack_id, "post-1", "Hub Pack v2")).unwrap();
    assert_eq!(string_field(&updated, "name").as_deref(), Some("Mine"));
    assert_eq!(enabled_clock(&updated), enabled_clock(&before));
    assert_eq!(updated.clocks().unwrap().get("created"), before.clocks().unwrap().get("created"));

    let refused = save_pack(&h.ctx, unattended(&pack_id, "post-2", "Hub Pack")).unwrap_err();
    assert_eq!(refused.code, ErrorCode::NotFound);
    delete_pack(&h.ctx, &pack_id).unwrap();
    assert_eq!(
        save_pack(&h.ctx, unattended(&pack_id, "post-1", "Hub Pack")).unwrap_err().code,
        ErrorCode::NotFound
    );
    assert_eq!(
        save_pack(&h.ctx, unattended(&js("missing"), "post-1", "X")).unwrap_err().code,
        ErrorCode::NotFound
    );
}

#[test]
fn a_user_save_brings_a_deleted_pack_back_enabled() {
    let h = Harness::new();
    let pack_id = id_of(&save(&h, "Back"));
    delete_pack(&h.ctx, &pack_id).unwrap();
    h.clock.set(ms("2026-10-16T13:00:00.000Z"));
    let input =
        SavePackInput { id: Some(pack_id.clone()), pack: Some(pack("Back")), ..SavePackInput::default() };
    let revived = save_pack(&h.ctx, input).unwrap();
    assert!(!revived.is_deleted());
    assert_eq!(revived.get("enabled"), Some(&Value::Bool(true)));
    assert_eq!(ids(&list_metas(&h.ctx).unwrap()), [ENGLISH.to_owned(), id(1)]);
}
