// SPDX-License-Identifier: GPL-2.0-or-later
//! Bytes to text as the Electron main process reads them.

use std::borrow::Cow;

const BOM: &[u8] = b"\xEF\xBB\xBF";

/// `new TextDecoder('utf-8').decode(bytes)`, also what `Response.json()`
/// reads: a leading byte order mark is dropped, and each invalid sequence
/// becomes U+FFFD (the same maximal-subpart rule as `from_utf8_lossy`).
pub fn decode_utf8(bytes: &[u8]) -> Cow<'_, str> {
    String::from_utf8_lossy(bytes.strip_prefix(BOM).unwrap_or(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_one_leading_bom_and_replaces_invalid_sequences() {
        assert_eq!(decode_utf8(b"\xEF\xBB\xBF\xEF\xBB\xBFa"), "\u{feff}a");
        assert_eq!(decode_utf8(b"a\xFFb\xE6\x97"), "a\u{fffd}b\u{fffd}");
    }
}
