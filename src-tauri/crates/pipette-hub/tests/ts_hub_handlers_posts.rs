// SPDX-License-Identifier: GPL-2.0-or-later
//! The keymap post and private post scenarios recorded from the Electron
//! Hub handlers (ts_hub_handlers_posts.json, ts_hub_handlers_private.json):
//! each scenario's scripted Hub answers the Rust handlers, which must give
//! the same answers, send the same requests (a multipart body byte for
//! byte, with its boundary from the fixed clock) and wait the same 429
//! waits. These handlers write nothing to the userData, notify nothing and
//! log nothing; the fixtures are checked to record none of that.

#![allow(clippy::unwrap_used)]

mod common;

use std::sync::{Arc, Mutex};

use common::{Clock, Input, array, block_on, field, fixture, get, input, number, text};
use pipette_hub::posts::{self, KeymapPostParams, MyPostsParams};
use pipette_hub::private;
use pipette_hub::token::HubToken;
use pipette_hub::{BoxFuture, HubHttp, HubRequesters, IdTokenSource, node_base64_decode};
use pipette_js_json::{Value, js_string, stringify};
use pipette_net::{HttpError, HttpReply, HttpRequest};
use zeroize::Zeroizing;

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
    now: f64,
    rules: Mutex<Vec<Rule>>,
    seen: Mutex<Vec<Vec<u8>>>,
}

impl Script {
    /// The first rule whose method and path match and that has answers
    /// left answers; the last answer of a `repeat` rule repeats.
    fn answer(&self, request: HttpRequest) -> Result<HttpReply, HttpError> {
        let (method, path) = (request.method.as_str().to_owned(), path_of(&request, &self.base));
        self.seen.lock().unwrap().push(self.request_line(&request));
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
            .map(|v| text(v).to_owned());
        Ok(HttpReply {
            status: number(field(&response, "status")).unwrap() as u16,
            retry_after,
            content_type: Some("application/json".to_owned()),
            body: body.into_bytes(),
        })
    }

    /// A request as comparable bytes: method, path, query, the
    /// `Authorization` and `Content-Type` headers (the boundary checked and
    /// cut off) and the body, with a multipart boundary written
    /// `{boundary}`.
    fn request_line(&self, request: &HttpRequest) -> Vec<u8> {
        let rest = request.url.strip_prefix(&self.base).unwrap();
        // The query as its decoded pairs, which is what the fixture records.
        let query = rest.split_once('?').map_or("", |(_, query)| query);
        let query: String = form_urlencoded::Serializer::new(String::new())
            .extend_pairs(form_urlencoded::parse(query.as_bytes()))
            .finish();
        let mut boundary = None;
        let mut headers: Vec<(String, String)> = request
            .headers
            .iter()
            .map(|(name, value)| {
                let name = name.to_ascii_lowercase();
                match value.split_once("; boundary=") {
                    Some((content_type, cut)) => {
                        boundary = Some(cut.to_owned());
                        (name, content_type.to_owned())
                    }
                    None => (name, value.clone()),
                }
            })
            .collect();
        headers.sort();
        let mut line =
            format!("{} {} ?{query} {headers:?} ", request.method.as_str(), path_of(request, &self.base))
                .into_bytes();
        match (&request.body, boundary) {
            (None, _) => line.extend_from_slice(b"<none>"),
            (Some(body), None) => line.extend_from_slice(body),
            (Some(body), Some(boundary)) => {
                assert_eq!(boundary, format!("----PipetteBoundary{}", self.now));
                line.extend_from_slice(&replace(body, boundary.as_bytes(), b"{boundary}"));
            }
        }
        line
    }
}

fn replace(haystack: &[u8], needle: &[u8], with: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(haystack.len());
    let mut rest = haystack;
    while let Some(at) = rest.windows(needle.len()).position(|window| window == needle) {
        out.extend_from_slice(&rest[..at]);
        out.extend_from_slice(with);
        rest = &rest[at + needle.len()..];
    }
    out.extend_from_slice(rest);
    out
}

fn path_of(request: &HttpRequest, base: &str) -> String {
    let rest = request.url.strip_prefix(base).unwrap();
    rest.split_once('?').map_or(rest, |(path, _)| path).to_owned()
}

/// [`Script::request_line`] of a recorded request.
fn recorded_line(request: &Value) -> Vec<u8> {
    let query: Vec<String> = array(field(request, "query"))
        .iter()
        .map(|pair| {
            let pair = array(pair);
            form_urlencoded::Serializer::new(String::new())
                .append_pair(text(&pair[0]), text(&pair[1]))
                .finish()
        })
        .collect();
    let mut headers: Vec<(String, String)> = field(request, "headers")
        .as_object()
        .unwrap()
        .iter()
        .map(|(name, value)| (name.to_string_lossy().into_owned(), text(value).to_owned()))
        .collect();
    headers.sort();
    let mut line = format!(
        "{} {} ?{} {headers:?} ",
        text(field(request, "method")),
        text(field(request, "path")),
        query.join("&"),
    )
    .into_bytes();
    match get(request, "body") {
        None => line.extend_from_slice(b"<none>"),
        Some(body) => match get(body, "multipart") {
            Some(multipart) => line.extend(node_base64_decode(text(field(multipart, "normalized")))),
            None => line.extend_from_slice(text(field(body, "text")).as_bytes()),
        },
    }
    line
}

struct IdTokens;

impl IdTokenSource for IdTokens {
    fn id_token(&self) -> BoxFuture<'_, Option<Zeroizing<String>>> {
        Box::pin(std::future::ready(Some(Zeroizing::new("fixture-google-id-token".to_owned()))))
    }
}

