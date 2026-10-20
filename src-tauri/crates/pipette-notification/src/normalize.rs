// SPDX-License-Identifier: GPL-2.0-or-later
//! The response of the notice query to the result the renderer gets: a
//! status outside 2xx is `HTTP <status>`, the body is read as
//! `response.json()` reads it, a body without a `notifications` array is
//! `Invalid response format`, items that are not notices are dropped, and
//! each publication date is kept as given (a string `Date.parse` reads,
//! date_parse.rs) or written as `toISOString` writes it (a Firestore
//! timestamp). A Firestore timestamp past the range of a `Date` fails the
//! whole fetch, as `toISOString` throws a RangeError for it. The notices
//! keep the response's order; the renderer sorts them.

use pipette_js_json::{JsString, Object, Value};
use pipette_net::HttpReply;
use serde::{Deserialize, Serialize};

use crate::date_parse::is_valid_iso_date;

/// `AppNotification` of src/shared/types/notification.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppNotification {
    pub title: String,
    pub body: String,
    #[serde(rename = "type")]
    pub kind: String,
    /// ISO 8601 as the response gave it, or as `toISOString` writes a
    /// Firestore timestamp.
    pub published_at: String,
}

/// `NotificationFetchResult` of src/shared/types/notification.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationFetchResult {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notifications: Option<Vec<AppNotification>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl NotificationFetchResult {
    pub fn fetched(notifications: Vec<AppNotification>) -> Self {
        Self { success: true, notifications: Some(notifications), error: None }
    }

    pub fn failed(error: impl Into<String>) -> Self {
        Self { success: false, notifications: None, error: Some(error.into()) }
    }
}

/// The error of a body without a `notifications` array.
pub const INVALID_RESPONSE_FORMAT: &str = "Invalid response format";

/// The error of a Firestore timestamp outside the range of a `Date`: the
/// RangeError `toISOString` throws.
pub const INVALID_TIME_VALUE: &str = "RangeError: Invalid time value";

/// The result of the response `reply`.
pub fn result_from_reply(reply: &HttpReply) -> NotificationFetchResult {
    if !reply.ok() {
        return NotificationFetchResult::failed(format!("HTTP {}", reply.status));
    }
    let data = match parse_json_body(&reply.body) {
        Ok(data) => data,
        Err(error) => return NotificationFetchResult::failed(error),
    };
    let list = match &data {
        // `data.notifications` throws on null.
        Value::Null => {
            return NotificationFetchResult::failed(
                "TypeError: Cannot read properties of null (reading 'notifications')",
            );
        }
        Value::Object(object) => object.get("notifications"),
        // Any other value has no own `notifications`.
        _ => None,
    };
    let Some(Value::Array(items)) = list else {
        return NotificationFetchResult::failed(INVALID_RESPONSE_FORMAT);
    };
    let mut notifications = Vec::new();
    for item in items {
        let Some(raw) = valid_notification(item) else { continue };
        match normalize_timestamp(raw.published_at) {
            Ok(Some(published_at)) => notifications.push(AppNotification {
                title: lossy(raw.title),
                body: lossy(raw.body),
                kind: lossy(raw.kind),
                published_at,
            }),
            Ok(None) => {}
            Err(error) => return NotificationFetchResult::failed(error),
        }
    }
    NotificationFetchResult::fetched(notifications)
}

/// `response.json()`: the body decoded as UTF-8 (a leading byte order mark
/// dropped, invalid bytes as U+FFFD) and parsed as `JSON.parse` parses it.
fn parse_json_body(body: &[u8]) -> Result<Value, String> {
    let body = body.strip_prefix("\u{feff}".as_bytes()).unwrap_or(body);
    pipette_js_json::parse(&String::from_utf8_lossy(body)).map_err(|err| format!("SyntaxError: {err}"))
}

/// The fields of an item [`valid_notification`] accepts.
struct RawNotification<'a> {
    title: &'a JsString,
    body: &'a JsString,
    kind: &'a JsString,
    published_at: &'a Value,
}

