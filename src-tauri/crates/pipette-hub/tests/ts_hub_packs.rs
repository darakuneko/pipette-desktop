// SPDX-License-Identifier: GPL-2.0-or-later
//! The language and theme pack handlers against the Electron ones:
//!
//! - the `validatePack` and `validateI18nExport` tables of
//!   ts_hub_pure.json;
//! - the scenarios of ts_hub_handlers_i18n_packs.json and
//!   ts_hub_handlers_theme_packs.json: the recorded userData is seeded, the
//!   scripted Hub answers the Rust handlers, which must give the same
//!   answers, send the same requests (multipart bodies with the boundary
//!   written as `{boundary}`), wait the same waits, report the same sync
//!   units and leave the same userData. The pack handlers broadcast nothing
//!   and log nothing; the fixtures are checked to record none of that.

#![allow(clippy::unwrap_used)]

mod common;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use common::{Clock, array, block_on, field, fixture, get, number, text};
use pipette_entry_store::{FixedClock, WriteLocks};
use pipette_hub::packs::{self, PackKind, validate_i18n_export};
use pipette_hub::token::HubToken;
use pipette_hub::{HubHttp, HubRequesters, node_base64_decode};
use pipette_js_json::{JsString, Object, Value, stringify};
use pipette_keyboard_stores::StoreContext;
use pipette_net::{HttpError, HttpReply, HttpRequest};
use pipette_pack_stores::i18n_validate::validate_pack;

fn strings(list: &[JsString]) -> Value {
    Value::Array(list.iter().cloned().map(Value::String).collect())
}

