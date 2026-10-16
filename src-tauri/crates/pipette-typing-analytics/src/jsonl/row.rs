// SPDX-License-Identifier: GPL-2.0-or-later
//! One line of a per-day JSONL master (jsonl-row.ts): the composite row ids,
//! the line `serializeRow` writes, and the validation of `parseRow`.
//!
//! A row is held as the object `JSON.parse` made of the line, so a row read
//! from a file is written back (a delete mark, an import) with its keys in
//! their order, its number forms, its lone surrogates and the fields this
//! build does not know, as the TypeScript code writes the object it read.

use std::fmt::Write;

use pipette_js_json::{JsString, Object, Value};

/// `BIGRAM_HIST_BUCKETS`: the buckets of an n-gram's IKI histogram (`h`)
/// and of a matrix cell's keypress-duration histogram (`dh`).
pub const HIST_BUCKETS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowKind {
    Scope,
    CharMinute,
    MatrixMinute,
    MinuteStats,
    Session,
    BigramMinute,
    TrigramMinute,
}

impl RowKind {
    /// The kind of the `kind` tag of a line.
    pub fn from_tag(tag: &str) -> Option<Self> {
        Some(match tag {
            "scope" => Self::Scope,
            "char-minute" => Self::CharMinute,
            "matrix-minute" => Self::MatrixMinute,
            "minute-stats" => Self::MinuteStats,
            "session" => Self::Session,
            "bigram-minute" => Self::BigramMinute,
            "trigram-minute" => Self::TrigramMinute,
            _ => return None,
        })
    }

    pub fn tag(self) -> &'static str {
        match self {
            Self::Scope => "scope",
            Self::CharMinute => "char-minute",
            Self::MatrixMinute => "matrix-minute",
            Self::MinuteStats => "minute-stats",
            Self::Session => "session",
            Self::BigramMinute => "bigram-minute",
            Self::TrigramMinute => "trigram-minute",
        }
    }
}

/// A row `parseRow` accepts: the parsed object (always a
/// [`Value::Object`]), its kind and its id.
#[derive(Debug, Clone, PartialEq)]
pub struct JsonlRow {
    kind: RowKind,
    id: JsString,
    value: Value,
}

impl JsonlRow {
    /// `parseRow(line)`: `None` for text that is not JSON, a row without its
    /// required fields, a malformed optional group or an unknown kind.
    pub fn parse(line: &str) -> Option<Self> {
        if line.is_empty() {
            return None;
        }
        Self::from_value(pipette_js_json::parse(line).ok()?)
    }

    /// The checks of `parseRow` on a parsed value.
    pub fn from_value(value: Value) -> Option<Self> {
        let Value::Object(obj) = &value else { return None };
        let Some(Value::String(id)) = obj.get("id") else { return None };
        let kind = RowKind::from_tag(obj.get("kind")?.as_str()?)?;
        if !is_finite_number(obj.get("updated_at")) {
            return None;
        }
        if obj.get("is_deleted").is_some_and(|v| !matches!(v, Value::Bool(_))) {
            return None;
        }
        // `typeof payload === 'object'` also lets an array through, but no
        // kind's payload check passes on an array: each needs a named field.
        let Some(Value::Object(payload)) = obj.get("payload") else { return None };
        let valid = match kind {
            RowKind::Scope => is_scope_payload(payload),
            RowKind::CharMinute => is_char_minute_payload(payload),
            RowKind::MatrixMinute => is_matrix_minute_payload(payload),
            RowKind::MinuteStats => is_minute_stats_payload(payload),
            RowKind::Session => is_session_payload(payload),
            RowKind::BigramMinute => is_ngram_minute_payload(payload, "bigrams"),
            RowKind::TrigramMinute => is_ngram_minute_payload(payload, "trigrams"),
        };
        if !valid {
            return None;
        }
        let id = id.clone();
        Some(Self { kind, id, value })
    }

    pub fn kind(&self) -> RowKind {
        self.kind
    }

    pub fn id(&self) -> &JsString {
        &self.id
    }

    /// The parsed object, a [`Value::Object`].
    pub fn value(&self) -> &Value {
        &self.value
    }

    pub fn into_value(self) -> Value {
        self.value
    }

