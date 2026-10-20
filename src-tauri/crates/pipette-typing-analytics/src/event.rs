// SPDX-License-Identifier: GPL-2.0-or-later
//! The events the renderer sends while recording (`TypingAnalyticsEvent`)
//! and the checks made before taking one.
//!
//! A core field that fails its check (the time, the keyboard, the matrix
//! position, the key) drops the whole event. The optional classification
//! fields of a `matrix` press (`action`, `overlap`, `pollGapMs`) are
//! dropped on their own instead: an out-of-range value there is a timing
//! artifact, and the press itself still happened.
//!
//! `typingTest` and `runId` are taken only as strings (a missing or null
//! `runId` is `''`, the untagged bucket, and an empty `typingTest` is no
//! test); the renderer sends nothing else.

use pipette_js_json::{Object, Value};

use crate::fingerprint::KeyboardInfo;

/// `OBSERVATION_HOLE_MS` (src/shared/typing-analytics-timing.ts): the
/// largest polling gap a press can carry.
pub const OBSERVATION_HOLE_MS: f64 = 200.0;

/// `MAX_MATRIX_RELEASE_DURATION_MS`: the longest keypress a release may
/// report.
pub const MAX_MATRIX_RELEASE_DURATION_MS: f64 = 60_000.0;

/// A tap-hold key's resolution.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TapHold {
    Tap,
    Hold,
}

/// A key position of the matrix and the keycode mapped there.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MatrixKey {
    pub row: f64,
    pub col: f64,
    pub layer: f64,
    pub keycode: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum EventKind {
    /// A character typed (`kind: 'char'`).
    Char { key: String },
    /// A matrix press (`kind: 'matrix'`).
    Matrix { key: MatrixKey, action: Option<TapHold>, overlap: Option<bool>, poll_gap_ms: Option<f64> },
    /// A matrix release carrying the press's duration (`kind: 'matrix-release'`).
    Release { key: MatrixKey, duration_ms: f64 },
}

#[derive(Clone, Debug, PartialEq)]
pub struct TypingEvent {
    pub ts: f64,
    pub keyboard: KeyboardInfo,
    pub typing_test: Option<String>,
    /// `''` for input outside a typing test run.
    pub run_id: String,
    pub kind: EventKind,
}

