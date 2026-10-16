// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync unit names of the typing-analytics files (sync.ts).

/// The unit of the deleted-ranges file of one (keyboard uid, machine hash):
/// `keyboards/{uid}/devices/{machineHash}/deleted-ranges`. Also the write
/// lock key of that file.
pub fn typing_deleted_ranges_sync_unit(uid: &str, machine_hash: &str) -> String {
    format!("keyboards/{uid}/devices/{machine_hash}/deleted-ranges")
}