    /// `serializeRow(row)`.
    pub fn serialize(&self) -> String {
        serialize_row(&self.value)
    }
}

/// `serializeRow(row)`: `JSON.stringify(row)` and a newline.
pub fn serialize_row(row: &Value) -> String {
    let mut line = pipette_js_json::stringify(row);
    line.push('\n');
    line
}

/// `String(n)`: ECMAScript's Number::toString, `NaN` and `Infinity`
/// included.
pub(crate) fn js_number_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let mut out = String::new();
    pipette_js_json::write_number(&mut out, n);
    out
}

/// `encodeURIComponent(text)`. A Rust string has no lone surrogate, the
/// one input that makes it throw.
fn enc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

pub fn scope_row_id(scope_id: &str) -> String {
    format!("scope|{}", enc(scope_id))
}

pub fn char_minute_row_id(scope_id: &str, minute_ts: f64, run_id: &str, ch: &str) -> String {
    format!("char|{}|{}|{}|{}", enc(scope_id), js_number_string(minute_ts), enc(run_id), enc(ch))
}

pub fn matrix_minute_row_id(
    scope_id: &str,
    minute_ts: f64,
    run_id: &str,
    row: f64,
    col: f64,
    layer: f64,
) -> String {
    format!(
        "matrix|{}|{}|{}|{}|{}|{}",
        enc(scope_id),
        js_number_string(minute_ts),
        enc(run_id),
        js_number_string(row),
        js_number_string(col),
        js_number_string(layer)
    )
}

pub fn minute_stats_row_id(scope_id: &str, minute_ts: f64, run_id: &str) -> String {
    format!("stats|{}|{}|{}", enc(scope_id), js_number_string(minute_ts), enc(run_id))
}

pub fn session_row_id(session_id: &str) -> String {
    format!("session|{}", enc(session_id))
}

pub fn bigram_minute_row_id(scope_id: &str, minute_ts: f64, run_id: &str) -> String {
    format!("bigram|{}|{}|{}", enc(scope_id), js_number_string(minute_ts), enc(run_id))
}

pub fn trigram_minute_row_id(scope_id: &str, minute_ts: f64, run_id: &str) -> String {
    format!("trigram|{}|{}|{}", enc(scope_id), js_number_string(minute_ts), enc(run_id))
}

// --- parseRow ------------------------------------------------------------

fn is_string(p: &Object, key: &str) -> bool {
    matches!(p.get(key), Some(Value::String(_)))
}

/// `typeof v === 'number' && Number.isFinite(v)`.
fn is_finite_number(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Number(n)) if n.is_finite())
}

fn is_number(p: &Object, key: &str) -> bool {
    is_finite_number(p.get(key))
}

fn is_number_or_null(p: &Object, key: &str) -> bool {
    matches!(p.get(key), Some(Value::Null)) || is_number(p, key)
}

/// `allOrNone`: `Some(false)` when none of `keys` is present, `Some(true)`
/// when all are, `None` for a partial group (a malformed row).
fn all_or_none(p: &Object, keys: &[&str]) -> Option<bool> {
    let present = keys.iter().filter(|key| p.contains_key(key)).count();
    match present {
        0 => Some(false),
        n if n == keys.len() => Some(true),
        _ => None,
    }
}

/// `appName` / `typingTest`: absent, null or a string.
fn is_optional_string_or_null(p: &Object, key: &str) -> bool {
    matches!(p.get(key), None | Some(Value::Null | Value::String(_)))
}

/// The tags of every per-minute payload: `appName` and `typingTest` absent,
/// null or a string, `runId` absent or a string.
fn has_valid_tags(p: &Object) -> bool {
    is_optional_string_or_null(p, "appName")
        && is_optional_string_or_null(p, "typingTest")
        && matches!(p.get("runId"), None | Some(Value::String(_)))
}

/// `isHistBuckets`: exactly [`HIST_BUCKETS`] finite numbers.
fn is_hist(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Array(items))
        if items.len() == HIST_BUCKETS && items.iter().all(|item| is_finite_number(Some(item))))
}

