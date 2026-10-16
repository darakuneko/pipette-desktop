// SPDX-License-Identifier: GPL-2.0-or-later
//! Trash names for Drive data files the sync stops reading
//! (src/main/sync/drive-trash.ts). A copy of a name that is not the chosen
//! one ([`crate::canonical`]) is renamed to
//! `{name}.trash.{renamedAtMs}.{preModifiedMs}.{id}` instead of being
//! deleted, so it can be renamed back while no other copy of the name is
//! left. The name keeps every fact the later steps need, so nothing about
//! a trash file is stored anywhere else:
//!   - `renamedAtMs`: when it was renamed; its age counts from this;
//!   - `preModifiedMs`: its modifiedTime before the rename; the newest of
//!     these is the one renamed back;
//!   - `id`: its own Drive id, which keeps trash names unique.
//!
//! Every sync-unit file name ends in `.enc`, so a trash name maps to no
//! sync unit and the sync passes leave it alone.

use std::sync::LazyLock;

use pipette_sync_format::drive_names::{is_data_file_name, sync_unit_from_file_name};
use regex::Regex;

use crate::DriveFile;

/// How long a trash file is kept before it may be deleted: 30 days.
pub const TRASH_QUARANTINE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

const TRASH_MARK: &str = ".trash.";
/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// `^(.+\.enc)\.trash\.(\d+)\.(\d+)\.([A-Za-z0-9_-]+)$` of drive-trash.ts,
/// with JavaScript's `.` (any character but the four line terminators)
/// and its ASCII-only `\d`.
static TRASH_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([^\n\r\x{2028}\x{2029}]+\.enc)\.trash\.([0-9]+)\.([0-9]+)\.([A-Za-z0-9_-]+)$")
        .expect("constant pattern")
});

/// What a trash file's name says about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashInfo {
    /// The data file name the copy had before it was renamed.
    pub original_name: String,
    pub renamed_at_ms: i64,
    pub pre_modified_ms: i64,
}

fn is_drive_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// The trash name of `file` renamed at `renamed_at_ms`; `None` when its id
/// has characters a trash name cannot carry, so the name would not parse.
/// An unreadable or negative modifiedTime is written as 0, a negative
/// rename time as 0.
pub fn trash_file_name(file: &DriveFile, renamed_at_ms: i64) -> Option<String> {
    if !is_drive_id(&file.id) {
        return None;
    }
    let pre_modified_ms = pipette_time::parse_date_time_string(&file.modified_time).unwrap_or(0).max(0);
    Some(format!("{}{TRASH_MARK}{}.{pre_modified_ms}.{}", file.name, renamed_at_ms.max(0), file.id))
}

/// A decimal number as `Number` reads it, `None` past the safe integers.
fn safe_integer(digits: &str) -> Option<i64> {
    digits
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= MAX_SAFE_INTEGER)
        .and_then(|value| value.try_into().ok())
}

/// What the name of the file `id` named `name` says about it as a trash
/// file; `None` when it is not one: the name does not have the trash form,
/// the id in it is not the file's own, or the original name is not a data
/// file with a sync unit.
pub fn parse_trash_file(id: &str, name: &str) -> Option<TrashInfo> {
    let captures = TRASH_NAME.captures(name)?;
    let part = |index| captures.get(index).map_or("", |m| m.as_str());
    if part(4) != id {
        return None;
    }
    let original_name = part(1);
    let renamed_at_ms = safe_integer(part(2))?;
    let pre_modified_ms = safe_integer(part(3))?;
    if !is_data_file_name(original_name) || sync_unit_from_file_name(original_name).is_none() {
        return None;
    }
    Some(TrashInfo { original_name: original_name.to_owned(), renamed_at_ms, pre_modified_ms })
}

/// Whether the trash file has been kept for [`TRASH_QUARANTINE_MS`].
pub fn is_trash_expired(trash: &TrashInfo, now_ms: i64) -> bool {
    now_ms.saturating_sub(trash.renamed_at_ms) >= TRASH_QUARANTINE_MS
}
