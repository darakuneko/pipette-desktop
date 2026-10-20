// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the recorded golden scenarios of the typing test text handlers:
//! the same userData files, clock and new ids, the same calls, then each
//! response, the dialogs shown, the notified units and every file left
//! behind compared byte for byte. The texts of a file-system error and of a
//! JSON syntax error are recorded as placeholders.
//!
//! The arguments are checked here as the handlers check them (the app's
//! commands, src-tauri/src/store_commands/typing_texts.rs, do the same); the
//! import dialog answers the recorded path.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use common::{Harness, build, ms, recorded, tree_of, unsupported};
use pipette_js_json::{JsString, Object, Value};
use pipette_keyboard_stores::{
    TypingTextError, TypingTextErrorCode, TypingTextSave, TypingTextSource, TypingTextStore,
    typing_text_response,
};

fn text(step: &Object, key: &str) -> String {
    step.get(key).unwrap().as_str().unwrap().to_owned()
}

fn string_arg(step: &Object, key: &str) -> Option<JsString> {
    match step.get(key) {
        Some(Value::String(s)) => Some(s.clone()),
        _ => None,
    }
}

fn invalid_id() -> TypingTextError {
    TypingTextError::invalid_argument(TypingTextErrorCode::NotFound, "Invalid id")
}

/// `got` with the texts the fixture does not record replaced.
fn as_recorded(got: &str) -> String {
    let mut parsed = pipette_js_json::parse(got).unwrap();
    if let Value::Object(response) = &mut parsed
        && let Some(Value::String(error)) = response.get("error")
    {
        let error = error.to_string_lossy();
        if error.starts_with("SyntaxError: ") {
            response.insert("error", "<parse error>".into());
        } else if error.starts_with("Error: ") && error != "Error: Invalid filename" {
            response.insert("error", "<os error>".into());
        }
    }
    pipette_js_json::stringify(&parsed)
}

fn entries(list: Vec<pipette_entry_store::Entry>) -> Value {
    Value::Array(list.into_iter().map(Value::from).collect())
}

/// The save of a `save` step (`SaveTextInput`).
fn save_input(input: &Object) -> TypingTextSave {
    let source = input.get("source").map(|source| {
        let source = source.as_object().unwrap();
        TypingTextSource {
            provider: string_arg(source, "provider").unwrap(),
            work_id: string_arg(source, "workId").unwrap(),
        }
    });
    TypingTextSave {
        id: string_arg(input, "id"),
        name: string_arg(input, "name").unwrap(),
        text: string_arg(input, "text").unwrap(),
        source,
        keep_current_name: input.get("keepCurrentName") == Some(&Value::Bool(true)),
    }
}

/// Writes `size` bytes of `unit` repeated to `path`.
fn fill(path: &Path, size: usize, unit: &str) {
    let content = unit.repeat(size.div_ceil(unit.len()));
    fs::write(path, &content.as_bytes()[..size]).unwrap();
}

