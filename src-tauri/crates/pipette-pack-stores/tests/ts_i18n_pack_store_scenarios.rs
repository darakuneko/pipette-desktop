// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the language pack scenarios recorded from the real handlers of
//! src/main/i18n-pack-ipc.ts (scripts/pack-store-fixtures/
//! record-i18n-pack-store-fixtures.test.ts) through the handlers of this
//! crate, comparing each step's response, the default file name of each
//! export, the notified sync units and the userData tree left behind.
//!
//! The import dialog's answer is built from the files this crate reads, as
//! the shim builds it (src/tauri-shim/api/i18n-packs.ts). The recording
//! normalizes the paths under userData and the texts of file-system and
//! `JSON.parse` errors, and hashes large responses and files; the replay
//! normalizes its own answers the same way.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use common::{Harness, Node, build, ms, recorded, tree_of};
use pipette_js_json::{Object, Value};
use pipette_pack_stores::i18n_handlers::{self as handlers, Answer};
use pipette_pack_stores::{ImportFileRead, read_import_file, response};

/// Content larger than this is recorded by its hash.
const INLINE_LIMIT: usize = 4096;

fn fixture() -> Vec<Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_i18n_pack_store_scenarios.json");
    let Value::Array(scenarios) = pipette_js_json::parse(&fs::read_to_string(path).unwrap()).unwrap() else {
        panic!()
    };
    scenarios
}

fn text(value: &Value) -> String {
    value.as_str().unwrap().to_owned()
}

/// Sets the modification time of `path` to `ns` nanoseconds since the epoch.
fn set_mtime(path: &Path, ns: &str) {
    let ns: i128 = ns.parse().unwrap();
    let offset = Duration::from_nanos(u64::try_from(ns.unsigned_abs()).unwrap());
    let time = if ns < 0 { UNIX_EPOCH - offset } else { UNIX_EPOCH + offset };
    fs::File::options().write(true).open(path).unwrap().set_modified(time).unwrap();
}

/// A path under userData as recorded.
fn shown_path(user_data: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(user_data).unwrap();
    format!("<userData>/{}", relative.to_string_lossy())
}

/// The error texts the recording normalizes: a file-system error's
/// (`Error: …` with the OS's text) and a `JSON.parse` failure's.
fn normalized_error(message: &str) -> String {
    if message.starts_with("SyntaxError:") {
        "<parse error>".to_owned()
    } else if message.starts_with("Error: ") && message.contains("(os error ") {
        "<os error>".to_owned()
    } else {
        message.to_owned()
    }
}

/// The handler's response as recorded: errors normalized, the JSON text
/// hashed when long.
fn outcome(mut response: Object) -> Value {
    if let Some(Value::String(error)) = response.get("error").cloned() {
        response.insert("error", normalized_error(&error.to_string_lossy()).into());
    }
    recorded_text(&pipette_js_json::stringify(&Value::Object(response)))
}

fn recorded_text(json: &str) -> Value {
    if json.len() > INLINE_LIMIT {
        let mut hashed = Object::new();
        hashed.insert("sha256", pipette_entry_store::body_hash(json).into());
        Value::Object(hashed)
    } else {
        json.into()
    }
}

/// A file path under userData and its export answer's `filePath` shown as
/// recorded.
fn answer_outcome(answer: Answer, user_data: &Path) -> Value {
    let mut response = response(answer);
    if let Some(Value::Object(data)) = response.get("data").cloned()
        && let Some(Value::String(path)) = data.get("filePath")
    {
        let mut data = data.clone();
        data.insert("filePath", shown_path(user_data, Path::new(&*path.to_string_lossy())).into());
        response.insert("data", Value::Object(data));
    }
    outcome(response)
}

/// The import dialog's answer for the chosen `paths`, as the shim builds it
/// from what the backend reads.
fn import_outcome(user_data: &Path, chosen: Option<&Value>) -> Value {
    let paths: Vec<PathBuf> = match chosen {
        Some(Value::Array(list)) => list.iter().map(|path| user_data.join(text(path))).collect(),
        _ => Vec::new(),
    };
    let mut answer = Object::new();
    answer.insert("canceled", paths.is_empty().into());
    let files = paths
        .iter()
        .map(|path| {
            let mut file = Object::new();
            file.insert("filePath", shown_path(user_data, path).into());
            match read_import_file(path) {
                ImportFileRead::Text { text, size } => {
                    #[allow(clippy::cast_precision_loss)]
                    let size = Value::from(size as f64);
                    match pipette_js_json::parse(&text) {
                        Ok(raw) => {
                            file.insert("raw", raw);
                            file.insert("fileSizeBytes", size);
                        }
                        Err(_) => {
                            file.insert("fileSizeBytes", size);
                            file.insert("parseError", "<parse error>".into());
                        }
                    }
                }
                ImportFileRead::Failed(_) => {
                    file.insert("parseError", "<os error>".into());
                }
            }
            Value::Object(file)
        })
        .collect();
    answer.insert("files", Value::Array(files));
    recorded_text(&pipette_js_json::stringify(&Value::Object(answer)))
}

/// The pack JSON an import-apply step passes.
fn raw_of(raw: &Object, user_data: &Path) -> Option<Value> {
    if raw.contains_key("absent") {
        return None;
    }
    if let Some(value) = raw.get("value") {
        return Some(value.clone());
    }
    let bytes = fs::read(user_data.join(text(raw.get("fromFile").unwrap()))).unwrap();
    Some(pipette_js_json::parse(&String::from_utf8_lossy(&bytes)).unwrap())
}

struct Played {
    outcomes: Vec<Value>,
    default_paths: Vec<Value>,
}

