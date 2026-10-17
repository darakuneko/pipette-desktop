// SPDX-License-Identifier: GPL-2.0-or-later
//! The key label scenarios recorded from the Electron Hub handlers
//! (ts_hub_handlers_key_labels.json): the recorded userData is seeded, the
//! scripted Hub answers the Rust handlers, which must give the same
//! answers, send the same requests, wait the same waits, report the same
//! sync units and leave the same userData. The key label handlers
//! broadcast nothing and log nothing; the fixture is checked to record
//! none of that.

#![allow(clippy::unwrap_used)]

mod common;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use common::{Clock, array, block_on, field, fixture, get, number, text};
use pipette_entry_store::{FixedClock, WriteLocks};
use pipette_hub::key_labels;
use pipette_hub::token::HubToken;
use pipette_hub::{HubHttp, HubRequesters};
use pipette_js_json::{Value, stringify};
use pipette_keyboard_stores::StoreContext;
use pipette_net::{HttpError, HttpReply, HttpRequest};

/// A rule of the scripted Hub (hub-harness.ts `HubRule`).
struct Rule {
    method: String,
    path: String,
    responses: Vec<Value>,
    repeat: bool,
    used: usize,
}

struct Script {
    base: String,
    rules: Mutex<Vec<Rule>>,
    seen: Mutex<Vec<String>>,
}

impl Script {
    /// The first rule whose method and path match and that has answers
    /// left answers; the last answer of a `repeat` rule repeats.
    fn answer(&self, request: HttpRequest) -> Result<HttpReply, HttpError> {
        let rest = request.url.strip_prefix(&self.base).unwrap();
        let path = rest.split_once('?').map_or(rest, |(path, _)| path);
        self.seen.lock().unwrap().push(request_line(&request, &self.base));
        let response = {
            let mut rules = self.rules.lock().unwrap();
            let rule = rules
                .iter_mut()
                .find(|rule| {
                    rule.method == request.method.as_str()
                        && rule.path == path
                        && (rule.repeat || rule.used < rule.responses.len())
                })
                .unwrap_or_else(|| panic!("no rule answers {} {rest}", request.method.as_str()));
            let index = rule.used.min(rule.responses.len() - 1);
            rule.used += 1;
            rule.responses[index].clone()
        };
        assert!(get(&response, "during").is_none());
        let body = match (get(&response, "json"), get(&response, "text")) {
            (Some(json), _) => stringify(json),
            (None, Some(body)) => text(body).to_owned(),
            (None, None) => String::new(),
        };
        let retry_after = get(&response, "headers")
            .and_then(|headers| get(headers, "Retry-After"))
            .map(|v| text(v).to_owned());
        Ok(HttpReply {
            status: number(field(&response, "status")).unwrap() as u16,
            retry_after,
            content_type: Some("application/json".to_owned()),
            body: body.into_bytes(),
        })
    }
}

/// A request as one comparable line: method, path, the query's pairs
/// sorted (the recorder writes them sorted), the `Authorization` and
/// `Content-Type` headers and the body text.
fn request_line(request: &HttpRequest, base: &str) -> String {
    let rest = request.url.strip_prefix(base).unwrap();
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let mut headers: Vec<(String, String)> =
        request.headers.iter().map(|(name, value)| (name.to_ascii_lowercase(), value.clone())).collect();
    headers.sort();
    let body = request.body.as_ref().map(|body| String::from_utf8(body.clone()).unwrap());
    let mut pairs: Vec<&str> = query.split('&').filter(|pair| !pair.is_empty()).collect();
    pairs.sort_unstable();
    format!("{} {path} ?{} {headers:?} {body:?}", request.method.as_str(), pairs.join("&"))
}

/// [`request_line`] of a recorded request.
fn recorded_line(request: &Value) -> String {
    let mut query: Vec<String> = array(field(request, "query"))
        .iter()
        .map(|pair| {
            let pair = array(pair);
            form_urlencoded::Serializer::new(String::new())
                .append_pair(text(&pair[0]), text(&pair[1]))
                .finish()
        })
        .collect();
    query.sort_unstable();
    let mut headers: Vec<(String, String)> = field(request, "headers")
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| (name.to_string_lossy().into_owned(), text(value).to_owned()))
        .collect();
    headers.sort();
    let body = get(request, "body").map(|body| text(field(body, "text")).to_owned());
    format!(
        "{} {} ?{} {headers:?} {body:?}",
        text(field(request, "method")),
        text(field(request, "path")),
        query.join("&"),
    )
}

/// The userData files under `dir`, by their path from it.
fn tree(dir: &Path) -> BTreeMap<String, String> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let relative = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                out.insert(relative, std::fs::read_to_string(&path).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

fn recorded_tree(value: &Value) -> BTreeMap<String, String> {
    value
        .as_object()
        .unwrap()
        .iter()
        .map(|(path, content)| (path.to_string_lossy().into_owned(), text(content).to_owned()))
        .collect()
}

fn seed(dir: &Path, value: &Value) {
    for (path, content) in recorded_tree(value) {
        let target = dir.join(path);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, content).unwrap();
    }
}

