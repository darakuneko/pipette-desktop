// SPDX-License-Identifier: GPL-2.0-or-later
//! The specs of src/main/sync/__tests__/sync-pending-store.test.ts on the
//! upload side and the accounts: the settle, the cancel and putting it
//! back, and the hand-over of the units to the signed-in account. The
//! sign-in and sign-out around them are pipette-sync's (tests/account.rs).

#![allow(clippy::unwrap_used)]

mod common;

use common::Harness;
use pipette_sync_pending::{PendingStore, PendingWriteError};
use serde_json::json;

fn active(store: &PendingStore) -> Vec<String> {
    let mut units: Vec<String> =
        store.snapshot_generations().keys().map(|unit| unit.as_str().unwrap().to_owned()).collect();
    units.sort();
    units
}

fn held(store: &PendingStore, sub: &str) -> Vec<String> {
    let mut units: Vec<String> = store
        .held()
        .into_iter()
        .filter(|(account, _)| account.as_str() == Some(sub))
        .flat_map(|(_, units)| units.into_iter().map(|unit| unit.as_str().unwrap().to_owned()))
        .collect();
    units.sort();
    units
}

fn owner(store: &PendingStore) -> Option<String> {
    store.owner().map(|owner| owner.as_str().unwrap().to_owned())
}

mod writing_the_pending_state {
    use super::*;

    #[test]
    fn writes_a_settled_unit_out_of_the_file() {
        let h = Harness::new();
        let store = h.launch();
        store.notify_change("favorites/tapDance");
        h.scheduler.advance();

        store.settle("favorites/tapDance", store.pending_generation_of("favorites/tapDance"));
        h.scheduler.advance();

        assert_eq!(h.read_json()["units"], json!([]));
    }

    #[test]
    fn keeps_a_unit_marked_again_after_the_generation_was_taken() {
        let h = Harness::new();
        let store = h.launch();
        store.notify_change("favorites/tapDance");
        let generations = store.snapshot_generations();
        store.notify_change("favorites/tapDance");

        store.settle("favorites/tapDance", generations["favorites/tapDance"]);

        assert_eq!(active(&store), ["favorites/tapDance"]);
        // Only the very same generation settles: an older one does not.
        store.settle("favorites/tapDance", generations["favorites/tapDance"] - 1);
        assert_eq!(active(&store), ["favorites/tapDance"]);
    }

    #[test]
    fn a_settle_does_not_tell_the_listener() {
        let h = Harness::new();
        let store = h.launch();
        store.notify_change("favorites/tapDance");
        store.settle("favorites/tapDance", store.pending_generation_of("favorites/tapDance"));
        assert_eq!(*h.statuses.lock().unwrap(), [true]);

        store.broadcast_status();

        assert_eq!(*h.statuses.lock().unwrap(), [true, false]);
    }

    #[test]
    fn writes_a_cancel_of_several_prefixes_at_once_held_units_of_other_accounts_included() {
        let h = Harness::new();
        h.add_keyboard_dir("uid1");
        h.write_file(
            &json!({ "version": 1, "owner": null, "units": [],
                "held": { "account-a": ["keyboards/uid1/settings", "favorites/macro"], "account-b": ["themes/index"] } })
            .to_string(),
        );
        let store = h.launch();
        store.notify_change("keyboards/uid1/snapshots");
        store.notify_change("favorites/tapDance");
        store.notify_change("i18n/index");

        store.cancel(Some(&["keyboards/uid1/", "themes/", "i18n/"]), false).unwrap();

        assert_eq!(
            h.read_json(),
            json!({ "version": 1, "owner": null, "units": ["favorites/tapDance"], "held": { "account-a": ["favorites/macro"] } })
        );
        assert_eq!(held(&store, "account-a"), ["favorites/macro"]);
        assert!(held(&store, "account-b").is_empty());
    }