/// An item that is an object with string `title`, `body` and
/// `type`, and a `publishedAt` that is a string or a Firestore timestamp.
fn valid_notification(item: &Value) -> Option<RawNotification<'_>> {
    let object = item.as_object()?;
    let string = |key| match object.get(key) {
        Some(Value::String(s)) => Some(s),
        _ => None,
    };
    let published_at = object.get("publishedAt")?;
    if !matches!(published_at, Value::String(_)) && firestore_seconds(published_at).is_none() {
        return None;
    }
    Some(RawNotification {
        title: string("title")?,
        body: string("body")?,
        kind: string("type")?,
        published_at,
    })
}

/// `_seconds` of a Firestore timestamp: an object with numbers `_seconds` and
/// `_nanoseconds`.
fn firestore_seconds(value: &Value) -> Option<f64> {
    let object: &Object = value.as_object()?;
    match (object.get("_seconds"), object.get("_nanoseconds")) {
        (Some(Value::Number(seconds)), Some(Value::Number(_))) => Some(*seconds),
        _ => None,
    }
}

/// The time of a valid notice's `publishedAt`: the string
/// when it is a date, `None` when it is not, and a Firestore timestamp as
/// `new Date(_seconds * 1000).toISOString()` (the nanoseconds dropped), or
/// the RangeError of a time out of range.
fn normalize_timestamp(value: &Value) -> Result<Option<String>, &'static str> {
    if let Value::String(text) = value {
        return Ok(text.as_str().filter(|text| is_valid_iso_date(text)).map(str::to_owned));
    }
    let Some(seconds) = firestore_seconds(value) else { return Ok(None) };
    let ms = pipette_time::date_value_ms(&Value::Number(seconds * 1000.0)).ok_or(INVALID_TIME_VALUE)?;
    #[allow(clippy::cast_possible_truncation, reason = "a time value is a whole number within ±8.64e15")]
    Ok(Some(pipette_time::iso_8601_millis(ms as i64)))
}

