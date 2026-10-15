// SPDX-License-Identifier: GPL-2.0-or-later
//! Reading a per-day JSONL master (jsonl-reader.ts) and validating each line
//! (`parseRow`, jsonl-row.ts). A line that fails validation is dropped, not
//! an error, so rows of a newer build's kinds never stop a replay.
//!
//! Numbers stay `f64` all the way to SQLite: the TypeScript side holds them
//! as JavaScript numbers and better-sqlite3 binds every number as a double,
//! so an INTEGER column stores a whole value as INTEGER (column affinity)
//! and a fractional one as REAL. Binding the same doubles keeps both sides
//! storing the same storage class.

use serde_json::{Map, Value};

/// `BIGRAM_HIST_BUCKETS` (jsonl-row.ts).
pub const HIST_BUCKETS: usize = 8;

#[derive(Debug, Clone, PartialEq)]
pub struct RowCommon {
    pub updated_at: f64,
    pub is_deleted: bool,
}

/// Per-minute tags shared by every rollup row. `app_name` / `typing_test`
/// are null when absent; `run_id` is `''` when absent.
#[derive(Debug, Clone, PartialEq)]
pub struct MinuteTags {
    pub app_name: Option<String>,
    pub typing_test: Option<String>,
    pub run_id: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScopePayload {
    pub id: String,
    pub machine_hash: String,
    pub os_platform: String,
    pub os_release: String,
    pub os_arch: String,
    pub keyboard_uid: String,
    pub keyboard_vendor_id: f64,
    pub keyboard_product_id: f64,
    pub keyboard_product_name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CharMinutePayload {
    pub scope_id: String,
    pub minute_ts: f64,
    pub char: String,
    pub count: f64,
    pub tags: MinuteTags,
}

/// The keypress-duration triple `dh` / `ds` / `dq`, all present or none.
#[derive(Debug, Clone, PartialEq)]
pub struct Duration {
    pub hist: [f64; HIST_BUCKETS],
    pub sum: f64,
    pub sum_sq: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MatrixMinutePayload {
    pub scope_id: String,
    pub minute_ts: f64,
    pub row: f64,
    pub col: f64,
    pub layer: f64,
    pub keycode: f64,
    pub count: f64,
    pub tap_count: f64,
    pub hold_count: f64,
    pub duration: Option<Duration>,
    pub tags: MinuteTags,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MinuteStatsPayload {
    pub scope_id: String,
    pub minute_ts: f64,
    pub keystrokes: f64,
    pub active_ms: f64,
    /// avg, min, p25, p50, p75, max.
    pub intervals: [Option<f64>; 6],
    pub poll_p50_ms: Option<f64>,
    pub poll_p95_ms: Option<f64>,
    pub tags: MinuteTags,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionPayload {
    pub id: String,
    pub scope_id: String,
    pub start_ms: f64,
    pub end_ms: f64,
}

/// One bigram / trigram of a minute. `sums` is `s` / `sq`, `overlap` is
/// `oc` / `on`; each pair is all present or none.
#[derive(Debug, Clone, PartialEq)]
pub struct NgramEntry {
    pub count: f64,
    pub hist: [f64; HIST_BUCKETS],
    pub sums: Option<(f64, f64)>,
    pub overlap: Option<(f64, f64)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NgramMinutePayload {
    pub scope_id: String,
    pub minute_ts: f64,
    /// `(ngram id, entry)`. The order is not the JavaScript key order; every
    /// id is its own row, so the order does not change the result.
    pub entries: Vec<(String, NgramEntry)>,
    pub tags: MinuteTags,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RowPayload {
    Scope(ScopePayload),
    CharMinute(CharMinutePayload),
    MatrixMinute(MatrixMinutePayload),
    MinuteStats(MinuteStatsPayload),
    Session(SessionPayload),
    BigramMinute(NgramMinutePayload),
    TrigramMinute(NgramMinutePayload),
}

#[derive(Debug, Clone, PartialEq)]
pub struct JsonlRow {
    pub common: RowCommon,
    pub payload: RowPayload,
}

/// The rows of a whole file, the way `readRows` reads it: lines end at
/// `\n`, `\r\n` or a lone `\r` (Node's readline), blank and invalid lines
/// are dropped, and when the text does not end with `\n` its last line is
/// a crash-truncated write and is dropped too.
pub(crate) fn read_rows(text: &str) -> Vec<JsonlRow> {
    let mut lines = split_lines(text);
    if !text.ends_with('\n') {
        lines.pop();
    }
    lines.into_iter().filter_map(parse_row).collect()
}

fn split_lines(text: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let bytes = text.as_bytes();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => {
                lines.push(&text[start..i]);
                start = i + 1;
            }
            b'\r' => {
                lines.push(&text[start..i]);
                if bytes.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if start < bytes.len() {
        lines.push(&text[start..]);
    }
    lines
}

/// One line, or `None` where `parseRow` returns null.
fn parse_row(line: &str) -> Option<JsonlRow> {
    if line.is_empty() {
        return None;
    }
    let value: Value = serde_json::from_str(line).ok()?;
    let obj = value.as_object()?;
    obj.get("id")?.as_str()?;
    let kind = obj.get("kind")?.as_str()?;
    let updated_at = obj.get("updated_at")?.as_f64()?;
    let is_deleted = match obj.get("is_deleted") {
        None => false,
        Some(v) => v.as_bool()?,
    };
    let p = obj.get("payload")?.as_object()?;
    let payload = match kind {
        "scope" => RowPayload::Scope(scope(p)?),
        "char-minute" => RowPayload::CharMinute(char_minute(p)?),
        "matrix-minute" => RowPayload::MatrixMinute(matrix_minute(p)?),
        "minute-stats" => RowPayload::MinuteStats(minute_stats(p)?),
        "session" => RowPayload::Session(session(p)?),
        "bigram-minute" => RowPayload::BigramMinute(ngram_minute(p, "bigrams")?),
        "trigram-minute" => RowPayload::TrigramMinute(ngram_minute(p, "trigrams")?),
        _ => return None,
    };
    Some(JsonlRow { common: RowCommon { updated_at, is_deleted }, payload })
}

type Obj = Map<String, Value>;

fn string(p: &Obj, key: &str) -> Option<String> {
    p.get(key)?.as_str().map(str::to_owned)
}

fn number(p: &Obj, key: &str) -> Option<f64> {
    p.get(key)?.as_f64()
}

/// Present and null, or a number (`isNumericOrNull`). Absent fails.
fn number_or_null(p: &Obj, key: &str) -> Option<Option<f64>> {
    match p.get(key)? {
        Value::Null => Some(None),
        v => v.as_f64().map(Some),
    }
}

/// Absent or null reads as null; a string is kept; anything else fails
/// (`isOptionalAppName` / `isOptionalTypingTest`).
fn optional_string(p: &Obj, key: &str) -> Option<Option<String>> {
    match p.get(key) {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(s)) => Some(Some(s.clone())),
        Some(_) => None,
    }
}

fn tags(p: &Obj) -> Option<MinuteTags> {
    let run_id = match p.get("runId") {
        None => String::new(),
        Some(v) => v.as_str()?.to_owned(),
    };
    Some(MinuteTags {
        app_name: optional_string(p, "appName")?,
        typing_test: optional_string(p, "typingTest")?,
        run_id,
    })
}

/// The all-or-nothing gate of `allOrNone`: `Some(false)` when none of
/// `keys` is present, `Some(true)` when all are, `None` (reject) otherwise.
fn all_or_none(p: &Obj, keys: &[&str]) -> Option<bool> {
    let present = keys.iter().filter(|k| p.contains_key(**k)).count();
    match present {
        0 => Some(false),
        n if n == keys.len() => Some(true),
        _ => None,
    }
}

fn hist(value: &Value) -> Option<[f64; HIST_BUCKETS]> {
    let items = value.as_array()?;
    if items.len() != HIST_BUCKETS {
        return None;
    }
    let mut out = [0.0; HIST_BUCKETS];
    for (slot, item) in out.iter_mut().zip(items) {
        *slot = item.as_f64()?;
    }
    Some(out)
}

fn scope(p: &Obj) -> Option<ScopePayload> {
    Some(ScopePayload {
        id: string(p, "id")?,
        machine_hash: string(p, "machineHash")?,
        os_platform: string(p, "osPlatform")?,
        os_release: string(p, "osRelease")?,
        os_arch: string(p, "osArch")?,
        keyboard_uid: string(p, "keyboardUid")?,
        keyboard_vendor_id: number(p, "keyboardVendorId")?,
        keyboard_product_id: number(p, "keyboardProductId")?,
        keyboard_product_name: string(p, "keyboardProductName")?,
    })
}

fn char_minute(p: &Obj) -> Option<CharMinutePayload> {
    Some(CharMinutePayload {
        scope_id: string(p, "scopeId")?,
        minute_ts: number(p, "minuteTs")?,
        char: string(p, "char")?,
        count: number(p, "count")?,
        tags: tags(p)?,
    })
}

fn matrix_minute(p: &Obj) -> Option<MatrixMinutePayload> {
    let duration = if all_or_none(p, &["dh", "ds", "dq"])? {
        Some(Duration { hist: hist(p.get("dh")?)?, sum: number(p, "ds")?, sum_sq: number(p, "dq")? })
    } else {
        None
    };
    Some(MatrixMinutePayload {
        scope_id: string(p, "scopeId")?,
        minute_ts: number(p, "minuteTs")?,
        row: number(p, "row")?,
        col: number(p, "col")?,
        layer: number(p, "layer")?,
        keycode: number(p, "keycode")?,
        count: number(p, "count")?,
        tap_count: number(p, "tapCount")?,
        hold_count: number(p, "holdCount")?,
        duration,
        tags: tags(p)?,
    })
}

fn minute_stats(p: &Obj) -> Option<MinuteStatsPayload> {
    let (poll_p50_ms, poll_p95_ms) = if all_or_none(p, &["pollP50Ms", "pollP95Ms"])? {
        (number_or_null(p, "pollP50Ms")?, number_or_null(p, "pollP95Ms")?)
    } else {
        (None, None)
    };
    Some(MinuteStatsPayload {
        scope_id: string(p, "scopeId")?,
        minute_ts: number(p, "minuteTs")?,
        keystrokes: number(p, "keystrokes")?,
        active_ms: number(p, "activeMs")?,
        intervals: [
            number_or_null(p, "intervalAvgMs")?,
            number_or_null(p, "intervalMinMs")?,
            number_or_null(p, "intervalP25Ms")?,
            number_or_null(p, "intervalP50Ms")?,
            number_or_null(p, "intervalP75Ms")?,
            number_or_null(p, "intervalMaxMs")?,
        ],
        poll_p50_ms,
        poll_p95_ms,
        tags: tags(p)?,
    })
}

fn session(p: &Obj) -> Option<SessionPayload> {
    Some(SessionPayload {
        id: string(p, "id")?,
        scope_id: string(p, "scopeId")?,
        start_ms: number(p, "startMs")?,
        end_ms: number(p, "endMs")?,
    })
}

fn non_negative_integer(value: &Value) -> Option<f64> {
    let n = value.as_f64()?;
    (n.fract() == 0.0 && n >= 0.0).then_some(n)
}

fn ngram_entry(value: &Value) -> Option<NgramEntry> {
    let o = value.as_object()?;
    let sums = if all_or_none(o, &["s", "sq"])? { Some((number(o, "s")?, number(o, "sq")?)) } else { None };
    let overlap = if all_or_none(o, &["oc", "on"])? {
        let oc = non_negative_integer(o.get("oc")?)?;
        let on = non_negative_integer(o.get("on")?)?;
        if oc > on {
            return None;
        }
        Some((oc, on))
    } else {
        None
    };
    Some(NgramEntry { count: number(o, "c")?, hist: hist(o.get("h")?)?, sums, overlap })
}

/// `bigrams` / `trigrams` may be an object or, as JavaScript also accepts,
/// an array whose indexes become the ids.
fn ngram_minute(p: &Obj, field: &str) -> Option<NgramMinutePayload> {
    let scope_id = string(p, "scopeId")?;
    let minute_ts = number(p, "minuteTs")?;
    let tags = tags(p)?;
    let entries = match p.get(field)? {
        Value::Object(map) => {
            map.iter().map(|(k, v)| Some((k.clone(), ngram_entry(v)?))).collect::<Option<Vec<_>>>()?
        }
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, v)| Some((i.to_string(), ngram_entry(v)?)))
            .collect::<Option<Vec<_>>>()?,
        _ => return None,
    };
    Some(NgramMinutePayload { scope_id, minute_ts, entries, tags })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_end_at_lf_crlf_and_lone_cr() {
        assert_eq!(split_lines("a\nb\r\nc\rd\n"), vec!["a", "b", "c", "d"]);
        assert_eq!(split_lines("a\r"), vec!["a"]);
        assert_eq!(split_lines("a\n\nb"), vec!["a", "", "b"]);
        assert!(split_lines("").is_empty());
    }

    #[test]
    fn last_line_without_newline_is_dropped() {
        let row = r#"{"id":"s","kind":"session","updated_at":1,"payload":{"id":"s","scopeId":"x","startMs":1,"endMs":2}}"#;
        assert_eq!(read_rows(&format!("{row}\n{row}")).len(), 1);
        assert_eq!(read_rows(&format!("{row}\r")).len(), 0);
        assert_eq!(read_rows(&format!("{row}\r\n")).len(), 1);
    }
}
