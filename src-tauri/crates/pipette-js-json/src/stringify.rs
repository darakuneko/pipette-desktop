// SPDX-License-Identifier: GPL-2.0-or-later
//! `JSON.stringify(value, undefined, gap)`: the property order of
//! [`Object`], numbers as ECMAScript's Number::toString (`-0` as `0`, a
//! non-finite number as `null`), and the escapes of a well-formed
//! `JSON.stringify` (`\b \t \n \f \r`, `\"`, `\\`, other control characters
//! and lone surrogates as lowercase `\uxxxx`, everything else as is).

use std::fmt::Write;

use crate::value::{JsString, Object, Value};

/// The longest gap `JSON.stringify` uses, in UTF-16 code units.
const MAX_GAP_UNITS: usize = 10;

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    stringify_with_gap(value, "")
}

/// `JSON.stringify(value, undefined, gap)` for a string `gap`, which is cut
/// to its first 10 UTF-16 code units as there. A surrogate pair the cut
/// would split is left out whole: a Rust string cannot hold the lone half
/// JavaScript keeps. An empty gap writes everything on one line.
pub fn stringify_with_gap(value: &Value, gap: &str) -> String {
    let mut units = 0;
    let gap: String = gap
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= MAX_GAP_UNITS
        })
        .collect();
    let mut writer = Writer { out: String::new(), gap: &gap, indent: String::new() };
    writer.value(value);
    writer.out
}

struct Writer<'a> {
    out: String,
    gap: &'a str,
    indent: String,
}

impl Writer<'_> {
    fn value(&mut self, value: &Value) {
        match value {
            Value::Null => self.out.push_str("null"),
            Value::Bool(true) => self.out.push_str("true"),
            Value::Bool(false) => self.out.push_str("false"),
            Value::Number(n) => write_number(&mut self.out, *n),
            Value::String(s) => write_string(&mut self.out, s),
            Value::Array(items) => self.array(items),
            Value::Object(object) => self.object(object),
        }
    }

    /// Writes the items between `open` and `close`, each on its own line
    /// when there is a gap.
    fn list<T>(
        &mut self,
        open: char,
        close: char,
        items: impl ExactSizeIterator<Item = T>,
        mut item: impl FnMut(&mut Self, T),
    ) {
        self.out.push(open);
        if items.len() == 0 {
            self.out.push(close);
            return;
        }
        let outer = self.indent.clone();
        self.indent.push_str(self.gap);
        for (i, element) in items.enumerate() {
            if i > 0 {
                self.out.push(',');
            }
            if !self.gap.is_empty() {
                self.out.push('\n');
                self.out.push_str(&self.indent);
            }
            item(self, element);
        }
        if !self.gap.is_empty() {
            self.out.push('\n');
            self.out.push_str(&outer);
        }
        self.indent = outer;
        self.out.push(close);
    }

    fn array(&mut self, items: &[Value]) {
        self.list('[', ']', items.iter(), |writer, value| writer.value(value));
    }

    fn object(&mut self, object: &Object) {
        let entries: Vec<_> = object.iter().collect();
        self.list('{', '}', entries.into_iter(), |writer, (key, value)| {
            write_string(&mut writer.out, key);
            writer.out.push(':');
            if !writer.gap.is_empty() {
                writer.out.push(' ');
            }
            writer.value(value);
        });
    }
}

/// ECMAScript's Number::toString for a finite number, `null` otherwise.
pub fn write_number(out: &mut String, n: f64) {
    if n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER {
        write_integer(out, n);
    } else if n.is_finite() {
        out.push_str(ryu_js::Buffer::new().format_finite(n));
    } else {
        out.push_str("null");
    }
}

/// `Number.MAX_SAFE_INTEGER`: every integer up to it converts to `i64`
/// exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Number::toString of an integer up to [`MAX_SAFE_INTEGER`]: its decimal
/// digits, `-0` as `0`. Most numbers the stores and the analytics write are
/// such integers (times, counts), and this is faster than the general
/// formatting.
fn write_integer(out: &mut String, n: f64) {
    // The bound above makes the cast exact; `-0.0` casts to 0.
    #[allow(clippy::cast_possible_truncation)]
    let int = n as i64;
    if int < 0 {
        out.push('-');
    }
    let mut magnitude = int.unsigned_abs();
    let mut digits = [0u8; 20];
    let mut start = digits.len();
    loop {
        start -= 1;
        // A remainder below 10 fits in a u8.
        #[allow(clippy::cast_possible_truncation)]
        let digit = (magnitude % 10) as u8;
        digits[start] = b'0' + digit;
        magnitude /= 10;
        if magnitude == 0 {
            break;
        }
    }
    for &digit in &digits[start..] {
        out.push(char::from(digit));
    }
}

