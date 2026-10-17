// SPDX-License-Identifier: GPL-2.0-or-later
//! `Buffer.from(text, 'base64')` of Node: a forgiving decode that never
//! fails. Characters outside both base64 alphabets (`+/` and `-_`) are
//! skipped, decoding stops at the first `=`, a trailing lone character is
//! dropped, and the output is capped at the size Node allocates from the
//! string's length. Node reads each UTF-16 code unit by its low byte only,
//! so a character such as `Ł` (U+0141) counts as `A` and the high half of
//! a surrogate pair (U+D83D) as `=`.

/// The 6-bit value of `byte` in either alphabet.
fn sextet(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// `base64_decoded_size` of Node: the buffer Node allocates. Its check for
/// trailing `=` compares whole code units.
fn decoded_size(units: &[u16]) -> usize {
    let equals = u16::from(b'=');
    let mut size = units.len();
    if size < 2 {
        return 0;
    }
    if units[size - 1] == equals {
        size -= 1;
        if units[size - 1] == equals {
            size -= 1;
        }
    }
    if size < 2 {
        return 0;
    }
    let remainder = size % 4;
    let mut decoded = size / 4 * 3;
    if remainder != 0 {
        if decoded == 0 && remainder == 1 {
            decoded = 0;
        } else {
            decoded += 1 + usize::from(remainder == 3);
        }
    }
    decoded
}

/// Decodes `text` as `Buffer.from(text, 'base64')` does.
pub fn node_base64_decode(text: &str) -> Vec<u8> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let capacity = decoded_size(&units);
    let mut out = Vec::with_capacity(capacity);
    // Each group of four valid characters gives three bytes; a character
    // after the first of its group completes one byte.
    let mut previous = 0u8;
    let mut position = 0usize;
    for unit in units.iter().map(|unit| unit.to_le_bytes()[0]) {
        let Some(value) = sextet(unit) else {
            if unit == b'=' {
                break;
            }
            continue;
        };
        let byte = match position {
            0 => None,
            1 => Some((previous << 2) | (value >> 4)),
            2 => Some(((previous & 0x0F) << 4) | (value >> 2)),
            _ => Some(((previous & 0x03) << 6) | value),
        };
        if let Some(byte) = byte {
            if out.len() >= capacity {
                break;
            }
            out.push(byte);
        }
        previous = value;
        position = (position + 1) % 4;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_as_node_does() {
        let hex = |bytes: Vec<u8>| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        for (text, expected) in [
            ("", ""),
            ("Q", ""),
            ("QQ", "41"),
            ("QQ==", "41"),
            ("QUJD", "414243"),
            ("QU JD\nRA==", "41424344"),
            ("Q!U@J#D", "414243"),
            ("QQ==QUJD", "41"),
            ("-_-_", "fbffbf"),
            ("QUJ\u{0141}", "414240"),
            ("😀QUJD", ""),
            // U+013D reads as `=` while decoding but not in the size.
            ("QUJDRA\u{013D}", "41424344"),
        ] {
            assert_eq!(hex(node_base64_decode(text)), expected, "{text:?}");
        }
    }
}
