// SPDX-License-Identifier: GPL-2.0-or-later
//! The input checks and helpers against the recorded golden tables of
//! tests/fixtures/ts_hub_pure.json.
//!
//! Inputs the Rust signatures cannot take are skipped and counted: a string
//! with a lone surrogate (the IPC arguments are Rust strings), and a post
//! id that is not a string (`validatePostId` coerces it, the command takes
//! a string). For the text checks any value that is not a string is `None`,
//! which they reject. The tables of `isValidHubVialProtocol`,
//! `validatePack` and `validateI18nExport` are for the favorite and
//! language pack handlers and are read there.

#![allow(clippy::unwrap_used)]

mod common;

use common::{Input, array, field, fixture, get, input, number, outcome, same_number, text};
use pipette_hub::node_base64_decode;
use pipette_hub::validate::{
    InvalidInput, KeymapPostInput, build_files, clamp_int, compute_total_pages, sanitize_filename_base,
    validate_display_name, validate_keyboard_name, validate_post_id, validate_title,
};
use pipette_js_json::{Value, stringify};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn the_text_checks_match_the_golden() {
    let golden = fixture("ts_hub_pure.json");
    let mut failures = Vec::new();
    let mut skipped = 0;
    type Check = fn(Option<&str>) -> Result<String, InvalidInput>;
    let checks: [(&str, Check); 3] = [
        ("validateTitle", validate_title),
        ("validateDisplayName", validate_display_name),
        ("validateKeyboardName", validate_keyboard_name),
    ];
    for (name, check) in checks {
        for case in array(field(&golden, name)) {
            let actual = match input(field(case, "input")) {
                Input::Text(s) => check(Some(&s)),
                Input::NotAString => check(None),
                Input::LoneSurrogate => {
                    skipped += 1;
                    continue;
                }
            };
            let actual = actual.map(Value::from).map_err(|err| err.to_string());
            if actual != outcome(case) {
                failures.push(format!("{name}({}): {actual:?}", stringify(field(case, "input"))));
            }
        }
    }
    for case in array(field(&golden, "validatePostId")) {
        let Input::Text(post_id) = input(field(case, "input")) else {
            skipped += 1;
            continue;
        };
        let actual = validate_post_id(&post_id).map(|()| Value::Null).map_err(|err| err.to_string());
        if actual != outcome(case) {
            failures.push(format!("validatePostId({post_id:?}): {actual:?}"));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
    // 2 strings with a lone surrogate per text check, 8 post ids that are
    // not strings.
    assert_eq!(skipped, 14);
}

#[test]
fn the_number_helpers_match_the_golden() {
    let golden = fixture("ts_hub_pure.json");
    let mut failures = Vec::new();
    for case in array(field(&golden, "clampInt")) {
        let ok = field(case, "ok");
        let (min, max) = (number(field(ok, "min")).unwrap(), number(field(ok, "max")).unwrap());
        let actual = clamp_int(number(field(case, "input")), min, max);
        if !same_number(actual, number(field(ok, "result"))) {
            failures
                .push(format!("clampInt({}, {min}, {max}) = {actual:?}", stringify(field(case, "input"))));
        }
    }
    for case in array(field(&golden, "computeTotalPages")) {
        let args = array(field(case, "input"));
        let total = number(&args[0]).unwrap_or(f64::NAN);
        let per_page = args.get(1).and_then(number).unwrap_or(f64::NAN);
        let actual = compute_total_pages(total, per_page);
        if !same_number(Some(actual), number(field(case, "ok"))) {
            failures.push(format!("computeTotalPages({}) = {actual}", stringify(field(case, "input"))));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn file_names_base64_and_build_files_match_the_golden() {
    let golden = fixture("ts_hub_pure.json");
    let mut failures = Vec::new();
    let mut skipped = 0;
    let string = |value: &Value| match input(value) {
        Input::Text(s) => Some(s),
        _ => None,
    };
    for case in array(field(&golden, "sanitizeFilenameBase")) {
        let args = array(field(case, "input"));
        let (Some(product), Some(fallback)) = (string(&args[0]), string(&args[1])) else {
            skipped += 1;
            continue;
        };
        let actual = sanitize_filename_base(&product, &fallback);
        if Some(actual.as_str()) != field(case, "ok").as_str() {
            failures.push(format!("sanitizeFilenameBase({}) = {actual}", stringify(field(case, "input"))));
        }
    }
    for case in array(field(&golden, "base64Decode")) {
        let Some(encoded) = string(field(case, "input")) else {
            skipped += 1;
            continue;
        };
        let actual = hex(&node_base64_decode(&encoded));
        if actual != text(field(case, "hex")) {
            failures.push(format!("base64Decode({encoded:?}) = {actual}"));
        }
    }
    for case in array(field(&golden, "keyboardFileBase")) {
        let Some(name) = string(field(case, "input")) else {
            skipped += 1;
            continue;
        };
        let files = build_files(KeymapPostInput {
            keyboard_name: &name,
            vil_json: "",
            pipette_json: "",
            keymap_c: "",
            pdf_base64: "",
            thumbnail_base64: "",
        })
        .unwrap();
        let names = field(case, "names");
        for (key, actual) in [
            ("vil", &files.vil.name),
            ("pipette", &files.pipette.name),
            ("c", &files.c.name),
            ("pdf", &files.pdf.name),
            ("thumbnail", &files.thumbnail.name),
        ] {
            if actual != text(field(names, key)) {
                failures.push(format!("keyboardFileBase({name:?}).{key} = {actual}"));
            }
        }
    }
    for case in array(field(&golden, "buildFiles")) {
        let args = field(case, "input");
        let strings: Option<Vec<String>> =
            ["keyboardName", "vilJson", "pipetteJson", "keymapC", "pdfBase64", "thumbnailBase64"]
                .iter()
                .map(|key| string(field(args, key)))
                .collect();
        let Some(s) = strings else {
            skipped += 1;
            continue;
        };
        let actual = build_files(KeymapPostInput {
            keyboard_name: &s[0],
            vil_json: &s[1],
            pipette_json: &s[2],
            keymap_c: &s[3],
            pdf_base64: &s[4],
            thumbnail_base64: &s[5],
        });
        match (actual, outcome(case)) {
            (Err(err), Err(expected)) if err.to_string() == expected => {}
            (Ok(files), Ok(expected)) => {
                for (key, file) in [
                    ("vil", &files.vil),
                    ("pipette", &files.pipette),
                    ("c", &files.c),
                    ("pdf", &files.pdf),
                    ("thumbnail", &files.thumbnail),
                ] {
                    let want = field(&expected, key);
                    let bytes = number(field(want, "bytes")).unwrap() as usize;
                    let data = get(want, "base64").and_then(string).map(|b| node_base64_decode(&b));
                    if file.name != text(field(want, "name"))
                        || file.data.len() != bytes
                        || data.is_some_and(|data| data != file.data)
                    {
                        failures.push(format!(
                            "buildFiles({:?}).{key}: {} ({} bytes)",
                            s[0],
                            file.name,
                            file.data.len()
                        ));
                    }
                }
            }
            (actual, expected) => {
                failures.push(format!("buildFiles({:?}): {:?} expected {expected:?}", s[0], actual.err()))
            }
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
    // One file name with a lone surrogate.
    assert_eq!(skipped, 1);
}