/// A recorded string argument; `None` for a value that is not a string.
fn string(value: Option<&Value>) -> Option<String> {
    match input(value?) {
        Input::Text(text) => Some(text),
        Input::LoneSurrogate => panic!("a lone surrogate cannot reach a command"),
        Input::NotAString => None,
    }
}

/// The text inputs of a recorded `HubUploadPostParams`.
struct PostStrings([Option<String>; 7]);

impl PostStrings {
    fn of(params: &Value) -> Self {
        let keys =
            ["title", "keyboardName", "vilJson", "pipetteJson", "keymapC", "pdfBase64", "thumbnailBase64"];
        Self(keys.map(|key| string(get(params, key))))
    }

    fn params(&self) -> KeymapPostParams<'_> {
        let [title, keyboard_name, vil_json, pipette_json, keymap_c, pdf_base64, thumbnail_base64] =
            self.0.each_ref().map(Option::as_deref);
        KeymapPostParams {
            title,
            keyboard_name,
            vil_json,
            pipette_json,
            keymap_c,
            pdf_base64,
            thumbnail_base64,
        }
    }
}

/// A recorded number argument: `None` for an absent one or one that is
/// not a number.
fn opt_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(_) | Value::Null => number(value?),
        Value::Object(object) if object.contains_key("$n") || object.contains_key("$u") => number(value?),
        _ => None,
    }
}

async fn run_call(token: &HubToken, call: &str, args: &[Value]) -> Value {
    let arg = args.first();
    match call {
        "HUB_UPLOAD_POST" => {
            let strings = PostStrings::of(arg.unwrap());
            posts::upload_post(token, strings.params()).await
        }
        "HUB_UPDATE_POST" => {
            let params = arg.unwrap();
            let strings = PostStrings::of(params);
            let post_id = string(get(params, "postId"));
            posts::update_post(token, post_id.as_deref(), strings.params()).await
        }
        "HUB_PATCH_POST" => {
            let params = arg.unwrap();
            let (post_id, title) = (string(get(params, "postId")), string(get(params, "title")));
            posts::patch_post(token, post_id.as_deref(), title.as_deref()).await
        }
        "HUB_DELETE_POST" => posts::delete_post(token, string(arg).as_deref()).await,
        "HUB_FETCH_MY_POSTS" => {
            let params = MyPostsParams {
                page: arg.and_then(|params| opt_number(get(params, "page"))),
                per_page: arg.and_then(|params| opt_number(get(params, "per_page"))),
            };
            posts::fetch_my_posts(token, params).await
        }
        "HUB_FETCH_MY_KEYBOARD_POSTS" => posts::fetch_my_keyboard_posts(token, string(arg).as_deref()).await,
        "HUB_UPLOAD_PRIVATE_POST" => {
            let params = arg.unwrap();
            let strings = PostStrings::of(params);
            private::upload_private_post(token, strings.params(), opt_number(get(params, "expiresInDays")))
                .await
        }
        "HUB_DELETE_PRIVATE_POST" => {
            let kind = js_string(arg);
            private::delete_private_post(token, &kind, string(args.get(1)).as_deref()).await
        }
        other => panic!("not a posts call: {other}"),
    }
}

fn run_fixture(name: &str, scenario_count: usize) {
    let f = fixture(name);
    let base = text(field(&f, "hubBase")).to_owned();
    let now = number(field(&f, "nowMs")).unwrap();
    let mut failures = Vec::new();
    let scenarios = array(field(&f, "scenarios"));
    assert_eq!(scenarios.len(), scenario_count);
    for scenario in scenarios {
        let name = text(field(scenario, "name"));
        assert_eq!(
            stringify(field(scenario, "treeBefore")),
            stringify(field(scenario, "treeAfter")),
            "{name}"
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
        let token = HubToken::new(http, Arc::new(IdTokens));

        for (index, step) in array(field(scenario, "steps")).iter().enumerate() {
            for key in ["notified", "events", "logs"] {
                assert!(array(field(step, key)).is_empty(), "{name} #{index}: {key}");
            }
            script.seen.lock().unwrap().clear();
            clock.slept.lock().unwrap().clear();
            let action = field(step, "step");
            let recorded = field(step, "answer");
            let answer =
                block_on(run_call(&token, text(field(action, "call")), array(field(action, "args"))));
            if stringify(&answer) != stringify(recorded) {
                failures.push(format!(
                    "{name} #{index}: {} expected {}",
                    stringify(&answer),
                    stringify(recorded)
                ));
            }
            let seen = script.seen.lock().unwrap().clone();
            let expected: Vec<Vec<u8>> = array(field(step, "requests")).iter().map(recorded_line).collect();
            if seen != expected {
                let lossy = |lines: &[Vec<u8>]| -> Vec<String> {
                    lines.iter().map(|line| String::from_utf8_lossy(line).into_owned()).collect()
                };
                failures.push(format!(
                    "{name} #{index}: requests {:#?} expected {:#?}",
                    lossy(&seen),
                    lossy(&expected)
                ));
            }
            let slept: Vec<f64> =
                clock.slept.lock().unwrap().iter().map(|wait| wait.as_secs_f64() * 1000.0).collect();
            let expected_sleeps: Vec<f64> =
                array(field(step, "sleeps")).iter().map(|ms| number(ms).unwrap()).collect();
            if slept != expected_sleeps {
                failures.push(format!("{name} #{index}: sleeps {slept:?} expected {expected_sleeps:?}"));
            }
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn the_keymap_post_scenarios_match_the_ts() {
    run_fixture("ts_hub_handlers_posts.json", 6);
}

#[test]
fn the_private_post_scenarios_match_the_ts() {
    run_fixture("ts_hub_handlers_private.json", 2);
}
