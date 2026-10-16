// SPDX-License-Identifier: GPL-2.0-or-later
//! The cleanup every application name goes through before it is stored, on
//! JavaScript strings (UTF-16 code units, lone surrogates included).

use pipette_js_json::JsString;

/// The longest stored name, in UTF-16 code units. Real names are a few dozen
/// characters; the cap keeps junk from a misbehaving lookup out of the cache.
pub const MAX_NAME_LENGTH: usize = 256;

/// The stored form of a name, or `None` when nothing is left: the C0 control
/// characters (U+0000 to U+001F) and U+007F removed, then JavaScript's
/// `trim`, then cut to [`MAX_NAME_LENGTH`] code units. The cut can split a
/// surrogate pair, leaving a lone surrogate at the end, as `String.slice`
/// does.
pub fn normalize(units: &[u16]) -> Option<JsString> {
    let kept: Vec<u16> = units.iter().copied().filter(|&unit| !is_control(unit)).collect();
    let trimmed = js_trim(&kept);
    if trimmed.is_empty() {
        return None;
    }
    Some(JsString::from_utf16(trimmed[..trimmed.len().min(MAX_NAME_LENGTH)].to_vec()))
}

fn is_control(unit: u16) -> bool {
    unit <= 0x1f || unit == 0x7f
}

/// `String.prototype.trim`: `units` without the ECMAScript WhiteSpace and
/// LineTerminator code points (all in the BMP) at either end. Unlike
/// `char::is_whitespace` these include U+FEFF and leave out U+0085.
pub(crate) fn js_trim(units: &[u16]) -> &[u16] {
    let start = units.iter().position(|&unit| !is_js_whitespace(unit)).unwrap_or(units.len());
    let end = units.iter().rposition(|&unit| !is_js_whitespace(unit)).map_or(start, |last| last + 1);
    &units[start..end]
}

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
    fn strips_controls_then_trims_then_cuts() {
        assert_eq!(normalize(&units(" Bad\u{1}Name\u{7f} ")), Some("BadName".into()));
        assert_eq!(normalize(&units("\u{feff}x\u{85}")), Some("x\u{85}".into()));
        assert_eq!(normalize(&units("\u{1}  \u{1}")), None);
        assert_eq!(normalize(&[]), None);
        let long = "A".repeat(255) + "\u{1F600}";
        let cut = normalize(&units(&long)).map(|s| s.utf16_units());
        assert_eq!(cut.as_deref().map(<[u16]>::len), Some(MAX_NAME_LENGTH));
        assert_eq!(cut.and_then(|u| u.last().copied()), Some(0xd83d));
    }
}
