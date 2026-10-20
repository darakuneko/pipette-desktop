// SPDX-License-Identifier: GPL-2.0-or-later
//! The recorded golden Analyze post scenarios of the Hub handlers
//! (ts_hub_handlers_analytics.json): on the same userData, typing analytics
//! seed, machine hash and time, each scenario's scripted Hub answers the
//! Rust handlers, which must give the same answers, send the same requests
//! (the multipart bodies byte for byte, with the boundary taken out), wait
//! the same 429 waits, notify the same sync units and leave the same
//! userData. The cache groups days by local time, so the scenarios run in a
//! process of their own in the time zone they were recorded in.

#![allow(clippy::unwrap_used)]

mod common;

use std::path::Path;
use std::sync::{Arc, Mutex};

use common::{Clock, array, field, fixture, get, number, text};
use pipette_entry_store::{FixedClock, WriteLocks};
use pipette_hub::analytics::AnalyticsPosts;
use pipette_hub::sources::{AnalyticsJob, AnalyticsSource, BoxFuture};
use pipette_hub::token::HubToken;
use pipette_hub::{HubHttp, HubRequesters, node_base64_decode};
use pipette_js_json::{Object, Value, stringify};
use pipette_keyboard_stores::StoreContext;
use pipette_net::{HttpError, HttpReply, HttpRequest};
use pipette_time::test_util::in_each_time_zone;
use pipette_typing_analytics::DbActor;

const FIXTURE: &str = "ts_hub_handlers_analytics.json";

/// The seeded cache of the Analyze export golden, with its machine hash.
struct Seeded {
    db: DbActor,
    hash: String,
}

impl AnalyticsSource for Seeded {
    fn machine_hash(&self) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(std::future::ready(Ok(self.hash.clone())))
    }

    fn with_db(&self, job: AnalyticsJob) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { self.db.call(move |db| job(db)).await.map_err(|err| err.to_string()) })
    }
}

fn seeded(hash: &str) -> Seeded {
    let seed = std::fs::read_to_string(format!(
        "{}/tests/fixtures/ts_hub_analytics_export_seed.jsonl",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let db = DbActor::open_in_memory().unwrap();
    db.call_blocking(move |db| db.apply_day_jsonl(&seed).map(|_| ())).unwrap().unwrap();
    Seeded { db, hash: hash.to_owned() }
}

/// A request in the form both sides can be compared in: the boundary of a
/// multipart body is written `{boundary}` in the body and as a template
/// with `{now}` on its own.
#[derive(Debug, PartialEq)]
struct Sent {
    method: String,
    path: String,
    query: Vec<(String, String)>,
    headers: Vec<(String, String)>,
    boundary: Option<String>,
    body: Option<Vec<u8>>,
}

fn sent(request: &HttpRequest, base: &str, now: f64) -> Sent {
    let rest = request.url.strip_prefix(base).unwrap();
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let mut query: Vec<(String, String)> = form_urlencoded::parse(query.as_bytes()).into_owned().collect();
    query.sort();
    let mut boundary = None;
    let mut headers: Vec<(String, String)> = request
        .headers
        .iter()
        .map(|(name, value)| {
            let name = name.to_ascii_lowercase();
            if let Some((kind, rest)) = value.split_once("; boundary=").filter(|_| name == "content-type") {
                boundary = Some(rest.to_owned());
                return (name, kind.to_owned());
            }
            (name, value.clone())
        })
        .collect();
    headers.sort();
    let body = request.body.clone().map(|body| match &boundary {
        Some(boundary) => replace(&body, boundary.as_bytes(), b"{boundary}"),
        None => body,
    });
    let boundary = boundary.map(|boundary| boundary.replace(&format!("{}", now as i64), "{now}"));
    Sent { method: request.method.as_str().to_owned(), path: path.to_owned(), query, headers, boundary, body }
}

fn replace(haystack: &[u8], needle: &[u8], with: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(haystack.len());
    let mut at = 0;
    while at < haystack.len() {
        if haystack[at..].starts_with(needle) {
            out.extend_from_slice(with);
            at += needle.len();
        } else {
            out.push(haystack[at]);
            at += 1;
        }
    }
    out
}

/// A request of the recorded request log as [`Sent`].
fn recorded(request: &Value) -> Sent {
    let query = array(field(request, "query"))
        .iter()
        .map(|pair| {
            let pair = array(pair);
            (text(&pair[0]).to_owned(), text(&pair[1]).to_owned())
        })
        .collect();
    let mut headers: Vec<(String, String)> = field(request, "headers")
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| (name.to_string_lossy().into_owned(), text(value).to_owned()))
        .collect();
    headers.sort();
    let (boundary, body) = match get(request, "body") {
        None => (None, None),
        Some(body) => match (get(body, "multipart"), get(body, "text"), get(body, "base64")) {
            (Some(multipart), _, _) => (
                Some(text(field(multipart, "boundary")).to_owned()),
                Some(node_base64_decode(text(field(multipart, "normalized")))),
            ),
            (None, Some(body), _) => (None, Some(text(body).as_bytes().to_vec())),
            (None, None, Some(bytes)) => (None, Some(node_base64_decode(text(bytes)))),
            _ => panic!("a body of another kind: {}", stringify(body)),
        },
    };
    Sent {
        method: text(field(request, "method")).to_owned(),
        path: text(field(request, "path")).to_owned(),
        query,
        headers,
        boundary,
        body,
    }
}

/// A rule of the scripted Hub.
struct Rule {
    method: String,
    path: String,
    responses: Vec<Value>,
    repeat: bool,
    used: usize,
}

struct Script {
    base: String,
    now: f64,
    rules: Mutex<Vec<Rule>>,
    seen: Mutex<Vec<Sent>>,
}

impl Script {
    /// The first rule whose method and path match and that has answers
    /// left answers; the last answer of a `repeat` rule repeats.
    fn answer(&self, request: HttpRequest) -> Result<HttpReply, HttpError> {
        let request = sent(&request, &self.base, self.now);
        let (method, path) = (request.method.clone(), request.path.clone());
        self.seen.lock().unwrap().push(request);
        let response = {
            let mut rules = self.rules.lock().unwrap();
            let rule = rules
                .iter_mut()
                .find(|rule| {
                    rule.method == method
                        && rule.path == path
                        && (rule.repeat || rule.used < rule.responses.len())
                })
                .unwrap_or_else(|| panic!("no rule answers {method} {path}"));
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
            .map(|value| text(value).to_owned());
        Ok(HttpReply {
            status: number(field(&response, "status")).unwrap() as u16,
            retry_after,
            content_type: Some("application/json".to_owned()),
            body: body.into_bytes(),
        })
    }
}

/// `value` without the properties tagged `undefined` (`{"$u": true}`),
/// which a JSON answer leaves out.
fn defined(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut out = Object::new();
            for (key, item) in object.iter() {
                if !get(item, "$u").is_some_and(Value::is_truthy) {
                    out.insert(key.clone(), defined(item));
                }
            }
            out.into()
        }
        Value::Array(items) => Value::Array(items.iter().map(defined).collect()),
        other => other.clone(),
    }
}

