// SPDX-License-Identifier: GPL-2.0-or-later
//! Checks the input checks, the helpers and `parseRetryAfter` against the
//! results the TS functions of src/main/hub/ give, recorded in Node
//! (tests/fixtures/pure_functions.json). Numbers that JSON cannot hold are
//! written as the strings `NaN`, `Infinity`, `-Infinity` and `-0`.

// Test helpers outside #[test] functions panic on a broken fixture.
#![allow(clippy::unwrap_used)]

use pipette_hub::multipart::{KeymapFiles, UploadFile, sanitize_field_value};
use pipette_hub::node_base64_decode;
use pipette_hub::retry_after::parse_retry_after;
use pipette_hub::validate::{
    KeymapPostInput, build_files, clamp_int, compute_total_pages, sanitize_filename_base,
    validate_display_name, validate_file_sizes, validate_keyboard_name, validate_post_id, validate_title,
};
use serde_json::Value;

fn fixture() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/pure_functions.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn cases<'a>(fixture: &'a Value, name: &str) -> &'a Vec<Value> {
    fixture[name].as_array().unwrap_or_else(|| panic!("no {name} in the fixture"))
}

/// A recorded number: a JSON number, or one of the strings for the values
/// JSON cannot hold; `None` for null.
fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => None,
        Value::Number(n) => n.as_f64(),
        Value::String(text) => Some(match text.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "-0" => -0.0,
            other => panic!("not a number: {other}"),
        }),
        other => panic!("not a number: {other}"),
    }
}

fn same_number(actual: Option<f64>, expected: Option<f64>) -> bool {
    match (actual, expected) {
        (None, None) => true,
        (Some(a), Some(e)) if a.is_nan() && e.is_nan() => true,
        (Some(a), Some(e)) => a == e && a.is_sign_negative() == e.is_sign_negative(),
        _ => false,
    }
}

/// `{ ok }` or `{ error }` of a recorded call, as a result.
fn outcome(case: &Value) -> Result<Value, String> {
    match case.get("error") {
        Some(error) => Err(error.as_str().unwrap().to_owned()),
        None => Ok(case["ok"].clone()),
    }
}

#[test]
fn the_text_checks_match_the_ts() {
    let fixture = fixture();
    type Check = fn(Option<&str>) -> Result<String, pipette_hub::validate::InvalidInput>;
    let checks: [(&str, Check); 3] = [
        ("validateTitle", validate_title),
        ("validateDisplayName", validate_display_name),
        ("validateKeyboardName", validate_keyboard_name),
    ];
    let mut failures = Vec::new();
    for (name, check) in checks {
        for case in cases(&fixture, name) {
            let actual = check(case["input"].as_str()).map(Value::String).map_err(|err| err.to_string());
            if actual != outcome(case) {
                failures.push(format!("{name}({}): {actual:?}, expected {:?}", case["input"], outcome(case)));
            }
        }
    }
    for case in cases(&fixture, "validatePostId") {
        let actual = validate_post_id(case["input"].as_str().unwrap())
            .map(|()| Value::Bool(true))
            .map_err(|e| e.to_string());
        if actual != outcome(case) {
            failures.push(format!("validatePostId({}): {actual:?}", case["input"]));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn the_number_helpers_match_the_ts() {
    let fixture = fixture();
    let mut failures = Vec::new();
    for case in cases(&fixture, "clampInt") {
        let (min, max) = (number(&case["min"]).unwrap(), number(&case["max"]).unwrap());
        let actual = clamp_int(number(&case["value"]), min, max);
        if !same_number(actual, number(&case["result"])) {
            failures.push(format!(
                "clampInt({}, {min}, {max}) = {actual:?}, expected {}",
                case["value"], case["result"]
            ));
        }
    }
    for case in cases(&fixture, "computeTotalPages") {
        let actual = compute_total_pages(number(&case["total"]).unwrap(), number(&case["perPage"]).unwrap());
        if !same_number(Some(actual), number(&case["result"])) {
            failures.push(format!("computeTotalPages({}, {}) = {actual}", case["total"], case["perPage"]));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn the_file_names_match_the_ts() {
    let fixture = fixture();
    for case in cases(&fixture, "sanitizeFilenameBase") {
        let actual =
            sanitize_filename_base(case["productName"].as_str().unwrap(), case["fallback"].as_str().unwrap());
        assert_eq!(actual, case["result"].as_str().unwrap(), "{case}");
    }
    for case in cases(&fixture, "keyboardFileBase") {
        let input = KeymapPostInput {
            keyboard_name: case["input"].as_str().unwrap(),
            vil_json: "",
            pipette_json: "",
            keymap_c: "",
            pdf_base64: "",
            thumbnail_base64: "",
        };
        let files = build_files(input).unwrap();
        assert_eq!(files.vil.name, case["vil"].as_str().unwrap(), "{case}");
        assert_eq!(files.thumbnail.name, case["thumbnail"].as_str().unwrap(), "{case}");
    }
}

#[test]
fn the_file_size_limits_match_the_ts() {
    let fixture = fixture();
    for case in cases(&fixture, "fileSizes") {
        let size = |key: &str| usize::try_from(case["sizes"][key].as_u64().unwrap()).unwrap();
        let file = |key: &str| UploadFile { name: String::new(), data: vec![0; size(key)] };
        let files = KeymapFiles {
            vil: file("vil"),
            pipette: file("pipette"),
            c: file("c"),
            pdf: file("pdf"),
            thumbnail: file("thumbnail"),
        };
        let actual = validate_file_sizes(&files).map(|()| Value::Bool(true)).map_err(|err| err.to_string());
        assert_eq!(actual, outcome(case), "{}", case["sizes"]);
    }
}

#[test]
fn base64_decodes_as_node_does() {
    let fixture = fixture();
    for case in cases(&fixture, "base64") {
        let hex: String =
            node_base64_decode(case["input"].as_str().unwrap()).iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, case["hex"].as_str().unwrap(), "{:?}", case["input"]);
    }
}

#[test]
fn field_values_lose_their_line_breaks_as_in_the_ts() {
    let fixture = fixture();
    for case in cases(&fixture, "sanitizeFieldValue") {
        assert_eq!(
            sanitize_field_value(case["input"].as_str().unwrap()),
            case["result"].as_str().unwrap(),
            "{case}"
        );
    }
}

#[test]
fn retry_after_matches_the_ts() {
    let fixture = fixture();
    let now = fixture["retryAfter"]["nowMs"].as_f64().unwrap();
    let mut failures = Vec::new();
    for case in fixture["retryAfter"]["cases"].as_array().unwrap() {
        let header = case["header"].as_str().unwrap();
        let actual = parse_retry_after(Some(header), now);
        if !same_number(actual, number(&case["seconds"])) {
            failures.push(format!("{header:?}: {actual:?}, expected {}", case["seconds"]));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
