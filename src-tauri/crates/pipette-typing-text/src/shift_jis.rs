// SPDX-License-Identifier: GPL-2.0-or-later
//! `new TextDecoder('shift_jis').decode(bytes)` as Chromium runs it (its
//! ICU): the WHATWG Shift_JIS decoder, an invalid
//! sequence written as U+FFFD, no BOM handling, with two differences from
//! the WHATWG standard that the recorded fixtures show:
//!
//! - the user-defined area ends with lead byte 0xF8 (U+E000..U+E69B); a
//!   0xF9 lead byte is not mapped, where the standard maps it to
//!   U+E69C..U+E757;
//! - 0x87 0x5E decodes to one U+FFFD, where the standard writes U+FFFD and
//!   then decodes the 0x5E (`^`) again.
//!
//! The double-byte characters come from encoding_rs's JIS X 0208 index.

use std::sync::LazyLock;

use encoding_rs::SHIFT_JIS;

use crate::units::REPLACEMENT_CHARACTER;

/// The pointers of the user-defined area (lead bytes 0xF0..=0xF9), which
/// map to U+E000 onwards.
const USER_DEFINED: std::ops::RangeInclusive<usize> = 8836..=10715;
/// The last of them that is mapped (lead byte 0xF8).
const USER_DEFINED_MAPPED_END: usize = 10527;
/// The pair decoded to U+FFFD as a whole.
const SWALLOWED_PAIR: (u8, u8) = (0x87, 0x5e);
const POINTERS: usize = 11280;

/// The JIS X 0208 index by WHATWG pointer; 0 where no character is mapped.
static INDEX: LazyLock<Vec<u16>> = LazyLock::new(|| {
    let mut index = vec![0u16; POINTERS];
    for lead in (0x81..=0x9f).chain(0xe0..=0xfc) {
        for trail in (0x40..=0x7e).chain(0x80..=0xfc) {
            let bytes = [lead, trail];
            let (text, had_errors) = SHIFT_JIS.decode_without_bom_handling(&bytes);
            let mut units = text.encode_utf16();
            if let (false, Some(unit), None) = (had_errors, units.next(), units.next()) {
                if let Some(pointer) = pointer(lead, trail) {
                    index[pointer] = unit;
                }
            }
        }
    }
    index
});

/// The WHATWG pointer of a lead and trail byte, `None` for a trail byte
/// outside 0x40..=0x7E and 0x80..=0xFC.
fn pointer(lead: u8, trail: u8) -> Option<usize> {
    if !matches!(trail, 0x40..=0x7e | 0x80..=0xfc) {
        return None;
    }
    let lead_offset = if lead < 0xa0 { 0x81 } else { 0xc1 };
    let offset = if trail < 0x7f { 0x40 } else { 0x41 };
    Some(usize::from(lead - lead_offset) * 188 + usize::from(trail - offset))
}

/// The character of a double-byte sequence, `None` when it is not mapped.
fn double_byte(lead: u8, trail: u8) -> Option<u16> {
    if (lead, trail) == SWALLOWED_PAIR {
        return Some(REPLACEMENT_CHARACTER);
    }
    let pointer = pointer(lead, trail)?;
    if USER_DEFINED.contains(&pointer) {
        // At most 0x69B above U+E000.
        return (pointer <= USER_DEFINED_MAPPED_END)
            .then(|| 0xe000 + (pointer - USER_DEFINED.start()) as u16);
    }
    INDEX.get(pointer).copied().filter(|&unit| unit != 0)
}

/// The UTF-16 code units of the Shift_JIS `bytes`.
pub fn decode_shift_jis(bytes: &[u8]) -> Vec<u16> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        i += 1;
        match byte {
            0x00..=0x80 => out.push(u16::from(byte)),
            0xa1..=0xdf => out.push(0xff61 + u16::from(byte - 0xa1)),
            0x81..=0x9f | 0xe0..=0xfc => match bytes.get(i) {
                None => out.push(REPLACEMENT_CHARACTER),
                Some(&trail) => {
                    let unit = double_byte(byte, trail);
                    out.push(unit.unwrap_or(REPLACEMENT_CHARACTER));
                    // An unmapped pair gives an ASCII trail byte back to be
                    // decoded on its own.
                    if unit.is_some() || trail >= 0x80 {
                        i += 1;
                    }
                }
            },
            _ => out.push(REPLACEMENT_CHARACTER),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::units::utf16;

    #[test]
    fn decodes_ascii_kana_and_kanji() {
        let bytes = [b'A', 0x90, 0xc2, 0x8b, 0xf3, 0xb1, 0x82, 0xa0, 0x5c, 0x7e, 0x80];
        assert_eq!(decode_shift_jis(&bytes), utf16("A青空ｱあ\\~\u{80}"));
    }

    #[test]
    fn writes_u_fffd_for_invalid_sequences() {
        assert_eq!(decode_shift_jis(&[0xa0]), [0xfffd]);
        assert_eq!(decode_shift_jis(&[0xfd, 0xff]), [0xfffd, 0xfffd]);
        // A lead byte with an ASCII trail byte keeps the ASCII byte.
        assert_eq!(decode_shift_jis(&[0x81, 0x7f]), [0xfffd, 0x7f]);
        assert_eq!(decode_shift_jis(&[0x81, 0x20]), [0xfffd, 0x20]);
        assert_eq!(decode_shift_jis(&[0x81, 0xfd]), [0xfffd]);
        assert_eq!(decode_shift_jis(&[0x81]), [0xfffd]);
        // An unmapped pair with a non-ASCII trail byte is one U+FFFD.
        assert_eq!(decode_shift_jis(&[0x85, 0x80]), [0xfffd]);
    }

    #[test]
    fn maps_the_user_defined_area_up_to_lead_byte_0xf8() {
        assert_eq!(decode_shift_jis(&[0xf0, 0x40]), [0xe000]);
        assert_eq!(decode_shift_jis(&[0xf8, 0xfc]), [0xe69b]);
        assert_eq!(decode_shift_jis(&[0xf9, 0x40]), [0xfffd, 0x40]);
        assert_eq!(decode_shift_jis(&[0xf9, 0xfc]), [0xfffd]);
    }

    #[test]
    fn swallows_0x87_0x5e() {
        assert_eq!(decode_shift_jis(&[0x87, 0x5e, b'a']), [0xfffd, 0x61]);
        assert_eq!(decode_shift_jis(&[0x87, 0x40]), [0x2460]);
    }

    #[test]
    fn keeps_a_utf8_bom_as_bytes() {
        // EF BB is one double-byte character, BF the half-width ｿ.
        let decoded = decode_shift_jis(&[0xef, 0xbb, 0xbf]);
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[1], 0xff7f);
    }
}
