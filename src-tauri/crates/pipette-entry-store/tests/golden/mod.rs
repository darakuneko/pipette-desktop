// SPDX-License-Identifier: GPL-2.0-or-later
//! Reading the recorded fixtures. They are
//! read with pipette-js-json, which keeps the lone surrogates the
//! JavaScript values carry.

#![allow(dead_code, clippy::unwrap_used, clippy::panic)]

use pipette_entry_store::{EntryError, EntryGroup, EntryStore};
use pipette_js_json::{JsString, Object, Value, parse, stringify};

pub fn load(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

pub fn get<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.as_object().and_then(|o| o.get(key)).unwrap_or_else(|| panic!("no {key} in {}", stringify(value)))
}

pub fn has(value: &Value, key: &str) -> bool {
    value.as_object().is_some_and(|o| o.contains_key(key))
}

pub fn list(value: &Value) -> &[Value] {
    match value {
        Value::Array(items) => items,
        other => panic!("not an array: {}", stringify(other)),
    }
}

pub fn js(value: &Value) -> &JsString {
    match value {
        Value::String(s) => s,
        other => panic!("not a string: {}", stringify(other)),
    }
}

pub fn text(value: &Value) -> String {
    js(value).to_string_lossy().into_owned()
}

pub fn int(value: &Value) -> i64 {
    match value {
        Value::Number(n) => *n as i64,
        other => panic!("not a number: {}", stringify(other)),
    }
}

pub fn object(text: &str) -> Object {
    match parse(text).unwrap() {
        Value::Object(o) => o,
        other => panic!("not an object: {}", stringify(&other)),
    }
}

pub fn store(value: &Value) -> EntryStore {
    EntryStore::from_name(&text(value)).unwrap()
}

pub fn group(name: &str) -> EntryGroup {
    [EntryGroup::Created, EntryGroup::Body, EntryGroup::Name, EntryGroup::Hub, EntryGroup::Enabled]
        .into_iter()
        .find(|g| g.key() == name)
        .unwrap()
}

/// Checks a result against an `outcome` of the generator: `{out}` (the
/// JSON text of the value, `null` when there was none) or `{throws}`.
pub fn check_outcome(
    failures: &mut Vec<String>,
    label: &str,
    expected: &Value,
    actual: Result<Option<String>, EntryError>,
) {
    match (has(expected, "throws"), actual) {
        (true, Err(_)) => {}
        (false, Ok(out)) => {
            let want = get(expected, "out");
            let want = if *want == Value::Null { None } else { Some(text(want)) };
            if out != want {
                failures.push(format!("{label}:\n  got  {out:?}\n  want {want:?}"));
            }
        }
        (true, Ok(out)) => failures.push(format!("{label}: got {out:?}, the golden throws")),
        (false, Err(err)) => {
            failures.push(format!("{label}: {err}, the golden returns {}", stringify(expected)))
        }
    }
}

pub fn expect_eq<T: PartialEq + std::fmt::Debug>(
    failures: &mut Vec<String>,
    label: impl AsRef<str>,
    got: T,
    want: T,
) {
    if got != want {
        failures.push(format!("{}:\n  got  {got:?}\n  want {want:?}", label.as_ref()));
    }
}

pub fn assert_none(failures: Vec<String>) {
    assert!(failures.is_empty(), "{} mismatches:\n{}", failures.len(), failures.join("\n"));
}
