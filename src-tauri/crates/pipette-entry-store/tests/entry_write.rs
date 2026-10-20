// SPDX-License-Identifier: GPL-2.0-or-later
//! The specs of the entry write helpers.

#![allow(clippy::unwrap_used)]

mod common;

use common::*;
use pipette_entry_store::{
    EPOCH_ISO, EntryError, EntryGroup, EntryMutation, EntryStore, MetaGroup, OverwriteOptions,
    apply_entry_mutation, builtin_entry, create_entry, derived_updated_at, normalize_entries,
    normalize_entry, overwrite_entry,
};
use pipette_js_json::{JsString, Object, Value, parse};

const T0: i64 = 1_767_225_600_000; // 2026-01-01
const T1: i64 = 1_769_904_000_000; // 2026-02-01
const T2: i64 = 1_772_323_200_000; // 2026-03-01

fn iso(ms: i64) -> String {
    pipette_time::iso_8601_millis(ms)
}

fn label(overrides: &[(&str, &str)]) -> Object {
    let mut object = obj(&fields(&[
        ("id", "\"a\""),
        ("name", "\"A\""),
        ("filename", "\"a_1.json\""),
        ("savedAt", &q(&iso(T0))),
        ("updatedAt", &q(&iso(T0))),
    ]));
    for (key, value) in overrides {
        object.insert(*key, parse(value).unwrap());
    }
    object
}

const BOTH: OverwriteOptions = OverwriteOptions { body: true, explicit: true };

