// SPDX-License-Identifier: GPL-2.0-or-later
//! The recorded golden key label scenarios of the Hub handlers
//! (ts_hub_handlers_key_labels.json): the recorded userData is seeded, the
//! scripted Hub answers the Rust handlers, which must give the same
//! answers, send the same requests, wait the same waits, report the same
//! sync units and leave the same userData. The key label handlers
//! broadcast nothing and log nothing; the fixture is checked to record
//! none of that.

#![allow(clippy::unwrap_used)]

mod common;

use std::sync::Arc;

use common::scripted_hub::{
    ScriptedHub, recorded_line, recorded_tree, scenario_stores, scripted_hub, seed, tree,
};
use common::{array, block_on, field, fixture, get, number, text};
use pipette_hub::key_labels;
use pipette_hub::token::HubToken;
use pipette_js_json::{Value, stringify};
use pipette_keyboard_stores::StoreContext;

/// An argument as the handler gets it: `None` for `undefined`.
fn arg(args: &[Value]) -> Option<&Value> {
    args.first().filter(|value| get(value, "$u").is_none())
}

async fn run_call(token: &HubToken, stores: &StoreContext, call: &str, args: &[Value]) -> String {
    let http = token.http();
    let a = arg(args);
    match call {
        "KEY_LABEL_HUB_LIST" => key_labels::list(http, a).await,
        "KEY_LABEL_HUB_DETAIL" => key_labels::detail(http, a).await,
        "KEY_LABEL_HUB_TIMESTAMPS" => key_labels::timestamps(http, a).await,
        "KEY_LABEL_HUB_DOWNLOAD" => key_labels::download(http, stores, a).await,
        "KEY_LABEL_HUB_UPLOAD" => key_labels::upload(token, stores, a).await,
        "KEY_LABEL_HUB_UPDATE" => key_labels::update(token, stores, a).await,
        "KEY_LABEL_HUB_SYNC" => key_labels::sync(http, stores, a).await,
        "KEY_LABEL_HUB_DELETE" => key_labels::delete(token, stores, a).await,
        other => panic!("not a key label call: {other}"),
    }
}

#[test]
fn the_key_label_scenarios_match_the_golden() {
    let f = fixture("ts_hub_handlers_key_labels.json");
    let base = text(field(&f, "hubBase")).to_owned();
    let now = number(field(&f, "nowMs")).unwrap();
    let scenarios = array(field(&f, "scenarios"));
    assert_eq!(scenarios.len(), 7);
    let mut failures = Vec::new();
    for scenario in scenarios {
        let name = text(field(scenario, "name"));
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), field(scenario, "treeBefore"));
        for rule in array(field(scenario, "rules")) {
            assert!(get(rule, "query").is_none() && get(rule, "body").is_none(), "{name}");
        }
        let (stores, notified) = scenario_stores(dir.path(), now);
        let ScriptedHub { script, clock, http } = scripted_hub(&base, now, field(scenario, "rules"));
        let token = HubToken::new(http, Arc::new(|| Some("fixture-google-id-token".to_owned())));

        for (index, step) in array(field(scenario, "steps")).iter().enumerate() {
            for key in ["events", "logs"] {
                assert!(array(field(step, key)).is_empty(), "{name} #{index}: {key}");
            }
            script.seen.lock().unwrap().clear();
            notified.lock().unwrap().clear();
            clock.slept.lock().unwrap().clear();
            let action = field(step, "step");
            let answer = block_on(run_call(
                &token,
                &stores,
                text(field(action, "call")),
                array(field(action, "args")),
            ));
            let expected = stringify(field(step, "answer"));
            if answer != expected {
                failures.push(format!("{name} #{index}: {answer} expected {expected}"));
            }
            // A timestamps call sends its batches at once; the recorder
            // writes them sorted, as here.
            let mut seen = script.seen.lock().unwrap().clone();
            let mut expected: Vec<String> =
                array(field(step, "requests")).iter().map(recorded_line).collect();
            if text(field(action, "call")) == "KEY_LABEL_HUB_TIMESTAMPS" {
                seen.sort();
                expected.sort();
            }
            if seen != expected {
                failures.push(format!("{name} #{index}: requests {seen:#?} expected {expected:#?}"));
            }
            let units = notified.lock().unwrap().clone();
            let expected_units: Vec<String> =
                array(field(step, "notified")).iter().map(|unit| text(unit).to_owned()).collect();
            if units != expected_units {
                failures.push(format!("{name} #{index}: notified {units:?} expected {expected_units:?}"));
            }
            let slept: Vec<f64> =
                clock.slept.lock().unwrap().iter().map(|wait| wait.as_secs_f64() * 1000.0).collect();
            let expected_sleeps: Vec<f64> =
                array(field(step, "sleeps")).iter().map(|ms| number(ms).unwrap()).collect();
            if slept != expected_sleeps {
                failures.push(format!("{name} #{index}: sleeps {slept:?} expected {expected_sleeps:?}"));
            }
        }
        let (after, expected) = (tree(dir.path()), recorded_tree(field(scenario, "treeAfter")));
        if after != expected {
            failures.push(format!("{name}: userData {after:#?} expected {expected:#?}"));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
