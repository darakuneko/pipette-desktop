// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the scenarios recorded from the real electron-store by
//! scripts/app-config-fixtures/ (tests/fixtures/scenarios.json) on the Rust
//! store: after every step config.json must hold the same bytes, and the
//! step must return, fail and notify as it did there. The one intended
//! difference: where electron-store throws on a config.json that is not
//! JSON at start, the Rust store moves the file aside and starts from the
//! defaults.

// Test helpers outside #[test] functions panic on a broken fixture.
#![allow(clippy::unwrap_used)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use pipette_app_config::{AppConfigStore, CONFIG_FILE_NAME, Value, clamp_zoom_factor, truthy};
use pipette_js_json::{parse, stringify};
use serde::Deserialize;

#[derive(Deserialize)]
struct Scenario {
    name: String,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
struct Step {
    op: String,
    key: Option<String>,
    value: Option<String>,
    text: Option<String>,
    hex: Option<String>,
    file: Option<String>,
    result: Option<String>,
    error: Option<StepError>,
    notified: Option<Vec<(String, String)>>,
}

#[derive(Deserialize)]
struct StepError {
    name: String,
    message: String,
}

fn fixture<T: for<'de> Deserialize<'de>>(name: &str) -> T {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn read_file(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

fn scenario_dir(index: usize) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pipette-app-config-golden-{}-{index}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}

/// The bytes a first start writes: the defaults.
fn fresh_file(scenarios: &[Scenario]) -> String {
    let new = scenarios.iter().find(|s| s.name == "new").unwrap();
    new.steps[0].file.clone().unwrap()
}

struct Replay {
    dir: PathBuf,
    path: PathBuf,
    store: Option<AppConfigStore>,
    notified: Arc<Mutex<Vec<(String, String)>>>,
    fresh: String,
}

impl Replay {
    fn store(&self) -> &AppConfigStore {
        self.store.as_ref().unwrap()
    }

    /// Runs `step`; `Err` describes how it differs from the recording.
    fn run(&mut self, step: &Step) -> Result<(), String> {
        let before = read_file(&self.path);
        let outcome: Result<Option<String>, String> = match step.op.as_str() {
            "write" => {
                std::fs::write(&self.path, step.text.as_deref().unwrap()).unwrap();
                Ok(None)
            }
            "writeHex" => {
                std::fs::write(&self.path, hex_bytes(step.hex.as_deref().unwrap())).unwrap();
                Ok(None)
            }
            "delete" => {
                std::fs::remove_file(&self.path).unwrap();
                Ok(None)
            }
            "start" => return self.start(step, before),
            "getAll" => self
                .store()
                .get_all()
                .map(|all| Some(stringify(&Value::Object(all))))
                .map_err(|e| e.to_string()),
            "ipcSet" | "ipcSetUndefined" => {
                self.notified.lock().unwrap().clear();
                let key = step.key.as_deref().unwrap();
                self.store()
                    .set_from_renderer(key, step.value.as_deref())
                    .map(|()| None)
                    .map_err(|e| e.to_string())
            }
            "set" => {
                let value = parse(step.value.as_deref().unwrap()).unwrap();
                self.store()
                    .set(step.key.as_deref().unwrap(), value)
                    .map(|()| None)
                    .map_err(|e| e.to_string())
            }
            "clear" => self.store().clear().map(|()| None).map_err(|e| e.to_string()),
            "replace" => {
                let Value::Object(object) = parse(step.value.as_deref().unwrap()).unwrap() else { panic!() };
                self.store().replace(object).map(|()| None).map_err(|e| e.to_string())
            }
            op => panic!("unknown op {op}"),
        };
        compare_outcome(step, outcome)?;
        if let Some(expected) = &step.notified {
            let notified = self.notified.lock().unwrap().clone();
            if &notified != expected {
                return Err(format!("notified {notified:?}, expected {expected:?}"));
            }
        }
        self.compare_file(step)
    }

    fn start(&mut self, step: &Step, before: Option<String>) -> Result<(), String> {
        self.store = Some(AppConfigStore::open(&self.dir));
        let notified = Arc::clone(&self.notified);
        self.store()
            .subscribe(move |key, value| notified.lock().unwrap().push((key.to_owned(), stringify(value))));
        if let Some(error) = &step.error {
            // electron-store throws here; the Rust store sets the file aside.
            assert_eq!(error.name, "SyntaxError");
            let aside: Vec<_> = std::fs::read_dir(&self.dir)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| {
                    path.file_name().unwrap().to_string_lossy().starts_with("config.json.corrupt-")
                })
                .collect();
            if aside.len() != 1 || read_file(&aside[0]) != before {
                return Err(format!("expected the corrupt file set aside, found {aside:?}"));
            }
            if read_file(&self.path).as_ref() != Some(&self.fresh) {
                return Err("expected a fresh config.json".into());
            }
            return Ok(());
        }
        let all = self.store().get_all().map(|all| stringify(&Value::Object(all)));
        if all.as_ref().ok() != step.result.as_ref() {
            return Err(format!("loaded {all:?}, expected {:?}", step.result));
        }
        self.compare_file(step)
    }

    fn compare_file(&self, step: &Step) -> Result<(), String> {
        let actual = read_file(&self.path);
        if actual != step.file {
            return Err(format!("file {actual:?}, expected {:?}", step.file));
        }
        Ok(())
    }
}

fn compare_outcome(step: &Step, outcome: Result<Option<String>, String>) -> Result<(), String> {
    match (&outcome, &step.error) {
        (Ok(result), None) if result == &step.result => Ok(()),
        // conf's own messages must match; JSON.parse's need not.
        (Err(message), Some(error)) if error.name != "TypeError" || message == &error.message => Ok(()),
        _ => Err(format!(
            "returned {outcome:?}, expected result {:?} error {:?}",
            step.result,
            step.error.as_ref().map(|e| &e.message)
        )),
    }
}

#[test]
fn scenarios_match_electron_store() {
    let scenarios: Vec<Scenario> = fixture("scenarios.json");
    let fresh = fresh_file(&scenarios);
    let mut failures = Vec::new();
    for (index, scenario) in scenarios.iter().enumerate() {
        let dir = scenario_dir(index);
        let path = dir.join(CONFIG_FILE_NAME);
        let mut replay =
            Replay { dir: dir.clone(), path, store: None, notified: Arc::default(), fresh: fresh.clone() };
        for (i, step) in scenario.steps.iter().enumerate() {
            if let Err(why) = replay.run(step) {
                failures.push(format!("{} step {i} ({}): {why}", scenario.name, step.op));
                break;
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Coercion {
    input: String,
    zoom_factor: f64,
    boolean: bool,
}

#[test]
fn coercions_match_typescript() {
    for case in fixture::<Vec<Coercion>>("coercions.json") {
        let value = (case.input != "undefined").then(|| parse(&case.input).unwrap());
        assert_eq!(clamp_zoom_factor(value.as_ref()), case.zoom_factor, "clampZoomFactor({})", case.input);
        assert_eq!(truthy(value.as_ref()), case.boolean, "Boolean({})", case.input);
    }
}
