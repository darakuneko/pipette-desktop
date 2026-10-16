// SPDX-License-Identifier: GPL-2.0-or-later
//! The checks of a run log about to be saved (`validateRunLog` of
//! src/main/typing-run-log-store.ts): its shape, its size, and keystroke
//! times relative to the run's own start, done here whatever the renderer
//! already checked, since the log is the data a typed text is most easily
//! recovered from.
//!
//! The log arrives as the value `JSON.parse` reads from the text the shim
//! sends, so it holds no `undefined`, `NaN` or `Infinity` (JSON writes the
//! last two as `null`); each check answers for those as the handler does
//! for the value it got, a number check failing on `null` as it does on
//! `NaN`.

use pipette_entry_store::{is_safe_path_segment, utf16_len};
use pipette_js_json::{JsString, Object, Value};

use super::RunLogError;

/// Keystrokes a run log may hold.
pub const MAX_RUN_LOG_EVENTS: usize = 10_000;

/// The longest a run log may be, in bytes of its UTF-8 JSON text.
pub const MAX_RUN_LOG_BYTES: usize = 1_000_000;

/// How far past the run's own duration a keystroke time may land: clock
/// jitter and rounding, not an absolute time.
const TIMESTAMP_SLACK_MS: f64 = 5000.0;

/// The longest `typedChar` / `mistakeKey`, in UTF-16 code units: a
/// generous multiple of the longest romaji spelling (`kyaa`), there to
/// refuse an absurd payload.
const MAX_MISTAKE_FIELD_LENGTH: usize = 32;

/// A run log that passed the checks.
#[derive(Debug)]
pub(crate) struct ValidRunLog {
    pub run_id: JsString,
    pub started_at: JsString,
    /// The log as `JSON.stringify` writes it, which the store saves.
    pub serialized: String,
}

fn number(object: &Object, key: &str) -> Option<f64> {
    match object.get(key) {
        Some(Value::Number(n)) => Some(*n),
        _ => None,
    }
}

fn finite(object: &Object, key: &str) -> Option<f64> {
    number(object, key).filter(|n| n.is_finite())
}

/// `Number.isInteger`.
fn is_integer(n: f64) -> bool {
    n.is_finite() && n.trunc() == n
}

fn non_negative_integer(object: &Object, key: &str) -> bool {
    number(object, key).is_some_and(|n| is_integer(n) && n >= 0.0)
}

/// Absent, or a value `is_kind` accepts.
fn optional(object: &Object, key: &str, is_kind: impl FnOnce(&Value) -> bool) -> bool {
    object.get(key).is_none_or(is_kind)
}

fn is_bool(value: &Value) -> bool {
    matches!(value, Value::Bool(_))
}

fn is_string(value: &Value) -> bool {
    matches!(value, Value::String(_))
}

fn is_short_string(value: &Value) -> bool {
    matches!(value, Value::String(s) if utf16_len(s) <= MAX_MISTAKE_FIELD_LENGTH)
}

/// `isValidRowColKeycode` of the analytics pipeline.
fn is_valid_row_col_keycode(k: &Object) -> bool {
    non_negative_integer(k, "row") && non_negative_integer(k, "col") && finite(k, "keycode").is_some()
}

fn is_valid_keystroke(value: &Value, duration_ms: f64) -> bool {
    let Value::Object(k) = value else { return false };
    let bound = duration_ms + TIMESTAMP_SLACK_MS;
    let Some(press) = finite(k, "pressMs") else { return false };
    if press < 0.0 || press > bound {
        return false;
    }
    if k.get("releaseMs").is_some() {
        match finite(k, "releaseMs") {
            Some(release) if release >= press && release <= bound => {}
            _ => return false,
        }
    }
    is_valid_row_col_keycode(k)
        && optional(k, "expectedChar", is_string)
        && optional(k, "correct", is_bool)
        && optional(k, "overlapped", is_bool)
        && optional(k, "typedChar", is_short_string)
        && optional(k, "mistakeKey", is_short_string)
}

