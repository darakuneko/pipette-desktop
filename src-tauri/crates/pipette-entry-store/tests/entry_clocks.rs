// SPDX-License-Identifier: GPL-2.0-or-later
//! The specs of src/main/sync/__tests__/entry-clocks.test.ts: the store
//! groups, clock parsing, canonical JSON, the v1 → v2 normalization and the
//! clock writers.

#![allow(clippy::unwrap_used)]

mod common;

use common::*;
use pipette_entry_store::{
    EPOCH_ISO, EntryError, EntryGroup, EntryStore, RESERVED_FIELDS, body_fields_of, canonical_json, clock_ms,
    derived_updated_at, group_values, mark_deleted, new_clocks, normalize_entry, revive_entry, set_clock,
    touch_clock,
};
use pipette_js_json::{Value, parse};

#[test]
fn the_body_list_is_exactly_the_fields_no_other_group_claims() {
    for store in EntryStore::ALL {
        let def = store.groups();
        let mut body: Vec<String> =
            body_fields_of(def, &full(store)).iter().map(|k| k.as_str().unwrap().to_owned()).collect();
        body.sort();
        let mut expected: Vec<&str> = def.body.to_vec();
        expected.sort();
        assert_eq!(body, expected, "{store:?}");
    }
}

#[test]
fn every_meta_field_belongs_to_exactly_one_group_or_is_reserved() {
    for store in EntryStore::ALL {
        let def = store.groups();
        let groups = [
            def.body,
            def.created_fields,
            def.name.unwrap_or(&[]),
            def.hub.unwrap_or(&[]),
            def.enabled.unwrap_or(&[]),
        ];
        for key in full(store).keys() {
            let key = key.as_str().unwrap();
            let owners = groups.iter().filter(|g| g.contains(&key)).count();
            assert_eq!(owners + usize::from(RESERVED_FIELDS.contains(&key)), 1, "{store:?} {key}");
        }
    }
}

