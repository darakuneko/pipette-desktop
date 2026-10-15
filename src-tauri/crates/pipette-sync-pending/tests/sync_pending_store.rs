// SPDX-License-Identifier: GPL-2.0-or-later
//! The specs of src/main/sync/__tests__/sync-pending-store.test.ts that cover
//! what this crate does: the delayed writes, the generations and the startup
//! restore. The settle, cancel and account hand-over specs belong to the
//! upload side, which is not here.

#![allow(clippy::unwrap_used)]

mod common;

use common::Harness;
use serde_json::json;

const EMPTY: &str = r#"{"version":1,"owner":null,"units":[],"held":{}}"#;

mod writing_the_pending_state {
    use super::*;

    #[test]
    fn writes_the_units_marked_pending_once_the_write_delay_passes_in_one_write() {
        let h = Harness::new();
        let store = h.launch();
        store.notify_change("favorites/tapDance");
        store.notify_change("favorites/macro");
        assert_eq!(h.read_file(), EMPTY);
        assert_eq!(h.scheduler.waiting(), 1);

        h.scheduler.advance();

        assert_eq!(
            h.read_file(),
            r#"{"version":1,"owner":null,"units":["favorites/tapDance","favorites/macro"],"held":{}}"#
        );
        assert_eq!(h.scheduler.waiting(), 0);
    }

    #[test]
    fn schedules_no_write_when_a_unit_already_pending_changes_again() {
        let h = Harness::new();
        let store = h.launch();
        store.notify_change("favorites/tapDance");
        h.scheduler.advance();
        let generation = store.pending_generation_of("favorites/tapDance");
        let scheduled = h.scheduler.scheduled();

        store.notify_change("favorites/tapDance");

        assert_eq!(h.scheduler.scheduled(), scheduled);
        assert!(store.pending_generation_of("favorites/tapDance") > generation);
    }

    #[test]
    fn does_not_push_out_a_write_that_is_due() {
        let h = Harness::new();
        let store = h.launch();
        store.notify_change("favorites/tapDance");
        store.notify_change("favorites/macro");
        store.notify_change("meta/keyboard-names");
        assert_eq!(h.scheduler.scheduled(), 2, "the restore's write and the first change's");
    }

    #[test]
    fn writes_again_after_the_directory_is_removed() {
        let h = Harness::new();
        let store = h.launch();
        std::fs::remove_dir_all(h.user_data().join("local")).unwrap();

        store.notify_change("favorites/tapDance");
        h.scheduler.advance();

        assert_eq!(h.read_json()["units"], json!(["favorites/tapDance"]));
    }

    #[test]
    fn writes_again_after_a_failed_write_even_for_a_unit_already_pending() {
        let h = Harness::new();
        let store = h.launch();
        store.notify_change("favorites/tapDance");
        std::fs::remove_file(h.pending_path()).unwrap();
        // A non-empty directory in the file's place makes the rename fail.
        std::fs::create_dir_all(h.pending_path().join("blocker")).unwrap();
        h.scheduler.advance();

        std::fs::remove_dir_all(h.pending_path()).unwrap();
        store.notify_change("favorites/tapDance");
        assert_eq!(h.scheduler.waiting(), 1);
        h.scheduler.advance();

        assert_eq!(h.read_json()["units"], json!(["favorites/tapDance"]));
        // Written again, a unit already pending schedules nothing.
        store.notify_change("favorites/tapDance");
        assert_eq!(h.scheduler.waiting(), 0);
    }