fn play(h: &Harness, steps: &[Value]) -> Played {
    let user_data = h.user_data().to_path_buf();
    let mut played = Played { outcomes: Vec::new(), default_paths: Vec::new() };
    for step in steps {
        let step = step.as_object().unwrap();
        let arg = |key: &str| step.get(key);
        let mut default_path = Value::Null;
        let ctx = &h.ctx;
        let outcome = match text(arg("op").unwrap()).as_str() {
            "at" => {
                h.clock.set(ms(&text(arg("time").unwrap())));
                Value::Null
            }
            "list" => answer_outcome(handlers::list(ctx), &user_data),
            "get" => answer_outcome(handlers::get(ctx, arg("id")), &user_data),
            "hasName" => answer_outcome(handlers::has_name(ctx, arg("name"), arg("excludeId")), &user_data),
            "rename" => answer_outcome(handlers::rename(ctx, arg("id"), arg("name")), &user_data),
            "setEnabled" => answer_outcome(handlers::set_enabled(ctx, arg("id"), arg("enabled")), &user_data),
            "refreshCoverage" => {
                answer_outcome(handlers::refresh_coverage(ctx, arg("id"), arg("values")), &user_data)
            }
            "reorder" => answer_outcome(handlers::reorder(ctx, arg("ids")), &user_data),
            "delete" => answer_outcome(handlers::delete(ctx, arg("id")), &user_data),
            "hubPostId" => answer_outcome(
                handlers::set_hub_post_id(
                    ctx,
                    arg("id"),
                    arg("hubPostId"),
                    arg("uploaderName"),
                    arg("hubUpdatedAt"),
                ),
                &user_data,
            ),
            "import" => import_outcome(&user_data, arg("dialog")),
            "importApply" => {
                let raw = raw_of(arg("raw").unwrap().as_object().unwrap(), &user_data);
                // The preload passes `options ?? {}`.
                let options = arg("options").cloned().unwrap_or_else(|| Value::Object(Object::new()));
                answer_outcome(handlers::import_apply(ctx, raw.as_ref(), Some(&options)), &user_data)
            }
            "export" => {
                let chosen = arg("dialog").filter(|d| **d != Value::Null).map(|d| user_data.join(text(d)));
                let exported = handlers::export(ctx, arg("id"), |name| {
                    default_path = name.into();
                    chosen
                });
                match exported {
                    Ok(answer) => answer_outcome(answer, &user_data),
                    Err(thrown) => {
                        let mut rejected = Object::new();
                        rejected.insert("rejected", thrown.into());
                        Value::Object(rejected)
                    }
                }
            }
            other => panic!("unknown step {other}"),
        };
        played.outcomes.push(outcome);
        played.default_paths.push(default_path);
    }
    played
}

fn show(value: &Value) -> String {
    match value {
        Value::String(s) => s.to_string_lossy().into_owned(),
        other => pipette_js_json::stringify(other),
    }
}

#[test]
fn the_language_pack_handlers_answer_and_write_as_the_typescript_ones() {
    let mut failures = Vec::new();
    for scenario in fixture() {
        let scenario = scenario.as_object().unwrap();
        let name = text(scenario.get("name").unwrap());
        let h = Harness::new();
        h.clock.set(ms(&text(scenario.get("time").unwrap())));
        build(h.user_data(), &tree_of(scenario.get("tree").unwrap()));
        for (path, ns) in scenario.get("mtimesNs").unwrap().as_object().unwrap().iter() {
            set_mtime(&h.path(&path.to_string_lossy()), &text(ns));
        }
        let Some(Value::Array(steps)) = scenario.get("steps") else { panic!() };
        let played = play(&h, steps);

        let Some(Value::Array(outcomes)) = scenario.get("outcomes") else { panic!() };
        for (i, (expected, actual)) in outcomes.iter().zip(&played.outcomes).enumerate() {
            if expected != actual {
                failures.push(format!(
                    "{name}, step {i} ({}):\n  expected {}\n  actual   {}",
                    show(steps[i].as_object().unwrap().get("op").unwrap()),
                    show(expected),
                    show(actual)
                ));
            }
        }
        let Some(Value::Array(default_paths)) = scenario.get("defaultPaths") else { panic!() };
        if default_paths != &played.default_paths {
            failures.push(format!("{name}: default paths {default_paths:?} != {:?}", played.default_paths));
        }
        let notified: Vec<String> = match scenario.get("notified") {
            Some(Value::Array(units)) => units.iter().map(text).collect(),
            _ => panic!(),
        };
        if notified != h.notified() {
            failures.push(format!("{name}: notified {notified:?} != {:?}", h.notified()));
        }
        let expected_tree: std::collections::BTreeMap<String, Node> =
            tree_of(scenario.get("after").unwrap()).into_iter().collect();
        let actual_tree = recorded(h.user_data(), INLINE_LIMIT);
        for (path, node) in &expected_tree {
            match actual_tree.get(path) {
                Some(actual) if actual == node => {}
                Some(Node::File(actual)) => failures.push(format!(
                    "{name}: {path} differs:\n  expected {}\n  actual   {}",
                    match node {
                        Node::File(bytes) => String::from_utf8_lossy(bytes).into_owned(),
                        other => format!("{other:?}"),
                    },
                    String::from_utf8_lossy(actual)
                )),
                other => failures.push(format!("{name}: {path} is {other:?}, expected {node:?}")),
            }
        }
        for path in actual_tree.keys().filter(|path| !expected_tree.contains_key(*path)) {
            failures.push(format!("{name}: unexpected {path}"));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
