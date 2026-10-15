// SPDX-License-Identifier: GPL-2.0-or-later
//! Snapshot body filenames, as src/shared/snapshot-filename.ts builds them:
//! `{device}_{timestamp}_{id}.pipette`. Every snapshot of a keyboard shares
//! one folder that sync merges across PCs, so the name carries the entry id
//! and two snapshots saved in the same millisecond never share a file. The
//! device name comes first and the timestamp second, so
//! [`crate::extract_device_name_from_filename`] reads it back.

use pipette_entry_store::truncate_utf8_name_part;

/// UTF-8 bytes the device name may take in a snapshot filename. The rest
/// (`_` + timestamp + `_` + id + `.pipette`, about 70 bytes) keeps the whole
/// name within [`pipette_entry_store::MAX_BODY_FILENAME_BYTES`].
pub const MAX_SNAPSHOT_DEVICE_NAME_BYTES: usize = 120;

const SNAPSHOT_FILE_EXTENSION: &str = ".pipette";

/// `safe_device_name` cut to [`MAX_SNAPSHOT_DEVICE_NAME_BYTES`] between code
/// points, without the `_` / `.` / whitespace the cut leaves at its end, or
/// `keyboard` when nothing is left. A name within the limit is returned as
/// it is.
pub fn cap_snapshot_device_name(safe_device_name: &str) -> String {
    if safe_device_name.len() <= MAX_SNAPSHOT_DEVICE_NAME_BYTES {
        return safe_device_name.to_owned();
    }
    let units: Vec<u16> = safe_device_name.encode_utf16().collect();
    let cut = truncate_utf8_name_part(&units, MAX_SNAPSHOT_DEVICE_NAME_BYTES);
    // Cut between code points of a valid string: still valid UTF-16.
    if cut.is_empty() { "keyboard".to_owned() } else { String::from_utf16_lossy(cut) }
}

/// `{device}_{timestamp}_{id}.pipette`, the device name capped by
/// [`cap_snapshot_device_name`].
pub fn build_snapshot_filename(safe_device_name: &str, timestamp: &str, id: &str) -> String {
    format!("{}_{timestamp}_{id}{SNAPSHOT_FILE_EXTENSION}", cap_snapshot_device_name(safe_device_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TS: &str = "2026-03-15T14-35-29.037Z";
    const ID: &str = "0b9f6f1e-3c1a-4e0e-9d7a-2f1d5f6b8a90";

    #[test]
    fn a_name_within_the_limit_is_kept() {
        let name = "a".repeat(MAX_SNAPSHOT_DEVICE_NAME_BYTES);
        assert_eq!(cap_snapshot_device_name(&name), name);
        assert_eq!(build_snapshot_filename("KB", TS, ID), format!("KB_{TS}_{ID}.pipette"));
    }

    #[test]
    fn a_long_name_is_cut_between_code_points_without_trailing_separators() {
        // 118 bytes, then a 4-byte emoji that does not fit.
        let name = format!("{}{}", "a".repeat(118), "😀😀");
        assert_eq!(cap_snapshot_device_name(&name), "a".repeat(118));
        // The cut leaves "_. " at the end, which goes.
        let name = format!("{}_. {}", "b".repeat(117), "c".repeat(10));
        assert_eq!(cap_snapshot_device_name(&name), "b".repeat(117));
        // 40 three-byte characters fill the limit exactly.
        let name = "鍵".repeat(41);
        assert_eq!(cap_snapshot_device_name(&name), "鍵".repeat(40));
    }

    #[test]
    fn a_name_cut_to_nothing_is_keyboard() {
        let name = format!("{}x", "_".repeat(MAX_SNAPSHOT_DEVICE_NAME_BYTES));
        assert_eq!(cap_snapshot_device_name(&name), "keyboard");
    }

    #[test]
    fn the_device_name_of_a_capped_filename_reads_back_as_the_capped_name() {
        let long = "Very Long Keyboard ".repeat(20);
        let filename = build_snapshot_filename(&long, TS, ID);
        let read = crate::extract_device_name_from_filename(&filename.as_str().into()).unwrap();
        assert_eq!(read.as_str(), Some(cap_snapshot_device_name(&long).as_str()));
    }
}
