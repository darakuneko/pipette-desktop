// SPDX-License-Identifier: GPL-2.0-or-later
//! The startup update of the Hub-linked language packs against Electron's
//! (the scenarios of ts_hub_handlers_startup_sync.json): the recorded
//! userData is seeded, the scripted Hub answers the Rust pass, which must
//! send the same requests, wait the same waits, report the same sync units,
//! log the same lines, broadcast the same event and leave the same
//! userData. The downloads go out at once, so the requests, the sync units
//! and the per-pack error lines are compared sorted.

#![allow(clippy::unwrap_used)]

mod common;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use common::{Clock, array, block_on, field, fixture, get, number, text};
use pipette_entry_store::{FixedClock, WriteLocks};
use pipette_hub::startup_sync::run;
use pipette_hub::{HubHttp, HubRequesters};
use pipette_js_json::{Value, stringify};
use pipette_keyboard_stores::StoreContext;
use pipette_net::{HttpError, HttpReply, HttpRequest};

/// A rule of the scripted Hub (hub-harness.ts `HubRule`).
struct Rule {
    method: String,
    path: String,
    body: Option<String>,
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
    fn answer(&self, request: HttpRequest) -> Result<HttpReply, HttpError> {
        let rest = request.url.strip_prefix(&self.base).unwrap();
        assert!(!rest.contains('?'), "no query is sent: {rest}");
        let body = request.body.as_ref().map(|body| String::from_utf8(body.clone()).unwrap());
        let mut headers: Vec<(String, String)> =
            request.headers.iter().map(|(name, value)| (name.to_ascii_lowercase(), value.clone())).collect();
        headers.sort();
        self.seen.lock().unwrap().push(format!("{} {rest} {headers:?} {body:?}", request.method.as_str()));
        let response = {
            let mut rules = self.rules.lock().unwrap();
            let rule = rules
                .iter_mut()
                .find(|rule| {
                    rule.method == request.method.as_str()
                        && rule.path == rest
                        && rule.body.as_ref().is_none_or(|b| body.as_ref() == Some(b))
                        && (rule.repeat || rule.used < rule.responses.len())
                })
                .unwrap_or_else(|| panic!("no rule answers {} {rest}", request.method.as_str()));
            let index = rule.used.min(rule.responses.len() - 1);
            rule.used += 1;
            rule.responses[index].clone()
        };
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

/// A recorded request as [`Script::answer`] writes it.
fn recorded_line(request: &Value) -> String {
    assert!(array(field(request, "query")).is_empty());
    let mut headers: Vec<(String, String)> = field(request, "headers")
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| (name.to_string_lossy().into_owned(), text(value).to_owned()))
        .collect();
    headers.sort();
    let body = get(request, "body").map(|body| text(field(body, "text")).to_owned());
    format!("{} {} {headers:?} {body:?}", text(field(request, "method")), text(field(request, "path")))
}

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

fn sorted(mut list: Vec<String>) -> Vec<String> {
    list.sort();
    list
}

/// The log lines with the per-pack error lines, which follow the summary
/// in the order the downloads ended, sorted.
fn log_lines(mut lines: Vec<String>) -> Vec<String> {
    let first_error =
        lines.iter().position(|line| line.contains("i18n startup sync error ")).unwrap_or(lines.len());
    lines[first_error..].sort();
    lines
}

#[test]
fn the_startup_sync_scenarios_match_the_ts() {
    let f = fixture("ts_hub_handlers_startup_sync.json");
    let base = text(field(&f, "hubBase")).to_owned();
    let now = number(field(&f, "nowMs")).unwrap();
    let scenarios = array(field(&f, "scenarios"));
    assert_eq!(scenarios.len(), 4);
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
        let rules = array(field(scenario, "rules"))
            .iter()
            .map(|rule| {
                assert!(get(rule, "query").is_none());
                Rule {
                    method: text(field(rule, "method")).to_owned(),
                    path: text(field(rule, "path")).to_owned(),
                    body: get(rule, "body").map(stringify),
                    responses: array(field(rule, "responses")).clone(),
                    repeat: get(rule, "repeat").is_some_and(Value::is_truthy),
                    used: 0,
                }
            })
            .collect();
        let script =
            Arc::new(Script { base: base.clone(), rules: Mutex::new(rules), seen: Mutex::new(Vec::new()) });
        let answering = Arc::clone(&script);
        let requester = move |request: HttpRequest| answering.answer(request);
        let clock = Arc::new(Clock { now, slept: Mutex::new(Vec::new()) });
        let http = HubHttp::new(base.clone(), HubRequesters::single(Arc::new(requester)), clock.clone());

        let steps = array(field(scenario, "steps"));
        assert_eq!(steps.len(), 1);
        let step = &steps[0];
        assert!(field(field(step, "step"), "startupSync").is_truthy());
        let outcome = block_on(run(&http, &stores, &|| false));
        assert!(!outcome.stopped);

        let seen = sorted(script.seen.lock().unwrap().clone());
        let expected = sorted(array(field(step, "requests")).iter().map(recorded_line).collect());
        if seen != expected {
            failures.push(format!("{name}: requests {seen:#?} expected {expected:#?}"));
        }
        let units = sorted(notified.lock().unwrap().clone());
        let expected =
            sorted(array(field(step, "notified")).iter().map(|unit| text(unit).to_owned()).collect());
        if units != expected {
            failures.push(format!("{name}: notified {units:?} expected {expected:?}"));
        }
        let slept = clock.slept.lock().unwrap().len();
        if slept != array(field(step, "sleeps")).len() {
            failures.push(format!("{name}: {slept} sleeps"));
        }
        let logs = log_lines(
            outcome
                .report()
                .into_iter()
                .map(|(level, message)| format!("{} {message}", level.as_str().to_ascii_lowercase()))
                .collect(),
        );
        let expected = log_lines(
            array(field(step, "logs"))
                .iter()
                .map(|line| format!("{} {}", text(field(line, "level")), text(field(line, "message"))))
                .collect(),
        );
        if logs != expected {
            failures.push(format!("{name}: logs {logs:#?} expected {expected:#?}"));
        }
        let events: Vec<String> = array(field(step, "events"))
            .iter()
            .map(|event| {
                assert!(array(field(event, "args")).is_empty());
                text(field(event, "channel")).to_owned()
            })
            .collect();
        let sent: Vec<String> =
            outcome.changed().then(|| "i18n-pack:changed".to_owned()).into_iter().collect();
        if sent != events {
            failures.push(format!("{name}: events {sent:?} expected {events:?}"));
        }
        let (after, expected) = (tree(dir.path()), recorded_tree(field(scenario, "treeAfter")));
        if after != expected {
            failures.push(format!("{name}: userData {after:#?} expected {expected:#?}"));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