/// Writes the recorded tree: a file per path, an empty directory for a path
/// ending with `/`.
fn write_tree(dir: &Path, tree: &Value) {
    for (path, content) in tree.as_object().unwrap().iter() {
        let path = path.as_str().unwrap();
        if let Some(directory) = path.strip_suffix('/') {
            std::fs::create_dir_all(dir.join(directory)).unwrap();
            continue;
        }
        let target = dir.join(path);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, text(content)).unwrap();
    }
}

/// The tree as the recorded scenarios hold it: every file by its path, and
/// every empty directory but the root as `path/` with no content.
fn read_tree(root: &Path) -> Vec<(String, Option<String>)> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, Option<String>)>) {
        let mut entries: Vec<_> =
            std::fs::read_dir(dir).unwrap().map(|entry| entry.unwrap().path()).collect();
        entries.sort();
        let relative = |path: &Path| path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        if entries.is_empty() && dir != root {
            out.push((format!("{}/", relative(dir)), None));
        }
        for path in entries {
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                out.push((relative(&path), Some(std::fs::read_to_string(&path).unwrap())));
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

fn recorded_tree(tree: &Value) -> Vec<(String, Option<String>)> {
    let mut out: Vec<(String, Option<String>)> = tree
        .as_object()
        .unwrap()
        .iter()
        .map(|(path, content)| (path.as_str().unwrap().to_owned(), content.as_str().map(str::to_owned)))
        .collect();
    out.sort();
    out
}

async fn run_call(posts: &AnalyticsPosts<'_>, call: &str, params: &Value) -> Value {
    match call {
        "HUB_UPLOAD_ANALYTICS_POST" => posts.upload(params).await,
        "HUB_UPDATE_ANALYTICS_POST" => posts.update(params).await,
        "HUB_PREVIEW_ANALYTICS_POST" => posts.preview(params).await,
        "HUB_UPLOAD_PRIVATE_ANALYTICS_POST" => posts.upload_private(params).await,
        other => panic!("not an analytics call: {other}"),
    }
}

#[test]
fn the_analytics_scenarios_match_the_ts() {
    let golden = fixture(FIXTURE);
    let zone = text(field(&golden, "timeZone"));
    let Some(_) = in_each_time_zone("the_analytics_scenarios_match_the_ts", &[zone]) else { return };

    let base = text(field(&golden, "hubBase")).to_owned();
    let now = number(field(&golden, "nowMs")).unwrap();
    let source = seeded(text(field(&golden, "ownHash")));
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let scenarios = array(field(&golden, "scenarios"));
    assert_eq!(scenarios.len(), 6);
    let mut failures = Vec::new();
    for scenario in scenarios {
        let name = text(field(scenario, "name"));
        let dir = tempfile::tempdir().unwrap();
        write_tree(dir.path(), field(scenario, "treeBefore"));
        let notified = Arc::new(Mutex::new(Vec::<String>::new()));
        let notify = Arc::clone(&notified);
        let store = StoreContext::new(
            dir.path(),
            Arc::new(FixedClock::new(now as i64)),
            Arc::new(WriteLocks::new()),
            Arc::new(move |unit: &str| notify.lock().unwrap().push(unit.to_owned())),
        );
        let rules = array(field(scenario, "rules"))
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
            .collect();
        let script = Arc::new(Script {
            base: base.clone(),
            now,
            rules: Mutex::new(rules),
            seen: Mutex::new(Vec::new()),
        });
        let answering = Arc::clone(&script);
        let requester = move |request: HttpRequest| answering.answer(request);
        let clock = Arc::new(Clock { now, slept: Mutex::new(Vec::new()) });
        let http = HubHttp::new(base.clone(), HubRequesters::single(Arc::new(requester)), clock.clone());
        let token = HubToken::new(http, Arc::new(|| Some("fixture-google-id-token".to_owned())));
        let posts = AnalyticsPosts { token: &token, store: &store, source: &source };

        for (index, step) in array(field(scenario, "steps")).iter().enumerate() {
            for key in ["events", "logs"] {
                assert!(array(field(step, key)).is_empty(), "{name} #{index}: {key}");
            }
            script.seen.lock().unwrap().clear();
            clock.slept.lock().unwrap().clear();
            notified.lock().unwrap().clear();
            let action = field(step, "step");
            let call = text(field(action, "call"));
            let params = array(field(action, "args")).first().cloned().unwrap_or(Value::Null);
            let answer = runtime.block_on(run_call(&posts, call, &params));
            let expected = defined(field(step, "answer"));
            if stringify(&answer) != stringify(&expected) {
                failures.push(format!(
                    "{name} #{index}: {} expected {}",
                    stringify(&answer),
                    stringify(&expected)
                ));
            }
            let seen = std::mem::take(&mut *script.seen.lock().unwrap());
            let expected: Vec<Sent> = array(field(step, "requests")).iter().map(recorded).collect();
            if seen != expected {
                let lines = |requests: &[Sent]| -> Vec<String> {
                    requests
                        .iter()
                        .map(|request| {
                            let body = request.body.as_deref().map(String::from_utf8_lossy);
                            format!(
                                "{} {} {:?} {:?} {body:?}",
                                request.method, request.path, request.headers, request.boundary
                            )
                        })
                        .collect()
                };
                failures.push(format!(
                    "{name} #{index}: requests\n{:#?}\nexpected\n{:#?}",
                    lines(&seen),
                    lines(&expected)
                ));
            }
            let slept: Vec<f64> =
                clock.slept.lock().unwrap().iter().map(|wait| wait.as_secs_f64() * 1000.0).collect();
            let expected_sleeps: Vec<f64> =
                array(field(step, "sleeps")).iter().map(|ms| number(ms).unwrap()).collect();
            if slept != expected_sleeps {
                failures.push(format!("{name} #{index}: sleeps {slept:?} expected {expected_sleeps:?}"));
            }
            let units = notified.lock().unwrap().clone();
            let expected_units: Vec<String> =
                array(field(step, "notified")).iter().map(|unit| text(unit).to_owned()).collect();
            if units != expected_units {
                failures.push(format!("{name} #{index}: notified {units:?} expected {expected_units:?}"));
            }
        }
        let after = read_tree(dir.path());
        let expected = recorded_tree(field(scenario, "treeAfter"));
        if after != expected {
            let differing: Vec<&String> = after
                .iter()
                .chain(&expected)
                .filter(|entry| !(after.contains(entry) && expected.contains(entry)))
                .map(|(path, _)| path)
                .collect();
            failures.push(format!("{name}: the userData after differs at {differing:?}"));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
