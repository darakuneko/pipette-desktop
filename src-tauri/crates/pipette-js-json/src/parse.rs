// SPDX-License-Identifier: GPL-2.0-or-later
//! `JSON.parse` without a reviver: the same grammar (RFC 8259, whitespace
//! limited to space, tab, LF and CR, no byte order mark), numbers rounded to
//! the nearest f64, `\u` escapes decoded to UTF-16 code units with lone
//! surrogates kept, and objects built with [`Object::insert`], so a
//! duplicate key keeps its first position and takes its last value.

use crate::value::{JsString, Object, Value};

/// How deep arrays and objects may nest. V8 has no fixed limit; this one
/// keeps the recursion of parsing, writing and dropping a value well inside
/// a thread's stack.
pub const MAX_DEPTH: usize = 1000;

/// Why a text is not JSON, and the byte offset where that shows.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{reason} at position {position}")]
pub struct ParseError {
    pub reason: &'static str,
    pub position: usize,
}

/// The reason of a text nested deeper than [`MAX_DEPTH`].
const NESTING_TOO_DEEP: &str = "Nesting too deep";

impl ParseError {
    /// Whether parsing stopped at nesting deeper than [`MAX_DEPTH`], which
    /// `JSON.parse` reads on.
    pub fn is_nesting_too_deep(&self) -> bool {
        self.reason == NESTING_TOO_DEEP
    }
}

/// Parses `text` as `JSON.parse(text)` does.
pub fn parse(text: &str) -> Result<Value, ParseError> {
    let mut parser = Parser { bytes: text.as_bytes(), pos: 0 };
    parser.skip_whitespace();
    let value = parser.value(0)?;
    parser.skip_whitespace();
    if parser.pos != parser.bytes.len() {
        return Err(parser.error("Unexpected non-whitespace character after JSON"));
    }
    Ok(value)
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Parser<'_> {
    fn error(&self, reason: &'static str) -> ParseError {
        ParseError { reason, position: self.pos }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn expect_literal(&mut self, literal: &[u8], value: Value) -> Result<Value, ParseError> {
        if self.bytes[self.pos..].starts_with(literal) {
            self.pos += literal.len();
            Ok(value)
        } else {
            Err(self.error("Unexpected token"))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Value, ParseError> {
        match self.peek() {
            None => Err(self.error("Unexpected end of JSON input")),
            Some(b'{') => self.object(depth + 1),
            Some(b'[') => self.array(depth + 1),
            Some(b'"') => self.string().map(Value::String),
            Some(b't') => self.expect_literal(b"true", Value::Bool(true)),
            Some(b'f') => self.expect_literal(b"false", Value::Bool(false)),
            Some(b'n') => self.expect_literal(b"null", Value::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => Err(self.error("Unexpected token")),
        }
    }

    fn check_depth(&self, depth: usize) -> Result<(), ParseError> {
        if depth > MAX_DEPTH { Err(self.error(NESTING_TOO_DEEP)) } else { Ok(()) }
    }

    fn array(&mut self, depth: usize) -> Result<Value, ParseError> {
        self.check_depth(depth)?;
        self.pos += 1;
        let mut items = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Value::Array(items));
        }
        loop {
            self.skip_whitespace();
            items.push(self.value(depth)?);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    return Ok(Value::Array(items));
                }
                None => return Err(self.error("Unexpected end of JSON input")),
                Some(_) => return Err(self.error("Expected ',' or ']' after array element")),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value, ParseError> {
        self.check_depth(depth)?;
        self.pos += 1;
        let mut object = Object::new();
        self.skip_whitespace();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Value::Object(object));
        }
        loop {
            self.skip_whitespace();
            match self.peek() {
                Some(b'"') => {}
                None => return Err(self.error("Unexpected end of JSON input")),
                Some(_) => return Err(self.error("Expected double-quoted property name")),
            }
            let key = self.string()?;
            self.skip_whitespace();
            if self.peek() != Some(b':') {
                return Err(self.error("Expected ':' after property name"));
            }
            self.pos += 1;
            self.skip_whitespace();
            let value = self.value(depth)?;
            object.insert(key, value);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(Value::Object(object));
                }
                None => return Err(self.error("Unexpected end of JSON input")),
                Some(_) => return Err(self.error("Expected ',' or '}' after property value")),
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.pos;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
        self.pos - start
    }

    fn number(&mut self) -> Result<Value, ParseError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(self.error("No number after minus sign")),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if self.digits() == 0 {
                return Err(self.error("Unterminated fractional number"));
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if self.digits() == 0 {
                return Err(self.error("Exponent part is missing a number"));
            }
        }
        // The grammar above is a subset of what `f64::from_str` accepts, and
        // it rounds to nearest as JavaScript does.
        let text =
            std::str::from_utf8(&self.bytes[start..self.pos]).map_err(|_| self.error("Invalid number"))?;
        text.parse::<f64>().map(Value::Number).map_err(|_| self.error("Invalid number"))
    }

    fn hex4(&mut self) -> Result<u16, ParseError> {
        let digits =
            self.bytes.get(self.pos..self.pos + 4).ok_or_else(|| self.error("Bad Unicode escape"))?;
        let mut unit = 0u16;
        for &digit in digits {
            let nibble = (digit as char).to_digit(16).ok_or_else(|| self.error("Bad Unicode escape"))?;
            unit = unit << 4 | nibble as u16;
        }
        self.pos += 4;
        Ok(unit)
    }

    /// The low surrogate of a `\uXXXX` escape right here, consumed if there
    /// is one.
    fn trailing_low_surrogate(&mut self) -> Option<u16> {
        if self.bytes.get(self.pos..self.pos + 2) != Some(b"\\u") {
            return None;
        }
        let saved = self.pos;
        self.pos += 2;
        match self.hex4() {
            Ok(unit) if (0xdc00..0xe000).contains(&unit) => Some(unit),
            _ => {
                self.pos = saved;
                None
            }
        }
    }

    fn string(&mut self) -> Result<JsString, ParseError> {
        self.pos += 1;
        let mut out = StringBuilder::default();
        loop {
            let run_start = self.pos;
            while let Some(byte) = self.peek() {
                if byte == b'"' || byte == b'\\' || byte < 0x20 {
                    break;
                }
                self.pos += 1;
            }
            // The run ends at an ASCII byte, so it is whole UTF-8.
            let run = std::str::from_utf8(&self.bytes[run_start..self.pos])
                .map_err(|_| self.error("Invalid UTF-8"))?;
            out.push_str(run);
            match self.peek() {
                None => return Err(self.error("Unterminated string in JSON")),
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(out.finish());
                }
                Some(b'\\') => {
                    self.pos += 1;
                    self.escape(&mut out)?;
                }
                Some(_) => return Err(self.error("Bad control character in string literal")),
            }
        }
    }

    fn escape(&mut self, out: &mut StringBuilder) -> Result<(), ParseError> {
        let Some(byte) = self.peek() else {
            return Err(self.error("Unterminated string in JSON"));
        };
        self.pos += 1;
        let c = match byte {
            b'"' => '"',
            b'\\' => '\\',
            b'/' => '/',
            b'b' => '\u{8}',
            b'f' => '\u{c}',
            b'n' => '\n',
            b'r' => '\r',
            b't' => '\t',
            b'u' => {
                let unit = self.hex4()?;
                if (0xd800..0xdc00).contains(&unit)
                    && let Some(low) = self.trailing_low_surrogate()
                {
                    let code = 0x10000 + ((u32::from(unit) - 0xd800) << 10) + (u32::from(low) - 0xdc00);
                    out.push_char(char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER));
                } else if (0xd800..0xe000).contains(&unit) {
                    out.push_lone_surrogate(unit);
                } else {
                    out.push_char(char::from_u32(u32::from(unit)).unwrap_or(char::REPLACEMENT_CHARACTER));
                }
                return Ok(());
            }
            _ => return Err(self.error("Bad escaped character")),
        };
        out.push_char(c);
        Ok(())
    }
}