fn is_scope_payload(p: &Object) -> bool {
    ["id", "machineHash", "osPlatform", "osRelease", "osArch", "keyboardUid", "keyboardProductName"]
        .iter()
        .all(|key| is_string(p, key))
        && is_number(p, "keyboardVendorId")
        && is_number(p, "keyboardProductId")
}

fn is_char_minute_payload(p: &Object) -> bool {
    is_string(p, "scopeId")
        && is_number(p, "minuteTs")
        && is_string(p, "char")
        && is_number(p, "count")
        && has_valid_tags(p)
}

/// `dh` / `ds` / `dq`: none, or a histogram and two finite numbers.
fn is_valid_duration_triple(p: &Object) -> bool {
    match all_or_none(p, &["dh", "ds", "dq"]) {
        None => false,
        Some(false) => true,
        Some(true) => is_hist(p.get("dh")) && is_number(p, "ds") && is_number(p, "dq"),
    }
}

fn is_matrix_minute_payload(p: &Object) -> bool {
    is_string(p, "scopeId")
        && ["minuteTs", "row", "col", "layer", "keycode", "count", "tapCount", "holdCount"]
            .iter()
            .all(|key| is_number(p, key))
        && is_valid_duration_triple(p)
        && has_valid_tags(p)
}

/// `pollP50Ms` / `pollP95Ms`: none, or both, each null or a finite number.
fn is_valid_poll_stats_pair(p: &Object) -> bool {
    match all_or_none(p, &["pollP50Ms", "pollP95Ms"]) {
        None => false,
        Some(false) => true,
        Some(true) => is_number_or_null(p, "pollP50Ms") && is_number_or_null(p, "pollP95Ms"),
    }
}

fn is_minute_stats_payload(p: &Object) -> bool {
    is_string(p, "scopeId")
        && is_number(p, "minuteTs")
        && is_number(p, "keystrokes")
        && is_number(p, "activeMs")
        && [
            "intervalAvgMs",
            "intervalMinMs",
            "intervalP25Ms",
            "intervalP50Ms",
            "intervalP75Ms",
            "intervalMaxMs",
        ]
        .iter()
        .all(|key| is_number_or_null(p, key))
        && is_valid_poll_stats_pair(p)
        && has_valid_tags(p)
}

fn is_session_payload(p: &Object) -> bool {
    is_string(p, "id") && is_string(p, "scopeId") && is_number(p, "startMs") && is_number(p, "endMs")
}

/// `Number.isInteger(v) && v >= 0` (`-0` included).
fn is_non_negative_integer(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) if n.is_finite() && n.fract() == 0.0 && *n >= 0.0 => Some(*n),
        _ => None,
    }
}

/// `s` / `sq`: none, or two finite numbers. `oc` / `on`: none, or two
/// non-negative integers with `oc <= on`.
fn is_ngram_entry(value: &Value) -> bool {
    let Value::Object(o) = value else { return false };
    let sums_ok = match all_or_none(o, &["s", "sq"]) {
        None => false,
        Some(false) => true,
        Some(true) => is_number(o, "s") && is_number(o, "sq"),
    };
    let overlap_ok = match all_or_none(o, &["oc", "on"]) {
        None => false,
        Some(false) => true,
        Some(true) => match (is_non_negative_integer(o.get("oc")), is_non_negative_integer(o.get("on"))) {
            (Some(oc), Some(on)) => oc <= on,
            _ => false,
        },
    };
    is_number(o, "c") && is_hist(o.get("h")) && sums_ok && overlap_ok
}

