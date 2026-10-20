// SPDX-License-Identifier: GPL-2.0-or-later
//! The input checks and small helpers of the Hub handlers, with
//! JavaScript's meaning: lengths in UTF-16 code units, `trim()` of the
//! ECMAScript whitespace, `Math.floor` and the non-finite numbers, and the
//! character replacement of file names per UTF-16 code unit (a character
//! outside the BMP becomes two `_`). The messages are the ones
//! src/renderer/utils/hub-error-i18n.ts maps.

use crate::base64::node_base64_decode;
use crate::js::{js_length, js_trim};
use crate::multipart::{KeymapFiles, UploadFile};

/// A rejected input, with its message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct InvalidInput(pub String);

fn invalid(message: &str) -> InvalidInput {
    InvalidInput(message.to_owned())
}

/// `POST_ID_RE`: `^[a-zA-Z0-9_-]+$`.
pub fn is_valid_post_id(post_id: &str) -> bool {
    !post_id.is_empty() && post_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `validatePostId`.
pub fn validate_post_id(post_id: &str) -> Result<(), InvalidInput> {
    if is_valid_post_id(post_id) { Ok(()) } else { Err(invalid("Invalid post ID")) }
}

const DISPLAY_NAME_MAX_LENGTH: usize = 50;
const KEYBOARD_NAME_MAX_LENGTH: usize = 100;
const TITLE_MAX_LENGTH: usize = 200;

/// The trimmed text when it is not empty and at most `max` UTF-16 units;
/// `None` (any value that is not a string) is empty.
fn trimmed_within(
    text: Option<&str>,
    max: usize,
    empty: &str,
    too_long: &str,
) -> Result<String, InvalidInput> {
    let trimmed = js_trim(text.ok_or_else(|| invalid(empty))?);
    if trimmed.is_empty() {
        return Err(invalid(empty));
    }
    if js_length(&trimmed) > max {
        return Err(invalid(too_long));
    }
    Ok(trimmed)
}

/// `validateDisplayName`; `None` stands for any value that is not a string.
pub fn validate_display_name(display_name: Option<&str>) -> Result<String, InvalidInput> {
    trimmed_within(
        display_name,
        DISPLAY_NAME_MAX_LENGTH,
        "Display name must not be empty",
        "Display name too long",
    )
}

/// `validateKeyboardName`; `None` stands for any value that is not a string.
pub fn validate_keyboard_name(name: Option<&str>) -> Result<String, InvalidInput> {
    trimmed_within(name, KEYBOARD_NAME_MAX_LENGTH, "Missing keyboard name", "Keyboard name too long")
}

/// `validateTitle`; `None` stands for any value that is not a string.
pub fn validate_title(title: Option<&str>) -> Result<String, InvalidInput> {
    trimmed_within(title, TITLE_MAX_LENGTH, "Title must not be empty", "Title too long")
}

/// `clampInt`: `None` for `undefined` / `null` and for a value whose floor
/// is not finite, else the floor within `min..=max`.
pub fn clamp_int(value: Option<f64>, min: f64, max: f64) -> Option<f64> {
    let floored = value?.floor();
    if !floored.is_finite() {
        return None;
    }
    // `Math.max(min, Math.min(max, floored))`; neither argument is NaN here.
    Some(min.max(max.min(floored)))
}

/// `computeTotalPages`.
pub fn compute_total_pages(total: f64, per_page: f64) -> f64 {
    let total = if total.is_finite() { total.max(0.0) } else { 0.0 };
    let per_page = if per_page.is_finite() && per_page > 0.0 { per_page } else { 1.0 };
    (total / per_page).ceil().max(1.0)
}

/// `text.replace(/[^a-zA-Z0-9_-]/g, '_')`: per UTF-16 code unit.
pub fn replace_unsafe_filename_units(text: &str) -> String {
    text.encode_utf16()
        .map(|unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' => char::from(byte),
            _ => '_',
        })
        .collect()
}

/// `sanitizeFilenameBase`: the first non-empty of `product_name`,
/// `fallback` and `analytics`, with the unsafe characters replaced.
pub fn sanitize_filename_base(product_name: &str, fallback: &str) -> String {
    let source = [product_name, fallback].into_iter().find(|text| !text.is_empty()).unwrap_or("analytics");
    let source = replace_unsafe_filename_units(source);
    if source.is_empty() { "analytics".to_owned() } else { source }
}