    #[test]
    fn leaves_no_temp_file_behind_when_a_write_fails() {
        let h = Harness::new();
        let store = h.launch();
        std::fs::remove_file(h.pending_path()).unwrap();
        std::fs::create_dir_all(h.pending_path().join("blocker")).unwrap();

        store.notify_change("favorites/tapDance");
        h.scheduler.advance();

        let temp_files: Vec<_> = std::fs::read_dir(h.user_data().join("local"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert_eq!(temp_files, Vec::<String>::new());
    }
}

mod generations_and_status {
    use super::*;

    #[test]
    fn hands_out_generations_from_one_and_zero_for_a_unit_not_pending() {
        let h = Harness::new();
        let store = h.launch();
        assert_eq!(store.pending_generation_of("favorites/macro"), 0);
        store.notify_change("favorites/macro");
        store.notify_change("favorites/tapDance");
        store.notify_change("favorites/macro");
        assert_eq!(store.pending_generation_of("favorites/macro"), 3);
        assert_eq!(store.pending_generation_of("favorites/tapDance"), 2);
    }

    #[test]
    fn tells_the_listener_after_each_change_and_answers_the_status() {
        let h = Harness::new();
        let store = h.launch();
        assert!(!store.has_pending_changes());
        assert_eq!(*h.statuses.lock().unwrap(), Vec::<bool>::new(), "a restore tells nobody");

        store.notify_change("favorites/macro");
        store.notify_change("favorites/macro");

        assert!(store.has_pending_changes());
        assert_eq!(*h.statuses.lock().unwrap(), [true, true]);
    }
}

mod writing_now {
    use super::*;

    #[test]
    fn writes_at_once_and_takes_the_place_of_the_write_that_is_due() {
        let h = Harness::new();
        let store = h.launch();
        store.notify_change("favorites/macro");

        store.persist_now();
        assert_eq!(h.read_json()["units"], json!(["favorites/macro"]));

        // The write that was due finds it has been done and writes nothing.
        std::fs::remove_file(h.pending_path()).unwrap();
        h.scheduler.advance();
        assert!(!h.pending_path().exists());

        // The next change schedules a write of its own.
        store.notify_change("favorites/tapDance");
        h.scheduler.advance();
        assert_eq!(h.read_json()["units"], json!(["favorites/macro", "favorites/tapDance"]));
    }

    #[test]
    fn writes_from_several_threads_never_interleave() {
        let h = Harness::new();
        let store = h.launch();
        std::thread::scope(|scope| {
            for thread in 0..8 {
                let store = store.clone();
                scope.spawn(move || {
                    for i in 0..20 {
                        store.notify_change(&format!("favorites/t{thread}-{i}"));
                        store.persist_now();
                    }
                });
            }
        });
        let units = h.read_json()["units"].as_array().unwrap().len();
        assert_eq!(units, 160);
    }
}

mod restoring_the_pending_state_at_startup {
    use super::*;

    #[test]
    fn restores_nothing_from_a_missing_file() {
        let h = Harness::new();
        let store = h.launch();
        assert!(!store.has_pending_changes());
        assert_eq!(h.read_file(), EMPTY);
    }

    #[test]
    fn restores_nothing_from_a_malformed_file_and_writes_over_it() {
        for content in [
            r#"{"version":1,"#,
            r#"{"version":2,"owner":null,"units":["favorites/tapDance"],"held":{}}"#,
            r#"{"version":1,"owner":null,"units":"favorites/tapDance","held":{}}"#,
            "[1,2]",
            "\u{feff}{\"version\":1,\"owner\":null,\"units\":[\"favorites/tapDance\"],\"held\":{}}",
        ] {
            let h = Harness::new();
            h.write_file(content);
            let store = h.launch();
            assert!(!store.has_pending_changes(), "{content}");
            assert_eq!(h.read_file(), EMPTY, "{content}");
        }
    }

    #[test]
    fn drops_units_with_an_unsafe_segment() {
        let h = Harness::new();
        h.write_file(
            r#"{"version":1,"owner":null,"units":["favorites/tapDance","favorites/../x","favorites//macro","",7,"meta/keyboard-names","a\\b"],"held":{}}"#,
        );
        h.launch();
        assert_eq!(h.read_json()["units"], json!(["favorites/tapDance", "meta/keyboard-names"]));
    }

    #[test]
    fn drops_the_units_of_a_keyboard_whose_directory_is_gone_keeps_the_others_and_writes_the_drop_back() {
        let h = Harness::new();
        h.add_keyboard_dir("uid1");
        h.write_file(
            &json!({
                "version": 1,
                "owner": "account-a",
                "units": ["keyboards/uid1/settings", "keyboards/uid2/settings", "keyboards/uid2/devices/h/days/2026-10-01", "favorites/tapDance"],
                "held": { "account-b": ["keyboards/uid2/snapshots", "keyboards/uid1/snapshots"], "account-c": ["keyboards/uid2/settings"] },
            })
            .to_string(),
        );

        h.launch();

        assert_eq!(
            h.read_file(),
            r#"{"version":1,"owner":"account-a","units":["keyboards/uid1/settings","favorites/tapDance"],"held":{"account-b":["keyboards/uid1/snapshots"]}}"#
        );
    }

    #[test]
    fn keeps_a_unit_whose_keyboard_cannot_be_checked() {
        let h = Harness::new();
        // `sync/keyboards` is a file: the check fails with something other
        // than a missing entry.
        std::fs::create_dir_all(h.user_data().join("sync")).unwrap();
        std::fs::write(h.user_data().join("sync").join("keyboards"), "").unwrap();
        h.write_file(r#"{"version":1,"owner":null,"units":["keyboards/uid1/settings"],"held":{}}"#);
        h.launch();
        assert_eq!(h.read_json()["units"], json!(["keyboards/uid1/settings"]));
    }

    #[test]
    fn restores_the_units_in_file_order_with_new_generations() {
        let h = Harness::new();
        h.write_file(
            r#"{"version":1,"owner":null,"units":["favorites/b","favorites/a","favorites/b"],"held":{}}"#,
        );
        let store = h.launch();
        assert_eq!(store.pending_generation_of("favorites/b"), 1);
        assert_eq!(store.pending_generation_of("favorites/a"), 2);
        assert_eq!(h.read_json()["units"], json!(["favorites/b", "favorites/a"]));
    }

    #[test]
    fn leaves_a_file_it_cannot_read_as_it_is_and_keeps_the_changes_in_memory() {
        let h = Harness::new();
        let content = r#"{"version":1,"owner":"account-a","units":["favorites/tapDance"],"held":{}}"#;
        h.write_file(content);
        if !make_unreadable(&h) {
            return;
        }

        let store = h.restore();
        store.notify_change("favorites/macro");
        h.scheduler.advance();
        store.persist_now();

        assert_eq!(h.scheduler.scheduled(), 0);
        assert!(store.has_pending_changes());
        assert_eq!(store.pending_generation_of("favorites/tapDance"), 0);
        set_mode(&h, 0o600);
        assert_eq!(h.read_file(), content);
    }

    #[test]
    fn leaves_a_file_nested_too_deep_to_read_as_it_is() {
        let h = Harness::new();
        let deep = format!("{}{}", "[".repeat(1001), "]".repeat(1001));
        let content =
            format!(r#"{{"version":1,"owner":null,"units":["favorites/macro"],"held":{{}},"x":{deep}}}"#);
        h.write_file(&content);

        let store = h.launch();
        store.notify_change("favorites/combo");
        h.scheduler.advance();

        assert_eq!(h.read_file(), content);
    }

    #[test]
    fn reads_an_owner_that_is_not_a_string_or_is_empty_as_none() {
        for owner in ["42", "\"\"", "null", "{}"] {
            let h = Harness::new();
            h.write_file(&format!(
                r#"{{"version":1,"owner":{owner},"units":["favorites/tapDance"],"held":[]}}"#
            ));
            h.launch();
            assert_eq!(
                h.read_file(),
                r#"{"version":1,"owner":null,"units":["favorites/tapDance"],"held":{}}"#
            );
        }
    }

    #[test]
    fn keeps_the_held_units_of_named_accounts_only() {
        let h = Harness::new();
        h.write_file(
            r#"{"version":1,"owner":"me","units":[],"held":{"b":["favorites/x","favorites/x"],"":["favorites/y"],"c":[],"d":"favorites/z","e":["../z"],"7":["favorites/w"]}}"#,
        );
        h.launch();
        assert_eq!(
            h.read_file(),
            r#"{"version":1,"owner":"me","units":[],"held":{"7":["favorites/w"],"b":["favorites/x"]}}"#
        );
    }

    #[cfg(unix)]
    fn set_mode(h: &Harness, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(h.pending_path(), std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /// Takes away the read permission; false (and the test skips) when the
    /// file stays readable, as it does for root.
    #[cfg(unix)]
    fn make_unreadable(h: &Harness) -> bool {
        set_mode(h, 0o000);
        if std::fs::read(h.pending_path()).is_ok() {
            set_mode(h, 0o600);
            eprintln!("skipped: the file stays readable without the permission");
            return false;
        }
        true
    }

    #[cfg(not(unix))]
    fn set_mode(_: &Harness, _: u32) {}

    #[cfg(not(unix))]
    fn make_unreadable(_: &Harness) -> bool {
        eprintln!("skipped: needs Unix permissions");
        false
    }
}
