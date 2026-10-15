// SPDX-License-Identifier: GPL-2.0-or-later
//! Sync unit ↔ Google Drive file name mapping, the pure functions of
//! `src/main/sync/google-drive.ts`.
//!
//! A sync unit's file name is the unit with every `/` replaced by `_` plus
//! `.enc`. The reverse mapping is pattern based and only knows the unit
//! shapes that exist; anything else (including the password-check file)
//! maps to `None`.

use regex::Regex;
use std::sync::LazyLock;

use crate::password_check::PASSWORD_CHECK_UNIT;

/// Sync unit of the keyboard-name index (`KEYBOARD_META_SYNC_UNIT` in
/// `src/shared/types/keyboard-meta.ts`).
pub const KEYBOARD_META_SYNC_UNIT: &str = "meta/keyboard-names";

/// Unencrypted lock a machine holds while it re-encrypts every remote file
/// under a new sync password.
pub const PASSWORD_CHANGE_LOCK_FILE: &str = "password-change-lock.json";

/// Name prefix of the unencrypted sync-format markers.
pub const SYNC_FORMAT_FILE_PREFIX: &str = "sync-format-v";

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// JavaScript's `.`: any character except the four line terminators.
const DOT: &str = r"[^\n\r\x{2028}\x{2029}]";

fn pattern(source: &str) -> Regex {
    let source = source.replace("(.+?)", &format!("({DOT}+?)")).replace("(.+)", &format!("({DOT}+)"));
    // Patterns are constants of this file; the unit tests compile them all.
    Regex::new(&source).expect("constant pattern")
}

static SYNC_FORMAT_FILE: LazyLock<Regex> = LazyLock::new(|| pattern(r"^sync-format-v([0-9]+)\.json$"));
static DAY: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"^keyboards_(.+?)_devices_(.+?)_days_([0-9]{4}-[0-9]{2}-[0-9]{2})\.enc$"));
static DELETED_RANGES: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"^keyboards_(.+?)_devices_(.+?)_deleted-ranges\.enc$"));
static KEYBOARD_STORE: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"^keyboards_(.+?)_(settings|snapshots|runs|analyze_filters)\.enc$"));
static FAVORITE: LazyLock<Regex> = LazyLock::new(|| pattern(r"^favorites_(.+)\.enc$"));
static I18N_PACK: LazyLock<Regex> = LazyLock::new(|| pattern(r"^i18n_packs_(.+)\.enc$"));
static THEME_PACK: LazyLock<Regex> = LazyLock::new(|| pattern(r"^themes_packs_(.+)\.enc$"));

/// Drive file name of `sync_unit`: `favorites/tapDance` →
/// `favorites_tapDance.enc`.
pub fn drive_file_name(sync_unit: &str) -> String {
    drive_filename_prefix(sync_unit) + ".enc"
}

/// Drive file name prefix of a sync-unit path prefix (no `.enc`), for
/// listing one subtree by name.
pub fn drive_filename_prefix(sync_unit_prefix: &str) -> String {
    sync_unit_prefix.replace('/', "_")
}

pub fn is_password_change_lock_file(name: &str) -> bool {
    name == PASSWORD_CHANGE_LOCK_FILE
}

pub fn sync_format_file_name(version: u64) -> String {
    format!("{SYNC_FORMAT_FILE_PREFIX}{version}.json")
}

/// The `n` of a `sync-format-v{n}.json` marker name; `None` for any other
/// name or when `n` is beyond JavaScript's safe integer range.
pub fn parse_sync_format_file_name(name: &str) -> Option<u64> {
    let digits = SYNC_FORMAT_FILE.captures(name)?.get(1)?.as_str();
    // More digits than u64 holds is also beyond the safe range.
    digits.parse::<u64>().ok().filter(|version| *version <= MAX_SAFE_INTEGER)
}

/// Whether a listed file holds encrypted user data: none of the
/// password-check sentinel, the password-change lock and the sync-format
/// markers.
pub fn is_data_file_name(name: &str) -> bool {
    name != drive_file_name(PASSWORD_CHECK_UNIT)
        && !is_password_change_lock_file(name)
        && parse_sync_format_file_name(name).is_none()
}

fn exact_sync_unit(file_name: &str) -> Option<&'static str> {
    match file_name {
        "key-labels.enc" => Some("key-labels"),
        "typing-test-texts.enc" => Some("typing-test-texts"),
        "i18n_index.enc" => Some("i18n/index"),
        "themes_index.enc" => Some("themes/index"),
        "meta_keyboard-names.enc" => Some(KEYBOARD_META_SYNC_UNIT),
        _ => None,
    }
}

fn group<'a>(captures: &regex::Captures<'a>, index: usize) -> &'a str {
    captures.get(index).map_or("", |m| m.as_str())
}

/// The sync unit a Drive file name holds, or `None` when the name is not a
/// data sync unit. The keyboard uid and machine hash captures are
/// non-greedy, as in the TypeScript patterns.
pub fn sync_unit_from_file_name(file_name: &str) -> Option<String> {
    if let Some(exact) = exact_sync_unit(file_name) {
        return Some(exact.to_owned());
    }
    if let Some(c) = DAY.captures(file_name) {
        return Some(format!("keyboards/{}/devices/{}/days/{}", group(&c, 1), group(&c, 2), group(&c, 3)));
    }
    if let Some(c) = DELETED_RANGES.captures(file_name) {
        return Some(format!("keyboards/{}/devices/{}/deleted-ranges", group(&c, 1), group(&c, 2)));
    }
    if let Some(c) = KEYBOARD_STORE.captures(file_name) {
        return Some(format!("keyboards/{}/{}", group(&c, 1), group(&c, 2)));
    }
    if let Some(c) = FAVORITE.captures(file_name) {
        return Some(format!("favorites/{}", group(&c, 1)));
    }
    if let Some(c) = I18N_PACK.captures(file_name) {
        return Some(format!("i18n/packs/{}", group(&c, 1)));
    }
    if let Some(c) = THEME_PACK.captures(file_name) {
        return Some(format!("themes/packs/{}", group(&c, 1)));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyboard_meta_file_name_matches_the_exact_table() {
        assert_eq!(drive_file_name(KEYBOARD_META_SYNC_UNIT), "meta_keyboard-names.enc");
    }

    #[test]
    fn every_pattern_compiles() {
        for re in
            [&SYNC_FORMAT_FILE, &DAY, &DELETED_RANGES, &KEYBOARD_STORE, &FAVORITE, &I18N_PACK, &THEME_PACK]
        {
            assert!(!re.as_str().is_empty());
        }
    }

    #[test]
    fn dot_does_not_cross_line_terminators() {
        assert_eq!(sync_unit_from_file_name("favorites_a\nb.enc"), None);
        assert_eq!(sync_unit_from_file_name("favorites_a\u{2028}b.enc"), None);
        assert_eq!(sync_unit_from_file_name("favorites_a\u{85}b.enc").as_deref(), Some("favorites/a\u{85}b"));
    }
}