#[test]
fn validate_pack_matches_the_ts() {
    let golden = fixture("ts_hub_pure.json");
    let cases = array(field(&golden, "validatePack"));
    assert_eq!(cases.len(), 36);
    let mut failures = Vec::new();
    for case in cases {
        let check = validate_pack(Some(field(case, "input")));
        let mut actual = Object::new();
        actual.insert("ok", Value::Bool(check.ok()));
        actual.insert("errors", strings(&check.errors));
        actual.insert("warnings", strings(&check.warnings));
        actual.insert("dangerousKeys", strings(&check.dangerous_keys));
        if let Some((name, version)) = &check.header {
            let header: Object =
                [("name", Value::String(name.clone())), ("version", Value::String(version.clone()))]
                    .into_iter()
                    .collect();
            actual.insert("header", Value::Object(header));
        }
        let (actual, expected) = (stringify(&Value::Object(actual)), stringify(field(case, "ok")));
        if actual != expected {
            failures.push(format!("{}: {actual} expected {expected}", stringify(field(case, "input"))));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn validate_i18n_export_matches_the_ts() {
    let golden = fixture("ts_hub_pure.json");
    let cases = array(field(&golden, "validateI18nExport"));
    assert_eq!(cases.len(), 18);
    let mut failures = Vec::new();
    for case in cases {
        let check = validate_i18n_export(Some(field(case, "input")));
        let mut actual = Object::new();
        actual.insert("ok", Value::Bool(check.ok()));
        if let Some(reason) = &check.reason {
            actual.insert("reason", Value::String(reason.clone()));
        }
        actual.insert("warnings", strings(&check.warnings));
        let (actual, expected) = (stringify(&Value::Object(actual)), stringify(field(case, "ok")));
        if actual != expected {
            failures.push(format!("{}: {actual} expected {expected}", stringify(field(case, "input"))));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

/// A rule of the scripted Hub (hub-harness.ts `HubRule`).
struct Rule {
    method: String,
    path: String,
    query: Option<String>,
    body: Option<String>,
    responses: Vec<Value>,
    repeat: bool,
    used: usize,
}

impl Rule {
    fn of(rule: &Value) -> Self {
        Rule {
            method: text(field(rule, "method")).to_owned(),
            path: text(field(rule, "path")).to_owned(),
            query: get(rule, "query").map(|query| text(query).to_owned()),
            body: get(rule, "body").map(stringify),
            responses: array(field(rule, "responses")).clone(),
            repeat: get(rule, "repeat").is_some_and(Value::is_truthy),
            used: 0,
        }
    }
}

struct Script {
    base: String,
    rules: Mutex<Vec<Rule>>,
    seen: Mutex<Vec<String>>,
}

impl Script {
    /// The first rule whose method, path, query and body match and that
    /// has answers left answers; the last answer of a `repeat` rule
    /// repeats.
    fn answer(&self, request: HttpRequest) -> Result<HttpReply, HttpError> {
        let rest = request.url.strip_prefix(&self.base).unwrap();
        let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
        let body = request.body.as_ref().map(|body| String::from_utf8_lossy(body).into_owned());
        self.seen.lock().unwrap().push(request_line(&request, &self.base));
        let response = {
            let mut rules = self.rules.lock().unwrap();
            let rule = rules
                .iter_mut()
                .find(|rule| {
                    rule.method == request.method.as_str()
                        && rule.path == path
                        && rule.query.as_ref().is_none_or(|q| q == query)
                        && rule.body.as_ref().is_none_or(|b| body.as_ref() == Some(b))
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

/// A request as one comparable line: method, path, the query's pairs (in
/// any order: the recorder writes them sorted), the
/// `Authorization` and `Content-Type` headers (without a multipart
/// boundary) and the body, a multipart body with its boundary as
/// `{boundary}`.
fn request_line(request: &HttpRequest, base: &str) -> String {
    let rest = request.url.strip_prefix(base).unwrap();
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let mut boundary = None;
    let mut headers: Vec<(String, String)> = request
        .headers
        .iter()
        .map(|(name, value)| match value.split_once("; boundary=") {
            Some((kind, found)) => {
                boundary = Some(found.to_owned());
                (name.to_ascii_lowercase(), kind.to_owned())
            }
            None => (name.to_ascii_lowercase(), value.clone()),
        })
        .collect();
    headers.sort();
    let body = request.body.as_ref().map(|body| {
        let body = String::from_utf8(body.clone()).unwrap();
        match &boundary {
            Some(boundary) => body.replace(boundary.as_str(), "{boundary}"),
            None => body,
        }
    });
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
    let body = get(request, "body").map(|body| match get(body, "multipart") {
        Some(multipart) => {
            String::from_utf8(node_base64_decode(text(field(multipart, "normalized")))).unwrap()
        }
        None => text(field(body, "text")).to_owned(),
    });
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
fn arg(args: &[Value], index: usize) -> Option<&Value> {
    args.get(index).filter(|value| get(value, "$u").is_none())
}

async fn run_call(token: &HubToken, stores: &StoreContext, call: &str, args: &[Value]) -> Value {
    let http = token.http();
    let (a, b) = (arg(args, 0), arg(args, 1));
    match call {
        "HUB_UPLOAD_I18N_POST" => packs::upload(token, stores, PackKind::I18n, a).await,
        "HUB_UPDATE_I18N_POST" => packs::update(token, stores, PackKind::I18n, a).await,
        "HUB_DELETE_I18N_POST" => packs::delete(token, stores, PackKind::I18n, a, b).await,
        "HUB_LIST_I18N_POSTS" => packs::list(http, PackKind::I18n, a).await,
        "HUB_DOWNLOAD_I18N_POST" => packs::download(http, PackKind::I18n, a).await,
        "HUB_I18N_PACK_TIMESTAMPS" => packs::timestamps(http, PackKind::I18n, a).await,
        "HUB_UPLOAD_THEME_POST" => packs::upload(token, stores, PackKind::Theme, a).await,
        "HUB_UPDATE_THEME_POST" => packs::update(token, stores, PackKind::Theme, a).await,
        "HUB_DELETE_THEME_POST" => packs::delete(token, stores, PackKind::Theme, a, b).await,
        "HUB_LIST_THEME_POSTS" => packs::list(http, PackKind::Theme, a).await,
        "HUB_DOWNLOAD_THEME_POST" => packs::download(http, PackKind::Theme, a).await,
        "HUB_THEME_PACK_TIMESTAMPS" => packs::timestamps(http, PackKind::Theme, a).await,
        other => panic!("not a pack call: {other}"),
    }
}

fn sorted(mut list: Vec<String>) -> Vec<String> {
    list.sort();
    list
}

fn check_scenarios(name: &str, scenario_count: usize) {
    let f = fixture(name);
    let base = text(field(&f, "hubBase")).to_owned();
    let now = number(field(&f, "nowMs")).unwrap();
    let scenarios = array(field(&f, "scenarios"));
    assert_eq!(scenarios.len(), scenario_count);
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
            rules: Mutex::new(array(field(scenario, "rules")).iter().map(Rule::of).collect()),
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
            // The batches of a timestamps call go out together; the
            // recorder writes what they did sorted.
            let unordered = text(field(action, "call")).ends_with("_PACK_TIMESTAMPS");
            let answer = block_on(run_call(
                &token,
                &stores,
                text(field(action, "call")),
                array(field(action, "args")),
            ));
            let expected = stringify(field(step, "answer"));
            if stringify(&answer) != expected {
                failures.push(format!("{name} #{index}: {} expected {expected}", stringify(&answer)));
            }
            let mut seen = script.seen.lock().unwrap().clone();
            let mut expected: Vec<String> =
                array(field(step, "requests")).iter().map(recorded_line).collect();
            let mut units = notified.lock().unwrap().clone();
            let mut expected_units: Vec<String> =
                array(field(step, "notified")).iter().map(|unit| text(unit).to_owned()).collect();
            if unordered {
                (seen, expected) = (sorted(seen), sorted(expected));
                (units, expected_units) = (sorted(units), sorted(expected_units));
            }
            if seen != expected {
                failures.push(format!("{name} #{index}: requests {seen:#?} expected {expected:#?}"));
            }
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

#[test]
fn the_language_pack_scenarios_match_the_ts() {
    check_scenarios("ts_hub_handlers_i18n_packs.json", 8);
}

#[test]
fn the_theme_pack_scenarios_match_the_ts() {
    check_scenarios("ts_hub_handlers_theme_packs.json", 3);
}
