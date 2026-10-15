// SPDX-License-Identifier: GPL-2.0-or-later
//! UTF-8 byte counting and truncation for file names, on JavaScript strings
//! (UTF-16 code units, lone surrogates included). The common file systems
//! limit a name to 255 bytes (UTF-8 on Linux and macOS; 255 UTF-16 units on
//! Windows, never more than the UTF-8 byte count), so a multi-byte name
//! hits the limit before its character count does.
//!
//! Same rules as src/shared/utils/utf8-truncate.ts: a lone surrogate counts
//! 3 bytes, the bytes of the U+FFFD it is written as.

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

/// Whether `unit` matches `\s` of a JavaScript regular expression: the
/// ECMAScript WhiteSpace and LineTerminator code points (all in the BMP).
fn is_js_whitespace(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
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
    fn a_name_part_drops_the_separators_and_spaces_the_cut_leaves() {
        assert_eq!(truncate_utf8_name_part(&units("ab_. \u{3000}cd"), 7), &units("ab")[..]);
        // U+FEFF is `\s` in JavaScript; U+0085 is not.
        assert_eq!(truncate_utf8_name_part(&units("a\u{feff}"), 10), &units("a")[..]);
        assert_eq!(truncate_utf8_name_part(&units("a\u{85}"), 10), &units("a\u{85}")[..]);
        assert_eq!(truncate_utf8_name_part(&units("___"), 10), &[] as &[u16]);
    }
}
