// SPDX-License-Identifier: GPL-2.0-or-later
//! The keymap snapshot handlers against what the TypeScript handlers did on
//! the same userData directory, step by step (tests/fixtures/
//! keymap_snapshots.json, written by `pnpm run
//! generate:analytics-db-fixtures`): each answer as JSON text and the tree
//! left at the end.

// Helpers outside #[test] functions unwrap fixture data too.
#![allow(clippy::unwrap_used)]

mod common;

use common::{array, build_tree, field, fixture, number, record_tree, text, tree_of, untag};
use pipette_js_json::Value;
use pipette_typing_analytics::keymap_snapshots::{
    save_snapshot_request, snapshot_for_range_request, snapshot_summaries_request,
};

#[test]
fn the_handlers_match_typescript() {
    let fixture = fixture("keymap_snapshots.json");
    let hash = text(&fixture, "machineHash").to_owned();
    let now = number(field(&fixture, "nowMs")) as i64;
    let machine_hash = || Ok(hash.clone());
    let dir = tempfile::tempdir().unwrap();
    build_tree(dir.path(), &tree_of(field(&fixture, "tree")));

    for (i, step) in array(&fixture, "steps").iter().enumerate() {
        let Some(Value::Array(args)) = untag(field(step, "args")) else { panic!("args of step {i}") };
        let arg = |n: usize| args.get(n).cloned().unwrap_or(Value::Null);
        let response = match text(step, "kind") {
            "save" => Some(save_snapshot_request(dir.path(), &arg(0), machine_hash, now).to_json()),
            "get" => snapshot_for_range_request(dir.path(), &arg(0), &arg(1), &arg(2), machine_hash)
                .ok()
                .map(|value| pipette_js_json::stringify(&value)),
            "list" => snapshot_summaries_request(dir.path(), &arg(0), machine_hash)
                .ok()
                .map(|value| pipette_js_json::stringify(&value)),
            other => panic!("unknown step {other}"),
        };
        assert_eq!(response.as_deref(), field(step, "response").as_str(), "step {i}: {step:?}");
    }
    let after = record_tree(&dir.path().join("typing-analytics"));
    assert_eq!(after, tree_of(field(&fixture, "after")));
}
