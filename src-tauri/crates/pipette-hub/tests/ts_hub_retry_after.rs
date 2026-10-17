// SPDX-License-Identifier: GPL-2.0-or-later
//! The 429 retry against the Electron Hub client (tests/fixtures/
//! ts_hub_retry_after.json, recorded by scripts/hub-fixtures/): a 429 with
//! each `Retry-After`, then a 200, through each way a response is read.
//! The requests sent, the waits, the error and its `retryAfterSeconds`
//! match for every header both clients read.
//!
//! The `jsOnly` headers are ones only `Date.parse` was expected to read.
//! The Rust client reads an HTTP date in the RFC 7231 forms (any weekday,
//! names in any case, GMT or UTC); for such a header it must match the TS
//! exactly, and for any other it behaves as with no `Retry-After` at all.

#![allow(clippy::unwrap_used)]

mod common;

use common::{array, block_on, field, fixture, get, number, reply, same_number, scripted, text};
use pipette_hub::retry_after::parse_retry_after;
use pipette_hub::{Endpoint, HubError, RequestBody};
use pipette_js_json::Value;

/// What one 429-then-200 exchange did.
#[derive(Debug, PartialEq)]
struct Run {
    requests: usize,
    sleeps_ms: Vec<f64>,
    error: Option<String>,
    retry_after: Option<f64>,
}

impl Run {
    fn same(&self, other: &Run) -> bool {
        self.requests == other.requests
            && self.sleeps_ms == other.sleeps_ms
            && self.error == other.error
            && same_number(self.retry_after, other.retry_after)
    }
}

fn run(via: &str, header: Option<&str>, now: f64) -> Run {
    let (endpoint, ok_body) = match via {
        "hub-client.ts fetchAuthMe" => (Endpoint::AuthMe, r#"{"ok":true,"data":{"id":"u"}}"#),
        "hub-key-labels.ts fetchKeyLabelTimestamps" => {
            (Endpoint::KeyLabelTimestamps, r#"{"ok":true,"data":[]}"#)
        }
        "hub-i18n.ts fetchI18nPackTimestamps" => (Endpoint::I18nTimestamps, r#"{"ok":true,"data":[]}"#),
        "hub-i18n.ts downloadI18nPostBody" => (Endpoint::I18nDownload { post_id: "p" }, r#"{"version":1}"#),
        other => panic!("no endpoint for {other}"),
    };
    let client = scripted(
        "http://127.0.0.1:9",
        now,
        vec![reply(429, header, "Too Many Requests"), reply(200, None, ok_body)],
    );
    let outcome = block_on(client.http.send(&endpoint, Some("jwt"), RequestBody::None));
    let (error, retry_after) = match &outcome {
        Ok(_) => (None, None),
        Err(err @ HubError::Status { retry_after, .. }) => (Some(err.to_string()), *retry_after),
        Err(err) => (Some(err.to_string()), None),
    };
    let sleeps_ms = client.clock.slept.lock().unwrap().iter().map(|d| d.as_secs_f64() * 1000.0).collect();
    Run { requests: client.seen.lock().unwrap().len(), sleeps_ms, error, retry_after }
}

#[test]
fn the_retry_matches_the_ts() {
    let golden = fixture("ts_hub_retry_after.json");
    let now = number(field(&golden, "nowMs")).unwrap();
    let mut failures = Vec::new();
    let mut checked = 0;
    for case in array(field(&golden, "cases")) {
        let header = text(field(case, "header"));
        let kind = text(field(case, "kind"));
        for result in array(field(case, "results")) {
            let via = text(field(result, "via"));
            let recorded = Run {
                requests: number(field(result, "requests")).unwrap() as usize,
                sleeps_ms: array(field(result, "sleepsMs")).iter().map(|v| number(v).unwrap()).collect(),
                error: get(result, "error").and_then(Value::as_str).map(str::to_owned),
                retry_after: get(result, "retryAfterSeconds").and_then(number),
            };
            let actual = run(via, Some(header), now);
            let read_by_rust = parse_retry_after(Some(header), now).is_some();
            let expected = if kind == "jsOnly" && !read_by_rust { run(via, None, now) } else { recorded };
            if !actual.same(&expected) {
                failures.push(format!("{header:?} [{kind}] {via}: {actual:?}, expected {expected:?}"));
            }
            checked += 1;
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
    assert_eq!(checked, 44 * 4);
}
