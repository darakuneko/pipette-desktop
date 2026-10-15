// SPDX-License-Identifier: GPL-2.0-or-later
//! The clock specs of src/main/__tests__/entry-store-clocks.test.ts: which
//! per-group clock each write path of the stores moves, revival on
//! explicit overwrites, the fixed built-in entries and the move of body
//! files to id-carrying names, written as the sequences of helper calls
//! the store handlers make.

#![allow(clippy::unwrap_used)]

mod common;

use std::fs;

use common::*;
use pipette_entry_store::{
    EPOCH_ISO, EntryError, EntryGroup, EntryList, EntryMutation, EntryStore, MetaGroup, OverwriteOptions,
    apply_entry_mutation, builtin_entry, clock_ms, create_entry, id_body_filename, normalize_entries,
    overwrite_entry, read_index_migrated, set_clock,
};
use pipette_js_json::{JsString, Object, Value};
use tempfile::TempDir;

const T0: i64 = 1_767_225_600_000; // 2026-01-01
const T1: i64 = 1_769_904_000_000; // 2026-02-01
const T2: i64 = 1_772_323_200_000; // 2026-03-01
const T3: i64 = 1_775_001_600_000; // 2026-04-01

fn iso(ms: i64) -> String {
    pipette_time::iso_8601_millis(ms)
}

fn clock_list(pairs: &[(&str, i64)]) -> String {
    let quoted: Vec<(&str, String)> = pairs.iter().map(|(k, v)| (*k, q(&iso(*v)))).collect();
    let refs: Vec<(&str, &str)> = quoted.iter().map(|(k, v)| (*k, v.as_str())).collect();
    fields(&refs)
}

const EXPLICIT_BODY: OverwriteOptions = OverwriteOptions { body: true, explicit: true };

fn id(text: &str) -> JsString {
    JsString::from(text)
}

fn meta(
    entries: &mut [pipette_entry_store::Entry],
    entry_id: &str,
    group: MetaGroup,
    now: i64,
    key: &str,
    value: &str,
) {
    apply_entry_mutation(entries, &id(entry_id), EntryMutation::Meta(group), now, |e| e.set(key, value))
        .unwrap();
}

#[test]
fn favorites_save_names_the_body_after_the_id_and_rename_hub_delete_each_move_their_own_clock() {
    let entry_id = id("6b1e");
    let filename =
        id_body_filename(EntryStore::Favorites, &entry_id, &id("macro_2026-01-01T00-00-00.000Z.json"));
    assert!(filename.as_str().unwrap().ends_with("_6b1e.json"));
    let fields = obj(&format!(
        r#"{{"id":"6b1e","label":"M","filename":{},"savedAt":{}}}"#,
        q(filename.as_str().unwrap()),
        q(&iso(T0))
    ));
    let mut entries = vec![create_entry(EntryStore::Favorites, fields, T0)];
    assert_eq!(clocks(&entries[0]), clock_list(&[("created", T0), ("body", T0), ("name", T0), ("hub", T0)]));

    meta(&mut entries, "6b1e", MetaGroup::Name, T1, "label", "M2");
    assert_eq!(clocks(&entries[0]), clock_list(&[("created", T0), ("body", T0), ("name", T1), ("hub", T0)]));
    assert_eq!(text(&entries[0], "updatedAt"), Some(iso(T1)));

    meta(&mut entries, "6b1e", MetaGroup::Hub, T2, "hubPostId", "post-1");
    assert_eq!(clocks(&entries[0]), clock_list(&[("created", T0), ("body", T0), ("name", T1), ("hub", T2)]));

    apply_entry_mutation(&mut entries, &entry_id, EntryMutation::Delete, T3, |_| {}).unwrap();
    assert_eq!(text(&entries[0], "deletedAt"), Some(iso(T3)));
    assert_eq!(clock(&entries[0], EntryGroup::Hub), iso(T2));
    assert_eq!(text(&entries[0], "updatedAt"), Some(iso(T3)));
}

#[test]
fn favorites_import_sets_created_to_now_and_keeps_the_exported_saved_at() {
    let fields = obj(
        r#"{"id":"i","label":"Imported","filename":"macro_x_i.json","savedAt":"2020-01-01T00:00:00.000Z"}"#,
    );
    let e = create_entry(EntryStore::Favorites, fields, T1);
    assert_eq!(text(&e, "savedAt").as_deref(), Some("2020-01-01T00:00:00.000Z"));
    assert_eq!(clock(&e, EntryGroup::Created), iso(T1));
}