#[test]
fn canonical_json_sorts_keys_at_every_level() {
    let value = parse(r#"{"b":1,"a":{"c":[{"z":1,"y":2}]}}"#).unwrap();
    assert_eq!(canonical_json(Some(&value)), r#"{"a":{"c":[{"y":2,"z":1}]},"b":1}"#);
    assert_eq!(canonical_json(None), "null");
}

#[test]
fn canonical_json_keeps_array_index_keys_first_and_leaves_out_proto() {
    let value = parse(r#"{"b":1,"10":2,"9":3,"__proto__":{"x":1},"a":null}"#).unwrap();
    assert_eq!(canonical_json(Some(&value)), r#"{"9":3,"10":2,"a":null,"b":1}"#);
}

#[test]
fn clock_ms_treats_non_strings_and_unparseable_strings_as_0() {
    assert_eq!(clock_ms(Some(&Value::Number(42.0))), 0);
    assert_eq!(clock_ms(Some(&Value::Null)), 0);
    assert_eq!(clock_ms(None), 0);
    assert_eq!(clock_ms(Some(&"garbage".into())), 0);
    assert_eq!(clock_ms(Some(&t(1).into())), ms(1));
}

// normalizeEntry — v1 entries

#[test]
fn v1_favorites_body_is_saved_at_and_meta_is_updated_at() {
    let n = normalized(EntryStore::Favorites, &full(EntryStore::Favorites));
    assert_eq!(
        clocks(&n),
        fields(&[("created", &q(&t(1))), ("body", &q(&t(1))), ("name", &q(&t(2))), ("hub", &q(&t(2)))])
    );
    assert_eq!(text(&n, "updatedAt"), Some(t(2)));
}

#[test]
fn v1_snapshots_and_analyze_filters_body_is_updated_at_or_saved_at() {
    assert_eq!(
        clock(&normalized(EntryStore::Snapshots, &full(EntryStore::Snapshots)), EntryGroup::Body),
        t(2)
    );
    assert_eq!(
        clock(&normalized(EntryStore::AnalyzeFilters, &full(EntryStore::AnalyzeFilters)), EntryGroup::Body),
        t(2)
    );
    let no_updated = without(full(EntryStore::Snapshots), "updatedAt");
    let t1 = q(&t(1));
    assert_eq!(
        clocks(&normalized(EntryStore::Snapshots, &no_updated)),
        fields(&[("created", &t1), ("body", &t1), ("name", &t1), ("hub", &t1)])
    );
}

#[test]
fn v1_key_labels_and_texts_body_is_saved_at_and_texts_have_no_hub_clock() {
    let (t1, t2) = (q(&t(1)), q(&t(2)));
    assert_eq!(
        clocks(&normalized(EntryStore::KeyLabels, &full(EntryStore::KeyLabels))),
        fields(&[("created", &t1), ("body", &t1), ("name", &t2), ("hub", &t2)])
    );
    assert_eq!(
        clocks(&normalized(EntryStore::TypingTestTexts, &full(EntryStore::TypingTestTexts))),
        fields(&[("created", &t1), ("body", &t1), ("name", &t2)])
    );
}

#[test]
fn v1_run_logs_have_no_meta_clocks_and_saved_at_is_a_body_field() {
    let t1 = q(&t(1));
    assert_eq!(
        clocks(&normalized(EntryStore::RunLogs, &full(EntryStore::RunLogs))),
        fields(&[("created", &t1), ("body", &t1)])
    );
    assert!(EntryStore::RunLogs.groups().body.contains(&"savedAt"));
}

#[test]
fn v1_packs_start_the_index_body_clock_at_the_epoch() {
    let (t1, t2, epoch) = (q(&t(1)), q(&t(2)), q(EPOCH_ISO));
    assert_eq!(
        clocks(&normalized(EntryStore::I18nPacks, &full(EntryStore::I18nPacks))),
        fields(&[("created", &t1), ("body", &epoch), ("name", &t2), ("hub", &t2), ("enabled", &t2)])
    );
    assert_eq!(
        clocks(&normalized(EntryStore::ThemePacks, &full(EntryStore::ThemePacks))),
        fields(&[("created", &t1), ("body", &epoch), ("name", &t2), ("hub", &t2)])
    );
}

#[test]
fn v1_keeps_a_tombstone_and_includes_deleted_at_in_updated_at() {
    let n = normalized(EntryStore::Favorites, &with(full(EntryStore::Favorites), "deletedAt", &q(&t(9))));
    assert_eq!(text(&n, "deletedAt"), Some(t(9)));
    assert_eq!(text(&n, "updatedAt"), Some(t(9)));
}

#[test]
fn normalization_keeps_the_key_order_and_unknown_fields() {
    let raw = obj(&format!(
        r#"{{"9":1,"zeta":true,"id":"f","updatedAt":{},"label":"L","savedAt":{},"extra":{{"b":1,"a":2}}}}"#,
        q(&t(2)),
        q(&t(1))
    ));
    let n = normalized(EntryStore::Favorites, &raw);
    let keys: Vec<_> = n.as_object().keys().map(|k| k.as_str().unwrap().to_owned()).collect();
    assert_eq!(keys, ["9", "zeta", "id", "updatedAt", "label", "savedAt", "extra", "clocks"]);
    assert_eq!(json(n.get("extra").unwrap().clone()), r#"{"b":1,"a":2}"#);
}

// normalizeEntry — v2 entries

fn v2() -> pipette_js_json::Object {
    let clocks =
        fields(&[("created", &q(&t(1))), ("body", &q(&t(1))), ("name", &q(&t(3))), ("hub", &q(&t(4)))]);
    with(with(full(EntryStore::Favorites), "clocks", &clocks), "updatedAt", &q(&t(4)))
}

fn v2_clocks() -> String {
    json(v2().get("clocks").unwrap().clone())
}

#[test]
fn v2_keeps_valid_clocks_and_rewrites_updated_at_as_their_max() {
    let n = normalized(EntryStore::Favorites, &with(v2(), "updatedAt", &q(&t(0))));
    assert_eq!(clocks(&n), v2_clocks());
    assert_eq!(text(&n, "updatedAt"), Some(t(4)));
}

#[test]
fn v2_treats_invalid_clocks_as_0_and_drops_groups_the_store_does_not_have() {
    let raw = with(
        without(full(EntryStore::Favorites), "updatedAt"),
        "clocks",
        &format!(r#"{{"created":42,"body":"garbage","name":null,"enabled":{}}}"#, q(&t(5))),
    );
    let epoch = q(EPOCH_ISO);
    assert_eq!(
        clocks(&normalized(EntryStore::Favorites, &raw)),
        fields(&[("created", &epoch), ("body", &epoch)])
    );
}

#[test]
fn a_non_object_clocks_value_is_read_as_v1_and_an_array_as_empty_clocks() {
    let (t1, t2) = (q(&t(1)), q(&t(2)));
    let n = normalized(EntryStore::Favorites, &with(full(EntryStore::Favorites), "clocks", "\"x\""));
    assert_eq!(clocks(&n), fields(&[("created", &t1), ("body", &t1), ("name", &t2), ("hub", &t2)]));
    // typeof [] is 'object': read as v2 clocks with none set, and the
    // updatedAt of a v1 write raises the meta clocks.
    let n = normalized(EntryStore::Favorites, &with(full(EntryStore::Favorites), "clocks", "[1]"));
    let epoch = q(EPOCH_ISO);
    assert_eq!(clocks(&n), fields(&[("created", &epoch), ("body", &epoch), ("name", &t2), ("hub", &t2)]));
}

#[test]
fn an_updated_at_newer_than_every_clock_raises_the_meta_clocks() {
    let n =
        normalized(EntryStore::Favorites, &with(with(v2(), "label", "\"renamed\""), "updatedAt", &q(&t(7))));
    let (t1, t7) = (q(&t(1)), q(&t(7)));
    assert_eq!(clocks(&n), fields(&[("created", &t1), ("body", &t1), ("name", &t7), ("hub", &t7)]));
    assert_eq!(text(&n, "updatedAt"), Some(t(7)));
}

#[test]
fn a_v1_app_write_on_a_snapshot_also_raises_the_body_clock() {
    let t1 = q(&t(1));
    let snap = with(
        with(
            full(EntryStore::Snapshots),
            "clocks",
            &fields(&[("created", &t1), ("body", &t1), ("name", &t1), ("hub", &t1)]),
        ),
        "updatedAt",
        &q(&t(7)),
    );
    let t7 = q(&t(7));
    assert_eq!(
        clocks(&normalized(EntryStore::Snapshots, &snap)),
        fields(&[("created", &t1), ("body", &t7), ("name", &t7), ("hub", &t7)])
    );
}

#[test]
fn a_v1_app_write_never_raises_created_or_a_saved_at_rule_body() {
    let t1 = q(&t(1));
    let entry = with(
        with(with(full(EntryStore::Favorites), "savedAt", &q(&t(8))), "updatedAt", &q(&t(8))),
        "clocks",
        &fields(&[("created", &t1), ("body", &t1), ("name", &t1), ("hub", &t1)]),
    );
    let t8 = q(&t(8));
    assert_eq!(
        clocks(&normalized(EntryStore::Favorites, &entry)),
        fields(&[("created", &t1), ("body", &t1), ("name", &t8), ("hub", &t8)])
    );
}

#[test]
fn an_entry_written_through_derived_updated_at_is_never_read_as_a_v1_write() {
    let mut entry = pipette_entry_store::Entry::from_object(with(v2(), "deletedAt", &q(&t(3))));
    touch_clock(&mut entry, EntryGroup::Name, ms(9)).unwrap();
    let n = normalize_entry(EntryStore::Favorites, entry.as_object());
    let expected = with(obj(&v2_clocks()), "name", &q(&t(9)));
    assert_eq!(clocks(&n), json(expected));
}

#[test]
fn an_updated_at_equal_to_deleted_at_is_not_read_as_a_v1_write() {
    let entry = with(with(v2(), "deletedAt", &q(&t(6))), "updatedAt", &q(&t(6)));
    assert_eq!(clocks(&normalized(EntryStore::Favorites, &entry)), v2_clocks());
}

#[test]
fn an_invalid_deleted_at_counts_as_0() {
    assert!(!normalized(EntryStore::Favorites, &with(v2(), "deletedAt", "\"bad\"")).is_deleted());
    let bad_created = with(
        with(v2(), "clocks", &json(with(obj(&v2_clocks()), "created", "\"bad\""))),
        "deletedAt",
        "\"bad\"",
    );
    assert_eq!(
        text(&normalized(EntryStore::Favorites, &bad_created), "deletedAt").as_deref(),
        Some(EPOCH_ISO)
    );
    // null is a value: the entry was deleted at an invalid time.
    assert_eq!(
        text(&normalized(EntryStore::Favorites, &with(bad_created, "deletedAt", "null")), "deletedAt")
            .as_deref(),
        Some(EPOCH_ISO)
    );
}

#[test]
fn drops_a_stale_deleted_at_from_an_entry_alive_under_the_merge_rule() {
    let entry = with(
        with(
            with(v2(), "clocks", &json(with(obj(&v2_clocks()), "created", &q(&t(6))))),
            "deletedAt",
            &q(&t(5)),
        ),
        "updatedAt",
        &q(&t(6)),
    );
    let n = normalized(EntryStore::Favorites, &entry);
    assert!(!n.is_deleted());
    assert_eq!(text(&n, "updatedAt"), Some(t(6)));
}

#[test]
fn a_v1_tombstone_never_comes_back() {
    let n = normalized(
        EntryStore::Favorites,
        &with(with(full(EntryStore::Favorites), "savedAt", &q(&t(6))), "deletedAt", &q(&t(5))),
    );
    assert_eq!(text(&n, "deletedAt"), Some(t(5)));
    assert_eq!(clock(&n, EntryGroup::Created), t(5));
    let n = normalized(EntryStore::Favorites, &with(full(EntryStore::Favorites), "deletedAt", &q(&t(5))));
    assert_eq!(clock(&n, EntryGroup::Created), t(1));
}

// Clock writers

fn base() -> pipette_entry_store::Entry {
    normalized(EntryStore::Favorites, &full(EntryStore::Favorites))
}

#[test]
fn touch_clock_sets_one_clock_and_rewrites_updated_at() {
    let mut e = base();
    touch_clock(&mut e, EntryGroup::Hub, ms(9)).unwrap();
    assert_eq!(clocks(&e), json(with(obj(&clocks(&base())), "hub", &q(&t(9)))));
    assert_eq!(text(&e, "updatedAt"), Some(derived_updated_at(e.clocks().unwrap(), None)));
}

#[test]
fn touching_created_past_deleted_at_revives_and_touching_another_group_does_not() {
    let mut dead = base();
    mark_deleted(&mut dead, ms(5));
    let mut named = dead.clone();
    touch_clock(&mut named, EntryGroup::Name, ms(9)).unwrap();
    assert_eq!(text(&named, "deletedAt"), Some(t(5)));
    touch_clock(&mut dead, EntryGroup::Created, ms(9)).unwrap();
    assert!(!dead.is_deleted());
}

#[test]
fn touch_clock_moves_a_group_1_ms_past_its_clock_when_now_is_behind() {
    let mut e = base();
    touch_clock(&mut e, EntryGroup::Name, ms(50)).unwrap();
    touch_clock(&mut e, EntryGroup::Name, ms(9)).unwrap();
    assert_eq!(clock(&e, EntryGroup::Name), pipette_time::iso_8601_millis(ms(50) + 1));
}

#[test]
fn touch_clock_past_the_last_date_fails_and_leaves_the_entry_alone() {
    let mut e = base();
    set_clock(&mut e, EntryGroup::Name, "+275760-09-13T00:00:00.000Z");
    let before = e.clone();
    assert_eq!(touch_clock(&mut e, EntryGroup::Name, ms(9)), Err(EntryError::TimeOutOfRange));
    assert_eq!(e, before);
}

#[test]
fn revive_entry_brings_a_tombstone_back_past_a_deleted_at_that_runs_ahead() {
    let mut back = base();
    mark_deleted(&mut back, ms(50));
    revive_entry(&mut back, ms(9)).unwrap();
    assert!(!back.is_deleted());
    assert_eq!(clock(&back, EntryGroup::Created), pipette_time::iso_8601_millis(ms(50) + 1));
    assert_eq!(text(&back, "updatedAt"), Some(clock(&back, EntryGroup::Created)));

    let mut dead = base();
    mark_deleted(&mut dead, ms(5));
    revive_entry(&mut dead, ms(9)).unwrap();
    assert_eq!(clock(&dead, EntryGroup::Created), t(9));

    let mut live = base();
    revive_entry(&mut live, ms(9)).unwrap();
    assert_eq!(live, base());
}

#[test]
fn new_clocks_start_every_group_the_store_has_at_now() {
    let t3 = q(&t(3));
    assert_eq!(
        json(new_clocks(EntryStore::I18nPacks, ms(3))),
        fields(&[("created", &t3), ("body", &t3), ("name", &t3), ("hub", &t3), ("enabled", &t3)])
    );
    assert_eq!(json(new_clocks(EntryStore::RunLogs, ms(3))), fields(&[("created", &t3), ("body", &t3)]));
}

#[test]
fn group_values_returns_one_group_the_body_being_every_unclaimed_field() {
    let def = EntryStore::Snapshots.groups();
    let snapshot = full(EntryStore::Snapshots);
    assert_eq!(
        json(group_values(def, &snapshot, EntryGroup::Body)),
        r#"{"filename":"s.pipette","vilVersion":2}"#
    );
    assert_eq!(
        json(group_values(def, &snapshot, EntryGroup::Hub)),
        r#"{"hubPostId":"h","hubPrivate":{"id":"p","url":"/p?token=x","expiresAt":null}}"#
    );
}

#[test]
fn mark_deleted_never_puts_deleted_at_before_created() {
    let mut ahead = base();
    set_clock(&mut ahead, EntryGroup::Created, &t(50));
    mark_deleted(&mut ahead, ms(9));
    assert_eq!(text(&ahead, "deletedAt"), Some(t(50)));
}
