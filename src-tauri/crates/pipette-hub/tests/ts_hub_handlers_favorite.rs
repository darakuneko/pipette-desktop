// SPDX-License-Identifier: GPL-2.0-or-later
//! The recorded golden favorite post scenarios of the Hub handlers
//! (ts_hub_handlers_favorite.json). Each handler is split: the page checks
//! the post (`check_post_id`, `check_post` here, which the backend runs
//! again), reads the entry through the backend (`read_entry`), names its
//! keycodes in its worker and sends the export JSON to the handler. Each
//! step runs those parts in that order on the recorded userData: a check or
//! a read that fails must fail with the recorded answer and send nothing.
//! Otherwise the read must give the entry's label, save time and body as
//! the userData has them, and the handler, given the recorded export JSON,
//! must give the recorded answer and send the recorded requests (multipart
//! bodies byte for byte, with the boundary of the fixture's clock) and
//! waits. That the page's worker builds the same JSON from the same entry
//! is the shim's test (src/tauri-shim/__tests__/hub-favorite.test.ts).
//!
//! Also the `isValidHubVialProtocol` table of ts_hub_pure.json.

#![allow(clippy::unwrap_used)]

mod common;

use std::path::Path;
use std::sync::{Arc, Mutex};

use common::{Clock, array, block_on, field, fixture, get, number, text};
use pipette_hub::favorite::{self, check_post, check_post_id, is_valid_hub_vial_protocol, read_entry};
use pipette_hub::token::HubToken;
use pipette_hub::{HubHttp, HubRequesters, node_base64_decode};
use pipette_js_json::{Object, Value, parse, stringify};
use pipette_net::{HttpError, HttpReply, HttpRequest};

/// A rule of the scripted Hub.
struct Rule {
    method: String,
    path: String,
    responses: Vec<Value>,
    used: usize,
}

/// The scripted Hub: the first rule whose method and path match and that
/// has answers left answers. Each request is kept as its log line.
struct Script {
    base: String,
    /// The fixture's clock, which the boundaries carry.
    now: i64,
    rules: Mutex<Vec<Rule>>,
    seen: Mutex<Vec<String>>,
}

impl Script {
    fn answer(&self, request: HttpRequest) -> Result<HttpReply, HttpError> {
        let (method, path) = (request.method.as_str().to_owned(), self.path_of(&request).to_owned());
        self.seen.lock().unwrap().push(self.request_line(&request));
        let response = {
            let mut rules = self.rules.lock().unwrap();
            let rule = rules
                .iter_mut()
                .find(|rule| rule.method == method && rule.path == path && rule.used < rule.responses.len())
                .unwrap_or_else(|| panic!("no rule answers {method} {path}"));
            rule.used += 1;
            rule.responses[rule.used - 1].clone()
        };
        let body = match (get(&response, "json"), get(&response, "text")) {
            (Some(json), _) => stringify(json),
            (None, Some(body)) => text(body).to_owned(),
            (None, None) => String::new(),
        };
        Ok(HttpReply {
            status: number(field(&response, "status")).unwrap() as u16,
            retry_after: get(&response, "headers")
                .and_then(|headers| get(headers, "Retry-After"))
                .map(|value| text(value).to_owned()),
            content_type: Some("application/json".to_owned()),
            body: body.into_bytes(),
        })
    }

    fn path_of<'a>(&self, request: &'a HttpRequest) -> &'a str {
        let rest = request.url.strip_prefix(&self.base).unwrap();
        rest.split_once('?').map_or(rest, |(path, _)| path)
    }

    /// Method, path, query, the `Authorization` and `Content-Type` headers
    /// (without the boundary), and the body: its text, or for a multipart
    /// body its boundary (`{now}` for the clock) and its bytes with the
    /// boundary as `{boundary}`.
    fn request_line(&self, request: &HttpRequest) -> String {
        let query = request.url.split_once('?').map_or("", |(_, query)| query);
        let mut boundary = None;
        let mut headers: Vec<(String, String)> = request
            .headers
            .iter()
            .map(|(name, value)| {
                let mut value = value.clone();
                if let Some((kind, rest)) = value.split_once("; boundary=") {
                    boundary = Some(rest.to_owned());
                    value = kind.to_owned();
                }
                (name.to_ascii_lowercase(), value)
            })
            .collect();
        headers.sort();
        let body = request.body.as_ref().map(|body| match &boundary {
            Some(boundary) => format!(
                "multipart {} {}",
                boundary.replace(&self.now.to_string(), "{now}"),
                String::from_utf8(body.clone()).unwrap().replace(boundary.as_str(), "{boundary}")
            ),
            None => String::from_utf8(body.clone()).unwrap(),
        });
        format!("{} {} ?{query} {headers:?} {body:?}", request.method.as_str(), self.path_of(request))
    }
}