#[test]
fn normalize_entries_reads_v1_entries_and_drops_those_without_a_string_id() {
    let list = Value::Array(vec![
        label(&[]).into(),
        Value::Null,
        Value::Number(3.0),
        obj(r#"{"name":"no id"}"#).into(),
        obj(r#"{"id":1}"#).into(),
    ]);
    let out = normalize_entries(EntryStore::KeyLabels, Some(&list));
    assert_eq!(out.len(), 1);
    let t0 = q(&iso(T0));
    assert_eq!(clocks(&out[0]), fields(&[("created", &t0), ("body", &t0), ("name", &t0), ("hub", &t0)]));
}

#[test]
fn normalize_entries_returns_nothing_for_a_non_array() {
    assert!(normalize_entries(EntryStore::KeyLabels, None).is_empty());
    assert!(normalize_entries(EntryStore::KeyLabels, Some(&obj("{}").into())).is_empty());
}

#[test]
fn create_entry_starts_every_group_of_the_store_at_now_and_drops_deleted_at() {
    let e = create_entry(EntryStore::KeyLabels, label(&[("deletedAt", &q(&iso(T0)))]), T1);
    let t1 = q(&iso(T1));
    assert_eq!(clocks(&e), fields(&[("created", &t1), ("body", &t1), ("name", &t1), ("hub", &t1)]));
    assert_eq!(text(&e, "updatedAt"), Some(iso(T1)));
    assert!(!e.is_deleted());
}

#[test]
fn builtin_entry_gives_every_clock_and_updated_at_the_epoch() {
    let fields = || obj(r#"{"id":"x","filename":"packs/x.json","savedAt":"1970-01-01T00:00:00.000Z"}"#);
    let a = builtin_entry(EntryStore::I18nPacks, fields());
    let b = builtin_entry(EntryStore::I18nPacks, fields());
    assert_eq!(json(a.clone()), json(b));
    assert_eq!(text(&a, "updatedAt").as_deref(), Some(EPOCH_ISO));
    assert!(a.clocks().unwrap().iter().all(|(_, c)| c.as_str() == Some(EPOCH_ISO)));
}

fn existing() -> pipette_entry_store::Entry {
    normalize_entry(EntryStore::KeyLabels, &label(&[]))
}

#[test]
fn overwrite_creates_when_there_is_no_existing_entry() {
    let e = overwrite_entry(EntryStore::KeyLabels, None, label(&[]), T1, BOTH).unwrap();
    assert_eq!(clock(&e, EntryGroup::Created), iso(T1));
}

#[test]
fn an_explicit_body_save_over_a_live_entry_moves_created_and_body_not_an_unchanged_name() {
    let e = overwrite_entry(
        EntryStore::KeyLabels,
        Some(&existing()),
        label(&[("filename", "\"a_2.json\"")]),
        T1,
        BOTH,
    )
    .unwrap();
    assert_eq!(clock(&e, EntryGroup::Created), iso(T1));
    assert_eq!(clock(&e, EntryGroup::Body), iso(T1));
    assert_eq!(clock(&e, EntryGroup::Name), iso(T0));
    assert_eq!(clock(&e, EntryGroup::Hub), iso(T0));
    assert_eq!(text(&e, "updatedAt"), Some(derived_updated_at(e.clocks().unwrap(), None)));
}

#[test]
fn overwrite_moves_a_meta_group_whose_values_changed() {
    let next = label(&[("name", "\"B\""), ("hubPostId", "\"p\"")]);
    let e = overwrite_entry(EntryStore::KeyLabels, Some(&existing()), next, T1, BOTH).unwrap();
    assert_eq!(clock(&e, EntryGroup::Name), iso(T1));
    assert_eq!(clock(&e, EntryGroup::Hub), iso(T1));
}

#[test]
fn a_meta_group_is_compared_by_canonical_json() {
    let ex = normalize_entry(
        EntryStore::Favorites,
        &obj(r#"{"id":"a","label":"L","hubPrivate":{"a":1,"b":2},"savedAt":"2026-01-01T00:00:00.000Z"}"#),
    );
    let next =
        obj(r#"{"id":"a","label":"L","hubPrivate":{"b":2,"a":1},"savedAt":"2026-01-01T00:00:00.000Z"}"#);
    let e = overwrite_entry(
        EntryStore::Favorites,
        Some(&ex),
        next,
        T1,
        OverwriteOptions { body: false, explicit: false },
    )
    .unwrap();
    assert_eq!(clocks(&e), clocks(&ex));
}

#[test]
fn an_unattended_save_moves_neither_created_nor_an_unchanged_name() {
    let options = OverwriteOptions { body: true, explicit: false };
    let e = overwrite_entry(
        EntryStore::KeyLabels,
        Some(&existing()),
        label(&[("filename", "\"a_2.json\"")]),
        T1,
        options,
    )
    .unwrap();
    assert_eq!(clock(&e, EntryGroup::Created), iso(T0));
    assert_eq!(clock(&e, EntryGroup::Name), iso(T0));
    assert_eq!(clock(&e, EntryGroup::Body), iso(T1));
}

#[test]
fn an_explicit_save_over_a_tombstone_revives_it_past_deleted_at_and_moves_every_group() {
    let dead = normalize_entry(
        EntryStore::KeyLabels,
        &label(&[("deletedAt", &q(&iso(T2))), ("updatedAt", &q(&iso(T2)))]),
    );
    let e = overwrite_entry(EntryStore::KeyLabels, Some(&dead), label(&[]), T1, BOTH).unwrap();
    assert!(!e.is_deleted());
    // A deletedAt from a clock running ahead still loses to the revival.
    assert_eq!(clock(&e, EntryGroup::Created), iso(T2 + 1));
    for group in [EntryGroup::Body, EntryGroup::Name, EntryGroup::Hub] {
        assert!(pipette_entry_store::clock_ms(e.clock(group)) >= T1, "{group:?}");
    }
}

#[test]
fn refuses_an_unattended_save_over_a_tombstone() {
    let dead = normalize_entry(EntryStore::KeyLabels, &label(&[("deletedAt", &q(&iso(T1)))]));
    let options = OverwriteOptions { body: true, explicit: false };
    assert_eq!(
        overwrite_entry(EntryStore::KeyLabels, Some(&dead), label(&[]), T2, options),
        Err(EntryError::UnattendedRevive)
    );
}

#[test]
fn apply_entry_mutation_moves_only_the_given_group_or_tombstones_for_delete() {
    let mut entries = vec![existing()];
    let a = JsString::from("a");
    let renamed = apply_entry_mutation(&mut entries, &a, EntryMutation::Meta(MetaGroup::Name), T1, |e| {
        e.set("name", "B");
    })
    .unwrap()
    .unwrap()
    .clone();
    assert_eq!(text(&renamed, "name").as_deref(), Some("B"));
    assert_eq!(clock(&renamed, EntryGroup::Name), iso(T1));
    assert_eq!(clock(&renamed, EntryGroup::Hub), iso(T0));
    assert_eq!(text(&renamed, "updatedAt"), Some(iso(T1)));
    assert_eq!(entries[0], renamed);
    let deleted = apply_entry_mutation(&mut entries, &a, EntryMutation::Delete, T2, |_| {}).unwrap().unwrap();
    assert_eq!(text(deleted, "deletedAt"), Some(iso(T2)));
    let missing = apply_entry_mutation(
        &mut entries,
        &JsString::from("missing"),
        EntryMutation::Meta(MetaGroup::Hub),
        T2,
        |_| {},
    );
    assert_eq!(missing, Ok(None));
}

#[test]
fn a_failed_mutation_leaves_the_entries_alone() {
    let mut entries = vec![existing()];
    pipette_entry_store::set_clock(&mut entries[0], EntryGroup::Hub, "+275760-09-13T00:00:00.000Z");
    let before = entries.clone();
    let result = apply_entry_mutation(
        &mut entries,
        &JsString::from("a"),
        EntryMutation::Meta(MetaGroup::Hub),
        T1,
        |e| {
            e.set("hubPostId", "p");
        },
    );
    assert_eq!(result, Err(EntryError::TimeOutOfRange));
    assert_eq!(entries, before);
}
