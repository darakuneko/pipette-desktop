// SPDX-License-Identifier: GPL-2.0-or-later
//! Log lines against the recorded lines the 0.4 build's logger appended for
//! the same time, level and message.

use std::path::Path;

use log::Level;
use pipette_logger::format_line;
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    lines: Vec<Line>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Line {
    epoch_ms: i64,
    level: String,
    message: String,
    line: String,
}

fn level(name: &str) -> Level {
    match name {
        "error" => Level::Error,
        "warn" => Level::Warn,
        "info" => Level::Info,
        "debug" => Level::Debug,
        other => panic!("unknown level {other}"),
    }
}

#[test]
fn the_lines_are_the_recorded_ones() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_log_lines.json");
    let fixture: Fixture = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert!(!fixture.lines.is_empty());
    for case in &fixture.lines {
        assert_eq!(format_line(case.epoch_ms, level(&case.level), &case.message), case.line);
    }
}
