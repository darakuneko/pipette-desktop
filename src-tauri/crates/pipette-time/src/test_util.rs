// SPDX-License-Identifier: GPL-2.0-or-later
//! Tests that run once per time zone. The time zone of a process is read
//! from `TZ` when the process starts (by this crate, by the C library behind
//! SQLite's `localtime`), and changing the environment of a running process
//! is unsound, so each zone gets a process of its own: the test binary runs
//! the one test again with `TZ` set.

use std::process::Command;

/// Set in the child processes [`in_each_time_zone`] starts, to the zone
/// that process runs in.
const CHILD_ZONE_VAR: &str = "PIPETTE_TEST_TIME_ZONE";

/// Run at the start of the test `test_path` (its full path in the test
/// binary, as `cargo test -- --exact` takes it). In the test's own process
/// this runs the test again for each of `zones` in a child process with
/// `TZ` set to the zone, fails when one of them fails or runs no test, and
/// returns `None`: the caller returns at once. In a child process it
/// returns the zone, and the caller runs the test body.
#[allow(clippy::expect_used, clippy::panic)]
pub fn in_each_time_zone(test_path: &str, zones: &[&str]) -> Option<String> {
    if let Ok(zone) = std::env::var(CHILD_ZONE_VAR) {
        assert_eq!(std::env::var("TZ").ok(), Some(zone.clone()), "TZ of the child process");
        return Some(zone);
    }
    assert!(!zones.is_empty(), "no time zones for {test_path}");
    let exe = std::env::current_exe().expect("the path of the test binary");
    for zone in zones {
        let output = Command::new(&exe)
            .args([test_path, "--exact", "--test-threads=1", "--nocapture"])
            .env("TZ", zone)
            .env(CHILD_ZONE_VAR, zone)
            .output()
            .expect("starting the test binary");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() || !stdout.contains("test result: ok. 1 passed") {
            panic!("{test_path} with TZ={zone} failed or did not run:\n{stdout}\n{stderr}");
        }
    }
    None
}

/// The zones of `zones` in which SQLite's `localtime` can run on this host.
/// SQLite reads the zone through the C library, and the one of Windows
/// takes `TZ` only in its own form (`PST8PDT`), not an IANA name: there only
/// `UTC` gives the same days as JavaScript. Without `TZ`, as the app runs,
/// both read the system's zone.
pub fn sqlite_time_zones<'a>(zones: &[&'a str]) -> Vec<&'a str> {
    zones.iter().copied().filter(|zone| !cfg!(windows) || *zone == "UTC").collect()
}
