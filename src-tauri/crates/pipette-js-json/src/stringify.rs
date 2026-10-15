// SPDX-License-Identifier: GPL-2.0-or-later
//! `JSON.stringify(value, undefined, gap)`: the property order of
//! [`Object`], numbers as ECMAScript's Number::toString (`-0` as `0`, a
//! non-finite number as `null`), and the escapes of a well-formed
//! `JSON.stringify` (`\b \t \n \f \r`, `\"`, `\\`, other control characters
//! and lone surrogates as lowercase `\uxxxx`, everything else as is).

use std::fmt::Write;

use crate::value::{JsString, Object, Value};

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    stringify_with_gap(value, "")
}

/// `JSON.stringify(value, undefined, gap)` for a string `gap`, which is cut
/// to its first 10 characters as there. An empty gap writes everything on
/// one line.
pub fn stringify_with_gap(value: &Value, gap: &str) -> String {
    let gap: String = gap.chars().take(10).collect();
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
    if n.is_finite() {
        out.push_str(ryu_js::Buffer::new().format_finite(n));
    } else {
        out.push_str("null");
    }
}

fn write_string(out: &mut String, s: &JsString) {
    out.push('"');
    for c in s.chars() {
        match c {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\t') => out.push_str("\\t"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok('\r') => out.push_str("\\r"),
            Ok(c) if c < '\u{20}' => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            Ok(c) => out.push(c),
            Err(unit) => {
                let _ = write!(out, "\\u{unit:04x}");
            }
        }
    }
    out.push('"');
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
    fn cuts_the_gap_to_ten_characters() {
        let value = parse("[1]").unwrap();
        assert_eq!(stringify_with_gap(&value, &" ".repeat(12)), format!("[\n{}1\n]", " ".repeat(10)));
    }
}
