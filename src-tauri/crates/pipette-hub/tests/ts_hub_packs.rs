// SPDX-License-Identifier: GPL-2.0-or-later
//! The language and theme pack handlers against the Electron ones:
//!
//! - the `validatePack` and `validateI18nExport` tables of
//!   ts_hub_pure.json;
//! - the scenarios of ts_hub_handlers_i18n_packs.json and
//!   ts_hub_handlers_theme_packs.json: the recorded userData is seeded, the
//!   scripted Hub answers the Rust handlers, which must give the same
//!   answers, send the same requests (multipart bodies with the boundary
//!   written as `{boundary}`), wait the same waits, report the same sync
//!   units and leave the same userData. The pack handlers broadcast nothing
//!   and log nothing; the fixtures are checked to record none of that.

#![allow(clippy::unwrap_used)]

mod common;

use std::sync::Arc;

use common::scripted_hub::{
    ScriptedHub, recorded_line, recorded_tree, scenario_stores, scripted_hub, seed, sorted, tree,
};
use common::{array, block_on, field, fixture, get, number, text};
use pipette_hub::packs::{self, PackKind, validate_i18n_export};
use pipette_hub::token::HubToken;
use pipette_js_json::{JsString, Object, Value, stringify};
use pipette_keyboard_stores::StoreContext;
use pipette_pack_stores::i18n_validate::validate_pack;

fn strings(list: &[JsString]) -> Value {
    Value::Array(list.iter().cloned().map(Value::String).collect())
}

#[test]
fn validate_pack_matches_the_ts() {
    let golden = fixture("ts_hub_pure.json");
    let cases = array(field(&golden, "validatePack"));
    assert_eq!(cases.len(), 36);
    let mut failures = Vec::new();
    for case in cases {
        let check = validate_pack(Some(field(case, "input")));
        let mut actual = Object::new();
        actual.insert("ok", Value::Bool(check.ok()));
        actual.insert("errors", strings(&check.errors));
        actual.insert("warnings", strings(&check.warnings));
        actual.insert("dangerousKeys", strings(&check.dangerous_keys));
        if let Some((name, version)) = &check.header {
            let header: Object =
                [("name", Value::String(name.clone())), ("version", Value::String(version.clone()))]
                    .into_iter()
                    .collect();
            actual.insert("header", Value::Object(header));
        }
        let (actual, expected) = (stringify(&Value::Object(actual)), stringify(field(case, "ok")));
        if actual != expected {
            failures.push(format!("{}: {actual} expected {expected}", stringify(field(case, "input"))));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn validate_i18n_export_matches_the_ts() {
    let golden = fixture("ts_hub_pure.json");
    let cases = array(field(&golden, "validateI18nExport"));
    assert_eq!(cases.len(), 18);
    let mut failures = Vec::new();
    for case in cases {
        let check = validate_i18n_export(Some(field(case, "input")));
        let mut actual = Object::new();
        actual.insert("ok", Value::Bool(check.ok()));
        if let Some(reason) = &check.reason {
            actual.insert("reason", Value::String(reason.clone()));
        }
        actual.insert("warnings", strings(&check.warnings));
        let (actual, expected) = (stringify(&Value::Object(actual)), stringify(field(case, "ok")));
        if actual != expected {
            failures.push(format!("{}: {actual} expected {expected}", stringify(field(case, "input"))));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

/// An argument as the handler gets it: `None` for `undefined`.
fn arg(args: &[Value], index: usize) -> Option<&Value> {
    args.get(index).filter(|value| get(value, "$u").is_none())
}

async fn run_call(token: &HubToken, stores: &StoreContext, call: &str, args: &[Value]) -> Value {
    let http = token.http();
    let (a, b) = (arg(args, 0), arg(args, 1));
    match call {
        "HUB_UPLOAD_I18N_POST" => packs::upload(token, stores, PackKind::I18n, a).await,
        "HUB_UPDATE_I18N_POST" => packs::update(token, stores, PackKind::I18n, a).await,
        "HUB_DELETE_I18N_POST" => packs::delete(token, stores, PackKind::I18n, a, b).await,
        "HUB_LIST_I18N_POSTS" => packs::list(http, PackKind::I18n, a).await,
        "HUB_DOWNLOAD_I18N_POST" => packs::download(http, PackKind::I18n, a).await,
        "HUB_I18N_PACK_TIMESTAMPS" => packs::timestamps(http, PackKind::I18n, a).await,
        "HUB_UPLOAD_THEME_POST" => packs::upload(token, stores, PackKind::Theme, a).await,
        "HUB_UPDATE_THEME_POST" => packs::update(token, stores, PackKind::Theme, a).await,
        "HUB_DELETE_THEME_POST" => packs::delete(token, stores, PackKind::Theme, a, b).await,
        "HUB_LIST_THEME_POSTS" => packs::list(http, PackKind::Theme, a).await,
        "HUB_DOWNLOAD_THEME_POST" => packs::download(http, PackKind::Theme, a).await,
        "HUB_THEME_PACK_TIMESTAMPS" => packs::timestamps(http, PackKind::Theme, a).await,
        other => panic!("not a pack call: {other}"),
    }
}

fn check_scenarios(name: &str, scenario_count: usize) {
    let f = fixture(name);
    let base = text(field(&f, "hubBase")).to_owned();
    let now = number(field(&f, "nowMs")).unwrap();
    let scenarios = array(field(&f, "scenarios"));
    assert_eq!(scenarios.len(), scenario_count);
    let mut failures = Vec::new();
    for scenario in scenarios {
        let name = text(field(scenario, "name"));
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), field(scenario, "treeBefore"));
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
            // The batches of a timestamps call go out together; the
            // recorder writes what they did sorted.
            let unordered = text(field(action, "call")).ends_with("_PACK_TIMESTAMPS");
            let answer = block_on(run_call(
                &token,
                &stores,
                text(field(action, "call")),
                array(field(action, "args")),
            ));
            let expected = stringify(field(step, "answer"));
            if stringify(&answer) != expected {
                failures.push(format!("{name} #{index}: {} expected {expected}", stringify(&answer)));
            }
            let mut seen = script.seen.lock().unwrap().clone();
            let mut expected: Vec<String> =
                array(field(step, "requests")).iter().map(recorded_line).collect();
            let mut units = notified.lock().unwrap().clone();
            let mut expected_units: Vec<String> =
                array(field(step, "notified")).iter().map(|unit| text(unit).to_owned()).collect();
            if unordered {
                (seen, expected) = (sorted(seen), sorted(expected));
                (units, expected_units) = (sorted(units), sorted(expected_units));
            }
            if seen != expected {
                failures.push(format!("{name} #{index}: requests {seen:#?} expected {expected:#?}"));
            }
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

#[test]
fn the_language_pack_scenarios_match_the_ts() {
    check_scenarios("ts_hub_handlers_i18n_packs.json", 8);
}

#[test]
fn the_theme_pack_scenarios_match_the_ts() {
    check_scenarios("ts_hub_handlers_theme_packs.json", 3);
}