/// Text until the first lone surrogate, UTF-16 code units from then on.
#[derive(Default)]
struct StringBuilder {
    text: String,
    units: Option<Vec<u16>>,
}

impl StringBuilder {
    fn push_str(&mut self, s: &str) {
        match &mut self.units {
            Some(units) => units.extend(s.encode_utf16()),
            None => self.text.push_str(s),
        }
    }

    fn push_char(&mut self, c: char) {
        match &mut self.units {
            Some(units) => units.extend(c.encode_utf16(&mut [0; 2]).iter()),
            None => self.text.push(c),
        }
    }

    fn push_lone_surrogate(&mut self, unit: u16) {
        let units = self.units.get_or_insert_with(|| self.text.encode_utf16().collect());
        units.push(unit);
    }

    fn finish(self) -> JsString {
        match self.units {
            Some(units) => JsString::from_utf16(units),
            None => self.text.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_what_json_parse_rejects() {
        for text in [
            "",
            " ",
            "\u{feff}{}",
            "01",
            "1.",
            ".5",
            "+1",
            "-",
            "1e",
            "[1,]",
            "{\"a\":1,}",
            "'a'",
            "NaN",
            "\"\\x\"",
            "\"a\nb\"",
            "{a:1}",
            "[1] x",
            "\u{a0}1",
            "\"\\u12\"",
        ] {
            assert!(parse(text).is_err(), "{text:?}");
        }
    }

    #[test]
    fn keeps_a_lone_surrogate_and_joins_an_escaped_pair() {
        let Value::String(lone) = parse(r#""a\ud800b""#).unwrap() else { panic!() };
        assert_eq!(lone.utf16_units(), [0x61, 0xd800, 0x62]);
        assert_eq!(parse(r#""\ud83d\ude00""#).unwrap(), Value::from("😀"));
        let Value::String(low_first) = parse(r#""\ude00\ud83d""#).unwrap() else { panic!() };
        assert_eq!(low_first.utf16_units(), [0xde00, 0xd83d]);
    }

    #[test]
    fn limits_the_nesting_depth() {
        let ok = format!("{}{}", "[".repeat(MAX_DEPTH), "]".repeat(MAX_DEPTH));
        assert!(parse(&ok).is_ok());
        let deep = format!("{}{}", "[".repeat(MAX_DEPTH + 1), "]".repeat(MAX_DEPTH + 1));
        assert_eq!(parse(&deep).unwrap_err().reason, "Nesting too deep");
        assert!(parse(&deep).unwrap_err().is_nesting_too_deep());
        assert!(!parse("[").unwrap_err().is_nesting_too_deep());
    }
}
