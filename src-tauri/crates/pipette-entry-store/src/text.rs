// SPDX-License-Identifier: GPL-2.0-or-later
//! UTF-8 byte counting and truncation for file names, on JavaScript strings
//! (UTF-16 code units, lone surrogates included). The common file systems
//! limit a name to 255 bytes (UTF-8 on Linux and macOS; 255 UTF-16 units on
//! Windows, never more than the UTF-8 byte count), so a multi-byte name
//! hits the limit before its character count does.
//!
//! Same rules as src/shared/utils/utf8-truncate.ts: a lone surrogate counts
//! 3 bytes, the bytes of the U+FFFD it is written as.
//!
//! Also the string methods the stores compare and clean names with
//! (`trim`, `toLowerCase`, `length`), with JavaScript's meaning.

use pipette_js_json::JsString;

/// Each code point of `units` with the number of units it takes; a lone
/// surrogate is a code point of its own.
fn code_points(units: &[u16]) -> impl Iterator<Item = (u32, usize)> + '_ {
    char::decode_utf16(units.iter().copied()).map(|unit| match unit {
        Ok(ch) => (u32::from(ch), ch.len_utf16()),
        Err(err) => (u32::from(err.unpaired_surrogate()), 1),
    })
}

fn code_point_bytes(cp: u32) -> usize {
    match cp {
        0..0x80 => 1,
        0x80..0x800 => 2,
        0x800..0x10000 => 3,
        _ => 4,
    }
}

/// UTF-8 bytes of `units`.
pub fn utf8_byte_length(units: &[u16]) -> usize {
    code_points(units).map(|(cp, _)| code_point_bytes(cp)).sum()
}

/// The longest prefix of `units` that fits in `max_bytes` UTF-8 bytes, cut
/// between code points (a surrogate pair or a multi-byte character is
/// never split).
pub fn truncate_utf8(units: &[u16], max_bytes: usize) -> &[u16] {
    let mut bytes = 0;
    let mut end = 0;
    for (cp, len) in code_points(units) {
        bytes += code_point_bytes(cp);
        if bytes > max_bytes {
            break;
        }
        end += len;
    }
    &units[..end]
}

/// [`truncate_utf8`] without the `_` / `.` / whitespace the cut leaves at
/// the end of a file-name part.
pub fn truncate_utf8_name_part(units: &[u16], max_bytes: usize) -> &[u16] {
    let mut cut = truncate_utf8(units, max_bytes);
    while let [rest @ .., last] = cut {
        if !(*last == u16::from(b'_') || *last == u16::from(b'.') || is_js_whitespace(*last)) {
            break;
        }
        cut = rest;
    }
    cut
}

/// `String.prototype.trim`: `units` without the whitespace and line
/// terminators (`\s`) at either end.
pub fn trim_js_whitespace(units: &[u16]) -> &[u16] {
    let start = units.iter().position(|&unit| !is_js_whitespace(unit)).unwrap_or(units.len());
    let end = units.iter().rposition(|&unit| !is_js_whitespace(unit)).map_or(start, |last| last + 1);
    &units[start..end]
}

/// Whether `unit` matches `\s` of a JavaScript regular expression: the
/// ECMAScript WhiteSpace and LineTerminator code points (all in the BMP).
pub fn is_js_whitespace(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

/// `s.trim()`.
pub fn js_trim(s: &JsString) -> JsString {
    JsString::from_utf16(trim_js_whitespace(&s.utf16_units()).to_vec())
}

/// `s.length`: the number of UTF-16 code units.
pub fn utf16_len(s: &JsString) -> usize {
    s.as_str().map_or_else(|| s.utf16_units().len(), |text| text.encode_utf16().count())
}

/// `String.prototype.toLowerCase` on UTF-16 code units: the full Unicode
/// lowercase mapping of each run of well-formed text, lowercased as a whole
/// so a final sigma reads its context; a lone surrogate stays as it is.
pub fn js_to_lower_case(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut run = String::new();
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(c) => run.push(c),
            Err(lone) => {
                out.extend(run.to_lowercase().encode_utf16());
                run.clear();
                out.push(lone.unpaired_surrogate());
            }
        }
    }
    out.extend(run.to_lowercase().encode_utf16());
    out
}

/// [`is_js_whitespace`] for a `char`: every JavaScript whitespace code point
/// is in the BMP.
pub(crate) fn is_js_whitespace_char(c: char) -> bool {
    u16::try_from(u32::from(c)).is_ok_and(is_js_whitespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn counts_utf8_bytes_with_3_for_a_lone_surrogate() {
        assert_eq!(utf8_byte_length(&units("aé日😀")), 1 + 2 + 3 + 4);
        assert_eq!(utf8_byte_length(&[0xd800]), 3);
        assert_eq!(utf8_byte_length(&[0xde00, 0xd83d]), 6);
        assert_eq!(utf8_byte_length(&[]), 0);
    }

    #[test]
    fn truncates_between_code_points() {
        let text = units("a😀b");
        assert_eq!(truncate_utf8(&text, 4), &units("a")[..]);
        assert_eq!(truncate_utf8(&text, 5), &units("a😀")[..]);
        assert_eq!(truncate_utf8(&text, 0), &[] as &[u16]);
        assert_eq!(truncate_utf8(&[0x61, 0xd800, 0x62], 4), &[0x61, 0xd800]);
    }

    #[test]
    fn trims_what_javascript_trims() {
        assert_eq!(trim_js_whitespace(&units("\u{feff}\t a b\u{3000}\n\u{2028}")), &units("a b")[..]);
        // U+0085 and U+200B are not whitespace in JavaScript.
        assert_eq!(trim_js_whitespace(&units("\u{85}a\u{200b}")), &units("\u{85}a\u{200b}")[..]);
        assert_eq!(trim_js_whitespace(&units(" \u{a0} ")), &[] as &[u16]);
        assert_eq!(trim_js_whitespace(&[0x20, 0xd800, 0x20]), &[0xd800]);
    }

    #[test]
    fn lowercases_as_javascript_does() {
        assert_eq!(js_to_lower_case(&units("ENGLISH")), units("english"));
        assert_eq!(js_to_lower_case(&units("ΣΑΣ")), units("σας"));
        assert_eq!(js_to_lower_case(&units("İ")), units("i\u{307}"));
        assert_eq!(js_to_lower_case(&[0x41, 0xd800, 0x42]), [0x61, 0xd800, 0x62]);
    }

    #[test]
    fn trims_and_measures_strings() {
        assert_eq!(js_trim(&JsString::from("\u{feff} a \u{3000}")), JsString::from("a"));
        assert_eq!(utf16_len(&JsString::from("😀a")), 3);
        assert_eq!(utf16_len(&JsString::from_utf16(vec![0xd800, 0x61])), 2);
    }

    #[test]
    fn a_name_part_drops_the_separators_and_spaces_the_cut_leaves() {
        assert_eq!(truncate_utf8_name_part(&units("ab_. \u{3000}cd"), 7), &units("ab")[..]);
        // U+FEFF is `\s` in JavaScript; U+0085 is not.
        assert_eq!(truncate_utf8_name_part(&units("a\u{feff}"), 10), &units("a")[..]);
        assert_eq!(truncate_utf8_name_part(&units("a\u{85}"), 10), &units("a\u{85}")[..]);
        assert_eq!(truncate_utf8_name_part(&units("___"), 10), &[] as &[u16]);
    }
}