const MB: usize = 1024 * 1024;

/// `FILE_SIZE_LIMITS`, in the order they are checked.
const FILE_SIZE_LIMITS: [(&str, usize, &str); 5] = [
    ("thumbnail", 2 * MB, "thumbnail"),
    ("vil", 10 * MB, "vil"),
    ("pipette", 10 * MB, "pipette"),
    ("c", 10 * MB, "keymap C"),
    ("pdf", 10 * MB, "PDF"),
];

/// `validateFileSize`: the first file over its limit, in the order of
/// `FILE_SIZE_LIMITS`.
pub fn validate_file_sizes(files: &KeymapFiles) -> Result<(), InvalidInput> {
    for (key, max, label) in FILE_SIZE_LIMITS {
        let size = match key {
            "thumbnail" => files.thumbnail.data.len(),
            "vil" => files.vil.data.len(),
            "pipette" => files.pipette.data.len(),
            "c" => files.c.data.len(),
            _ => files.pdf.data.len(),
        };
        if size > max {
            return Err(InvalidInput(format!("File too large: {label} exceeds {} MB limit", max / MB)));
        }
    }
    Ok(())
}

/// The text inputs of a keymap post (`HubUploadPostParams` without the
/// title).
#[derive(Debug, Clone, Copy)]
pub struct KeymapPostInput<'a> {
    pub keyboard_name: &'a str,
    pub vil_json: &'a str,
    pub pipette_json: &'a str,
    pub keymap_c: &'a str,
    pub pdf_base64: &'a str,
    pub thumbnail_base64: &'a str,
}

/// `buildFiles`: the five files named after the keyboard, the PDF and the
/// thumbnail decoded as Node decodes base64, then the size check.
pub fn build_files(input: KeymapPostInput<'_>) -> Result<KeymapFiles, InvalidInput> {
    let base = replace_unsafe_filename_units(input.keyboard_name);
    let file = |extension: &str, data: Vec<u8>| UploadFile { name: format!("{base}.{extension}"), data };
    let files = KeymapFiles {
        vil: file("vil", input.vil_json.as_bytes().to_vec()),
        pipette: file("pipette", input.pipette_json.as_bytes().to_vec()),
        c: file("c", input.keymap_c.as_bytes().to_vec()),
        pdf: file("pdf", node_base64_decode(input.pdf_base64)),
        thumbnail: file("jpg", node_base64_decode(input.thumbnail_base64)),
    };
    validate_file_sizes(&files)?;
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_lengths_in_utf16_units_after_a_js_trim() {
        assert_eq!(validate_title(Some("  a \u{3000}")), Ok("a".to_owned()));
        assert_eq!(validate_title(Some(&"😀".repeat(100))).map(|t| t.len()), Ok(400));
        assert_eq!(validate_title(Some(&"😀".repeat(101))), Err(invalid("Title too long")));
        assert_eq!(validate_title(None), Err(invalid("Title must not be empty")));
        assert_eq!(validate_display_name(Some(" \n ")), Err(invalid("Display name must not be empty")));
        assert_eq!(validate_keyboard_name(Some(&"x".repeat(101))), Err(invalid("Keyboard name too long")));
        assert_eq!(validate_post_id(""), Err(invalid("Invalid post ID")));
        assert_eq!(validate_post_id("a-B_9"), Ok(()));
    }

    #[test]
    fn clamps_and_counts_pages_as_the_ts_does() {
        assert_eq!(clamp_int(Some(5.9), 1.0, 100.0), Some(5.0));
        assert_eq!(clamp_int(Some(f64::NAN), 1.0, 100.0), None);
        assert_eq!(clamp_int(None, 1.0, 100.0), None);
        assert_eq!(compute_total_pages(21.0, 20.0), 2.0);
        assert_eq!(compute_total_pages(f64::NAN, 0.0), 1.0);
    }

    #[test]
    fn replaces_per_utf16_unit() {
        assert_eq!(replace_unsafe_filename_units("a b😀é-_"), "a_b___-_");
        assert_eq!(sanitize_filename_base("", ""), "analytics");
        assert_eq!(sanitize_filename_base("", " "), "_");
    }
}
