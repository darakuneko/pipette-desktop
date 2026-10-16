// SPDX-License-Identifier: GPL-2.0-or-later
//! Checks `ActiveWindow::app_name` against getCurrentAppName of the Electron
//! build, recorded by scripts/active-window-fixtures/ with stubs for the
//! native binding and gdbus: the normalization, the gdbus output parsing and
//! the fallback order, with the number of gdbus runs and the warning.

// Test helpers outside #[test] functions panic on a broken fixture.
#![allow(clippy::unwrap_used)]

use pipette_js_json::{JsString, Value};

use super::*;
use crate::tests::{FakeNative, FakeRunner, lookup};

fn fixture() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/app_monitor.json");
    pipette_js_json::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.as_object().unwrap().get(key).unwrap_or_else(|| panic!("no {key}"))
}

fn string(value: &Value) -> JsString {
    match value {
        Value::String(s) => s.clone(),
        other => panic!("not a string: {other:?}"),
    }
}

fn native(value: &Value) -> Option<FakeNative> {
    match field(value, "kind").as_str().unwrap() {
        "unavailable" => None,
        "throws" => Some(FakeNative::Throws),
        "null" => Some(FakeNative::NoWindow),
        "window" => {
            Some(FakeNative::Window(string(field(value, "application")), string(field(value, "title"))))
        }
        kind => panic!("unknown native kind {kind}"),
    }
}

#[test]
fn the_query_is_the_recorded_command() {
    let fixture = fixture();
    assert_eq!(field(&fixture, "gdbusCommand").as_str(), Some(GDBUS_COMMAND.join(" ").as_str()));
    let timeout = field(field(&fixture, "gdbusOptions"), "timeout");
    assert_eq!(timeout, &Value::Number(GDBUS_TIMEOUT.as_millis() as f64));
}

#[test]
fn app_name_matches_get_current_app_name() {
    let fixture = fixture();
    let Value::Array(cases) = field(&fixture, "cases") else { panic!("cases") };
    let mut failures = Vec::new();
    for case in cases {
        let gdbus = field(case, "gdbus");
        let stdout = gdbus.as_object().unwrap().get("stdout").map(|s| s.as_str().unwrap());
        let runner = FakeRunner::new(stdout);
        let linux = field(case, "platform").as_str() == Some("linux");
        let mut active = lookup(native(field(case, "native")), linux.then_some(&runner));
        let name = active.app_name();
        let expected = match field(case, "result") {
            Value::Null => None,
            result => Some(string(result)),
        };
        let runs = runner.runs().len() as f64;
        let warned = Value::Bool(active.warned);
        if name != expected
            || field(case, "gdbusRuns") != &Value::Number(runs)
            || field(case, "warned") != &warned
        {
            failures.push(format!(
                "{}: {name:?}, {runs} runs, warned {}",
                pipette_js_json::stringify(case),
                active.warned
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
