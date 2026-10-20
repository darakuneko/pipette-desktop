// SPDX-License-Identifier: GPL-2.0-or-later
//! The recorded golden account scenarios of the Hub handlers
//! (ts_hub_handlers_account.json): each scenario's scripted Hub answers the
//! Rust handlers, which must give the same answers, send the same requests
//! and wait the same 429 waits. The account handlers write nothing to the
//! userData, notify nothing and log nothing; the fixture is checked to
//! record none of that.

#![allow(clippy::unwrap_used)]

mod common;

use std::sync::{Arc, Mutex, OnceLock};

use common::{Clock, array, block_on, field, fixture, get, number, text};
use pipette_hub::account;
use pipette_hub::posts::{self, MyPostsParams};
use pipette_hub::token::HubToken;
use pipette_hub::{BoxFuture, HubHttp, HubRequesters, IdTokenSource};
use pipette_js_json::{Value, stringify};
use pipette_net::{HttpError, HttpReply, HttpRequest};
use zeroize::Zeroizing;

/// A rule of the scripted Hub.
struct Rule {
    method: String,
    path: String,
    responses: Vec<Value>,
    repeat: bool,
    used: usize,
}

struct Script {
    rules: Mutex<Vec<Rule>>,
    seen: Mutex<Vec<String>>,
    token: OnceLock<Arc<HubToken>>,
}

impl Script {
    /// The first rule whose method and path match and that has answers
    /// left answers; the last answer of a `repeat` rule repeats.
    fn answer(&self, request: HttpRequest, base: &str) -> Result<HttpReply, HttpError> {
        let line = request_line(&request, base);
        let (method, path) = (request.method.as_str().to_owned(), path_of(&request, base));
        self.seen.lock().unwrap().push(line);
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
        if let Some(during) = get(&response, "during") {
            assert_eq!(text(during), "clearHubTokenCache");
            self.token.get().unwrap().clear();
        }
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

fn path_of(request: &HttpRequest, base: &str) -> String {
    let rest = request.url.strip_prefix(base).unwrap();
    rest.split_once('?').map_or(rest, |(path, _)| path).to_owned()
}

/// A request as one comparable line: method, path, query, the
/// `Authorization` and `Content-Type` headers and the body text.
fn request_line(request: &HttpRequest, base: &str) -> String {
    let rest = request.url.strip_prefix(base).unwrap();
    let query = rest.split_once('?').map_or("", |(_, query)| query);
    let mut headers: Vec<(String, String)> =
        request.headers.iter().map(|(name, value)| (name.to_ascii_lowercase(), value.clone())).collect();
    headers.sort();
    let body = request.body.as_ref().map(|body| String::from_utf8(body.clone()).unwrap());
    format!("{} {} ?{query} {headers:?} {body:?}", request.method.as_str(), path_of(request, base))
}

/// [`request_line`] of a recorded request.
fn recorded_line(request: &Value) -> String {
    let query: Vec<String> = array(field(request, "query"))
        .iter()
        .map(|pair| {
            let pair = array(pair);
            form_pair(text(&pair[0]), text(&pair[1]))
        })
        .collect();
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

fn form_pair(key: &str, value: &str) -> String {
    form_urlencoded::Serializer::new(String::new()).append_pair(key, value).finish()
}

/// The id_token the scenario's Google answers (`None`: signed out).
struct IdTokens(Mutex<Option<String>>);

impl IdTokenSource for IdTokens {
    fn id_token(&self) -> BoxFuture<'_, Option<Zeroizing<String>>> {
        let token = self.0.lock().unwrap().clone().map(Zeroizing::new);
        Box::pin(std::future::ready(token))
    }
}

/// The answer of `call`, or `None` for a handler that answers nothing.
async fn run_call(token: &HubToken, call: &str, args: &[Value]) -> Option<Value> {
    let arg = args.first().and_then(Value::as_str);
    Some(match call {
        "HUB_GET_ORIGIN" => Value::from(account::origin(token.http())),
        "HUB_SET_AUTH_DISPLAY_NAME" => {
            account::set_auth_display_name(token, arg);
            return None;
        }
        "HUB_FETCH_AUTH_ME" => account::fetch_auth_me(token).await,
        "HUB_PATCH_AUTH_ME" => account::patch_auth_me(token, arg).await,
        // The posts handler of the token failure scenario.
        "HUB_FETCH_MY_POSTS" => {
            assert!(args.is_empty());
            posts::fetch_my_posts(token, MyPostsParams::default()).await
        }
        other => panic!("not an account call: {other}"),
    })
}

fn same_answer(actual: Option<&Value>, recorded: &Value) -> bool {
    match actual {
        None => get(recorded, "$u").is_some(),
        Some(actual) => stringify(actual) == stringify(recorded),
    }
}

#[test]
fn the_account_scenarios_match_the_ts() {
    let f = fixture("ts_hub_handlers_account.json");
    let base = text(field(&f, "hubBase")).to_owned();
    let now = number(field(&f, "nowMs")).unwrap();
    let mut failures = Vec::new();
    let scenarios = array(field(&f, "scenarios"));
    assert_eq!(scenarios.len(), 14);
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
            rules: Mutex::new(rules),
            seen: Mutex::new(Vec::new()),
            token: OnceLock::new(),
        });
        let answering = Arc::clone(&script);
        let requester_base = base.clone();
        let requester = move |request: HttpRequest| answering.answer(request, &requester_base);
        let clock = Arc::new(Clock { now, slept: Mutex::new(Vec::new()) });
        let http = HubHttp::new(base.clone(), HubRequesters::single(Arc::new(requester)), clock.clone());
        let id_tokens = Arc::new(IdTokens(Mutex::new(Some("fixture-google-id-token".to_owned()))));
        let token = Arc::new(HubToken::new(http, id_tokens.clone()));
        script.token.set(Arc::clone(&token)).ok().unwrap();