fn finite(object: &Object, key: &str) -> Option<f64> {
    match object.get(key) {
        Some(Value::Number(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}

fn text<'a>(object: &'a Object, key: &str) -> Option<&'a str> {
    object.get(key)?.as_str()
}

/// A non-negative integer (`Number.isInteger(n) && n >= 0`).
fn index(object: &Object, key: &str) -> Option<f64> {
    finite(object, key).filter(|n| n.fract() == 0.0 && *n >= 0.0)
}

/// `isValidKeyboard`.
fn keyboard(value: &Value) -> Option<KeyboardInfo> {
    let object = value.as_object()?;
    let uid = text(object, "uid").filter(|uid| !uid.is_empty())?;
    Some(KeyboardInfo {
        uid: uid.into(),
        vendor_id: finite(object, "vendorId")?,
        product_id: finite(object, "productId")?,
        product_name: text(object, "productName")?.into(),
    })
}

/// `isValidMatrixCommon`: row, col and layer non-negative integers, any
/// finite keycode.
fn matrix_key(object: &Object) -> Option<MatrixKey> {
    Some(MatrixKey {
        row: index(object, "row")?,
        col: index(object, "col")?,
        layer: index(object, "layer")?,
        keycode: finite(object, "keycode")?,
    })
}

impl TypingEvent {
    /// The event of a payload `isValidEvent` accepts, with the optional
    /// press fields `sanitizeMatrixAuxFields` would delete left out.
    pub fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let ts = finite(object, "ts")?;
        let keyboard = keyboard(object.get("keyboard")?)?;
        let kind = match text(object, "kind")? {
            "char" => EventKind::Char { key: text(object, "key").filter(|key| !key.is_empty())?.into() },
            "matrix" => EventKind::Matrix {
                key: matrix_key(object)?,
                action: match text(object, "action") {
                    Some("tap") => Some(TapHold::Tap),
                    Some("hold") => Some(TapHold::Hold),
                    _ => None,
                },
                overlap: match object.get("overlap") {
                    Some(Value::Bool(overlap)) => Some(*overlap),
                    _ => None,
                },
                poll_gap_ms: finite(object, "pollGapMs")
                    .filter(|gap| *gap > 0.0 && *gap <= OBSERVATION_HOLE_MS),
            },
            "matrix-release" => EventKind::Release {
                key: matrix_key(object)?,
                duration_ms: finite(object, "durationMs")
                    .filter(|d| *d > 0.0 && *d < MAX_MATRIX_RELEASE_DURATION_MS)?,
            },
            _ => return None,
        };
        Some(Self {
            ts,
            keyboard,
            typing_test: text(object, "typingTest").filter(|test| !test.is_empty()).map(Into::into),
            run_id: text(object, "runId").unwrap_or_default().into(),
            kind,
        })
    }

    /// Whether the event is a press or a character, which session detection
    /// counts; a release only carries a duration.
    pub fn is_keystroke(&self) -> bool {
        !matches!(self.kind, EventKind::Release { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Option<TypingEvent> {
        TypingEvent::parse(&pipette_js_json::parse(text).unwrap())
    }

    const KB: &str = r#""keyboard":{"uid":"0xAABB","vendorId":65261,"productId":0,"productName":"K"}"#;

    fn with(fields: &str) -> String {
        format!("{{{fields},{KB}}}")
    }

    #[test]
    fn takes_a_char_event() {
        let event =
            parse(&with(r#""kind":"char","key":"a","ts":1000,"runId":"r","typingTest":"t""#)).unwrap();
        assert_eq!(event.kind, EventKind::Char { key: "a".into() });
        assert_eq!(event.keyboard.uid, "0xAABB");
        assert_eq!(event.keyboard.vendor_id, 65261.0);
        assert_eq!((event.run_id.as_str(), event.typing_test.as_deref()), ("r", Some("t")));
        assert!(event.is_keystroke());
    }

    #[test]
    fn rejects_bad_core_fields() {
        for fields in [
            r#""kind":"char","key":"","ts":1"#,
            r#""kind":"char","key":"a""#,
            r#""kind":"char","key":"a","ts":"1""#,
            r#""kind":"other","ts":1"#,
            r#""kind":"matrix","row":-1,"col":0,"layer":0,"keycode":4,"ts":1"#,
            r#""kind":"matrix","row":0.5,"col":0,"layer":0,"keycode":4,"ts":1"#,
            r#""kind":"matrix","row":0,"col":0,"layer":0,"ts":1"#,
            r#""kind":"matrix-release","row":0,"col":0,"layer":0,"keycode":4,"ts":1,"durationMs":0"#,
            r#""kind":"matrix-release","row":0,"col":0,"layer":0,"keycode":4,"ts":1,"durationMs":60000"#,
            r#""kind":"matrix-release","row":0,"col":0,"layer":0,"keycode":4,"ts":1"#,
        ] {
            assert_eq!(parse(&with(fields)), None, "{fields}");
        }
        for keyboard in [
            r#"{"uid":"","vendorId":1,"productId":2,"productName":"K"}"#,
            r#"{"uid":"u","vendorId":"1","productId":2,"productName":"K"}"#,
            r#"{"uid":"u","vendorId":1,"productId":2}"#,
            "null",
        ] {
            let text = format!(r#"{{"kind":"char","key":"a","ts":1,"keyboard":{keyboard}}}"#);
            assert_eq!(parse(&text), None, "{keyboard}");
        }
        assert_eq!(parse("null"), None);
        assert_eq!(parse(r#""kind""#), None);
    }

    #[test]
    fn drops_bad_optional_press_fields_but_keeps_the_press() {
        let event = parse(&with(
            r#""kind":"matrix","row":1,"col":2,"layer":0,"keycode":4,"ts":1,"action":"double","overlap":1,"pollGapMs":201"#,
        ))
        .unwrap();
        let key = MatrixKey { row: 1.0, col: 2.0, layer: 0.0, keycode: 4.0 };
        assert_eq!(event.kind, EventKind::Matrix { key, action: None, overlap: None, poll_gap_ms: None });
        let event = parse(&with(
            r#""kind":"matrix","row":1,"col":2,"layer":0,"keycode":4,"ts":1,"action":"hold","overlap":false,"pollGapMs":200"#,
        ))
        .unwrap();
        let kind = EventKind::Matrix {
            key,
            action: Some(TapHold::Hold),
            overlap: Some(false),
            poll_gap_ms: Some(200.0),
        };
        assert_eq!(event.kind, kind);
        for gap in ["0", "-1", "null"] {
            let fields =
                format!(r#""kind":"matrix","row":1,"col":2,"layer":0,"keycode":4,"ts":1,"pollGapMs":{gap}"#);
            assert!(matches!(
                parse(&with(&fields)).unwrap().kind,
                EventKind::Matrix { poll_gap_ms: None, .. }
            ));
        }
    }

    #[test]
    fn takes_a_release_with_its_duration() {
        let event = parse(&with(
            r#""kind":"matrix-release","row":0,"col":0,"layer":1,"keycode":4.5,"ts":1,"durationMs":59999.5"#,
        ))
        .unwrap();
        let key = MatrixKey { row: 0.0, col: 0.0, layer: 1.0, keycode: 4.5 };
        assert_eq!(event.kind, EventKind::Release { key, duration_ms: 59999.5 });
        assert!(!event.is_keystroke());
    }

    #[test]
    fn tags_only_strings() {
        let event = parse(&with(r#""kind":"char","key":"a","ts":1,"runId":null,"typingTest":"""#)).unwrap();
        assert_eq!((event.run_id.as_str(), event.typing_test), ("", None));
        let event = parse(&with(r#""kind":"char","key":"a","ts":1,"runId":5,"typingTest":7"#)).unwrap();
        assert_eq!((event.run_id.as_str(), event.typing_test), ("", None));
    }
}
