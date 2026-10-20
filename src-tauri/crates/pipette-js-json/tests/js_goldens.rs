// SPDX-License-Identifier: GPL-2.0-or-later
//! Checks the crate against JSON.parse, JSON.stringify and String(number) as
//! recorded in Node.

// Test helpers outside #[test] functions panic on a broken fixture.
#![allow(clippy::unwrap_used)]

use pipette_js_json::{Value, parse, stringify_with_gap, write_number};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    texts: Vec<TextCase>,
    numbers: Vec<NumberCase>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextCase {
    text: String,
    ok: bool,
    compact: Option<String>,
    two_spaces: Option<String>,
    tab: Option<String>,
}

#[derive(Deserialize)]
struct NumberCase {
    bits: String,
    text: String,
}

fn fixture() -> Fixture {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/js_json.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn parse_and_stringify_match_javascript() {
    let mut failures = Vec::new();
    for case in fixture().texts {
        match (parse(&case.text), case.ok) {
            (Ok(value), true) => {
                for (gap, expected) in [("", &case.compact), ("  ", &case.two_spaces), ("\t", &case.tab)] {
                    let actual = stringify_with_gap(&value, gap);
                    if Some(&actual) != expected.as_ref() {
                        failures
                            .push(format!("{:?} gap {gap:?}: {actual:?}, expected {expected:?}", case.text));
                    }
                }
            }
            (Err(_), false) => {}
            (Ok(_), false) => failures.push(format!("{:?}: parsed, JSON.parse throws", case.text)),
            (Err(err), true) => failures.push(format!("{:?}: {err}, JSON.parse accepts it", case.text)),
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn numbers_format_as_javascript() {
    let mut failures = Vec::new();
    let numbers = fixture().numbers;
    assert!(numbers.len() > 1000);
    for case in numbers {
        let n = f64::from_bits(u64::from_str_radix(&case.bits, 16).unwrap());
        let mut out = String::new();
        write_number(&mut out, n);
        if out != case.text {
            failures.push(format!("{}: {out}, expected {}", case.bits, case.text));
        }
        // JSON.parse(String(n)) gives n back (`-0` comes back as `0`, which
        // compares equal).
        let reparsed = parse(&case.text).unwrap();
        if reparsed != Value::Number(n) {
            failures.push(format!("{}: parsing {} gives {reparsed:?}", case.bits, case.text));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
