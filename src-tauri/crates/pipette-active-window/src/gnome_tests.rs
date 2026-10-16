// SPDX-License-Identifier: GPL-2.0-or-later
//! The reply parsing on its own, and the system runner with harmless commands
//! (never gdbus: the tests do not touch the session bus).

use std::time::{Duration, Instant};

use super::*;

#[test]
fn reads_the_last_part_of_wm_class() {
    let reply = |json: &str| parse_focused_window_reply(&format!("('{json}',)\n"));
    assert_eq!(reply(r#"{"wm_class":"org.gnome.Nautilus","pid":1}"#), Some("Nautilus".into()));
    assert_eq!(reply(r#"{"wm_class":"gnome-terminal-server"}"#), Some("gnome-terminal-server".into()));
    assert_eq!(reply(r#"{"wm_class":"a.b."}"#), None);
    assert_eq!(reply(r#"{"wm_class":""}"#), None);
    assert_eq!(reply(r#"{"wm_class":5}"#), None);
    assert_eq!(parse_focused_window_reply(r#"("{\"title\":\"it's\",\"wm_class\":\"X\"}",)"#), None);
    assert_eq!(reply("null"), None);
    assert_eq!(parse_focused_window_reply("()"), None);
    assert_eq!(parse_focused_window_reply(""), None);
}

#[cfg(unix)]
fn sh(script: &str, timeout: Duration) -> Option<String> {
    SystemCommandRunner.run("sh", &["-c", script], timeout)
}

#[cfg(unix)]
#[test]
fn system_runner_gives_the_output_of_a_successful_command() {
    assert_eq!(sh("printf 'a\\nb'", Duration::from_secs(5)), Some("a\nb".to_owned()));
    // Invalid UTF-8 reads with U+FFFD, as Node decodes the output.
    assert_eq!(sh("printf 'x\\377y'", Duration::from_secs(5)), Some("x\u{FFFD}y".to_owned()));
}

#[cfg(unix)]
#[test]
fn system_runner_fails_on_errors_timeouts_and_oversized_output() {
    assert_eq!(sh("printf out; exit 1", Duration::from_secs(5)), None);
    assert_eq!(SystemCommandRunner.run("pipette-no-such-program", &[], Duration::from_secs(5)), None);
    assert_eq!(sh("head -c 1048577 /dev/zero", Duration::from_secs(5)), None);
    assert!(sh("head -c 1048576 /dev/zero", Duration::from_secs(5)).is_some());
    for script in ["sleep 5", "printf early; sleep 5", "exec >&-; sleep 5"] {
        let started = Instant::now();
        assert_eq!(sh(script, Duration::from_millis(100)), None, "{script}");
        assert!(started.elapsed() < Duration::from_secs(3), "{script}");
    }
}
