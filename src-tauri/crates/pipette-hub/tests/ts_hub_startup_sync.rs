// SPDX-License-Identifier: GPL-2.0-or-later
//! The startup update of the Hub-linked language packs against Electron's
//! (the scenarios of ts_hub_handlers_startup_sync.json): the recorded
//! userData is seeded, the scripted Hub answers the Rust pass, which must
//! send the same requests, wait the same waits, report the same sync units,
//! log the same lines, broadcast the same event and leave the same
//! userData. The downloads go out at once, so the requests, the sync units
//! and the per-pack error lines are compared sorted.

#![allow(clippy::unwrap_used)]

mod common;

use common::scripted_hub::{
    ScriptedHub, recorded_line, recorded_tree, scenario_stores, scripted_hub, seed, sorted, tree,
};
use common::{array, block_on, field, fixture, get, number, text};
use pipette_hub::startup_sync::run;

/// The log lines with the per-pack error lines, which follow the summary
/// in the order the downloads ended, sorted.
fn log_lines(mut lines: Vec<String>) -> Vec<String> {
    let first_error =
        lines.iter().position(|line| line.contains("i18n startup sync error ")).unwrap_or(lines.len());
    lines[first_error..].sort();
    lines
}

#[test]
fn the_startup_sync_scenarios_match_the_ts() {
    let f = fixture("ts_hub_handlers_startup_sync.json");
    let base = text(field(&f, "hubBase")).to_owned();
    let now = number(field(&f, "nowMs")).unwrap();
    let scenarios = array(field(&f, "scenarios"));
    assert_eq!(scenarios.len(), 4);
    let mut failures = Vec::new();
    for scenario in scenarios {
        let name = text(field(scenario, "name"));
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), field(scenario, "treeBefore"));
        for rule in array(field(scenario, "rules")) {
            assert!(get(rule, "query").is_none());
        }
        let (stores, notified) = scenario_stores(dir.path(), now);
        let ScriptedHub { script, clock, http } = scripted_hub(&base, now, field(scenario, "rules"));

        let steps = array(field(scenario, "steps"));
        assert_eq!(steps.len(), 1);
        let step = &steps[0];
        assert!(field(field(step, "step"), "startupSync").is_truthy());
        let outcome = block_on(run(&http, &stores, &|| false));
        assert!(!outcome.stopped);

        let seen = sorted(script.seen.lock().unwrap().clone());
        let expected = sorted(array(field(step, "requests")).iter().map(recorded_line).collect());
        if seen != expected {
            failures.push(format!("{name}: requests {seen:#?} expected {expected:#?}"));
        }
        let units = sorted(notified.lock().unwrap().clone());
        let expected =
            sorted(array(field(step, "notified")).iter().map(|unit| text(unit).to_owned()).collect());
        if units != expected {
            failures.push(format!("{name}: notified {units:?} expected {expected:?}"));
        }
        let slept = clock.slept.lock().unwrap().len();
        if slept != array(field(step, "sleeps")).len() {
            failures.push(format!("{name}: {slept} sleeps"));
        }
        let logs = log_lines(
            outcome
                .report()
                .into_iter()
                .map(|(level, message)| format!("{} {message}", level.as_str().to_ascii_lowercase()))
                .collect(),
        );
        let expected = log_lines(
            array(field(step, "logs"))
                .iter()
                .map(|line| format!("{} {}", text(field(line, "level")), text(field(line, "message"))))
                .collect(),
        );
        if logs != expected {
            failures.push(format!("{name}: logs {logs:#?} expected {expected:#?}"));
        }
        let events: Vec<String> = array(field(step, "events"))
            .iter()
            .map(|event| {
                assert!(array(field(event, "args")).is_empty());
                text(field(event, "channel")).to_owned()
            })
            .collect();
        let sent: Vec<String> =
            outcome.changed().then(|| "i18n-pack:changed".to_owned()).into_iter().collect();
        if sent != events {
            failures.push(format!("{name}: events {sent:?} expected {events:?}"));
        }
        let (after, expected) = (tree(dir.path()), recorded_tree(field(scenario, "treeAfter")));
        if after != expected {
            failures.push(format!("{name}: userData {after:#?} expected {expected:#?}"));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
