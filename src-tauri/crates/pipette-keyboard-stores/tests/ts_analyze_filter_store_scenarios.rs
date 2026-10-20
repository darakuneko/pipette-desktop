// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the recorded golden scenarios of the Analyze filter handlers:
//! the same userData files, clock and new ids, the same calls, then each
//! response, the notified units and every file left behind compared byte
//! for byte. A file-system error is recorded as `<os error>`, as its text
//! is the OS's.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use common::{Harness, ms, replay_scenarios, step_text as text};
use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::{
    AnalyzeFilterError, delete_analyze_filter, done, field, list_analyze_filters, load_analyze_filter,
    rename_analyze_filter, response_json, save_analyze_filter, set_analyze_filter_hub_post_id,
    set_analyze_filter_hub_private, update_analyze_filter,
};

/// The response the command answers, as JSON text; `None` for a clock move.
fn run_step(h: &Harness, step: &Object) -> Option<String> {
    let uid = || text(step, "uid");
    let id = || text(step, "id");
    let done = |result: Result<(), AnalyzeFilterError>| response_json(done(result));
    Some(match text(step, "op").as_str() {
        "at" => {
            h.clock.set(ms(&text(step, "time")));
            return None;
        }
        "list" => {
            response_json(list_analyze_filters(&h.ctx, &uid()).map(|entries| {
                field("entries", Value::Array(entries.into_iter().map(Value::from).collect()))
            }))
        }
        "save" => {
            let summary = step.get("summary").map(|_| text(step, "summary"));
            response_json(
                save_analyze_filter(
                    &h.ctx,
                    &uid(),
                    &text(step, "json"),
                    &text(step, "label"),
                    summary.as_deref(),
                )
                .map(|entry| field("entry", entry)),
            )
        }
        "load" => response_json(load_analyze_filter(&h.ctx, &uid(), &id()).map(|data| field("data", data))),
        "update" => done(update_analyze_filter(&h.ctx, &uid(), &id(), &text(step, "json"))),
        "rename" => done(rename_analyze_filter(&h.ctx, &uid(), &id(), &text(step, "label"))),
        "delete" => done(delete_analyze_filter(&h.ctx, &uid(), &id())),
        "hubPostId" => {
            let post_id = step.get("hubPostId").unwrap().as_str().map(str::to_owned);
            done(set_analyze_filter_hub_post_id(&h.ctx, &uid(), &id(), post_id.as_deref()))
        }
        "hubPrivate" => {
            let link = step.get("link").cloned().filter(|link| *link != Value::Null);
            done(set_analyze_filter_hub_private(&h.ctx, &uid(), &id(), link))
        }
        op => panic!("unknown step {op}"),
    })
}

#[test]
fn the_scenarios_match_the_typescript_handlers() {
    replay_scenarios(
        "ts_analyze_filter_store_scenarios.json",
        &[],
        |_| Harness::new(),
        &["Error: Invalid uid", "Error: Invalid filename"],
        run_step,
    );
}
