// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the recorded golden scenarios of the run log store:
//! the same userData files, clock and recording consent, the same calls
//! with each log read from the JSON text the shim sends, then each
//! response, the notified units and every file left behind compared byte
//! for byte. A file-system error is recorded as `<os error>` and a body
//! that is not JSON as `<syntax error>`, as their texts are Node's and V8's.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::cell::Cell;

use common::{Harness, fixture_scenarios, ms, replay_scenarios, step_text as text};
use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::{field, get_run_log, list_run_logs, response_json, save_run_log};

const FIXTURE: &str = "ts_run_log_store_scenarios.json";

/// The scenario whose `startedAt` forms the handler takes and the crate
/// refuses.
const V8_ONLY: &str = "startedAt forms only V8 reads";

fn count(step: &Object, key: &str) -> Option<usize> {
    match step.get(key) {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Some(Value::Number(n)) => Some(*n as usize),
        None => None,
        other => panic!("{key}: {other:?}"),
    }
}

/// The log a save step sends, with the recorder's `keys` and `pad`
/// applied.
fn sent_log(step: &Object) -> Option<Value> {
    let mut log = step.get("logText").map(|t| pipette_js_json::parse(t.as_str().unwrap()).unwrap())?;
    if let Some(keys) = count(step, "keys") {
        let key = pipette_js_json::parse(r#"{"pressMs":0,"keycode":4,"row":0,"col":1}"#).unwrap();
        let word =
            pipette_js_json::parse(r#"{"index":0,"display":"w0","typed":"w0","correct":true}"#).unwrap();
        let Value::Object(mut word) = word else { panic!() };
        word.insert("keystrokes", Value::Array(vec![key; keys]));
        let Value::Object(object) = &mut log else { panic!() };
        object.insert("words", Value::Array(vec![Value::Object(word)]));
    }
    if let Some(pad) = count(step, "pad") {
        let Value::Object(object) = &mut log else { panic!() };
        object.insert("note", "x".repeat(pad).into());
    }
    Some(log)
}

fn run_step(h: &Harness, consent: &Cell<bool>, step: &Object) -> Option<String> {
    let uid = || text(step, "uid");
    Some(match text(step, "op").as_str() {
        "at" => {
            h.clock.set(ms(&text(step, "time")));
            return None;
        }
        "consent" => {
            consent.set(step.get("accepted") == Some(&Value::Bool(true)));
            return None;
        }
        "list" => {
            response_json(list_run_logs(&h.ctx, &uid()).map(|entries| {
                field("entries", Value::Array(entries.into_iter().map(Value::from).collect()))
            }))
        }
        "get" => {
            response_json(get_run_log(&h.ctx, &uid(), &text(step, "runId")).map(|data| field("data", data)))
        }
        "save" => {
            let log = sent_log(step);
            response_json(
                save_run_log(&h.ctx, &uid(), log.as_ref(), consent.get()).map(|entry| field("entry", entry)),
            )
        }
        op => panic!("unknown step {op}"),
    })
}

#[test]
fn the_scenarios_match_the_typescript_store() {
    let consent = Cell::new(true);
    replay_scenarios(
        FIXTURE,
        &[V8_ONLY],
        |_| {
            consent.set(true);
            Harness::new()
        },
        &["Error: Invalid filename"],
        |h, step| run_step(h, &consent, step),
    );
}

#[test]
fn the_start_times_only_v8_reads_are_refused() {
    let scenarios = fixture_scenarios(FIXTURE);
    let scenario =
        scenarios.iter().map(|s| s.as_object().unwrap()).find(|s| text(s, "name") == V8_ONLY).unwrap();
    let Some(Value::Array(steps)) = scenario.get("steps") else { panic!() };
    let Some(Value::Array(outcomes)) = scenario.get("outcomes") else { panic!() };
    assert!(!steps.is_empty());
    let h = Harness::new();
    for (step, recorded) in steps.iter().zip(outcomes) {
        let step = step.as_object().unwrap();
        assert_eq!(step.get("v8Only"), Some(&Value::Bool(true)));
        assert!(recorded.as_str().unwrap().starts_with(r#"{"success":true"#));
        let got = run_step(&h, &Cell::new(true), step).unwrap();
        assert_eq!(got, r#"{"success":false,"error":"Invalid startedAt"}"#);
    }
    assert!(list_run_logs(&h.ctx, &text(steps[0].as_object().unwrap(), "uid")).unwrap().is_empty());
}