        for (index, step) in array(field(scenario, "steps")).iter().enumerate() {
            for key in ["notified", "events", "logs"] {
                assert!(array(field(step, key)).is_empty(), "{name} #{index}: {key}");
            }
            script.seen.lock().unwrap().clear();
            clock.slept.lock().unwrap().clear();
            let action = field(step, "step");
            let recorded = field(step, "answer");
            if let Some(id_token) = get(action, "idToken") {
                *id_tokens.0.lock().unwrap() = id_token.as_str().map(str::to_owned);
            } else if get(action, "clearHubTokenCache").is_some() {
                token.clear();
            } else if let Some(together) = get(action, "together") {
                let calls: Vec<(&str, &Vec<Value>)> = array(together)
                    .iter()
                    .map(|call| (text(field(call, "call")), array(field(call, "args"))))
                    .collect();
                let answers = block_on(async {
                    let runs = calls.iter().map(|(call, args)| run_call(&token, call, args));
                    futures_util::future::join_all(runs).await
                });
                for (answer, recorded) in answers.iter().zip(array(recorded)) {
                    if !same_answer(answer.as_ref(), recorded) {
                        failures
                            .push(format!("{name} #{index}: {answer:?} expected {}", stringify(recorded)));
                    }
                }
            } else {
                let answer =
                    block_on(run_call(&token, text(field(action, "call")), array(field(action, "args"))));
                if !same_answer(answer.as_ref(), recorded) {
                    let actual = answer.as_ref().map(stringify);
                    failures.push(format!("{name} #{index}: {actual:?} expected {}", stringify(recorded)));
                }
            }
            let mut seen = script.seen.lock().unwrap().clone();
            let mut expected: Vec<String> =
                array(field(step, "requests")).iter().map(recorded_line).collect();
            if get(action, "together").is_some() {
                seen.sort();
                expected.sort();
            }
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
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