/// [`Script::request_line`] of a recorded request.
fn recorded_line(request: &Value) -> String {
    assert!(array(field(request, "query")).is_empty());
    let mut headers: Vec<(String, String)> = field(request, "headers")
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| (name.to_string_lossy().into_owned(), text(value).to_owned()))
        .collect();
    headers.sort();
    let body = get(request, "body").map(|body| match get(body, "multipart") {
        Some(multipart) => format!(
            "multipart {} {}",
            text(field(multipart, "boundary")),
            String::from_utf8(node_base64_decode(text(field(multipart, "normalized")))).unwrap()
        ),
        None => text(field(body, "text")).to_owned(),
    });
    format!("{} {} ? {headers:?} {body:?}", text(field(request, "method")), text(field(request, "path")))
}

/// The JSON file the recorded multipart requests of a step carry: the
/// recorded export JSON (all of them are the same).
fn sent_json(step: &Value) -> Option<String> {
    let mut sent = array(field(step, "requests")).iter().filter_map(|request| {
        let multipart = get(field(request, "body"), "multipart")?;
        array(field(multipart, "parts"))
            .iter()
            .find(|part| text(field(part, "headers")).contains("name=\"json\""))
            .map(|part| text(field(part, "text")).to_owned())
    });
    let first = sent.next()?;
    assert!(sent.all(|other| other == first));
    Some(first)
}

fn seed(user_data: &Path, tree: &Value) {
    for (path, content) in tree.as_object().unwrap().iter() {
        let path = user_data.join(path.to_string_lossy().as_ref());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text(content)).unwrap();
    }
}

/// The entry the read must give: the index entry's label and save time and
/// the text of its body, from the recorded tree.
fn tree_entry(tree: &Value, ty: &str, entry_id: &str) -> String {
    let dir = format!("sync/favorites/{ty}");
    let index = parse(text(field(tree, &format!("{dir}/index.json")))).unwrap();
    let entry = array(field(&index, "entries"))
        .iter()
        .find(|entry| {
            get(entry, "id").and_then(Value::as_str) == Some(entry_id) && get(entry, "deletedAt").is_none()
        })
        .unwrap();
    let mut out = Object::new();
    for key in ["label", "savedAt"] {
        if let Some(value) = get(entry, key) {
            out.insert(key, value.clone());
        }
    }
    let body = field(tree, &format!("{dir}/{}", text(field(entry, "filename"))));
    out.insert("body", body.clone());
    stringify(&Value::Object(out))
}

fn failure(message: String) -> Value {
    Value::Object([("success", Value::Bool(false)), ("error", Value::from(message))].into_iter().collect())
}

