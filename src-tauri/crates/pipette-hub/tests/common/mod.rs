// SPDX-License-Identifier: GPL-2.0-or-later
//! What the golden tests share: reading the fixtures that
//! scripts/hub-fixtures/ records from the Electron Hub code, their tags,
//! and a Hub client on scripted replies with a fixed clock.
//!
//! The tags: `{"$n": "NaN" | "Infinity" | "-Infinity" | "-0"}` for a number
//! JSON cannot hold, `{"$u": true}` for `undefined`, and
//! `{"$repeat": s, "count": n}` for `s` repeated `n` times.

#![allow(dead_code, clippy::unwrap_used)]

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pipette_hub::{HubHttp, HubRequesters, HubTiming};
use pipette_js_json::{Value, parse, stringify};
use pipette_net::{HttpError, HttpReply, HttpRequest};

pub fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

pub fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|object| object.get(key))
}

pub fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    get(value, key).unwrap_or_else(|| panic!("no {key} in {}", stringify(value)))
}

pub fn array(value: &Value) -> &Vec<Value> {
    match value {
        Value::Array(items) => items,
        other => panic!("not an array: {}", stringify(other)),
    }
}

pub fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_else(|| panic!("not a string: {}", stringify(value)))
}

/// A recorded string input.
pub enum Input {
    Text(String),
    /// A string with a lone surrogate, which a Rust string cannot hold (the
    /// IPC arguments are Rust strings).
    LoneSurrogate,
    /// `undefined`, `null`, a number, a boolean, an array or an object.
    NotAString,
}

pub fn input(value: &Value) -> Input {
    match value {
        Value::String(s) => s.as_str().map_or(Input::LoneSurrogate, |s| Input::Text(s.to_owned())),
        Value::Object(object) if object.contains_key("$repeat") => {
            let unit = text(field(value, "$repeat"));
            let count = number(field(value, "count")).unwrap();
            Input::Text(unit.repeat(count as usize))
        }
        _ => Input::NotAString,
    }
}

/// A recorded number: `None` for `null` and `undefined`.
pub fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => None,
        Value::Number(n) => Some(*n),
        Value::Object(object) if object.contains_key("$u") => None,
        Value::Object(object) if object.contains_key("$n") => Some(match text(field(value, "$n")) {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "-0" => -0.0,
            other => panic!("$n {other}"),
        }),
        other => panic!("not a number: {}", stringify(other)),
    }
}

/// Equal numbers, NaN equal to NaN and -0 not equal to 0.
pub fn same_number(a: Option<f64>, b: Option<f64>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) if a.is_nan() && b.is_nan() => true,
        (Some(a), Some(b)) => a == b && a.is_sign_negative() == b.is_sign_negative(),
        _ => false,
    }
}

/// `{ok}` or `{error}` of a recorded call.
pub fn outcome(case: &Value) -> Result<Value, String> {
    match get(case, "error") {
        Some(error) => Err(text(error).to_owned()),
        None => Ok(get(case, "ok").cloned().unwrap_or(Value::Null)),
    }
}

/// A clock at a fixed time whose sleeps are recorded and return at once.
pub struct Clock {
    pub now: f64,
    pub slept: Mutex<Vec<Duration>>,
}

impl HubTiming for Clock {
    fn now_ms(&self) -> f64 {
        self.now
    }

    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        self.slept.lock().unwrap().push(duration);
        Box::pin(std::future::ready(()))
    }
}

pub struct Scripted {
    pub http: HubHttp,
    pub seen: Arc<Mutex<Vec<HttpRequest>>>,
    pub clock: Arc<Clock>,
}

pub fn reply(status: u16, retry_after: Option<&str>, body: &str) -> Result<HttpReply, HttpError> {
    Ok(HttpReply {
        status,
        retry_after: retry_after.map(str::to_owned),
        content_type: Some("application/json".to_owned()),
        body: body.as_bytes().to_vec(),
    })
}

/// A client on `base` that answers its requests with `replies` in turn.
pub fn scripted(base: &str, now: f64, replies: Vec<Result<HttpReply, HttpError>>) -> Scripted {
    let replies = Mutex::new(VecDeque::from(replies));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&seen);
    let requester = move |request: HttpRequest| {
        record.lock().unwrap().push(request);
        replies.lock().unwrap().pop_front().expect("a scripted reply")
    };
    let clock = Arc::new(Clock { now, slept: Mutex::new(Vec::new()) });
    let http = HubHttp::new(base, HubRequesters::single(Arc::new(requester)), clock.clone());
    Scripted { http, seen, clock }
}

pub fn block_on<T>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(future)
}
