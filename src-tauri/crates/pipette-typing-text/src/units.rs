// SPDX-License-Identifier: GPL-2.0-or-later
//! Helpers for JavaScript strings held as UTF-16 code units.

pub(crate) const LF: u16 = 0x0a;
pub(crate) const CR: u16 = 0x0d;
pub(crate) const SPACE: u16 = 0x20;
pub(crate) const REPLACEMENT_CHARACTER: u16 = 0xfffd;

/// The UTF-16 code units of `text`, which must be BMP only (checked when
/// the constant is evaluated), for the marker constants of this crate.
pub(crate) const fn bmp<const N: usize>(text: &str) -> [u16; N] {
    let bytes = text.as_bytes();
    let mut out = [0u16; N];
    let mut i = 0;
    let mut n = 0;
    while i < bytes.len() {
        let lead = bytes[i];
        assert!(lead < 0xf0, "not a BMP character");
        let (unit, len) = if lead < 0x80 {
            (lead as u16, 1)
        } else if lead < 0xe0 {
            ((((lead & 0x1f) as u16) << 6) | (bytes[i + 1] & 0x3f) as u16, 2)
        } else {
            (
                (((lead & 0x0f) as u16) << 12)
                    | (((bytes[i + 1] & 0x3f) as u16) << 6)
                    | (bytes[i + 2] & 0x3f) as u16,
                3,
            )
        };
        out[n] = unit;
        n += 1;
        i += len;
    }
    assert!(n == N, "wrong length");
    out
}

/// The first index at or after `from` where `needle` starts.
pub(crate) fn find(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    haystack.get(from..)?.windows(needle.len()).position(|window| window == needle).map(|at| at + from)
}

/// The first index at or after `from` whose unit is `unit`.
pub(crate) fn find_unit(haystack: &[u16], unit: u16, from: usize) -> Option<usize> {
    haystack.get(from..)?.iter().position(|&u| u == unit).map(|at| at + from)
}

/// `parts.join('\n')`.
pub(crate) fn join_lines(parts: &[&[u16]]) -> Vec<u16> {
    parts.join(&LF)
}

/// `text.replace(/\r\n?/g, '\n')`.
pub(crate) fn normalize_newlines(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut units = text.iter().copied().peekable();
    while let Some(unit) = units.next() {
        if unit == CR {
            units.next_if_eq(&LF);
            out.push(LF);
        } else {
            out.push(unit);
        }
    }
    out
}

/// Appends `cp` as `String.fromCodePoint` writes it: a surrogate code point
/// stays a lone surrogate. `cp` must be at most 0x10FFFF.
pub(crate) fn push_code_point(out: &mut Vec<u16>, cp: u32) {
    match u16::try_from(cp) {
        Ok(unit) => out.push(unit),
        Err(_) => {
            let offset = cp - 0x1_0000;
            // Both halves fit in 10 bits, so the casts are exact.
            out.push(0xd800 | (offset >> 10) as u16);
            out.push(0xdc00 | (offset & 0x3ff) as u16);
        }
    }
}

#[cfg(test)]
pub(crate) fn utf16(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bmp_encodes_ascii_and_multibyte_characters() {
        const MARK: [u16; 4] = bmp("a※é＃");
        assert_eq!(MARK.to_vec(), utf16("a※é＃"));
    }

    #[test]
    fn normalize_newlines_turns_crlf_and_cr_into_lf() {
        assert_eq!(normalize_newlines(&utf16("a\r\nb\rc\r\r\nd\n")), utf16("a\nb\nc\n\nd\n"));
    }

    #[test]
    fn push_code_point_writes_pairs_and_lone_surrogates() {
        let mut out = Vec::new();
        push_code_point(&mut out, 0x1f600);
        push_code_point(&mut out, 0xd800);
        push_code_point(&mut out, 0x9ad9);
        assert_eq!(out, vec![0xd83d, 0xde00, 0xd800, 0x9ad9]);
    }

    #[test]
    fn find_starts_at_the_given_index() {
        let text = utf16("abcabc");
        assert_eq!(find(&text, &utf16("bc"), 0), Some(1));
        assert_eq!(find(&text, &utf16("bc"), 2), Some(4));
        assert_eq!(find(&text, &utf16("bc"), 5), None);
        assert_eq!(find(&text, &utf16("bc"), 9), None);
        assert_eq!(find_unit(&text, u16::from(b'c'), 3), Some(5));
    }
}
