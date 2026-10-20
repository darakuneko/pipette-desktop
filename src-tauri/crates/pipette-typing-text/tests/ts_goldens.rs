// SPDX-License-Identifier: GPL-2.0-or-later
//! Checks the crate against the recorded goldens of the TypeScript
//! functions and Chromium's Shift_JIS decoder.

// Test helpers outside #[test] functions panic on a broken fixture.
#![allow(clippy::unwrap_used)]

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use pipette_js_json::{Object, Value, parse};
use pipette_typing_text::{
    AozoraTextError, aozora_text_from_zip, clean_aozora_text, decode_shift_jis, is_kana_only_text,
    normalize_file_import_text, parse_file_import_text,
};

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn array(value: &Value) -> &[Value] {
    match value {
        Value::Array(items) => items,
        _ => panic!("not an array: {value:?}"),
    }
}

fn field<'a>(object: &'a Object, key: &str) -> &'a Value {
    object.get(key).unwrap_or_else(|| panic!("no {key} in {object:?}"))
}

fn units(value: &Value) -> Vec<u16> {
    match value {
        Value::String(s) => s.utf16_units(),
        _ => panic!("not a string: {value:?}"),
    }
}

fn number(value: &Value) -> usize {
    match value {
        Value::Number(n) => *n as usize,
        _ => panic!("not a number: {value:?}"),
    }
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap()
}

/// Code units written as hex joined by `.` (empty for no units).
fn hex_units(text: &str) -> Vec<u16> {
    text.split('.')
        .filter(|part| !part.is_empty())
        .map(|part| u16::from_str_radix(part, 16).unwrap())
        .collect()
}

#[test]
fn normalize_file_import_text_matches_typescript() {
    let fixture = fixture("text_functions.json");
    let mut failures = Vec::new();
    for case in array(field(fixture.as_object().unwrap(), "normalize")) {
        let case = case.as_object().unwrap();
        let input = units(field(case, "input"));
        let max_words = number(field(case, "maxWords"));
        let normalized = normalize_file_import_text(&input, max_words);
        let expected =
            (units(field(case, "text")), number(field(case, "wordCount")), number(field(case, "lineCount")));
        if (normalized.text.clone(), normalized.word_count, normalized.line_count) != expected {
            failures.push(format!("{input:x?} ({max_words}): {normalized:?}, expected {expected:?}"));
        }
        if let Some(parsed) = case.get("parsed").and_then(Value::as_object) {
            let actual = parse_file_import_text(&input, max_words);
            let words: Vec<Vec<u16>> = array(field(parsed, "words")).iter().map(units).collect();
            let line_breaks: Vec<usize> = array(field(parsed, "lineBreaks")).iter().map(number).collect();
            let indents: Vec<Vec<u16>> = array(field(parsed, "indents")).iter().map(units).collect();
            if actual.words != words || actual.line_breaks != line_breaks || actual.indents != indents {
                failures.push(format!("{input:x?} ({max_words}): parse {actual:?}"));
            }
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn is_kana_only_text_matches_typescript() {
    let fixture = fixture("text_functions.json");
    let mut failures = Vec::new();
    for case in array(field(fixture.as_object().unwrap(), "kanaOnly")) {
        let case = case.as_object().unwrap();
        let input = units(field(case, "input"));
        let expected = matches!(field(case, "kanaOnly"), Value::Bool(true));
        if is_kana_only_text(&input) != expected {
            failures.push(format!("{input:x?}: expected {expected}"));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn clean_aozora_text_matches_typescript() {
    let fixture = fixture("text_functions.json");
    let mut failures = Vec::new();
    for case in array(field(fixture.as_object().unwrap(), "clean")) {
        let case = case.as_object().unwrap();
        let input = units(field(case, "input"));
        let actual = clean_aozora_text(&input);
        let matches = match (&actual, case.get("output"), case.get("throws")) {
            (Ok(output), Some(expected), None) => *output == units(expected),
            (Err(err), None, Some(thrown)) => format!("RangeError: {err}") == text(thrown),
            _ => false,
        };
        if !matches {
            failures.push(format!("{:?}: {actual:x?}", String::from_utf16_lossy(&input)));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn shift_jis_matches_the_recorded_decoder() {
    let fixture = fixture("shift_jis.json");
    let fixture = fixture.as_object().unwrap();
    let mut failures = Vec::new();
    let mut check = |bytes: &[u8], expected: &str| {
        let actual = decode_shift_jis(bytes);
        if actual != hex_units(expected) {
            failures.push(format!("{bytes:02x?}: {actual:04x?}, expected {expected}"));
        }
    };
    for (byte, expected) in array(field(fixture, "singleBytes")).iter().enumerate() {
        check(&[byte as u8], text(expected));
    }
    let pairs = field(fixture, "pairs").as_object().unwrap();
    assert_eq!(pairs.len(), 128);
    for (lead, row) in pairs.iter() {
        let lead = u8::from_str_radix(lead.as_str().unwrap(), 16).unwrap();
        let row: Vec<&str> = text(row).split(' ').collect();
        assert_eq!(row.len(), 256);
        for (trail, expected) in row.into_iter().enumerate() {
            check(&[lead, trail as u8], expected);
        }
    }
    for stream in array(field(fixture, "streams")) {
        let stream = stream.as_object().unwrap();
        let hex = text(field(stream, "bytes"));
        let bytes: Vec<u8> =
            (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
        check(&bytes, text(field(stream, "units")));
    }
    assert!(failures.is_empty(), "{} differences:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn aozora_zips_match_typescript() {
    let fixture = fixture("aozora_zips.json");
    let mut failures = Vec::new();
    for case in array(&fixture) {
        let case = case.as_object().unwrap();
        let name = text(field(case, "name"));
        let zip = BASE64_STANDARD.decode(text(field(case, "zip"))).unwrap();
        let actual = aozora_text_from_zip(&zip);
        let inflate_error = case.get("inflateError").is_some();
        let matches = match &actual {
            Ok(output) => case.get("text").is_some_and(|expected| *output == units(expected)),
            Err(AozoraTextError::InvalidCodePoint(err)) => {
                case.get("throws").is_some_and(|thrown| format!("RangeError: {err}") == text(thrown))
            }
            Err(err) => {
                let code = case.get("errorCode").map(text);
                let message = case.get("error").map(text);
                code == err.error_code() && (inflate_error || message == Some(err.to_string().as_str()))
            }
        };
        if !matches {
            failures.push(format!("{name}: {actual:?}"));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
