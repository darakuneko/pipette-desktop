// SPDX-License-Identifier: GPL-2.0-or-later
//! The theme pack check against `validateThemePack` of
//! src/shared/theme/validate.ts: every recorded pack gets
//! the same errors, warnings and header, and the limits and key lists the
//! check reads are those of src/shared/types/theme-store.ts.

#![allow(clippy::unwrap_used, clippy::panic)]

use std::path::Path;

use pipette_js_json::{JsString, Object, Value};
use pipette_pack_stores::theme_validate::{
    MAX_NAME_LENGTH, OPTIONAL_THEME_COLOR_KEYS, THEME_COLOR_KEYS, ThemeCheck, validate_theme_pack,
};

fn fixture() -> Object {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_theme_validate_cases.json");
    let Value::Object(root) = pipette_js_json::parse(&std::fs::read_to_string(path).unwrap()).unwrap() else {
        panic!()
    };
    root
}

fn strings(value: &Value) -> Vec<JsString> {
    match value {
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::String(s) => s.clone(),
                other => panic!("{other:?}"),
            })
            .collect(),
        other => panic!("{other:?}"),
    }
}

/// The check as `validateThemePack` answers it.
fn answered(result: &Object) -> ThemeCheck {
    let header = match result.get("header") {
        Some(Value::Object(header)) => match (header.get("name"), header.get("version")) {
            (Some(Value::String(name)), Some(Value::String(version))) => {
                Some((name.clone(), version.clone()))
            }
            other => panic!("{other:?}"),
        },
        None => None,
        other => panic!("{other:?}"),
    };
    ThemeCheck {
        errors: strings(result.get("errors").unwrap()),
        warnings: strings(result.get("warnings").unwrap()),
        header,
    }
}

#[test]
fn the_limits_and_keys_are_those_of_the_typescript_build() {
    let root = fixture();
    assert_eq!(root.get("maxNameLength"), Some(&Value::from(MAX_NAME_LENGTH as f64)));
    let keys = |key: &str| strings(root.get(key).unwrap());
    assert_eq!(keys("colorKeys"), THEME_COLOR_KEYS.map(JsString::from));
    assert_eq!(keys("optionalColorKeys"), OPTIONAL_THEME_COLOR_KEYS.map(JsString::from));
}

#[test]
fn every_pack_is_checked_as_the_typescript_check_does() {
    let root = fixture();
    let Some(Value::Array(cases)) = root.get("cases") else { panic!() };
    let mut failures = Vec::new();
    for (i, case) in cases.iter().enumerate() {
        let case = case.as_object().unwrap();
        let input = case.get("input");
        let Some(Value::Object(result)) = case.get("result") else { panic!() };
        let expected = answered(result);
        let actual = validate_theme_pack(input);
        if actual != expected {
            failures.push(format!("case {i}: {input:?}\n  expected {expected:?}\n  actual   {actual:?}"));
        }
        assert_eq!(result.get("ok"), Some(&Value::Bool(actual.ok())), "case {i}");
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
