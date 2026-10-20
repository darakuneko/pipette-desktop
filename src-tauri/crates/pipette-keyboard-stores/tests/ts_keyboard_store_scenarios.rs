// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the recorded golden scenarios of the keyboard store handlers:
//! the same userData files and clock, the same calls, then each response,
//! the notified units and every file left behind compared byte for byte.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::fs;
use std::path::Path;

use common::{Harness, build, ms, recorded, tree_of, unsupported};
use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::{
    MetaOutcome, keyboard_meta_name_if_missing, list_stored_keyboards, stored_keyboards_json,
    upsert_keyboard_meta,
};

fn text(value: Option<&Value>) -> String {
    value.unwrap().as_str().unwrap().to_owned()
}

/// What a step responds: `Some(JSON text)`, `None` for undefined, or `Err`
/// for a throw.
type Outcome = Result<Option<String>, String>;

fn run_step(h: &Harness, step: &Object) -> Outcome {
    match text(step.get("op")).as_str() {
        "at" => {
            h.clock.set(ms(&text(step.get("time"))));
            Ok(None)
        }
        "list" => list_stored_keyboards(&h.ctx)
            .map(|list| Some(stored_keyboards_json(&list)))
            .map_err(|e| e.to_string()),
        "upsert" => {
            let name = match step.get("name") {
                Some(Value::String(name)) => name.clone(),
                other => panic!("name {other:?}"),
            };
            upsert_keyboard_meta(&h.ctx, &text(step.get("uid")), &name)
                .map(|outcome| {
                    Some(match outcome {
                        MetaOutcome::Unchanged => r#""unchanged""#.to_owned(),
                        MetaOutcome::Upserted => r#""upserted""#.to_owned(),
                    })
                })
                .map_err(|e| e.to_string())
        }
        "nameIfMissing" => {
            // The command passes a string argument as a string and treats
            // anything else as not a string.
            let uid = step.get("uid").and_then(Value::as_str);
            let name = step.get("name").and_then(Value::as_str);
            keyboard_meta_name_if_missing(&h.ctx, uid, name).map(|()| None).map_err(|e| e.to_string())
        }
        op => panic!("unknown step {op}"),
    }
}

fn expected_outcome(value: &Value) -> Outcome {
    let object = value.as_object().unwrap();
    if object.contains_key("throws") {
        return Err(String::new());
    }
    match object.get("out").unwrap() {
        Value::Null => Ok(None),
        out => Ok(Some(out.as_str().unwrap().to_owned())),
    }
}

#[test]
fn the_scenarios_match_the_typescript_handlers() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_keyboard_store_scenarios.json");
    let fixture = pipette_js_json::parse(&fs::read_to_string(path).unwrap()).unwrap();
    let Value::Array(scenarios) = fixture else { panic!("not a list") };
    assert!(!scenarios.is_empty());
    for scenario in &scenarios {
        let scenario = scenario.as_object().unwrap();
        let name = text(scenario.get("name"));
        let h = Harness::new();
        h.clock.set(ms(&text(scenario.get("time"))));
        let tree = tree_of(scenario.get("tree").unwrap());
        if let Some(reason) = unsupported(h.user_data(), &tree) {
            eprintln!("SKIPPED {name}: {reason}");
            continue;
        }
        build(h.user_data(), &tree);

        let Some(Value::Array(steps)) = scenario.get("steps") else { panic!("{name}: no steps") };
        let Some(Value::Array(outcomes)) = scenario.get("outcomes") else { panic!("{name}: no outcomes") };
        for (at, (step, want)) in steps.iter().zip(outcomes).enumerate() {
            let got = run_step(&h, step.as_object().unwrap());
            match (got, expected_outcome(want)) {
                (Err(_), Err(_)) => {}
                (got, want) => assert_eq!(got, want, "{name}: step {at}"),
            }
        }

        let notified: Vec<String> = match scenario.get("notified") {
            Some(Value::Array(units)) => units.iter().map(|unit| unit.as_str().unwrap().to_owned()).collect(),
            other => panic!("{name}: notified {other:?}"),
        };
        assert_eq!(h.notified(), notified, "{name}: notified units");
        let want: std::collections::BTreeMap<_, _> =
            tree_of(scenario.get("after").unwrap()).into_iter().collect();
        assert_eq!(recorded(h.user_data()), want, "{name}: files");
    }
}