/// The step's response; `None` for a step that changes the clock or a file.
fn run_step(h: &Harness, store: &TypingTextStore, step: &Object, shown: &mut Vec<String>) -> Option<String> {
    let op = text(step, "op");
    let id = || string_arg(step, "id").ok_or_else(invalid_id);
    let result: Result<Option<Value>, TypingTextError> = match op.as_str() {
        "at" => {
            h.clock.set(ms(&text(step, "time")));
            return None;
        }
        "write" => {
            fs::write(h.user_data().join(text(step, "path")), text(step, "content")).unwrap();
            return None;
        }
        "fill" => {
            let size = match step.get("size") {
                Some(Value::Number(size)) => format!("{size}").parse().unwrap(),
                other => panic!("size {other:?}"),
            };
            fill(&h.user_data().join(text(step, "path")), size, &text(step, "unit"));
            return None;
        }
        "remove" => {
            fs::remove_file(h.user_data().join(text(step, "path"))).unwrap();
            return None;
        }
        "listAll" => {
            return Some(pipette_js_json::stringify(&entries(store.list(&h.ctx, true).unwrap())));
        }
        "list" => store.list(&h.ctx, false).map(|list| Some(entries(list))),
        "get" => id().and_then(|id| store.get(&h.ctx, &id)).map(|record| Some(Value::Object(record))),
        "rename" => id().and_then(|id| {
            let name = string_arg(step, "name").ok_or_else(|| {
                TypingTextError::invalid_argument(TypingTextErrorCode::InvalidName, "Invalid name")
            })?;
            store.rename(&h.ctx, &id, &name).map(|meta| Some(meta.into()))
        }),
        "delete" => id().and_then(|id| store.delete(&h.ctx, &id)).map(|()| None),
        "import" => {
            shown.push("Import UTF-8 Text".to_owned());
            match string_arg(step, "dialog") {
                Some(path) => store
                    .import_file(&h.ctx, &h.user_data().join(path.to_string_lossy().as_ref()))
                    .map(|meta| Some(meta.into())),
                None => Err(TypingTextError::cancelled()),
            }
        }
        "confirm" => store.confirm_import(&h.ctx).map(|meta| Some(meta.into())),
        "save" => {
            let input = save_input(step.get("input").unwrap().as_object().unwrap());
            store.save(&h.ctx, &input).map(|meta| Some(meta.into()))
        }
        op => panic!("unknown step {op}"),
    };
    Some(as_recorded(&typing_text_response(result)))
}

/// The titles of the recorded dialogs of a step.
fn recorded_dialogs(dialogs: &Value) -> Vec<String> {
    let Value::Array(dialogs) = dialogs else { panic!("dialogs {dialogs:?}") };
    dialogs.iter().map(|dialog| text(dialog.as_object().unwrap(), "title")).collect()
}

#[test]
fn the_scenarios_match_the_typescript_handlers() {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_typing_text_store_scenarios.json");
    let fixture = pipette_js_json::parse(&fs::read_to_string(path).unwrap()).unwrap();
    let Value::Array(scenarios) = fixture else { panic!("not a list") };
    assert!(!scenarios.is_empty());
    for scenario in &scenarios {
        let scenario = scenario.as_object().unwrap();
        let name = text(scenario, "name");
        let h = Harness::new();
        let store = TypingTextStore::default();
        h.clock.set(ms(&text(scenario, "time")));
        let tree = tree_of(scenario.get("tree").unwrap());
        if let Some(reason) = unsupported(h.user_data(), &tree) {
            eprintln!("SKIPPED {name}: {reason}");
            continue;
        }
        build(h.user_data(), &tree);

        let list = |key: &str| match scenario.get(key) {
            Some(Value::Array(items)) => items.clone(),
            other => panic!("{name}: {key} {other:?}"),
        };
        let (steps, outcomes, dialogs) = (list("steps"), list("outcomes"), list("dialogs"));
        assert_eq!(steps.len(), outcomes.len(), "{name}");
        assert_eq!(steps.len(), dialogs.len(), "{name}");
        for (at, ((step, want), want_dialogs)) in steps.iter().zip(&outcomes).zip(&dialogs).enumerate() {
            let mut shown = Vec::new();
            let got = run_step(&h, &store, step.as_object().unwrap(), &mut shown);
            assert_eq!(got.as_deref(), want.as_str(), "{name}: step {at}");
            assert_eq!(shown, recorded_dialogs(want_dialogs), "{name}: dialogs of step {at}");
        }

        let notified: Vec<String> =
            list("notified").iter().map(|unit| unit.as_str().unwrap().to_owned()).collect();
        assert_eq!(h.notified(), notified, "{name}: notified units");
        let want: BTreeMap<_, _> = tree_of(scenario.get("after").unwrap()).into_iter().collect();
        assert_eq!(recorded(h.user_data()), want, "{name}: files");
    }
}
