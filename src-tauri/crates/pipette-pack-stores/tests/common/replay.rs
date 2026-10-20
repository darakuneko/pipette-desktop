// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the recorded golden scenarios through the handlers of this crate, comparing each step's response, the
//! default file name of each export, the notified sync units and the
//! userData tree left behind.
//!
//! The import dialog's answer is built from the files this crate reads, as
//! the shim builds it (src/tauri-shim/api/{i18n,theme}-packs.ts). The
//! recording normalizes the paths under userData and the texts of
//! file-system and `JSON.parse` errors, and hashes large responses and
//! files; the replay normalizes its own answers the same way.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use pipette_js_json::{Object, Value};
use pipette_pack_stores::handlers::Answer;
use pipette_pack_stores::{ImportFileRead, read_import_file, response};

use super::{Harness, Node, build, ms, recorded, tree_of};

/// Content larger than this is recorded by its hash.
pub const INLINE_LIMIT: usize = 4096;

pub fn fixture(name: &str) -> Vec<Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    let Value::Array(scenarios) = pipette_js_json::parse(&fs::read_to_string(path).unwrap()).unwrap() else {
        panic!()
    };
    scenarios
}

pub fn text(value: &Value) -> String {
    value.as_str().unwrap().to_owned()
}

/// Sets the modification time of `path` to `ns` nanoseconds since the epoch.
pub fn set_mtime(path: &Path, ns: &str) {
    let ns: i128 = ns.parse().unwrap();
    let offset = Duration::from_nanos(u64::try_from(ns.unsigned_abs()).unwrap());
    let time = if ns < 0 { UNIX_EPOCH - offset } else { UNIX_EPOCH + offset };
    fs::File::options().write(true).open(path).unwrap().set_modified(time).unwrap();
}

/// A path under userData as recorded.
pub fn shown_path(user_data: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(user_data).unwrap();
    format!("<userData>/{}", relative.to_string_lossy())
}

/// The error texts the recording normalizes: a file-system error's
/// (`Error: …` with the OS's text) and a `JSON.parse` failure's.
pub fn normalized_error(message: &str) -> String {
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
pub fn outcome(mut response: Object) -> Value {
    if let Some(Value::String(error)) = response.get("error").cloned() {
        response.insert("error", normalized_error(&error.to_string_lossy()).into());
    }
    recorded_text(&pipette_js_json::stringify(&Value::Object(response)))
}

pub fn recorded_text(json: &str) -> Value {
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
pub fn answer_outcome(answer: Answer, user_data: &Path) -> Value {
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
pub fn import_outcome(user_data: &Path, chosen: Option<&Value>) -> Value {
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
pub fn raw_of(raw: &Object, user_data: &Path) -> Option<Value> {
    if raw.contains_key("absent") {
        return None;
    }
    if let Some(value) = raw.get("value") {
        return Some(value.clone());
    }
    let bytes = fs::read(user_data.join(text(raw.get("fromFile").unwrap()))).unwrap();
    Some(pipette_js_json::parse(&String::from_utf8_lossy(&bytes)).unwrap())
}

/// The path an export step's save dialog answers, under userData; `None`
/// cancels it.
pub fn export_choice(step: &Object, user_data: &Path) -> Option<PathBuf> {
    step.get("dialog").filter(|d| **d != Value::Null).map(|d| user_data.join(text(d)))
}

/// An export's answer as recorded: `{rejected}` when the handler throws.
pub fn export_outcome(exported: Result<Answer, String>, user_data: &Path) -> Value {
    match exported {
        Ok(answer) => answer_outcome(answer, user_data),
        Err(thrown) => {
            let mut rejected = Object::new();
            rejected.insert("rejected", thrown.into());
            Value::Object(rejected)
        }
    }
}

/// What a step did besides answering.
pub struct StepEffects {
    /// The default file name an export's save dialog offered.
    pub default_path: Value,
    /// Whether the step sent the store's change event.
    pub changed: bool,
}

/// Runs a step other than `at` and `import` (`op` and its fields), given
/// the harness and the userData directory; answers its outcome as recorded.
pub type PlayStep<'a> = dyn FnMut(&Harness, &str, &Object, &mut StepEffects) -> Value + 'a;

fn show(value: &Value) -> String {
    match value {
        Value::String(s) => s.to_string_lossy().into_owned(),
        other => pipette_js_json::stringify(other),
    }
}

/// Replays every scenario of the fixture `name` through `play_step`,
/// panicking with every difference found. A step recorded with `changed`
/// must report it, and the others must not.
pub fn replay(name: &str, play_step: &mut PlayStep<'_>) {
    let mut failures = Vec::new();
    for scenario in fixture(name) {
        let scenario = scenario.as_object().unwrap();
        let name = text(scenario.get("name").unwrap());
        let h = Harness::new();
        h.clock.set(ms(&text(scenario.get("time").unwrap())));
        let tree = tree_of(scenario.get("tree").unwrap());
        let paths = tree.iter().map(|(path, _)| path.as_str());
        if let Some(reason) = pipette_fs::test_util::unsupported_tree(h.user_data(), paths, false) {
            eprintln!("SKIPPED {name}: {reason}");
            continue;
        }
        build(h.user_data(), &tree);
        for (path, ns) in scenario.get("mtimesNs").unwrap().as_object().unwrap().iter() {
            set_mtime(&h.path(&path.to_string_lossy()), &text(ns));
        }
        let Some(Value::Array(steps)) = scenario.get("steps") else { panic!() };
        let Some(Value::Array(outcomes)) = scenario.get("outcomes") else { panic!() };
        let Some(Value::Array(default_paths)) = scenario.get("defaultPaths") else { panic!() };
        let user_data = h.user_data().to_path_buf();
        for (i, step) in steps.iter().enumerate() {
            let step = step.as_object().unwrap();
            let op = text(step.get("op").unwrap());
            let mut effects = StepEffects { default_path: Value::Null, changed: false };
            let actual = match op.as_str() {
                "at" => {
                    h.clock.set(ms(&text(step.get("time").unwrap())));
                    Value::Null
                }
                "import" => import_outcome(&user_data, step.get("dialog")),
                _ => play_step(&h, &op, step, &mut effects),
            };
            if outcomes[i] != actual {
                failures.push(format!(
                    "{name}, step {i} ({op}):\n  expected {}\n  actual   {}",
                    show(&outcomes[i]),
                    show(&actual)
                ));
            }
            if default_paths[i] != effects.default_path {
                failures.push(format!(
                    "{name}, step {i} ({op}): default path {:?} != {:?}",
                    default_paths[i], effects.default_path
                ));
            }
            let changed = step.get("changed") == Some(&Value::Bool(true));
            if changed != effects.changed {
                failures.push(format!("{name}, step {i} ({op}): changed {changed} != {}", effects.changed));
            }
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
