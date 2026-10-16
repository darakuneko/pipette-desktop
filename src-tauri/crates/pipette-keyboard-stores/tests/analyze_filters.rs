// SPDX-License-Identifier: GPL-2.0-or-later
//! The Analyze filter store, as specified by the TypeScript tests of
//! src/main/__tests__/analyze-filter-store-hub-post-id.test.ts, with the
//! write serialization on top.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::sync::Arc;
use std::thread;

use common::Harness;
use pipette_entry_store::Entry;
use pipette_js_json::Value;
use pipette_keyboard_stores::{
    delete_analyze_filter, list_analyze_filters, load_analyze_filter, save_analyze_filter,
    set_analyze_filter_hub_post_id,
};

const UID: &str = "kb-uid-1";

fn save(h: &Harness, label: &str) -> String {
    let entry = save_analyze_filter(&h.ctx, UID, r#"{"version":1}"#, label, None).unwrap();
    entry.id().unwrap().as_str().unwrap().to_owned()
}

/// The entries of the index file as written.
fn index_entries(h: &Harness) -> Vec<Value> {
    let path = h.user_data().join("sync/keyboards").join(UID).join("analyze_filters/index.json");
    let parsed = pipette_js_json::parse(&std::fs::read_to_string(path).unwrap()).unwrap();
    let Some(Value::Array(entries)) = parsed.as_object().unwrap().get("entries").cloned() else { panic!() };
    entries
}

fn hub_post_id(entry: &Value) -> Option<&str> {
    entry.as_object().unwrap().get("hubPostId").and_then(Value::as_str)
}

#[test]
fn sets_a_hub_post_id_on_an_entry() {
    let h = Harness::new();
    let id = save(&h, "My filter");
    set_analyze_filter_hub_post_id(&h.ctx, UID, &id, Some("post-123")).unwrap();
    assert_eq!(hub_post_id(&index_entries(&h)[0]), Some("post-123"));
    assert_eq!(h.notified().last().map(String::as_str), Some("keyboards/kb-uid-1/analyze_filters"));
}

#[test]
fn none_and_a_blank_post_id_clear_it() {
    let h = Harness::new();
    let id = save(&h, "My filter");
    set_analyze_filter_hub_post_id(&h.ctx, UID, &id, Some("post-abc")).unwrap();
    set_analyze_filter_hub_post_id(&h.ctx, UID, &id, None).unwrap();
    assert_eq!(hub_post_id(&index_entries(&h)[0]), None);
    set_analyze_filter_hub_post_id(&h.ctx, UID, &id, Some("post-xyz")).unwrap();
    set_analyze_filter_hub_post_id(&h.ctx, UID, &id, Some("   ")).unwrap();
    assert_eq!(hub_post_id(&index_entries(&h)[0]), None);
}

#[test]
fn a_missing_entry_is_not_found() {
    let h = Harness::new();
    let missing = set_analyze_filter_hub_post_id(&h.ctx, UID, "no-such-id", Some("post-1")).unwrap_err();
    assert_eq!(missing.to_string(), "Entry not found");
}

#[test]
fn a_stamped_entry_lists_with_its_post_id_and_loads_its_body() {
    let h = Harness::new();
    let id = save(&h, "seed");
    set_analyze_filter_hub_post_id(&h.ctx, UID, &id, Some("post-direct")).unwrap();
    let listed = list_analyze_filters(&h.ctx, UID).unwrap();
    assert_eq!(listed[0].get("hubPostId").and_then(Value::as_str), Some("post-direct"));
    assert_eq!(load_analyze_filter(&h.ctx, UID, &id).unwrap(), r#"{"version":1}"#);
}

#[test]
fn a_deleted_entry_is_not_listed_or_loaded() {
    let h = Harness::new();
    let id = save(&h, "to-delete");
    delete_analyze_filter(&h.ctx, UID, &id).unwrap();
    assert!(list_analyze_filters(&h.ctx, UID).unwrap().is_empty());
    assert_eq!(load_analyze_filter(&h.ctx, UID, &id).unwrap_err().to_string(), "Entry has been deleted");
}

#[test]
fn uids_that_are_not_one_path_segment_are_refused() {
    let h = Harness::new();
    assert_eq!(list_analyze_filters(&h.ctx, "../..").unwrap_err().to_string(), "Error: Invalid uid");
    let saved = save_analyze_filter(&h.ctx, "foo/bar", "{}", "test", None).unwrap_err();
    assert_eq!(saved.to_string(), "Error: Invalid uid");
}

#[test]
fn concurrent_saves_of_one_keyboard_never_lose_an_entry() {
    let h = Arc::new(Harness::new());
    let workers: Vec<_> = (0..8)
        .map(|i| {
            let h = Arc::clone(&h);
            thread::spawn(move || -> Entry {
                save_analyze_filter(&h.ctx, UID, "{}", &format!("F {i}"), Some("s")).unwrap()
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(list_analyze_filters(&h.ctx, UID).unwrap().len(), 8);
}