struct Index {
    head: Object,
    entries: Vec<pipette_entry_store::Entry>,
}

impl EntryList for Index {
    fn entries(&self) -> &[pipette_entry_store::Entry] {
        &self.entries
    }

    fn entries_mut(&mut self) -> &mut [pipette_entry_store::Entry] {
        &mut self.entries
    }
}

#[test]
fn a_locked_write_moves_a_v1_entrys_legacy_body_file_to_an_id_carrying_name() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    let v1 = format!(
        r#"{{"type":"macro","entries":[{{"id":"f1","label":"L","filename":"macro_ts_ab.json","savedAt":{0},"updatedAt":{0}}}]}}"#,
        q(&iso(T0))
    );
    fs::write(dir.join("index.json"), &v1).unwrap();
    fs::write(dir.join("macro_ts_ab.json"), r#"{"data":1}"#).unwrap();

    let mut index = read_index_migrated(
        EntryStore::Favorites,
        dir,
        || {
            let head = obj(&fs::read_to_string(dir.join("index.json"))?);
            let entries = normalize_entries(EntryStore::Favorites, head.get("entries"));
            Ok(Index { head, entries })
        },
        |index| {
            let mut out = index.head.clone();
            out.insert("entries", Value::Array(index.entries.iter().cloned().map(Value::from).collect()));
            fs::write(dir.join("index.json"), json(out))
        },
    )
    .unwrap();
    meta(&mut index.entries, "f1", MetaGroup::Name, T1, "label", "L2");

    assert_eq!(text(&index.entries[0], "filename").as_deref(), Some("macro_ts_ab_f1.json"));
    assert_eq!(clock(&index.entries[0], EntryGroup::Body), iso(T0));
    let mut listing: Vec<String> =
        fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    listing.sort();
    assert_eq!(listing, ["index.json", "macro_ts_ab_f1.json"]);
    assert_eq!(fs::read_to_string(dir.join("macro_ts_ab_f1.json")).unwrap(), r#"{"data":1}"#);
}

fn snapshot() -> pipette_entry_store::Entry {
    let fields = obj(&format!(
        r#"{{"id":"s1","label":"L","filename":"KB_ts_s1.pipette","savedAt":{},"vilVersion":1}}"#,
        q(&iso(T0))
    ));
    create_entry(EntryStore::Snapshots, fields, T0)
}

fn snapshot_update(
    existing: &pipette_entry_store::Entry,
    vil_version: f64,
    now: i64,
) -> Result<pipette_entry_store::Entry, EntryError> {
    let mut next = existing.as_object().clone();
    next.insert("vilVersion", Value::Number(vil_version));
    overwrite_entry(EntryStore::Snapshots, Some(existing), next, now, EXPLICIT_BODY)
}

#[test]
fn a_snapshot_update_is_an_explicit_overwrite_moving_created_and_body_but_not_name_and_hub() {
    let e = snapshot_update(&snapshot(), 2.0, T1).unwrap();
    assert_eq!(clocks(&e), clock_list(&[("created", T1), ("body", T1), ("name", T0), ("hub", T0)]));
}

#[test]
fn the_v1_to_v2_migration_update_moves_body_1_ms_past_its_old_value() {
    let mut e = snapshot();
    let old = clock_ms(e.clock(EntryGroup::Body));
    set_clock(&mut e, EntryGroup::Body, &iso(old + 1));
    assert_eq!(clocks(&e), clock_list(&[("created", T0), ("body", T0 + 1), ("name", T0), ("hub", T0)]));
    assert_eq!(text(&e, "updatedAt"), Some(iso(T0 + 1)));
}

#[test]
fn a_user_update_of_an_entry_deleted_meanwhile_brings_it_back() {
    let mut entries = vec![snapshot()];
    apply_entry_mutation(&mut entries, &id("s1"), EntryMutation::Delete, T1, |_| {}).unwrap();
    let e = snapshot_update(&entries[0], 2.0, T2).unwrap();
    assert!(!e.is_deleted());
    assert_eq!(clock(&e, EntryGroup::Created), iso(T2));
}

#[test]
fn the_builtin_qwerty_entry_is_identical_on_every_device() {
    let qwerty = || {
        obj(
            r#"{"id":"qwerty","name":"QWERTY","uploaderName":"pipette","filename":"qwerty_builtin.json","savedAt":"1970-01-01T00:00:00.000Z"}"#,
        )
    };
    let first = builtin_entry(EntryStore::KeyLabels, qwerty());
    assert_eq!(json(first.clone()), json(builtin_entry(EntryStore::KeyLabels, qwerty())));
    assert_eq!(text(&first, "updatedAt").as_deref(), Some(EPOCH_ISO));
    assert!(first.clocks().unwrap().iter().all(|(_, c)| c.as_str() == Some(EPOCH_ISO)));
}

#[test]
fn the_qwerty_uploader_name_is_backfilled_at_the_epoch_hub_clock() {
    let v1 = obj(&format!(
        r#"{{"id":"qwerty","name":"QWERTY","filename":"qwerty_old.json","savedAt":{},"updatedAt":{}}}"#,
        q(&iso(T0)),
        q(&iso(T1))
    ));
    let mut e = normalize_entries(EntryStore::KeyLabels, Some(&Value::Array(vec![v1.into()]))).remove(0);
    e.set("uploaderName", "pipette");
    set_clock(&mut e, EntryGroup::Hub, EPOCH_ISO);
    assert_eq!(clock(&e, EntryGroup::Hub), EPOCH_ISO);
    assert_eq!(clock(&e, EntryGroup::Name), iso(T1));
}

fn key_label(name: &str, extra: &str) -> Object {
    obj(&format!(r#"{{"id":"k","name":{},"filename":"k_x.json","savedAt":{}{extra}}}"#, q(name), q(&iso(T0))))
}

#[test]
fn a_key_label_rename_moves_name_only_and_a_hub_sync_keeping_the_name_moves_body_created_and_hub() {
    let mut entries =
        vec![create_entry(EntryStore::KeyLabels, key_label("Mine", r#","hubPostId":"post""#), T0)];
    meta(&mut entries, "k", MetaGroup::Name, T1, "name", "Renamed");
    assert_eq!(clocks(&entries[0]), clock_list(&[("created", T0), ("body", T0), ("name", T1), ("hub", T0)]));
    let next = key_label("Renamed", &format!(r#","hubPostId":"post","hubUpdatedAt":{}"#, q(&iso(T2))));
    let e = overwrite_entry(EntryStore::KeyLabels, Some(&entries[0]), next, T2, EXPLICIT_BODY).unwrap();
    assert_eq!(clocks(&e), clock_list(&[("created", T2), ("body", T2), ("name", T1), ("hub", T2)]));
}

#[test]
fn a_hub_download_over_a_deleted_label_brings_it_back_past_deleted_at() {
    let mut entries =
        vec![create_entry(EntryStore::KeyLabels, key_label("L", r#","hubPostId":"post-1""#), T0)];
    apply_entry_mutation(&mut entries, &id("k"), EntryMutation::Delete, T2, |_| {}).unwrap();
    // This device's clock runs behind the delete.
    let e = overwrite_entry(
        EntryStore::KeyLabels,
        Some(&entries[0]),
        key_label("L", r#","hubPostId":"post-1""#),
        T1,
        EXPLICIT_BODY,
    )
    .unwrap();
    assert!(!e.is_deleted());
    assert_eq!(clock(&e, EntryGroup::Created), iso(T2 + 1));
}

fn text_entry(name: &str) -> Object {
    obj(&format!(
        r#"{{"id":"t","name":{},"wordCount":2,"lineCount":1,"filename":"t_x.json","savedAt":{}}}"#,
        q(name),
        q(&iso(T0))
    ))
}

#[test]
fn a_typing_test_text_rename_moves_only_the_name_clock() {
    let mut entries = vec![create_entry(EntryStore::TypingTestTexts, text_entry("T"), T0)];
    meta(&mut entries, "t", MetaGroup::Name, T1, "name", "T2");
    assert_eq!(clocks(&entries[0]), clock_list(&[("created", T0), ("body", T0), ("name", T1)]));
}

#[test]
fn a_typing_test_text_overwrite_that_keeps_the_name_does_not_move_the_name_clock() {
    let existing = create_entry(EntryStore::TypingTestTexts, text_entry("T"), T0);
    let e = overwrite_entry(EntryStore::TypingTestTexts, Some(&existing), text_entry("T"), T1, EXPLICIT_BODY)
        .unwrap();
    assert_eq!(clocks(&e), clock_list(&[("created", T1), ("body", T1), ("name", T0)]));
}

#[test]
fn theme_pack_rename_hub_delete_move_their_own_clocks_and_a_save_over_the_tombstone_revives_it() {
    let pack = |name: &str| {
        obj(&format!(
            r#"{{"id":"th","filename":"packs/th.json","name":{},"version":"1.0.0","savedAt":{}}}"#,
            q(name),
            q(&iso(T0))
        ))
    };
    let mut entries = vec![create_entry(EntryStore::ThemePacks, pack("Theme"), T0)];
    meta(&mut entries, "th", MetaGroup::Name, T1, "name", "Theme 2");
    assert_eq!(clocks(&entries[0]), clock_list(&[("created", T0), ("body", T0), ("name", T1), ("hub", T0)]));
    meta(&mut entries, "th", MetaGroup::Hub, T2, "hubPostId", "post");
    apply_entry_mutation(&mut entries, &id("th"), EntryMutation::Delete, T2, |_| {}).unwrap();
    assert_eq!(clock(&entries[0], EntryGroup::Hub), iso(T2));
    assert_eq!(text(&entries[0], "deletedAt"), Some(iso(T2)));

    let e = overwrite_entry(EntryStore::ThemePacks, Some(&entries[0]), pack("Theme 3"), T3, EXPLICIT_BODY)
        .unwrap();
    assert!(!e.is_deleted());
    assert_eq!(clock(&e, EntryGroup::Created), iso(T3));
    assert_eq!(text(&e, "name").as_deref(), Some("Theme 3"));
}

fn lang(name: &str, version: &str, extra: &str) -> Object {
    obj(&format!(
        r#"{{"id":"l","filename":"packs/l.json","name":{},"version":{},"enabled":true,"savedAt":{}{extra}}}"#,
        q(name),
        q(version),
        q(&iso(T0))
    ))
}

#[test]
fn the_builtin_english_pack_has_epoch_clocks() {
    let english = builtin_entry(EntryStore::I18nPacks, lang("English", "1", ""));
    assert_eq!(text(&english, "updatedAt").as_deref(), Some(EPOCH_ISO));
    assert!(english.clocks().unwrap().iter().all(|(_, c)| c.as_str() == Some(EPOCH_ISO)));
}

#[test]
fn set_enabled_moves_enabled_and_a_user_save_over_a_deleted_pack_revives_it() {
    let mut entries = vec![create_entry(EntryStore::I18nPacks, lang("Lang", "1.0.0", ""), T0)];
    apply_entry_mutation(&mut entries, &id("l"), EntryMutation::Meta(MetaGroup::Enabled), T1, |e| {
        e.set("enabled", false)
    })
    .unwrap();
    assert_eq!(
        clocks(&entries[0]),
        clock_list(&[("created", T0), ("body", T0), ("name", T0), ("hub", T0), ("enabled", T1)])
    );
    apply_entry_mutation(&mut entries, &id("l"), EntryMutation::Delete, T1, |_| {}).unwrap();
    let e = overwrite_entry(
        EntryStore::I18nPacks,
        Some(&entries[0]),
        lang("Lang", "2.0.0", ""),
        T2,
        EXPLICIT_BODY,
    )
    .unwrap();
    assert!(!e.is_deleted());
    assert_eq!(e.get("enabled"), Some(&Value::Bool(true)));
    assert_eq!(clock(&e, EntryGroup::Created), iso(T2));
    assert_eq!(clock(&e, EntryGroup::Enabled), iso(T2));
}

#[test]
fn an_unattended_hub_update_keeps_the_local_name_and_moves_only_body_and_a_changed_hub() {
    let mut entries =
        vec![create_entry(EntryStore::I18nPacks, lang("Hub Lang", "1.0.0", r#","hubPostId":"post""#), T0)];
    meta(&mut entries, "l", MetaGroup::Name, T1, "name", "My Name");
    let next = lang("My Name", "2.0.0", &format!(r#","hubPostId":"post","hubUpdatedAt":{}"#, q(&iso(T2))));
    let unattended = OverwriteOptions { body: true, explicit: false };
    let e = overwrite_entry(EntryStore::I18nPacks, Some(&entries[0]), next.clone(), T2, unattended).unwrap();
    assert_eq!(
        clocks(&e),
        clock_list(&[("created", T0), ("body", T2), ("name", T1), ("hub", T2), ("enabled", T0)])
    );

    apply_entry_mutation(&mut entries, &id("l"), EntryMutation::Delete, T2, |_| {}).unwrap();
    assert_eq!(
        overwrite_entry(EntryStore::I18nPacks, Some(&entries[0]), next, T2, unattended),
        Err(EntryError::UnattendedRevive)
    );
}
