// SPDX-License-Identifier: GPL-2.0-or-later
//! The request of `fetchNotifications` (src/main/notification-store.ts):
//! a POST of the notice query, its body byte for byte as `JSON.stringify`
//! writes it, with the whole fetch bounded by 10 seconds
//! (`AbortSignal.timeout(FETCH_TIMEOUT_MS)`).

use std::time::Duration;

use pipette_js_json::{Object, Value};
use pipette_net::{HttpRequest, Limits, Method};

/// `FETCH_TIMEOUT_MS` of src/main/notification-store.ts: from the start of
/// the request until the whole body is in.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// The client's bounds: the default ones with the whole request cut at
/// [`FETCH_TIMEOUT`].
pub const NOTICE_LIMITS: Limits = Limits { total_timeout: FETCH_TIMEOUT, ..Limits::DEFAULT };

/// How many notices the query asks for.
const LIMIT: f64 = 10.0;

/// The query `fetchNotifications` posts, with `Date.now()` as `now_ms`:
/// the published notices, newest first, at most ten.
pub fn request_body(now_ms: i64) -> String {
    let object = |pairs: Vec<(&str, Value)>| Value::Object(pairs.into_iter().collect::<Object>());
    #[allow(
        clippy::cast_precision_loss,
        reason = "Date.now() is a whole number of milliseconds well inside 2^53"
    )]
    let now = now_ms as f64;
    let payload = object(vec![
        ("deviceId", "all".into()),
        ("type", "notification".into()),
        ("collection", "pipette-notification".into()),
        (
            "filters",
            Value::Array(vec![object(vec![
                ("field", "publishedAt".into()),
                ("op", "<=".into()),
                ("value", now.into()),
            ])]),
        ),
        ("orderBy", object(vec![("field", "publishedAt".into()), ("direction", "desc".into())])),
        ("limit", LIMIT.into()),
    ]);
    pipette_js_json::stringify(&payload)
}

/// The POST of the notice query to `url`.
pub fn notice_request(url: &str, now_ms: i64) -> HttpRequest {
    HttpRequest {
        method: Method::Post,
        url: url.to_owned(),
        headers: vec![("Content-Type".to_owned(), "application/json".to_owned())],
        body: Some(request_body(now_ms).into_bytes()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_body_is_the_query_of_fetch_notifications() {
        assert_eq!(
            request_body(1_792_281_600_000),
            r#"{"deviceId":"all","type":"notification","collection":"pipette-notification","filters":[{"field":"publishedAt","op":"<=","value":1792281600000}],"orderBy":{"field":"publishedAt","direction":"desc"},"limit":10}"#
        );
    }

    #[test]
    fn the_request_is_a_json_post_to_the_url() {
        let request = notice_request("http://127.0.0.1:9", 0);
        assert_eq!(request.method, Method::Post);
        assert_eq!(request.url, "http://127.0.0.1:9");
        assert_eq!(request.headers, [("Content-Type".to_owned(), "application/json".to_owned())]);
        assert_eq!(request.body, Some(request_body(0).into_bytes()));
    }

    #[test]
    fn the_whole_request_is_cut_at_ten_seconds() {
        assert_eq!(NOTICE_LIMITS.total_timeout, Duration::from_secs(10));
        assert_eq!(NOTICE_LIMITS.max_body_bytes, Limits::DEFAULT.max_body_bytes);
    }
}