/// The text of a string the renderer gets; a lone surrogate, which a Rust
/// string cannot hold, becomes U+FFFD.
fn lossy(text: &JsString) -> String {
    text.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(status: u16, body: &str) -> HttpReply {
        HttpReply { status, retry_after: None, content_type: None, body: body.as_bytes().to_vec() }
    }

    fn notice(title: &str, published_at: &str) -> AppNotification {
        AppNotification {
            title: title.to_owned(),
            body: "Body".to_owned(),
            kind: "Info".to_owned(),
            published_at: published_at.to_owned(),
        }
    }

    #[test]
    fn returns_the_notices_of_a_successful_fetch() {
        let result = result_from_reply(&reply(
            200,
            r#"{"notifications":[
                {"title":"Update","body":"New version","type":"Info","publishedAt":"2025-01-01T00:00:00Z"},
                {"title":"Maintenance","body":"Scheduled","type":"Warning","publishedAt":"2025-01-02T00:00:00Z"}
            ]}"#,
        ));
        assert_eq!(
            result,
            NotificationFetchResult::fetched(vec![
                AppNotification {
                    title: "Update".to_owned(),
                    body: "New version".to_owned(),
                    kind: "Info".to_owned(),
                    published_at: "2025-01-01T00:00:00Z".to_owned(),
                },
                AppNotification {
                    title: "Maintenance".to_owned(),
                    body: "Scheduled".to_owned(),
                    kind: "Warning".to_owned(),
                    published_at: "2025-01-02T00:00:00Z".to_owned(),
                },
            ])
        );
    }

    #[test]
    fn converts_a_firestore_timestamp_to_an_iso_string() {
        let result = result_from_reply(&reply(
            200,
            r#"{"notifications":[{"title":"TS","body":"Body","type":"Info","publishedAt":{"_seconds":1735689600,"_nanoseconds":0}}]}"#,
        ));
        // new Date(1735689600 * 1000).toISOString()
        assert_eq!(result, NotificationFetchResult::fetched(vec![notice("TS", "2025-01-01T00:00:00.000Z")]));
    }

    #[test]
    fn an_empty_list_is_no_notices() {
        assert_eq!(
            result_from_reply(&reply(200, r#"{"notifications":[]}"#)),
            NotificationFetchResult::fetched(vec![])
        );
    }

    #[test]
    fn a_status_outside_2xx_fails_with_the_status() {
        assert_eq!(result_from_reply(&reply(500, "")), NotificationFetchResult::failed("HTTP 500"));
    }

    #[test]
    fn drops_items_that_are_not_notices() {
        let result = result_from_reply(&reply(
            200,
            r#"{"notifications":[
                {"title":"Valid","body":"Body","type":"Info","publishedAt":"2025-01-01T00:00:00Z"},
                {"title":"Missing body"},
                null,
                "not an object",
                {"title":123,"body":"Body","type":"Info","publishedAt":"2025-01-01T00:00:00Z"}
            ]}"#,
        ));
        assert_eq!(result, NotificationFetchResult::fetched(vec![notice("Valid", "2025-01-01T00:00:00Z")]));
    }

    #[test]
    fn a_body_without_a_notices_array_is_an_invalid_format() {
        assert_eq!(
            result_from_reply(&reply(200, r#"{"message":"not wrapped"}"#)),
            NotificationFetchResult::failed(INVALID_RESPONSE_FORMAT)
        );
    }

    #[test]
    fn accepts_a_firestore_timestamp_and_drops_a_number() {
        let result = result_from_reply(&reply(
            200,
            r#"{"notifications":[
                {"title":"TS","body":"Body","type":"Info","publishedAt":{"_seconds":1700000000,"_nanoseconds":500}},
                {"title":"Str","body":"Body","type":"Info","publishedAt":"2025-01-01T00:00:00Z"},
                {"title":"Bad","body":"Body","type":"Info","publishedAt":12345}
            ]}"#,
        ));
        assert_eq!(
            result,
            NotificationFetchResult::fetched(vec![
                notice("TS", "2023-11-14T22:13:20.000Z"),
                notice("Str", "2025-01-01T00:00:00Z"),
            ])
        );
    }

    #[test]
    fn drops_notices_with_a_malformed_date() {
        let result = result_from_reply(&reply(
            200,
            r#"{"notifications":[
                {"title":"Valid","body":"Body","type":"Info","publishedAt":"2025-01-01T00:00:00Z"},
                {"title":"Invalid","body":"Body","type":"Info","publishedAt":"not-a-date"},
                {"title":"Empty","body":"Body","type":"Info","publishedAt":""}
            ]}"#,
        ));
        assert_eq!(result, NotificationFetchResult::fetched(vec![notice("Valid", "2025-01-01T00:00:00Z")]));
    }

    #[test]
    fn a_lone_surrogate_reaches_the_renderer_as_a_replacement_character() {
        let result = result_from_reply(&reply(
            200,
            r#"{"notifications":[{"title":"a\ud800","body":"Body","type":"Info","publishedAt":"2025-01-01T00:00:00Z"}]}"#,
        ));
        assert_eq!(
            result,
            NotificationFetchResult::fetched(vec![notice("a\u{fffd}", "2025-01-01T00:00:00Z")])
        );
    }

    #[test]
    fn an_infinite_number_of_seconds_is_out_of_range() {
        let result = result_from_reply(&reply(
            200,
            r#"{"notifications":[{"title":"T","body":"Body","type":"Info","publishedAt":{"_seconds":1e400,"_nanoseconds":0}}]}"#,
        ));
        assert_eq!(result, NotificationFetchResult::failed(INVALID_TIME_VALUE));
    }

    #[test]
    fn serializes_as_the_renderer_reads_it() {
        assert_eq!(
            serde_json::to_value(NotificationFetchResult::fetched(vec![notice("T", "2025-01-01T00:00:00Z")]))
                .unwrap_or_default(),
            serde_json::json!({
                "success": true,
                "notifications": [{ "title": "T", "body": "Body", "type": "Info", "publishedAt": "2025-01-01T00:00:00Z" }]
            })
        );
        assert_eq!(
            serde_json::to_value(NotificationFetchResult::failed("HTTP 500")).unwrap_or_default(),
            serde_json::json!({ "success": false, "error": "HTTP 500" })
        );
    }
}
