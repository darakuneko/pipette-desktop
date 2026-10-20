// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the recorded golden scenarios of the key label handlers:
//! the same userData files, clock and new ids, the same calls, then each
//! response, the dialogs shown, the notified units and every file left
//! behind compared byte for byte. The texts of a file-system error, of a
//! JSON syntax error and the userData path are recorded as placeholders.
//!
//! The arguments are checked here as the handlers check them (the app's
//! commands, src-tauri/src/store_commands/key_labels.rs, do the same); the
//! dialogs answer the recorded paths.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use common::{Harness, build, ms, recorded, tree_of};
use pipette_js_json::{JsString, Object, Value};
use pipette_keyboard_stores::{
    KeyLabelError, KeyLabelErrorCode, delete_key_label, export_key_label, get_key_label, has_key_label_name,
    import_key_label_files, key_label_response, list_key_labels, rename_key_label, reorder_key_labels,
    set_key_label_hub_post_id,
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

fn invalid_id() -> KeyLabelError {
    KeyLabelError::invalid_argument(KeyLabelErrorCode::NotFound, "Invalid id")
}

fn invalid_name() -> KeyLabelError {
    KeyLabelError::invalid_argument(KeyLabelErrorCode::InvalidName, "Invalid name")
}

/// `got` with the texts the fixture does not record replaced.
fn as_recorded(got: &str, user_data: &Path) -> String {
    let mut parsed = pipette_js_json::parse(got).unwrap();
    replace_texts(&mut parsed, &user_data.to_string_lossy());
    pipette_js_json::stringify(&parsed)
}

fn replace_texts(value: &mut Value, user_data: &str) {
    match value {
        Value::Object(object) => {
            let keys: Vec<JsString> = object.keys().cloned().collect();
            for key in keys {
                let mut child = object.get(key.as_str().unwrap()).unwrap().clone();
                match (key.as_str().unwrap(), &child) {
                    ("error", Value::String(error)) => {
                        let error = error.to_string_lossy();
                        if error.starts_with("SyntaxError: ") {
                            child = "<parse error>".into();
                        } else if error.starts_with("Error: ") && error != "Error: Invalid filename" {
                            child = "<os error>".into();
                        }
                    }
                    ("filePath", Value::String(path)) => {
                        // Windows joins the path with `\`, the recording on Linux
                        // with `/`.
                        child = path
                            .to_string_lossy()
                            .replace(user_data, "<userData>")
                            .replace(std::path::MAIN_SEPARATOR_STR, "/")
                            .into();
                    }
                    _ => replace_texts(&mut child, user_data),
                }
                object.insert(key, child);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| replace_texts(item, user_data)),
        _ => {}
    }
}

fn entries(list: Vec<pipette_entry_store::Entry>) -> Option<Value> {
    Some(Value::Array(list.into_iter().map(Value::from).collect()))
}

/// The paths the step's dialog answers, under userData.
fn dialog_paths(h: &Harness, step: &Object) -> Vec<PathBuf> {
    match step.get("dialog") {
        Some(Value::Array(paths)) => paths.iter().map(|p| h.user_data().join(p.as_str().unwrap())).collect(),
        Some(Value::String(path)) => vec![h.user_data().join(path.as_str().unwrap())],
        _ => Vec::new(),
    }
}

/// What the step shows of its dialog: its title, and the default file name
/// of a save dialog.
type Shown = Vec<(String, Option<String>)>;

fn export(h: &Harness, step: &Object, shown: &mut Shown) -> Result<Option<Value>, KeyLabelError> {
    let id = string_arg(step, "id").ok_or_else(invalid_id)?;
    let file = export_key_label(&h.ctx, &id)?;
    shown.push(("Export Key Label".to_owned(), Some(file.default_name)));
    let path = dialog_paths(h, step).into_iter().next().ok_or_else(KeyLabelError::cancelled)?;
    fs::write(&path, file.content)?;
    let data: Object =
        std::iter::once(("filePath", Value::from(path.to_string_lossy().into_owned()))).collect();
    Ok(Some(Value::Object(data)))
}

/// The step's response; `None` for a clock move.
fn run_step(h: &Harness, step: &Object, shown: &mut Shown) -> Option<String> {
    let op = text(step, "op");
    let id = || string_arg(step, "id").ok_or_else(invalid_id);
    let result: Result<Option<Value>, KeyLabelError> = match op.as_str() {
        "at" => {
            h.clock.set(ms(&text(step, "time")));
            return None;
        }
        "list" => list_key_labels(&h.ctx, false).map(entries),
        "listAll" => list_key_labels(&h.ctx, true).map(entries),
        "get" => id().and_then(|id| get_key_label(&h.ctx, &id)).map(|record| Some(Value::Object(record))),
        "rename" => id().and_then(|id| {
            let name = string_arg(step, "name").ok_or_else(invalid_name)?;
            rename_key_label(&h.ctx, &id, &name).map(|meta| Some(meta.into()))
        }),
        "delete" => id().and_then(|id| delete_key_label(&h.ctx, &id)).map(|()| None),
        "hubPostId" => id().and_then(|id| {
            let post_id = string_arg(step, "hubPostId");
            set_key_label_hub_post_id(&h.ctx, &id, post_id.as_ref(), None, None).map(|meta| Some(meta.into()))
        }),
        "reorder" => match step.get("ids") {
            Some(Value::Array(ids)) if ids.iter().all(|id| matches!(id, Value::String(_))) => {
                let ids: Vec<JsString> = ids
                    .iter()
                    .map(|id| if let Value::String(id) = id { id.clone() } else { panic!() })
                    .collect();
                reorder_key_labels(&h.ctx, &ids).map(|()| None)
            }
            _ => Err(KeyLabelError::invalid_argument(KeyLabelErrorCode::InvalidFile, "Invalid order list")),
        },
        "hasName" => string_arg(step, "name").ok_or_else(invalid_name).and_then(|name| {
            let exclude = string_arg(step, "excludeId");
            has_key_label_name(&h.ctx, &name, exclude.as_ref()).map(|found| Some(found.into()))
        }),
        "import" => {
            shown.push(("Import Key Label".to_owned(), None));
            let paths = dialog_paths(h, step);
            if paths.is_empty() {
                Err(KeyLabelError::cancelled())
            } else {
                Ok(Some(Value::Object(import_key_label_files(&h.ctx, &paths))))
            }
        }
        "export" => export(h, step, shown),
        op => panic!("unknown step {op}"),
    };
    Some(as_recorded(&key_label_response(result), h.user_data()))
}

/// The recorded dialogs of a step, as [`Shown`].
fn recorded_dialogs(dialogs: &Value) -> Shown {
    let Value::Array(dialogs) = dialogs else { panic!("dialogs {dialogs:?}") };
    dialogs
        .iter()
        .map(|dialog| {
            let dialog = dialog.as_object().unwrap();
            (text(dialog, "title"), dialog.get("defaultPath").map(|path| path.as_str().unwrap().to_owned()))
        })
        .collect()
}

#[test]
fn the_scenarios_match_the_golden() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_key_label_store_scenarios.json");
    let fixture = pipette_js_json::parse(&fs::read_to_string(path).unwrap()).unwrap();
    let Value::Array(scenarios) = fixture else { panic!("not a list") };
    assert!(!scenarios.is_empty());
    for scenario in &scenarios {
        let scenario = scenario.as_object().unwrap();
        let name = text(scenario, "name");
        let h = Harness::new();
        h.clock.set(ms(&text(scenario, "time")));
        build(h.user_data(), &tree_of(scenario.get("tree").unwrap()));

        let list = |key: &str| match scenario.get(key) {
            Some(Value::Array(items)) => items.clone(),
            other => panic!("{name}: {key} {other:?}"),
        };
        let (steps, outcomes, dialogs) = (list("steps"), list("outcomes"), list("dialogs"));
        assert_eq!(steps.len(), outcomes.len(), "{name}");
        assert_eq!(steps.len(), dialogs.len(), "{name}");
        for (at, ((step, want), want_dialogs)) in steps.iter().zip(&outcomes).zip(&dialogs).enumerate() {
            let mut shown = Vec::new();
            let got = run_step(&h, step.as_object().unwrap(), &mut shown);
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
