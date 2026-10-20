// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the recorded golden scenarios of the snapshot handlers:
//! the same userData files, clock and new ids, the same calls, then each
//! response, the notified units and every file left behind compared byte
//! for byte. A file-system error is recorded as `<os error>`, as its text
//! is the OS's.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use common::{Harness, build, ms, recorded, tree_of};
use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::{
    SnapshotError, delete_snapshot, field, list_snapshots, load_snapshot, rename_snapshot, response_json,
    save_snapshot, set_snapshot_hub_post_id, set_snapshot_hub_private, update_snapshot,
};

fn text(step: &Object, key: &str) -> String {
    step.get(key).unwrap().as_str().unwrap().to_owned()
}

fn number(step: &Object, key: &str) -> Option<f64> {
    match step.get(key) {
        Some(Value::Number(n)) => Some(*n),
        None => None,
        other => panic!("{key}: {other:?}"),
    }
}

/// The response the command answers, as JSON text; `None` for a clock move.
fn run_step(h: &Harness, step: &Object) -> Option<String> {
    let uid = || text(step, "uid");
    let id = || text(step, "id");
    let done = |result: Result<(), SnapshotError>| response_json(pipette_keyboard_stores::done(result));
    Some(match text(step, "op").as_str() {
        "at" => {
            h.clock.set(ms(&text(step, "time")));
            return None;
        }
        "list" => {
            response_json(list_snapshots(&h.ctx, &uid()).map(|entries| {
                field("entries", Value::Array(entries.into_iter().map(Value::from).collect()))
            }))
        }
        "save" => response_json(
            save_snapshot(
                &h.ctx,
                &uid(),
                &text(step, "json"),
                &text(step, "deviceName"),
                &text(step, "label"),
                number(step, "vilVersion"),
            )
            .map(|entry| field("entry", entry)),
        ),
        "load" => response_json(load_snapshot(&h.ctx, &uid(), &id()).map(|data| field("data", data))),
        "update" => {
            let migrate_from = step.get("migrateFrom").map(|_| text(step, "migrateFrom"));
            done(update_snapshot(
                &h.ctx,
                &uid(),
                &id(),
                &text(step, "json"),
                number(step, "vilVersion"),
                migrate_from.as_deref(),
            ))
        }
        "rename" => done(rename_snapshot(&h.ctx, &uid(), &id(), &text(step, "label"))),
        "delete" => done(delete_snapshot(&h.ctx, &uid(), &id())),
        "hubPostId" => {
            let post_id = step.get("hubPostId").unwrap().as_str().map(str::to_owned);
            done(set_snapshot_hub_post_id(&h.ctx, &uid(), &id(), post_id.as_deref()))
        }
        "hubPrivate" => {
            let link = step.get("link").cloned().filter(|link| *link != Value::Null);
            done(set_snapshot_hub_private(&h.ctx, &uid(), &id(), link))
        }
        op => panic!("unknown step {op}"),
    })
}

/// `got` with a file-system error's text replaced as the fixture records it.
fn as_recorded(got: String) -> String {
    let parsed = pipette_js_json::parse(&got).unwrap();
    let error = parsed.as_object().unwrap().get("error").and_then(Value::as_str).unwrap_or_default();
    let known = ["Error: Invalid uid", "Error: Invalid filename"];
    if error.starts_with("Error: ") && !known.contains(&error) {
        return r#"{"success":false,"error":"<os error>"}"#.to_owned();
    }
    got
}

#[test]
fn the_scenarios_match_the_typescript_handlers() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_snapshot_store_scenarios.json");
    let fixture = pipette_js_json::parse(&fs::read_to_string(path).unwrap()).unwrap();
    let Value::Array(scenarios) = fixture else { panic!("not a list") };
    assert!(!scenarios.is_empty());
    for scenario in &scenarios {
        let scenario = scenario.as_object().unwrap();
        let name = text(scenario, "name");
        let h = Harness::new();
        h.clock.set(ms(&text(scenario, "time")));
        build(h.user_data(), &tree_of(scenario.get("tree").unwrap()));

        let Some(Value::Array(steps)) = scenario.get("steps") else { panic!("{name}: no steps") };
        let Some(Value::Array(outcomes)) = scenario.get("outcomes") else { panic!("{name}: no outcomes") };
        assert_eq!(steps.len(), outcomes.len(), "{name}");
        for (at, (step, want)) in steps.iter().zip(outcomes).enumerate() {
            let got = run_step(&h, step.as_object().unwrap()).map(as_recorded);
            assert_eq!(got.as_deref(), want.as_str(), "{name}: step {at}");
        }

        let notified: Vec<String> = match scenario.get("notified") {
            Some(Value::Array(units)) => units.iter().map(|unit| unit.as_str().unwrap().to_owned()).collect(),
            other => panic!("{name}: notified {other:?}"),
        };
        assert_eq!(h.notified(), notified, "{name}: notified units");
        let want: BTreeMap<_, _> = tree_of(scenario.get("after").unwrap()).into_iter().collect();
        assert_eq!(recorded(h.user_data()), want, "{name}: files");
    }
}
