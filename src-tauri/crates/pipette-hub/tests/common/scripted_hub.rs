// SPDX-License-Identifier: GPL-2.0-or-later
//! The scripted Hub of the handler scenarios, the requests as comparable
//! lines, and the userData of a scenario: seeded from the recorded tree
//! before, compared with the recorded tree after.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use pipette_entry_store::{FixedClock, WriteLocks};
use pipette_hub::{HubHttp, HubRequesters, node_base64_decode};
use pipette_js_json::{Value, stringify};
use pipette_keyboard_stores::StoreContext;
use pipette_net::{HttpError, HttpReply, HttpRequest};

use super::{Clock, array, field, get, number, text};

/// A rule of the scripted Hub: the requests it answers (method, path, and
/// the query and body when the rule names them) and its answers in turn.
pub struct Rule {
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

pub struct Script {
    base: String,
    rules: Mutex<Vec<Rule>>,
    /// Every request so far, as [`request_line`] writes it.
    pub seen: Mutex<Vec<String>>,
    /// Every request so far, as it was sent.
    pub sent: Mutex<Vec<HttpRequest>>,
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
        self.sent.lock().unwrap().push(request.clone());
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

/// The scripted Hub of a scenario's `rules` on `base`, and a client on it
/// whose clock stands at `now` and records its sleeps.
pub struct ScriptedHub {
    pub script: Arc<Script>,
    pub clock: Arc<Clock>,
    pub http: HubHttp,
}

pub fn scripted_hub(base: &str, now: f64, rules: &Value) -> ScriptedHub {
    let script = Arc::new(Script {
        base: base.to_owned(),
        rules: Mutex::new(array(rules).iter().map(Rule::of).collect()),
        seen: Mutex::new(Vec::new()),
        sent: Mutex::new(Vec::new()),
    });
    let answering = Arc::clone(&script);
    let requester = move |request: HttpRequest| answering.answer(request);
    let clock = Arc::new(Clock { now, slept: Mutex::new(Vec::new()) });
    let http = HubHttp::new(base, HubRequesters::single(Arc::new(requester)), clock.clone());
    ScriptedHub { script, clock, http }
}

/// A request as one comparable line: method, path, the query's pairs (in
/// any order: the recorder writes them sorted), the `Authorization` and
/// `Content-Type` headers (without a multipart boundary) and the body, a
/// multipart body with its boundary as `{boundary}`.
pub fn request_line(request: &HttpRequest, base: &str) -> String {
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
pub fn recorded_line(request: &Value) -> String {
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

/// The stores of a scenario on `dir`, at the fixed time `now`, and the
/// sync units they report.
pub fn scenario_stores(dir: &Path, now: f64) -> (StoreContext, Arc<Mutex<Vec<String>>>) {
    let notified = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&notified);
    let stores = StoreContext::new(
        dir,
        Arc::new(FixedClock::new(now as i64)),
        Arc::new(WriteLocks::new()),
        Arc::new(move |unit: &str| record.lock().unwrap().push(unit.to_owned())),
    );
    (stores, notified)
}

/// The userData files under `dir`, by their path from it.
pub fn tree(dir: &Path) -> BTreeMap<String, String> {
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

/// A recorded userData tree (path → text).
pub fn recorded_tree(value: &Value) -> BTreeMap<String, String> {
    value
        .as_object()
        .unwrap()
        .iter()
        .map(|(path, content)| (path.to_string_lossy().into_owned(), text(content).to_owned()))
        .collect()
}

/// Writes a recorded userData tree under `dir`.
pub fn seed(dir: &Path, value: &Value) {
    for (path, content) in recorded_tree(value) {
        let target = dir.join(path);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, content).unwrap();
    }
}

pub fn sorted(mut list: Vec<String>) -> Vec<String> {
    list.sort();
    list
}
