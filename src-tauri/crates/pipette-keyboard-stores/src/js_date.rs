// SPDX-License-Identifier: GPL-2.0-or-later
//! `new Date(value).getTime()` for a JSON value read from a file, where the
//! stores read a timestamp that may hold anything.

use pipette_js_json::Value;
use pipette_time::{MAX_TIME_MS, parse_date_time_string};

/// The time `new Date(value)` holds, in milliseconds since the epoch, or
/// `None` where `getTime()` is NaN. A string is read as `Date.parse` reads
/// it (with the differences of [`parse_date_time_string`]), an array as the
/// text `String(array)` gives, a number and a boolean as numbers.
pub(crate) fn date_value_ms(value: &Value) -> Option<f64> {
    match value {
        Value::Null => time_clip(0.0),
        Value::Bool(b) => time_clip(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => time_clip(*n),
        Value::String(s) => parse(s.as_str()?),
        Value::Array(_) => parse(&to_js_string(value)?),
        Value::Object(_) => None,
    }
}

fn parse(text: &str) -> Option<f64> {
    // Every result is within ±8.64e15, exact as an f64.
    #[allow(clippy::cast_precision_loss)]
    parse_date_time_string(text).map(|ms| ms as f64)
}

/// ECMAScript TimeClip.
fn time_clip(n: f64) -> Option<f64> {
    #[allow(clippy::cast_precision_loss)]
    let max = MAX_TIME_MS as f64;
    (n.is_finite() && n.abs() <= max).then(|| n.trunc() + 0.0)
}

/// `String(value)`; `None` for text with a lone surrogate, which no date
/// string has.
fn to_js_string(value: &Value) -> Option<String> {
    Some(match value {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            let mut out = String::new();
            pipette_js_json::write_number(&mut out, *n);
            out
        }
        Value::String(s) => s.as_str()?.to_owned(),
        // Array.prototype.join: null elements are empty.
        Value::Array(items) => items.iter().map(to_js_string).collect::<Option<Vec<_>>>()?.join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pipette_js_json::parse as parse_json;

    fn ms(json: &str) -> Option<f64> {
        date_value_ms(&parse_json(json).unwrap())
    }

    #[test]
    fn reads_values_as_the_date_constructor_does() {
        assert_eq!(ms(r#""2026-01-01T00:00:00.000Z""#), Some(1_767_225_600_000.0));
        assert_eq!(ms(r#""not a date""#), None);
        assert_eq!(ms("1767225600000.9"), Some(1_767_225_600_000.0));
        assert_eq!(ms("-0.5"), Some(0.0));
        assert_eq!(ms("8640000000000001"), None);
        assert_eq!(ms("1e400"), None);
        assert_eq!(ms("true"), Some(1.0));
        assert_eq!(ms("false"), Some(0.0));
        assert_eq!(ms("null"), Some(0.0));
        assert_eq!(ms(r#"["2026-01-01"]"#), Some(1_767_225_600_000.0));
        assert_eq!(ms("[2026]"), Some(1_767_225_600_000.0));
        assert_eq!(ms("{}"), None);
        assert_eq!(ms(r#""\ud800""#), None);
    }
}
