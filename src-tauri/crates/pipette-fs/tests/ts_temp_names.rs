// SPDX-License-Identifier: GPL-2.0-or-later
//! The temp file names of `write_file_atomic` against the names the
//! TypeScript writer (src/main/utils/write-file-atomic.ts) built for the same
//! target names, pids and random bytes, and against the orphan sweep pattern
//! of src/main/utils/sweep-orphan-pack-bodies.ts.
//!
//! Regenerate the fixture with `pnpm run generate:fs-logger-fixtures`.

use std::path::Path;

use pipette_fs::{MAX_NAME_BYTES, temp_file_name};
use regex::Regex;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    sweep_pattern: String,
    random_hex: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    pid: u32,
    temp_name: String,
    matches_sweep_pattern: bool,
}

fn fixture() -> Fixture {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_temp_names.json");
    let bytes = std::fs::read(path).expect("the fixture is readable");
    serde_json::from_slice(&bytes).expect("the fixture parses")
}

#[test]
fn the_temp_names_are_the_typescript_ones() {
    let fixture = fixture();
    let random = u64::from_str_radix(&fixture.random_hex, 16).unwrap();
    let sweep = Regex::new(&fixture.sweep_pattern).unwrap();
    assert!(!fixture.cases.is_empty());
    for case in &fixture.cases {
        let ours = temp_file_name(&case.name, case.pid, random);
        assert_eq!(ours, case.temp_name, "{:?} with pid {}", case.name, case.pid);
        assert!(ours.len() <= MAX_NAME_BYTES);
        assert_eq!(sweep.is_match(&ours), case.matches_sweep_pattern, "{ours}");
    }
}

/// A temp file left behind next to a pack body is one the sweep removes.
#[test]
fn a_real_temp_name_for_a_json_target_matches_the_sweep_pattern() {
    let sweep = Regex::new(&fixture().sweep_pattern).unwrap();
    let name = temp_file_name("pack.json", std::process::id(), 0xdead_beef_cafe_f00d);
    assert!(sweep.is_match(&name), "{name}");
    assert!(name.starts_with("pack.json."));
}
