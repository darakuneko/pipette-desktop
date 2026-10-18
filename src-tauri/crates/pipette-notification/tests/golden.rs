// SPDX-License-Identifier: GPL-2.0-or-later
//! The notice fetch against what `fetchNotifications`
//! (src/main/notification-store.ts) did on the Electron main process,
//! recorded by scripts/resident-fixtures without sending anything
//! (tests/fixtures/notification.json):
//!
//! - `requests`: the request for each `Date.now()`, byte for byte;
//! - `cases`: a scripted response and the result, compared whole
//!   (`exact`) or by `success` only where the error text comes from the
//!   JavaScript engine (`success`);
//! - `dates`: whether a string publication date is kept. The `es` (Date
//!   Time String Format) and `rfc2822` rows must match; the `other` rows
//!   are forms only V8's fallback parser reads, the intended difference,
//!   where this build may drop what V8 keeps but never keeps what V8 drops.

use pipette_net::{HttpError, HttpReply, HttpRequest};
use pipette_notification::{
    NoticeDestination, NotificationFetchResult, fetch_notifications, is_valid_iso_date,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct Golden {
    requests: Vec<RequestCase>,
    cases: Vec<ResponseCase>,
    dates: Vec<DateCase>,
}

#[derive(Deserialize)]
struct RequestCase {
    now: i64,
    request: RecordedRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordedRequest {
    url: String,
    method: String,
    headers: serde_json::Map<String, serde_json::Value>,
    body: String,
    has_signal: bool,
}

#[derive(Deserialize)]
struct ResponseCase {
    name: String,
    response: ScriptedResponse,
    result: NotificationFetchResult,
    compare: Compare,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScriptedResponse {
    status: Option<u16>,
    body: Option<String>,
    content_type: Option<String>,
    network_error: Option<String>,
}

#[derive(Deserialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Compare {
    Exact,
    Success,
}

#[derive(Deserialize)]
struct DateCase {
    input: String,
    category: String,
    kept: bool,
}

fn golden() -> Golden {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/notification.json");
    let text = std::fs::read_to_string(path).unwrap_or_else(|err| panic!("{path}: {err}"));
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("{path}: {err}"))
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap_or_else(|err| panic!("{err}"))
}

/// Answers every request with `response` and keeps the requests.
fn scripted(
    response: &ScriptedResponse,
    seen: &std::sync::Mutex<Vec<HttpRequest>>,
) -> impl Fn(HttpRequest) -> Result<HttpReply, HttpError> + Send + Sync {
    move |request| {
        seen.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(request);
        if let Some(error) = &response.network_error {
            return Err(HttpError::Network(error.clone()));
        }
        Ok(HttpReply {
            status: response.status.unwrap_or_else(|| panic!("a scripted response without a status")),
            retry_after: None,
            content_type: response.content_type.clone(),
            body: response.body.clone().unwrap_or_default().into_bytes(),
        })
    }
}

#[test]
fn the_requests_match_the_golden() {
    let golden = golden();
    assert_eq!(golden.requests.len(), 5);
    // The destination of a build without the development tools, whatever
    // the environment holds: the URL Electron posts to. Nothing is sent.
    let destination = NoticeDestination::resolve(false, &|_| Some("http://127.0.0.1:9".to_owned()));
    let answer = ScriptedResponse {
        status: Some(200),
        body: Some(r#"{"notifications":[]}"#.to_owned()),
        content_type: None,
        network_error: None,
    };
    for case in &golden.requests {
        let seen = std::sync::Mutex::new(Vec::new());
        let result =
            runtime().block_on(fetch_notifications(&scripted(&answer, &seen), &destination.url, case.now));
        assert!(result.success);
        let mut seen = seen.into_inner().unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(seen.len(), 1);
        let request = seen.remove(0);
        let recorded = &case.request;
        assert_eq!(request.url, recorded.url, "now {}", case.now);
        assert_eq!(request.method.as_str(), recorded.method, "now {}", case.now);
        let headers: serde_json::Map<String, serde_json::Value> = request
            .headers
            .iter()
            .map(|(name, value)| (name.to_ascii_lowercase(), serde_json::Value::String(value.clone())))
            .collect();
        assert_eq!(headers, recorded.headers, "now {}", case.now);
        assert_eq!(request.body.as_deref(), Some(recorded.body.as_bytes()), "now {}", case.now);
        // The signal is the 10-second limit of the whole fetch.
        assert!(recorded.has_signal);
    }
}

#[test]
fn the_results_match_the_golden() {
    let golden = golden();
    assert_eq!(golden.cases.len(), 32);
    for case in &golden.cases {
        let seen = std::sync::Mutex::new(Vec::new());
        let result = runtime().block_on(fetch_notifications(
            &scripted(&case.response, &seen),
            pipette_notification::NOTIFICATION_ENDPOINT,
            0,
        ));
        match case.compare {
            Compare::Exact => assert_eq!(result, case.result, "{}", case.name),
            Compare::Success => {
                assert_eq!(result.success, case.result.success, "{}", case.name);
                assert_eq!(result.notifications, case.result.notifications, "{}", case.name);
            }
        }
    }
}

#[test]
fn the_dates_match_the_golden() {
    let golden = golden();
    let mut counts = [0; 3];
    for case in &golden.dates {
        let kept = is_valid_iso_date(&case.input);
        match case.category.as_str() {
            "es" | "rfc2822" => {
                assert_eq!(kept, case.kept, "{:?} ({})", case.input, case.category);
                counts[usize::from(case.category == "rfc2822")] += 1;
            }
            "other" => {
                assert!(!kept || case.kept, "{:?}: kept here, dropped by V8", case.input);
                counts[2] += 1;
            }
            category => panic!("{:?}: unknown category {category}", case.input),
        }
    }
    assert_eq!(counts, [21, 9, 35]);
}