/// The keystrokes of a valid word, or `None`.
fn valid_word_keystrokes(value: &Value, duration_ms: f64) -> Option<usize> {
    let Value::Object(w) = value else { return None };
    let valid = non_negative_integer(w, "index")
        && optional(w, "partial", is_bool)
        && w.get("display").is_some_and(is_string)
        && w.get("typed").is_some_and(is_string)
        && w.get("correct").is_some_and(is_bool);
    if !valid {
        return None;
    }
    let Some(Value::Array(keystrokes)) = w.get("keystrokes") else { return None };
    keystrokes.iter().all(|k| is_valid_keystroke(k, duration_ms)).then_some(keystrokes.len())
}

/// Sorted, unique, ascending integers, each below `word_count - 1`: a line
/// break ends a line another follows, so the last word is never one.
fn is_valid_line_breaks(value: &Value, word_count: usize) -> bool {
    let Value::Array(breaks) = value else { return false };
    #[allow(clippy::cast_precision_loss)]
    let last = word_count as f64 - 1.0;
    let mut prev = -1.0;
    for entry in breaks {
        let Value::Number(n) = *entry else { return false };
        if !is_integer(n) || n <= prev || n < 0.0 || n >= last {
            return false;
        }
        prev = n;
    }
    true
}

/// Checks `raw`, the log the renderer sent for `expected_uid` (`None` when
/// it sent none), and answers the handler's first failure.
pub(crate) fn validate_run_log(raw: Option<&Value>, expected_uid: &str) -> Result<ValidRunLog, RunLogError> {
    // An array is an object to `typeof` and fails on its missing runId.
    let empty = Object::new();
    let log = match raw {
        Some(Value::Object(log)) => log,
        Some(Value::Array(_)) => &empty,
        _ => return Err(RunLogError::Malformed),
    };
    let run_id = match log.get("runId") {
        Some(Value::String(id)) if is_safe_path_segment(&id.to_string_lossy()) => id.clone(),
        _ => return Err(RunLogError::InvalidRunId),
    };
    if !matches!(log.get("uid"), Some(Value::String(uid)) if *uid == *expected_uid) {
        return Err(RunLogError::UidMismatch);
    }
    let started_at = match log.get("startedAt") {
        Some(Value::String(at)) if pipette_time::date_string_ms(at).is_some() => at.clone(),
        _ => return Err(RunLogError::InvalidStartedAt),
    };
    let Some(duration_ms) = finite(log, "durationMs").filter(|ms| *ms >= 0.0) else {
        return Err(RunLogError::InvalidDurationMs);
    };
    if !log.get("mode").is_some_and(is_string) {
        return Err(RunLogError::InvalidMode);
    }
    if !log.get("language").is_some_and(is_string) {
        return Err(RunLogError::InvalidLanguage);
    }
    if !optional(log, "charCorrelationUnavailable", is_bool) {
        return Err(RunLogError::InvalidCharCorrelationUnavailable);
    }
    if !optional(log, "romajiInput", is_bool) {
        return Err(RunLogError::InvalidRomajiInput);
    }
    let Some(Value::Array(words)) = log.get("words") else { return Err(RunLogError::InvalidWords) };

    let mut events = 0;
    for word in words {
        events += valid_word_keystrokes(word, duration_ms).ok_or(RunLogError::InvalidWordEntry)?;
    }
    if events > MAX_RUN_LOG_EVENTS {
        return Err(RunLogError::TooManyKeystrokes);
    }
    if let Some(breaks) = log.get("lineBreaks")
        && !is_valid_line_breaks(breaks, words.len())
    {
        return Err(RunLogError::InvalidLineBreaks);
    }

    let serialized = pipette_js_json::stringify(raw.unwrap_or(&Value::Null));
    if serialized.len() > MAX_RUN_LOG_BYTES {
        return Err(RunLogError::TooLarge);
    }
    Ok(ValidRunLog { run_id, started_at, serialized })
}
