// SPDX-License-Identifier: GPL-2.0-or-later
//! Path-safety and file-name helpers of the stores, as in
//! src/shared/utils/safe-filename.ts.
//!
//! A JavaScript string with a lone surrogate is passed in its lossy form
//! (`JsString::to_string_lossy`): U+FFFD and a lone surrogate both fail
//! every allowlist here and neither is a separator, so the answers are the
//! same.

use std::sync::LazyLock;

use regex::Regex;

/// Runs of characters other than a Unicode letter or digit, `_` and `-`.
static UNSAFE_RUN: LazyLock<Regex> = LazyLock::new(|| {
    #[allow(clippy::unwrap_used)] // a literal pattern
    Regex::new(r"[^\p{L}\p{N}_-]+").unwrap()
});

/// `name` as a file-name stem: each run of characters other than a Unicode
/// letter or digit, `_` and `-` becomes one `_`, then leading and trailing
/// `_` go; `fallback` when nothing is left.
pub fn safe_filename(name: &str, fallback: &str) -> String {
    let replaced = UNSAFE_RUN.replace_all(name, "_");
    let trimmed = replaced.trim_matches('_');
    if trimmed.is_empty() { fallback.to_owned() } else { trimmed.to_owned() }
}

/// Whether `segment` is safe as a single path segment (a uid, a run id, a
/// stored filename): not empty, `.` or `..`, and without `/` or `\`, so a
/// crafted value can never leave its store directory.
pub fn is_safe_path_segment(segment: &str) -> bool {
    !segment.is_empty() && segment != "." && segment != ".." && !segment.contains(['/', '\\'])
}

/// Whether `key` is safe as a lock key or directory segment taken from an
/// untrusted import file (a keyboard uid, a favorite type): ASCII word
/// characters and `-` only. A value that is not a string is never safe;
/// the caller checks that before calling.
pub fn is_safe_key(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Whether `filename` from an untrusted import file's index entry is safe
/// to join onto a base directory: ASCII word characters, `.`, `(`, `)` and
/// `-`, and not `.` or `..`.
pub fn is_safe_path(filename: &str) -> bool {
    !filename.is_empty()
        && filename
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'(' | b')' | b'-'))
        && filename != "."
        && filename != ".."
}

/// Whether `id` is a safe i18n / theme pack id: 1 to 64 of `A-Z a-z 0-9 _ -`.
pub fn is_safe_pack_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && is_safe_key(id)
}

/// The ISO time of `epoch_ms` with `:` replaced by `-`, safe in a file
/// name (`:` is reserved on Windows).
pub fn ts_for_filename(epoch_ms: i64) -> String {
    pipette_time::iso_8601_millis(epoch_ms).replace(':', "-")
}

/// The compact time of `epoch_ms` for export file names,
/// `2026-07-31-153045`: no `:`, no fraction of a second, `-` for `T`.
pub fn ts_for_export_filename(epoch_ms: i64) -> String {
    let iso = pipette_time::iso_8601_millis(epoch_ms).replace(':', "");
    // toISOString always ends in `.sssZ`.
    let without_fraction =
        iso.strip_suffix('Z').and_then(|s| s.rsplit_once('.')).map_or(iso.as_str(), |(head, _)| head);
    without_fraction.replacen('T', "-", 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_segments() {
        for bad in ["", ".", "..", "a/b", "a\\b"] {
            assert!(!is_safe_path_segment(bad), "{bad:?}");
        }
        for good in ["my-file_1.json", "キーボード設定", "...", "a b", "\u{fffd}"] {
            assert!(is_safe_path_segment(good), "{good:?}");
        }
    }

    #[test]
    fn keys_paths_and_pack_ids() {
        assert!(is_safe_key("uid-1_abc"));
        assert!(!is_safe_key(""));
        assert!(!is_safe_key("a.b"));
        assert!(!is_safe_key("é"));
        assert!(is_safe_path("e1.pipette"));
        assert!(is_safe_path("a(1).json"));
        assert!(!is_safe_path(".."));
        assert!(!is_safe_path("a b"));
        assert!(is_safe_pack_id(&"a".repeat(64)));
        assert!(!is_safe_pack_id(&"a".repeat(65)));
        assert!(!is_safe_pack_id(""));
        assert!(!is_safe_pack_id("../evil"));
        assert!(!is_safe_pack_id("pack/id"));
    }

    #[test]
    fn timestamps_for_file_names() {
        // Date.parse('2026-07-31T15:30:45.123Z')
        let ms = 1_785_511_845_123;
        assert_eq!(ts_for_filename(ms), "2026-07-31T15-30-45.123Z");
        assert_eq!(ts_for_export_filename(ms), "2026-07-31-153045");
    }

    #[test]
    fn safe_filename_collapses_unsafe_runs() {
        assert_eq!(safe_filename("my file!!name", "fallback"), "my_file_name");
        assert_eq!(safe_filename("!!!", "fallback"), "fallback");
        assert_eq!(safe_filename("__日本語 ١٢__", "f"), "日本語_١٢");
    }
}
