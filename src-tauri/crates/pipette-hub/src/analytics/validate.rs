// SPDX-License-Identifier: GPL-2.0-or-later
//! The checks of an Analyze post's export before it is sent, and its size,
//! with the limits the Hub's own validator applies.

use pipette_js_json::{Object, Value};

use super::export::AnalyticsExport;

const MS_PER_DAY: f64 = 86_400_000.0;

/// The longest window the Hub accepts for an Analyze post
/// (`ANALYTICS_MAX_RANGE_MS`).
pub const ANALYTICS_MAX_RANGE_MS: f64 = 30.0 * MS_PER_DAY;

/// The fewest keystrokes an Analyze post may hold
/// (`ANALYTICS_MIN_KEYSTROKES`): fewer would let single keystrokes be read
/// back from the charts.
pub const ANALYTICS_MIN_KEYSTROKES: f64 = 100.0;

/// The result of [`validate_analytics_export`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Validation {
    Ok,
    /// The reason, as the Hub's validator words it.
    Failed(&'static str),
}

impl Validation {
    /// `{ ok: true }` or `{ ok: false, reason }`.
    pub fn to_js(self) -> Value {
        let mut out = Object::new();
        match self {
            Self::Ok => {
                out.insert("ok", Value::Bool(true));
            }
            Self::Failed(reason) => {
                out.insert("ok", Value::Bool(false));
                out.insert("reason", Value::from(reason));
            }
        }
        out.into()
    }
}

/// Checks for enough keystrokes, a window that does not end before it starts,
/// and no longer than thirty days. A NaN fails no check, as in JavaScript.
pub fn validate_analytics_export(export: &AnalyticsExport) -> Validation {
    if export.total_keystrokes < ANALYTICS_MIN_KEYSTROKES {
        return Validation::Failed("keystrokes below threshold");
    }
    let (from, to) = (export.from_ms, export.to_ms);
    if to < from {
        return Validation::Failed("snapshot.range.toMs must be >= fromMs");
    }
    if to - from > ANALYTICS_MAX_RANGE_MS {
        return Validation::Failed("range exceeds 30 days");
    }
    Validation::Ok
}

/// The UTF-8 length of the export's JSON text. The text escapes lone
/// surrogates, so it is the length Node's `Buffer.byteLength` gives.
pub fn estimate_analytics_export_size_bytes(export: &AnalyticsExport) -> usize {
    export.to_json().len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn export(total: f64, from: f64, to: f64) -> AnalyticsExport {
        AnalyticsExport::for_tests(total, from, to)
    }

    const FROM: f64 = 1_700_000_000_000.0;
    const TO: f64 = FROM + MS_PER_DAY;

    #[test]
    fn accepts_the_keystroke_threshold_and_rejects_below_it() {
        assert_eq!(validate_analytics_export(&export(ANALYTICS_MIN_KEYSTROKES, FROM, TO)), Validation::Ok);
        assert_eq!(
            validate_analytics_export(&export(ANALYTICS_MIN_KEYSTROKES - 1.0, FROM, TO)),
            Validation::Failed("keystrokes below threshold")
        );
    }

    #[test]
    fn accepts_thirty_days_and_rejects_a_millisecond_more() {
        let at_cap = export(200.0, FROM, FROM + ANALYTICS_MAX_RANGE_MS);
        assert_eq!(validate_analytics_export(&at_cap), Validation::Ok);
        let over = export(200.0, FROM, FROM + ANALYTICS_MAX_RANGE_MS + 1.0);
        assert_eq!(validate_analytics_export(&over), Validation::Failed("range exceeds 30 days"));
    }

    #[test]
    fn rejects_an_inverted_range() {
        assert_eq!(
            validate_analytics_export(&export(200.0, TO, FROM)),
            Validation::Failed("snapshot.range.toMs must be >= fromMs")
        );
    }

    #[test]
    fn nan_fails_no_check() {
        assert_eq!(validate_analytics_export(&export(f64::NAN, f64::NAN, FROM)), Validation::Ok);
    }

    #[test]
    fn writes_the_result_as_the_handler_answers_it() {
        let text = |v: Validation| pipette_js_json::stringify(&v.to_js());
        assert_eq!(text(Validation::Ok), r#"{"ok":true}"#);
        assert_eq!(
            text(Validation::Failed("range exceeds 30 days")),
            r#"{"ok":false,"reason":"range exceeds 30 days"}"#
        );
    }

    #[test]
    fn the_size_is_the_utf8_length_of_the_text() {
        let export = export(1.0, 0.0, 1.0);
        assert_eq!(estimate_analytics_export_size_bytes(&export), export.to_json().len());
    }
}