/// An argument as the handler gets it: `None` for `undefined`.
fn arg(args: &[Value]) -> Option<&Value> {
    args.first().filter(|value| get(value, "$u").is_none())
}

async fn run_call(token: &HubToken, stores: &StoreContext, call: &str, args: &[Value]) -> String {
    let http = token.http();
    let a = arg(args);
    match call {
        "KEY_LABEL_HUB_LIST" => key_labels::list(http, a).await,
        "KEY_LABEL_HUB_DETAIL" => key_labels::detail(http, a).await,
        "KEY_LABEL_HUB_TIMESTAMPS" => key_labels::timestamps(http, a).await,
        "KEY_LABEL_HUB_DOWNLOAD" => key_labels::download(http, stores, a).await,
        "KEY_LABEL_HUB_UPLOAD" => key_labels::upload(token, stores, a).await,
        "KEY_LABEL_HUB_UPDATE" => key_labels::update(token, stores, a).await,
        "KEY_LABEL_HUB_SYNC" => key_labels::sync(http, stores, a).await,
        "KEY_LABEL_HUB_DELETE" => key_labels::delete(token, stores, a).await,
        other => panic!("not a key label call: {other}"),
    }
}

#[test]
fn the_key_label_scenarios_match_the_ts() {
    let f = fixture("ts_hub_handlers_key_labels.json");
    let base = text(field(&f, "hubBase")).to_owned();
    let now = number(field(&f, "nowMs")).unwrap();
    let scenarios = array(field(&f, "scenarios"));
    assert_eq!(scenarios.len(), 7);
    let mut failures = Vec::new();
    for scenario in scenarios {
        let name = text(field(scenario, "name"));
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), field(scenario, "treeBefore"));
        let notified = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&notified);
        let stores = StoreContext::new(
            dir.path(),
            Arc::new(FixedClock::new(now as i64)),
            Arc::new(WriteLocks::new()),
            Arc::new(move |unit: &str| record.lock().unwrap().push(unit.to_owned())),
        );
        let script = Arc::new(Script {
            base: base.clone(),
            rules: Mutex::new(
                array(field(scenario, "rules"))
                    .iter()
                    .map(|rule| {
                        assert!(get(rule, "query").is_none() && get(rule, "body").is_none(), "{name}");
                        Rule {
                            method: text(field(rule, "method")).to_owned(),
                            path: text(field(rule, "path")).to_owned(),
                            responses: array(field(rule, "responses")).clone(),
                            repeat: get(rule, "repeat").is_some_and(Value::is_truthy),
                            used: 0,
                        }
                    })
                    .collect(),
            ),
            seen: Mutex::new(Vec::new()),
        });
        let answering = Arc::clone(&script);
        let requester = move |request: HttpRequest| answering.answer(request);
        let clock = Arc::new(Clock { now, slept: Mutex::new(Vec::new()) });
        let http = HubHttp::new(base.clone(), HubRequesters::single(Arc::new(requester)), clock.clone());
        let token = HubToken::new(http, Arc::new(|| Some("fixture-google-id-token".to_owned())));

        for (index, step) in array(field(scenario, "steps")).iter().enumerate() {
            for key in ["events", "logs"] {
                assert!(array(field(step, key)).is_empty(), "{name} #{index}: {key}");
            }
            script.seen.lock().unwrap().clear();
            notified.lock().unwrap().clear();
            clock.slept.lock().unwrap().clear();
            let action = field(step, "step");
            let answer = block_on(run_call(
                &token,
                &stores,
                text(field(action, "call")),
                array(field(action, "args")),
            ));
            let expected = stringify(field(step, "answer"));
            if answer != expected {
                failures.push(format!("{name} #{index}: {answer} expected {expected}"));
            }
            // A timestamps call sends its batches at once; the recorder
            // writes them sorted, as here.
            let mut seen = script.seen.lock().unwrap().clone();
            let mut expected: Vec<String> =
                array(field(step, "requests")).iter().map(recorded_line).collect();
            if text(field(action, "call")) == "KEY_LABEL_HUB_TIMESTAMPS" {
                seen.sort();
                expected.sort();
            }
            if seen != expected {
                failures.push(format!("{name} #{index}: requests {seen:#?} expected {expected:#?}"));
            }
            let units = notified.lock().unwrap().clone();
            let expected_units: Vec<String> =
                array(field(step, "notified")).iter().map(|unit| text(unit).to_owned()).collect();
            if units != expected_units {
                failures.push(format!("{name} #{index}: notified {units:?} expected {expected_units:?}"));
            }
            let slept: Vec<f64> =
                clock.slept.lock().unwrap().iter().map(|wait| wait.as_secs_f64() * 1000.0).collect();
            let expected_sleeps: Vec<f64> =
                array(field(step, "sleeps")).iter().map(|ms| number(ms).unwrap()).collect();
            if slept != expected_sleeps {
                failures.push(format!("{name} #{index}: sleeps {slept:?} expected {expected_sleeps:?}"));
            }
        }
        let (after, expected) = (tree(dir.path()), recorded_tree(field(scenario, "treeAfter")));
        if after != expected {
            failures.push(format!("{name}: userData {after:#?} expected {expected:#?}"));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