    #[test]
    fn cancels_everything_held_units_included_without_prefixes() {
        let h = Harness::new();
        h.write_file(r#"{"version":1,"owner":null,"units":[],"held":{"account-a":["favorites/macro"]}}"#);
        let store = h.launch();
        store.notify_change("favorites/tapDance");

        store.cancel(None, false).unwrap();

        assert_eq!(h.read_file(), r#"{"version":1,"owner":null,"units":[],"held":{}}"#);
        assert!(store.held().is_empty());
        assert_eq!(h.statuses.lock().unwrap().last(), Some(&false));
    }

    #[test]
    fn writes_nothing_when_no_unit_matches() {
        let h = Harness::new();
        let store = h.launch();
        store.notify_change("favorites/tapDance");
        h.scheduler.advance();
        std::fs::remove_file(h.pending_path()).unwrap();
        let told = h.statuses.lock().unwrap().len();

        store.cancel(Some(&["keyboards/"]), false).unwrap();
        store.cancel(Some(&[]), false).unwrap();

        assert!(!h.pending_path().exists());
        assert_eq!(active(&store), ["favorites/tapDance"]);
        assert_eq!(h.statuses.lock().unwrap().len(), told);
    }

    #[test]
    fn writes_anyway_when_asked_to_so_a_disk_failure_shows_before_a_reset_removes_anything() {
        let h = Harness::new();
        let store = h.launch();
        h.block_writes();

        assert!(store.cancel(Some(&["keyboards/"]), false).is_ok());
        assert!(matches!(store.cancel(Some(&["keyboards/"]), true), Err(PendingWriteError::Io(_))));
    }

    #[test]
    fn throws_and_keeps_the_pending_state_when_a_cancel_cannot_be_written() {
        let h = Harness::new();
        h.add_keyboard_dir("uid1");
        h.write_file(
            r#"{"version":1,"owner":null,"units":[],"held":{"account-a":["keyboards/uid1/snapshots"]}}"#,
        );
        let store = h.launch();
        store.notify_change("keyboards/uid1/settings");
        let generation = store.pending_generation_of("keyboards/uid1/settings");
        h.block_writes();

        assert!(store.cancel(Some(&["keyboards/uid1/"]), false).is_err());

        assert_eq!(active(&store), ["keyboards/uid1/settings"]);
        assert_eq!(store.pending_generation_of("keyboards/uid1/settings"), generation);
        assert_eq!(held(&store, "account-a"), ["keyboards/uid1/snapshots"]);
        assert_eq!(h.temp_files(), Vec::<String>::new());
    }

    #[test]
    fn writes_again_after_a_failed_cancel_for_a_unit_already_pending() {
        let h = Harness::new();
        let store = h.launch();
        store.notify_change("favorites/tapDance");
        h.scheduler.advance();
        h.block_writes();
        assert!(store.cancel(Some(&["favorites/"]), true).is_err());
        h.unblock_writes();

        store.notify_change("favorites/tapDance");
        h.scheduler.advance();

        assert_eq!(h.read_json()["units"], json!(["favorites/tapDance"]));
    }

    #[test]
    fn keeps_a_cancelled_unit_out_after_a_restart() {
        let h = Harness::new();
        h.add_keyboard_dir("uid1");
        let store = h.launch();
        store.notify_change("keyboards/uid1/settings");
        store.notify_change("favorites/tapDance");
        h.scheduler.advance();

        store.cancel(Some(&["keyboards/uid1/"]), false).unwrap();
        drop(store);
        let store = h.launch();

        assert_eq!(active(&store), ["favorites/tapDance"]);
    }

    #[test]
    fn a_cancel_written_now_takes_the_place_of_the_write_that_is_due() {
        let h = Harness::new();
        let store = h.launch();
        store.notify_change("favorites/tapDance");
        store.notify_change("keyboards/uid1/settings");

        store.cancel(Some(&["favorites/"]), false).unwrap();
        std::fs::remove_file(h.pending_path()).unwrap();
        h.scheduler.advance();

        assert!(!h.pending_path().exists());
    }
}

mod putting_the_pending_state_back {
    use super::*;

    #[test]
    fn puts_back_the_cancelled_active_units_with_their_generations_and_the_held_units_and_writes_them() {
        let h = Harness::new();
        h.add_keyboard_dir("uid1");
        let original = json!({ "version": 1, "owner": "account-a", "units": ["favorites/tapDance", "keyboards/uid1/settings"],
            "held": { "account-b": ["favorites/macro", "keyboards/uid1/snapshots"] } });
        h.write_file(&original.to_string());
        let store = h.launch();
        let generations = store.snapshot_generations();
        let copy = store.copy_state();

        store.cancel(Some(&["favorites/"]), true).unwrap();
        assert_eq!(
            h.read_json(),
            json!({ "version": 1, "owner": "account-a", "units": ["keyboards/uid1/settings"], "held": { "account-b": ["keyboards/uid1/snapshots"] } })
        );

        store.restore_cancelled(&copy);

        assert_eq!(active(&store), ["favorites/tapDance", "keyboards/uid1/settings"]);
        let mut restored: Vec<_> = store.snapshot_generations().into_iter().collect();
        let mut expected: Vec<_> = generations.into_iter().collect();
        restored.sort_by(|a, b| a.0.as_str().cmp(&b.0.as_str()));
        expected.sort_by(|a, b| a.0.as_str().cmp(&b.0.as_str()));
        assert_eq!(restored, expected);
        assert_eq!(held(&store, "account-b"), ["favorites/macro", "keyboards/uid1/snapshots"]);
        assert_eq!(owner(&store).as_deref(), Some("account-a"));
        let file = h.read_json();
        let mut units: Vec<String> = serde_json::from_value(file["units"].clone()).unwrap();
        units.sort();
        assert_eq!(units, ["favorites/tapDance", "keyboards/uid1/settings"]);
    }

    #[test]
    fn keeps_units_marked_after_the_copy_with_their_newer_generation() {
        let h = Harness::new();
        h.write_file(
            r#"{"version":1,"owner":"account-a","units":["favorites/tapDance","favorites/macro"],"held":{}}"#,
        );
        let store = h.launch();
        let copy = store.copy_state();

        store.cancel(Some(&["favorites/"]), true).unwrap();
        store.notify_change("favorites/macro");
        store.notify_change("favorites/combo");
        let newer = store.pending_generation_of("favorites/macro");

        store.restore_cancelled(&copy);

        assert_eq!(active(&store), ["favorites/combo", "favorites/macro", "favorites/tapDance"]);
        assert_eq!(store.pending_generation_of("favorites/macro"), newer);
        assert_eq!(
            Some(store.pending_generation_of("favorites/tapDance")),
            copy.generation_of("favorites/tapDance")
        );
        let mut units: Vec<String> = serde_json::from_value(h.read_json()["units"].clone()).unwrap();
        units.sort();
        assert_eq!(units, ["favorites/combo", "favorites/macro", "favorites/tapDance"]);
    }
}

mod a_file_that_cannot_be_read {
    use super::*;

    #[test]
    fn refuses_a_resets_cancel_and_lets_another_cancel_change_memory_only() {
        let h = Harness::new();
        h.write_file(r#"{"version":1,"owner":null,"units":["favorites/tapDance"],"held":{}}"#);
        if !h.make_unreadable() {
            return;
        }
        let store = h.launch();
        store.notify_change("favorites/macro");

        let refused = store.cancel(Some(&["favorites/"]), true);
        assert!(matches!(refused, Err(PendingWriteError::Unreadable)));
        assert_eq!(
            refused.unwrap_err().to_string(),
            "The pending sync changes file cannot be read; restart Pipette and try again"
        );
        assert_eq!(active(&store), ["favorites/macro"]);
        assert!(store.cancel(Some(&["favorites/"]), false).is_ok());
        assert!(active(&store).is_empty());
        h.make_readable();
        assert_eq!(h.read_json()["units"], json!(["favorites/tapDance"]));
    }
}

mod the_account_the_pending_units_belong_to {
    use super::*;

    fn start_with(h: &Harness, file: serde_json::Value) -> PendingStore {
        let mut file = file;
        file["version"] = json!(1);
        h.write_file(&file.to_string());
        h.launch()
    }

    #[test]
    fn holds_units_changed_under_another_account_for_it() {
        let h = Harness::new();
        let store =
            start_with(&h, json!({ "owner": "account-a", "units": ["favorites/tapDance"], "held": {} }));

        assert!(store.adopt_for_account(Some("account-b")));

        assert!(active(&store).is_empty());
        assert_eq!(
            h.read_file(),
            r#"{"version":1,"owner":"account-b","units":[],"held":{"account-a":["favorites/tapDance"]}}"#
        );
        assert_eq!(h.statuses.lock().unwrap().last(), Some(&false));
    }

    #[test]
    fn gives_units_changed_while_signed_out_to_the_signed_in_account() {
        let h = Harness::new();
        let store = start_with(&h, json!({ "owner": null, "units": ["favorites/tapDance"], "held": {} }));

        store.adopt_for_account(Some("account-b"));

        assert_eq!(active(&store), ["favorites/tapDance"]);
        assert_eq!(h.read_json()["owner"], "account-b");
    }

    #[test]
    fn makes_the_units_held_for_the_signed_in_account_active_again() {
        let h = Harness::new();
        let store = start_with(
            &h,
            json!({ "owner": "account-b", "units": ["favorites/macro"], "held": { "account-a": ["favorites/tapDance"] } }),
        );

        store.adopt_for_account(Some("account-a"));

        assert_eq!(owner(&store).as_deref(), Some("account-a"));
        assert_eq!(active(&store), ["favorites/tapDance"]);
        assert_eq!(held(&store, "account-b"), ["favorites/macro"]);
        assert_eq!(
            h.read_file(),
            r#"{"version":1,"owner":"account-a","units":["favorites/tapDance"],"held":{"account-b":["favorites/macro"]}}"#
        );
    }

    #[test]
    fn writes_nothing_when_the_units_already_belong_to_the_signed_in_account() {
        let h = Harness::new();
        let store =
            start_with(&h, json!({ "owner": "account-a", "units": ["favorites/tapDance"], "held": {} }));
        std::fs::remove_file(h.pending_path()).unwrap();

        assert!(!store.adopt_for_account(Some("account-a")));

        assert!(!h.pending_path().exists());
        assert_eq!(active(&store), ["favorites/tapDance"]);
    }

    #[test]
    fn changes_nothing_when_the_account_carries_no_id_or_nobody_is_signed_in() {
        let h = Harness::new();
        let store = start_with(
            &h,
            json!({ "owner": "account-a", "units": ["favorites/tapDance"], "held": { "account-b": ["favorites/macro"] } }),
        );
        std::fs::remove_file(h.pending_path()).unwrap();

        assert!(!store.adopt_for_account(None));

        assert!(!h.pending_path().exists());
        assert_eq!(owner(&store).as_deref(), Some("account-a"));
        assert_eq!(active(&store), ["favorites/tapDance"]);
    }

    #[test]
    fn marks_a_unit_pending_when_that_account_is_still_the_owner_or_the_pass_ran_as_nobody_known() {
        let h = Harness::new();
        let store = start_with(&h, json!({ "owner": "account-b", "units": [], "held": {} }));

        store.mark_pending_for(Some("account-b"), "favorites/tapDance");
        store.mark_pending_for(None, "favorites/macro");

        assert_eq!(active(&store), ["favorites/macro", "favorites/tapDance"]);
    }

    #[test]
    fn keeps_the_generation_of_a_unit_already_pending() {
        let h = Harness::new();
        let store = start_with(&h, json!({ "owner": "account-b", "units": ["favorites/macro"], "held": {} }));
        let generation = store.pending_generation_of("favorites/macro");

        store.mark_pending_for(Some("account-b"), "favorites/macro");

        assert_eq!(store.pending_generation_of("favorites/macro"), generation);
    }

    #[test]
    fn holds_it_for_that_account_when_another_account_has_signed_in_since() {
        let h = Harness::new();
        let store = start_with(&h, json!({ "owner": "account-b", "units": [], "held": {} }));

        store.mark_pending_for(Some("account-a"), "favorites/tapDance");

        assert!(active(&store).is_empty());
        assert_eq!(h.read_json()["held"], json!({ "account-a": ["favorites/tapDance"] }));
    }

    #[test]
    fn puts_the_ownership_back_when_it_cannot_be_written() {
        let h = Harness::new();
        let store =
            start_with(&h, json!({ "owner": "account-a", "units": ["favorites/tapDance"], "held": {} }));
        let generation = store.pending_generation_of("favorites/tapDance");
        h.block_writes();

        assert!(store.adopt_durably(Some("account-b")).is_err());
        assert!(store.hold_for_sign_out_durably().is_err());

        assert_eq!(owner(&store).as_deref(), Some("account-a"));
        assert_eq!(active(&store), ["favorites/tapDance"]);
        assert_eq!(store.pending_generation_of("favorites/tapDance"), generation);
        assert!(store.held().is_empty());
    }

    #[test]
    fn a_settle_of_a_pass_still_running_with_the_old_account_does_nothing() {
        let h = Harness::new();
        let store = start_with(&h, json!({ "owner": "account-a", "units": [], "held": {} }));
        store.notify_change("favorites/tapDance");
        let generations = store.snapshot_generations();

        store.hold_for_sign_out_durably().unwrap();
        store.notify_change("favorites/tapDance");
        store.settle("favorites/tapDance", generations["favorites/tapDance"]);

        assert_eq!(active(&store), ["favorites/tapDance"]);
        assert_eq!(held(&store, "account-a"), ["favorites/tapDance"]);
    }
}
