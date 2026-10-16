// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the scenarios recorded from the TypeScript Aozora Bunko import
//! handler by scripts/typing-text-fixtures/record-aozora-import-fixtures.test.ts:
//! the same userData files, HTTP replies, clock and new ids, the same
//! calls, then each response, the URLs asked, the notified units and every
//! file left behind compared byte for byte.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use common::{Harness, block_on, build, hex_bytes, recorded, tree_of};
use pipette_entry_store::{FixedClock, SequenceIds, WriteLocks};
use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::{StoreContext, TypingTextStore};
use pipette_net::{HttpError, HttpResponse};
use pipette_typing_datasets::import_aozora_work;

fn text(object: &Object, key: &str) -> String {
    object.get(key).unwrap().as_str().unwrap().to_owned()
}

fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items.iter().map(|item| item.as_str().unwrap().to_owned()).collect(),
        other => panic!("not a list: {other:?}"),
    }
}

fn queue_replies(h: &Harness, step: &Object) {
    let Some(Value::Array(replies)) = step.get("replies") else { panic!("no replies") };
    for reply in replies {
        let reply = reply.as_object().unwrap();
        h.reply(match reply.get("error") {
            // String(new Error(message)) of the rejected fetch.
            Some(message) => Err(HttpError::Network(format!("Error: {}", message.as_str().unwrap()))),
            None => {
                let Some(Value::Number(status)) = reply.get("status") else { panic!("no status") };
                Ok(HttpResponse { status: *status as u16, body: hex_bytes(&text(reply, "hex")) })
            }
        });
    }
}

#[test]
fn the_scenarios_match_the_typescript_handler() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_aozora_import_scenarios.json");
    let fixture = pipette_js_json::parse(&fs::read_to_string(path).unwrap()).unwrap();
    let Value::Array(scenarios) = fixture else { panic!("not a list") };
    assert!(!scenarios.is_empty());
    for scenario in &scenarios {
        let scenario = scenario.as_object().unwrap();
        let name = text(scenario, "name");
        let h = Harness::new();
        build(h.user_data(), &tree_of(scenario.get("tree").unwrap()));
        let notified = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&notified);
        let ctx = StoreContext::new(
            h.user_data(),
            Arc::new(FixedClock::new(pipette_time::parse_date_time_string(&text(scenario, "time")).unwrap())),
            Arc::new(WriteLocks::new()),
            Arc::new(move |unit: &str| record.lock().unwrap().push(unit.to_owned())),
        )
        .with_ids(Arc::new(SequenceIds::new((1..=50).map(|n| format!("00000000-0000-4000-8000-{n:012}")))));
        let texts = TypingTextStore::default();

        let Some(Value::Array(steps)) = scenario.get("steps") else { panic!("{name}: no steps") };
        let outcomes = strings(scenario.get("outcomes"));
        assert_eq!(steps.len(), outcomes.len(), "{name}");
        for (at, (step, want)) in steps.iter().zip(&outcomes).enumerate() {
            let step = step.as_object().unwrap();
            queue_replies(&h, step);
            // The handler's argument as the command reads it: a string, or
            // no work id.
            let work_id = step.get("workId").and_then(Value::as_str);
            let got = match block_on(import_aozora_work(&h.store, &ctx, &texts, work_id)) {
                Ok(response) => response,
                Err(err) => pipette_js_json::stringify(&Value::Object(
                    std::iter::once(("rejected", err.to_string().into())).collect(),
                )),
            };
            assert_eq!(&got, want, "{name}: step {at}");
            assert_eq!(h.replies_left(), 0, "{name}: step {at} left replies");
        }

        assert_eq!(h.urls(), strings(scenario.get("urls")), "{name}: fetched URLs");
        assert_eq!(*notified.lock().unwrap(), strings(scenario.get("notified")), "{name}: notified units");
        let want: BTreeMap<_, _> = tree_of(scenario.get("after").unwrap()).into_iter().collect();
        assert_eq!(recorded(h.user_data()), want, "{name}: files");
    }
}
