// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the recorded golden scenarios of the language store:
//! the same userData files and HTTP replies, the same calls, then each
//! response, the URLs asked and every file left behind compared byte for
//! byte. Error texts that are the OS's or the JSON parser's are compared as
//! the fixture records them (`<os error>`, `<parse error>`).

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use common::{Harness, block_on, build, bytes_of, hex_bytes, recorded, tree_of};
use pipette_js_json::{Object, Value};
use pipette_net::{HttpError, HttpResponse};
use pipette_typing_datasets::DatasetError;

fn text(step: &Object, key: &str) -> String {
    step.get(key).unwrap().as_str().unwrap().to_owned()
}

fn queue_replies(h: &Harness, step: &Object) {
    let Some(Value::Array(replies)) = step.get("replies") else { return };
    for reply in replies {
        let reply = reply.as_object().unwrap();
        h.reply(match reply.get("error") {
            // String(new Error(message)) of the rejected fetch.
            Some(message) => Err(HttpError::Network(format!("Error: {}", message.as_str().unwrap()))),
            None => {
                let Some(Value::Number(status)) = reply.get("status") else { panic!("no status") };
                let body = match reply.get("hex") {
                    Some(hex) => hex_bytes(hex.as_str().unwrap()),
                    None => bytes_of(reply.get("body").unwrap()),
                };
                Ok(HttpResponse { status: *status as u16, body })
            }
        });
    }
}

fn action(result: Result<(), String>) -> String {
    let mut object = Object::new();
    object.insert("success", result.is_ok().into());
    if let Err(error) = result {
        let error = if error.starts_with("Error: ") && error.contains("(os error ") {
            "<os error>".to_owned()
        } else if error.starts_with("SyntaxError: ") {
            "<parse error>".to_owned()
        } else {
            error
        };
        object.insert("error", error.into());
    }
    pipette_js_json::stringify(&Value::Object(object))
}

fn rejected(err: DatasetError) -> String {
    pipette_js_json::stringify(&Value::Object(
        std::iter::once(("rejected", err.to_string().into())).collect(),
    ))
}

/// The response of the call, as JSON text; `None` for a restart.
fn run_step(h: &mut Harness, step: &Object) -> Option<String> {
    let provider = step.get("provider").map(|p| p.as_str().unwrap().to_owned());
    let provider = provider.as_deref();
    let name = || text(step, "name");
    queue_replies(h, step);
    let store = h.store.clone();
    Some(match text(step, "op").as_str() {
        "restart" => {
            h.restart();
            return None;
        }
        "list" => match block_on(store.list(provider)) {
            Ok(entries) => pipette_js_json::stringify(&Value::Array(entries)),
            Err(err) => rejected(err),
        },
        "get" => match block_on(store.get(&name(), provider)) {
            Ok(Some(text)) => pipette_js_json::stringify(&pipette_js_json::parse(&text).unwrap()),
            Ok(None) => "null".to_owned(),
            Err(err) => rejected(err),
        },
        "download" => action(block_on(store.download(&name(), provider))),
        "delete" => action(block_on(store.delete(&name(), provider))),
        "check" => match block_on(store.check(provider)) {
            Ok(check) => format!(
                "{{\"provider\":{},\"updateAvailable\":{}}}",
                pipette_js_json::stringify(&check.provider.as_str().into()),
                check.update_available
            ),
            Err(err) => rejected(err),
        },
        "update" => match block_on(store.update(provider)) {
            Ok(update) => update.to_json(),
            Err(err) => rejected(err),
        },
        op => panic!("unknown step {op}"),
    })
}

#[test]
fn the_scenarios_match_the_golden() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_language_store_scenarios.json");
    let fixture = pipette_js_json::parse(&fs::read_to_string(path).unwrap()).unwrap();
    let Value::Array(scenarios) = fixture else { panic!("not a list") };
    assert!(!scenarios.is_empty());
    for scenario in &scenarios {
        let scenario = scenario.as_object().unwrap();
        let name = text(scenario, "name");
        let mut h = Harness::new();
        let Some(Value::Array(steps)) = scenario.get("steps") else { panic!("{name}: no steps") };
        // A language is stored as `<name>.json`.
        let unheld = steps
            .iter()
            .filter_map(|step| {
                step.as_object().unwrap().get("name")?.as_str().map(|name| format!("{name}.json"))
            })
            .find(|file| !pipette_fs::test_util::host_holds_name(file));
        if let Some(file) = unheld {
            eprintln!("SKIPPED {name}: the file system cannot hold the name {file:?}");
            continue;
        }
        build(h.user_data(), &tree_of(scenario.get("tree").unwrap()));

        let Some(Value::Array(outcomes)) = scenario.get("outcomes") else { panic!("{name}: no outcomes") };
        assert_eq!(steps.len(), outcomes.len(), "{name}");
        for (at, (step, want)) in steps.iter().zip(outcomes).enumerate() {
            let got = run_step(&mut h, step.as_object().unwrap());
            assert_eq!(got.as_deref(), want.as_str(), "{name}: step {at}");
            assert_eq!(h.replies_left(), 0, "{name}: step {at} left replies");
        }

        let urls: Vec<String> = match scenario.get("urls") {
            Some(Value::Array(urls)) => urls.iter().map(|url| url.as_str().unwrap().to_owned()).collect(),
            other => panic!("{name}: urls {other:?}"),
        };
        assert_eq!(h.urls(), urls, "{name}: fetched URLs");
        let want: BTreeMap<_, _> = tree_of(scenario.get("after").unwrap()).into_iter().collect();
        assert_eq!(recorded(h.user_data()), want, "{name}: files");
    }
}