/// The entries may be an object or, as `Object.values` also reads one, an
/// array.
fn is_ngram_minute_payload(p: &Object, field: &str) -> bool {
    if !is_string(p, "scopeId") || !is_number(p, "minuteTs") || !has_valid_tags(p) {
        return false;
    }
    match p.get(field) {
        Some(Value::Object(entries)) => entries.iter().all(|(_, entry)| is_ngram_entry(entry)),
        Some(Value::Array(entries)) => entries.iter().all(is_ngram_entry),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str) -> Option<JsonlRow> {
        JsonlRow::parse(text)
    }

    const SESSION: &str = r#"{"id":"s","kind":"session","updated_at":1,"payload":{"id":"s","scopeId":"x","startMs":1,"endMs":2}}"#;

    #[test]
    fn ids_url_encode_their_text_parts() {
        assert_eq!(scope_row_id("hash|linux|uid"), "scope|hash%7Clinux%7Cuid");
        assert_eq!(char_minute_row_id("s", 60_000.0, "", "a"), "char|s|60000||a");
        assert_eq!(char_minute_row_id("s", 60_000.0, "", "|"), "char|s|60000||%7C");
        assert_eq!(char_minute_row_id("s", 60_000.0, "run-1", "a"), "char|s|60000|run-1|a");
        assert_ne!(
            char_minute_row_id("s", 60_000.0, "run-1", "a"),
            char_minute_row_id("s", 60_000.0, "run-2", "a")
        );
        assert_eq!(matrix_minute_row_id("s", 60_000.0, "", 2.0, 3.0, 1.0), "matrix|s|60000||2|3|1");
        assert_eq!(matrix_minute_row_id("s", 60_000.0, "run-1", 2.0, 3.0, 1.0), "matrix|s|60000|run-1|2|3|1");
        assert_eq!(minute_stats_row_id("s", 60_000.0, ""), "stats|s|60000|");
        assert_eq!(session_row_id("uuid-123"), "session|uuid-123");
        assert_eq!(bigram_minute_row_id("s", 60_000.0, "run-1"), "bigram|s|60000|run-1");
        assert_eq!(trigram_minute_row_id("s", 60_000.0, ""), "trigram|s|60000|");
        assert_eq!(js_number_string(f64::NAN), "NaN");
        assert_eq!(js_number_string(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(js_number_string(-0.0), "0");
    }

    #[test]
    fn rows_round_trip_with_every_field() {
        let row = line(SESSION).unwrap();
        assert_eq!(row.kind(), RowKind::Session);
        assert_eq!(row.id(), "s");
        assert_eq!(row.serialize(), format!("{SESSION}\n"));
        let marked = r#"{"id":"c","kind":"char-minute","updated_at":9000,"is_deleted":true,"payload":{"scopeId":"s","minuteTs":60000,"char":"a","count":0}}"#;
        assert_eq!(line(marked).unwrap().serialize(), format!("{marked}\n"));
    }

    #[test]
    fn rejects_rows_without_their_required_fields() {
        assert!(line("").is_none());
        assert!(line("{ not json").is_none());
        assert!(line(r#"{"id":"x|1","kind":"mystery","updated_at":1,"payload":{}}"#).is_none());
        assert!(
            line(
                r#"{"id":"c","kind":"char-minute","updated_at":1,"payload":{"scopeId":"s","minuteTs":60000}}"#
            )
            .is_none()
        );
        assert!(line(&SESSION.replace(r#""updated_at":1"#, r#""updated_at":"soon""#)).is_none());
    }

    #[test]
    fn optional_groups_are_all_or_nothing() {
        let bigram = |entry: &str| {
            line(&format!(
                r#"{{"id":"b","kind":"bigram-minute","updated_at":1,"payload":{{"scopeId":"s","minuteTs":60000,"bigrams":{{"4_11":{entry}}}}}}}"#
            ))
        };
        const H: &str = "[0,2,0,0,0,0,0,0]";
        assert!(bigram(&format!(r#"{{"c":2,"h":{H}}}"#)).is_some());
        assert!(bigram(&format!(r#"{{"c":2,"h":{H},"s":240,"sq":28800}}"#)).is_some());
        assert!(bigram(&format!(r#"{{"c":2,"h":{H},"oc":1,"on":2}}"#)).is_some());
        for extra in [
            r#""s":240"#,
            r#""sq":28800"#,
            r#""s":"240","sq":28800"#,
            r#""oc":1"#,
            r#""on":2"#,
            r#""oc":1.5,"on":2"#,
            r#""oc":1,"on":-1"#,
            r#""oc":3,"on":2"#,
            r#""oc":"1","on":2"#,
        ] {
            assert!(bigram(&format!(r#"{{"c":2,"h":{H},{extra}}}"#)).is_none(), "{extra}");
        }
        assert!(bigram(r#"{"c":1,"h":[1,0,0]}"#).is_none());
        assert!(bigram(r#"{"c":1,"h":[1,0,0,0,0,0,0,null]}"#).is_none());
    }
}
