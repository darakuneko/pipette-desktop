// SPDX-License-Identifier: GPL-2.0-or-later
//! JavaScript's meaning of the string and number operations the Hub code
//! applies to its inputs.

use pipette_entry_store::trim_js_whitespace;
use pipette_js_json::write_number;

/// `text.trim()`.
pub fn js_trim(text: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    // The whitespace is all in the BMP, so the cut falls between characters.
    String::from_utf16_lossy(trim_js_whitespace(&units))
}

/// `text.length`: UTF-16 code units.
pub fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `String(n)`.
pub fn js_number_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_owned();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    let mut out = String::new();
    write_number(&mut out, n);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_javascript() {
        assert_eq!(js_trim("\u{3000} a b \u{feff}\n"), "a b");
        assert_eq!(js_trim("\u{200b}x"), "\u{200b}x");
        assert_eq!(js_length("😀é"), 3);
        for (n, text) in [
            (1.0, "1"),
            (1.5, "1.5"),
            (-0.0, "0"),
            (1e21, "1e+21"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
        ] {
            assert_eq!(js_number_string(n), text);
        }
    }
}