fn write_string(out: &mut String, s: &JsString) {
    if let Some(text) = s.as_str() {
        write_str(out, text);
        return;
    }
    out.push('"');
    for c in s.chars() {
        match c {
            Ok(c) => push_char(out, c),
            Err(unit) => {
                let _ = write!(out, "\\u{unit:04x}");
            }
        }
    }
    out.push('"');
}

/// `JSON.stringify(s)` of a string without lone surrogates, which a Rust
/// string cannot hold: the runs that need no escape are copied whole.
pub fn write_str(out: &mut String, s: &str) {
    out.push('"');
    let mut start = 0;
    for (i, byte) in s.bytes().enumerate() {
        // Every byte that needs an escape is ASCII, so `i` is a character
        // boundary.
        if byte < 0x20 || byte == b'"' || byte == b'\\' {
            out.push_str(&s[start..i]);
            push_char(out, char::from(byte));
            start = i + 1;
        }
    }
    out.push_str(&s[start..]);
    out.push('"');
}

fn push_char(out: &mut String, c: char) {
    match c {
        '"' => out.push_str("\\\""),
        '\\' => out.push_str("\\\\"),
        '\u{8}' => out.push_str("\\b"),
        '\t' => out.push_str("\\t"),
        '\n' => out.push_str("\\n"),
        '\u{c}' => out.push_str("\\f"),
        '\r' => out.push_str("\\r"),
        c if c < '\u{20}' => {
            let _ = write!(out, "\\u{:04x}", u32::from(c));
        }
        c => out.push(c),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    #[test]
    fn formats_numbers_as_javascript() {
        let cases = [
            (-0.0, "0"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (0.1 + 0.2, "0.30000000000000004"),
            (100.0, "100"),
            (f64::INFINITY, "null"),
            (f64::NAN, "null"),
        ];
        for (n, text) in cases {
            let mut out = String::new();
            write_number(&mut out, n);
            assert_eq!(out, text);
        }
    }

    #[test]
    fn formats_integers_as_the_general_formatting_does() {
        let mut cases =
            vec![0.0, -0.0, 1.0, -1.0, 9.0, 10.0, 1_789_257_600_000.0, MAX_SAFE_INTEGER, -MAX_SAFE_INTEGER];
        cases.extend((0..64).map(|shift| 2f64.powi(shift)));
        cases.extend((1..16).map(|exp| 10f64.powi(exp) - 1.0));
        for n in cases {
            let mut out = String::new();
            write_number(&mut out, n);
            assert_eq!(out, ryu_js::Buffer::new().format_finite(n), "{n}");
        }
    }

    #[test]
    fn indents_nested_values_and_keeps_empty_ones_inline() {
        let value = parse(r#"{"a":[1,{"b":{}}],"c":[]}"#).unwrap();
        assert_eq!(
            stringify_with_gap(&value, "\t"),
            "{\n\t\"a\": [\n\t\t1,\n\t\t{\n\t\t\t\"b\": {}\n\t\t}\n\t],\n\t\"c\": []\n}"
        );
        assert_eq!(stringify(&value), r#"{"a":[1,{"b":{}}],"c":[]}"#);
    }

    #[test]
    fn escapes_lone_surrogates_and_control_characters() {
        let value = parse(r#""\ud800\u0001\u001f\u007f ""#).unwrap();
        assert_eq!(stringify(&value), "\"\\ud800\\u0001\\u001f\u{7f}\u{2028}\"");
    }

    #[test]
    fn writes_a_str_as_its_string_value() {
        let text: String = (0u8..0x80).map(char::from).chain("é😀\u{2028}".chars()).collect();
        for s in [text.as_str(), "", "plain", "\"\\", "a\nb"] {
            let mut out = String::new();
            write_str(&mut out, s);
            // serde_json escapes as JSON.stringify does: the short escapes,
            // other control characters as lowercase `\u00xx`, nothing else.
            assert_eq!(out, serde_json::to_string(s).unwrap(), "{s:?}");
        }
    }

    #[test]
    fn cuts_the_gap_to_ten_characters() {
        let value = parse("[1]").unwrap();
        assert_eq!(stringify_with_gap(&value, &" ".repeat(12)), format!("[\n{}1\n]", " ".repeat(10)));
    }

    #[test]
    fn cuts_the_gap_to_ten_utf16_code_units() {
        let value = parse("[1]").unwrap();
        let gap = "😀".repeat(5);
        assert_eq!(stringify_with_gap(&value, &"😀".repeat(6)), format!("[\n{gap}1\n]"));
        let gap = format!("a{}", "😀".repeat(4));
        assert_eq!(stringify_with_gap(&value, &format!("a{}", "😀".repeat(5))), format!("[\n{gap}1\n]"));
    }
}
