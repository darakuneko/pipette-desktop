// SPDX-License-Identifier: GPL-2.0-or-later
//! The JavaScript string operations the pack stores compare names with,
//! on UTF-16 code units so a lone surrogate stays as it is.

use pipette_entry_store::trim_js_whitespace;
use pipette_js_json::{JsString, Value};

/// `s.trim()`.
pub fn trim(s: &JsString) -> JsString {
    JsString::from_utf16(trim_js_whitespace(&s.utf16_units()).to_vec())
}

/// `s.length`: the UTF-16 length.
pub fn utf16_len(s: &JsString) -> usize {
    s.as_str().map_or_else(|| s.utf16_units().len(), |text| text.encode_utf16().count())
}

/// `s.toLowerCase()`: the full Unicode lowercase mapping (Final_Sigma
/// included) of each run of well-formed text; a lone surrogate stays.
pub fn to_lower_case(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut Vec<u16>| {
        out.extend(run.to_lowercase().encode_utf16());
        run.clear();
    };
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(c) => run.push(c),
            Err(lone) => {
                flush(&mut run, &mut out);
                out.push(lone.unpaired_surrogate());
            }
        }
    }
    flush(&mut run, &mut out);
    out
}

/// `expr.trim().toLowerCase()` of a value that should be a string, or the
/// TypeError message `String(err)` gives when it is not: `expr` is the
/// expression V8 names in it.
pub fn folded_name(value: Option<&Value>, expr: &str) -> Result<Vec<u16>, String> {
    match value {
        Some(Value::String(s)) => Ok(to_lower_case(trim_js_whitespace(&s.utf16_units()))),
        None => Err("TypeError: Cannot read properties of undefined (reading 'trim')".to_owned()),
        Some(Value::Null) => Err("TypeError: Cannot read properties of null (reading 'trim')".to_owned()),
        Some(_) => Err(format!("TypeError: {expr}.trim is not a function")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lower(s: &str) -> String {
        String::from_utf16(&to_lower_case(&s.encode_utf16().collect::<Vec<_>>())).unwrap()
    }

    #[test]
    fn lowercases_as_javascript_does() {
        assert_eq!(lower("ENGLISH"), "english");
        assert_eq!(lower("ΣΑΣ"), "σας");
        assert_eq!(lower("İ"), "i\u{307}");
    }

    #[test]
    fn keeps_a_lone_surrogate() {
        let units = [0x41, 0xD800, 0x42];
        assert_eq!(to_lower_case(&units), [0x61, 0xD800, 0x62]);
    }

    #[test]
    fn trims_and_measures_in_utf16() {
        assert_eq!(trim(&JsString::from("\u{feff} a \u{3000}")), JsString::from("a"));
        assert_eq!(utf16_len(&JsString::from("😀a")), 3);
        assert_eq!(utf16_len(&JsString::from_utf16(vec![0xD800, 0x61])), 2);
    }

    #[test]
    fn a_name_that_is_not_a_string_is_a_type_error() {
        assert_eq!(folded_name(Some(&" Ab ".into()), "name"), Ok("ab".encode_utf16().collect()));
        assert_eq!(
            folded_name(Some(&5.0.into()), "m.name"),
            Err("TypeError: m.name.trim is not a function".into())
        );
        assert_eq!(
            folded_name(None, "m.name"),
            Err("TypeError: Cannot read properties of undefined (reading 'trim')".into())
        );
    }
}
