// SPDX-License-Identifier: GPL-2.0-or-later
//! `machine_id_original` against the value node-machine-id's
//! `machineId(true)` returned on this machine. The generator
//! (`pnpm run generate:sync-format-fixtures`) writes that value under
//! Cargo's temp directory; without it there is nothing to compare and the
//! test only says so.

// Test helpers outside #[test] functions unwrap fixture data too.
#![allow(clippy::unwrap_used)]

mod common;

use pipette_sync_format::machine_id_original;

#[test]
fn matches_node_machine_id_on_this_machine() {
    let path = common::shared_tmp_dir().join("node_machine_id.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        eprintln!("skipped: {} is missing; run pnpm run generate:sync-format-fixtures", path.display());
        return;
    };
    let recorded: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(machine_id_original().unwrap(), common::str_of(&recorded, "machineId"));
}