#[test]
fn the_favorite_scenarios_match_the_golden() {
    let f = fixture("ts_hub_handlers_favorite.json");
    let base = text(field(&f, "hubBase")).to_owned();
    let now = number(field(&f, "nowMs")).unwrap();
    let scenarios = array(field(&f, "scenarios"));
    assert_eq!(scenarios.len(), 4);
    let mut failures = Vec::new();
    let mut posted = 0;
    for scenario in scenarios {
        let name = text(field(scenario, "name"));
        let tree = field(scenario, "treeBefore");
        assert_eq!(stringify(tree), stringify(field(scenario, "treeAfter")), "{name}");
        let user_data = tempfile::tempdir().unwrap();
        seed(user_data.path(), tree);
        let sync_dir = user_data.path().join("sync");

        let rules = array(field(scenario, "rules"))
            .iter()
            .map(|rule| {
                assert!(
                    get(rule, "query").is_none()
                        && get(rule, "body").is_none()
                        && get(rule, "repeat").is_none()
                );
                Rule {
                    method: text(field(rule, "method")).to_owned(),
                    path: text(field(rule, "path")).to_owned(),
                    responses: array(field(rule, "responses")).clone(),
                    used: 0,
                }
            })
            .collect();
        let script = Arc::new(Script {
            base: base.clone(),
            now: now as i64,
            rules: Mutex::new(rules),
            seen: Mutex::new(Vec::new()),
        });
        let answering = Arc::clone(&script);
        let requester = move |request: HttpRequest| answering.answer(request);
        let clock = Arc::new(Clock { now, slept: Mutex::new(Vec::new()) });
        let http = HubHttp::new(base.clone(), HubRequesters::single(Arc::new(requester)), clock.clone());
        let token = HubToken::new(http, Arc::new(|| Some("fixture-google-id-token".to_owned())));

        for (index, step) in array(field(scenario, "steps")).iter().enumerate() {
            for key in ["notified", "events", "logs"] {
                assert!(array(field(step, key)).is_empty(), "{name} #{index}: {key}");
            }
            script.seen.lock().unwrap().clear();
            clock.slept.lock().unwrap().clear();
            let action = field(step, "step");
            let call = text(field(action, "call"));
            let params = &array(field(action, "args"))[0];
            let checked = match call {
                "HUB_UPDATE_FAVORITE_POST" => {
                    check_post_id(Some(params)).and_then(|_| check_post(Some(params)))
                }
                _ => check_post(Some(params)),
            };
            let read = checked
                .map_err(|err| err.message)
                .and_then(|_| read_entry(&sync_dir, get(params, "type"), get(params, "entryId")));
            let answer = match read {
                Err(message) => failure(message),
                Ok(entry) => {
                    let ty = text(field(params, "type"));
                    let expected = tree_entry(tree, ty, text(field(params, "entryId")));
                    if stringify(&entry) != expected {
                        failures
                            .push(format!("{name} #{index}: read {} expected {expected}", stringify(&entry)));
                    }
                    let json = sent_json(step).unwrap_or_else(|| panic!("{name} #{index}: nothing was sent"));
                    posted += 1;
                    block_on(async {
                        match call {
                            "HUB_UPLOAD_FAVORITE_POST" => favorite::upload(&token, Some(params), &json).await,
                            "HUB_UPDATE_FAVORITE_POST" => favorite::update(&token, Some(params), &json).await,
                            "HUB_UPLOAD_PRIVATE_FAVORITE_POST" => {
                                favorite::upload_private(&token, Some(params), &json).await
                            }
                            other => panic!("not a favorite call: {other}"),
                        }
                    })
                }
            };
            let recorded = field(step, "answer");
            if stringify(&answer) != stringify(recorded) {
                failures.push(format!(
                    "{name} #{index}: {} expected {}",
                    stringify(&answer),
                    stringify(recorded)
                ));
            }
            let seen = script.seen.lock().unwrap().clone();
            let expected: Vec<String> = array(field(step, "requests")).iter().map(recorded_line).collect();
            if seen != expected {
                failures.push(format!("{name} #{index}: requests {seen:#?} expected {expected:#?}"));
            }
            let slept: Vec<f64> =
                clock.slept.lock().unwrap().iter().map(|wait| wait.as_secs_f64() * 1000.0).collect();
            let expected_sleeps: Vec<f64> =
                array(field(step, "sleeps")).iter().map(|ms| number(ms).unwrap()).collect();
            if slept != expected_sleeps {
                failures.push(format!("{name} #{index}: sleeps {slept:?} expected {expected_sleeps:?}"));
            }
        }
        for rule in script.rules.lock().unwrap().iter() {
            if rule.used != rule.responses.len() {
                failures.push(format!("{name}: {} {} answered {} times", rule.method, rule.path, rule.used));
            }
        }
    }
    assert_eq!(posted, 13);
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

/// A recorded input: `None` for `undefined`, the tagged numbers as numbers.
fn tagged_input(value: &Value) -> Option<Value> {
    match get(value, "$u") {
        Some(_) => None,
        None if get(value, "$n").is_some() => Some(Value::Number(number(value).unwrap())),
        None => Some(value.clone()),
    }
}

#[test]
fn the_hub_vial_protocol_check_matches_the_golden() {
    let f = fixture("ts_hub_pure.json");
    let cases = array(field(&f, "isValidHubVialProtocol"));
    assert!(cases.len() >= 13);
    for case in cases {
        let input = tagged_input(field(case, "input"));
        let ok = field(case, "ok") == &Value::Bool(true);
        assert_eq!(is_valid_hub_vial_protocol(input.as_ref()), ok, "{}", stringify(case));
    }
}
