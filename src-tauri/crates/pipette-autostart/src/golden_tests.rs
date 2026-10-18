// SPDX-License-Identifier: GPL-2.0-or-later
//! The registrations against tests/fixtures/autostart.json, recorded from
//! the Electron build (scripts/resident-fixtures/record-autostart-fixtures.test.ts):
//! each scenario's launch and `autoLaunch` changes, run on a temporary
//! HOME standing in for the user's. What is compared: the login-item calls, the log lines (only the
//! start of a message that carries the system's error text) and the files
//! of `$HOME/.config/autostart` (and of `XDG_CONFIG_HOME`) after each step.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::tests::{capture, records};
use crate::{Environment, Os, Target, run, target};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/autostart.json");
const XDG_PLACEHOLDER: &str = "<a temporary directory apart from HOME>";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    exec_path: String,
    autostart_path: String,
    scenarios: Vec<Scenario>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Scenario {
    name: String,
    platform: String,
    is_packaged: bool,
    env: BTreeMap<String, String>,
    before: String,
    boot: Step,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    action: Value,
    calls: Vec<Value>,
    #[serde(default)]
    logs: Vec<Log>,
    autostart: Value,
    xdg_config_home: Option<Vec<String>>,
}

#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Log {
    level: String,
    message: String,
    #[serde(default)]
    os_error_follows: bool,
}

fn prepare(home: &Path, before: &str) {
    let autostart = home.join(".config").join("autostart");
    match before {
        "empty HOME" => {}
        "HOME with .config" => fs::create_dir(home.join(".config")).expect("create .config"),
        "an entry already there" => {
            fs::create_dir_all(&autostart).expect("create autostart");
            fs::write(autostart.join("pipette.desktop"), "old entry\n").expect("write the old entry");
            fs::write(autostart.join("other.desktop"), "someone else\n").expect("write another entry");
        }
        "autostart is a file" => {
            fs::create_dir(home.join(".config")).expect("create .config");
            fs::write(&autostart, "not a directory").expect("write the file");
        }
        "pipette.desktop is a directory" => {
            fs::create_dir_all(autostart.join("pipette.desktop")).expect("create the directory");
        }
        other => panic!("unknown starting state {other}"),
    }
}

/// `$HOME/.config/autostart` as the recorder writes it.
fn autostart_tree(home: &Path) -> Value {
    let dir = home.join(".config").join("autostart");
    let Ok(meta) = fs::symlink_metadata(&dir) else { return json!("missing") };
    if !meta.is_dir() {
        return json!("not a directory");
    }
    let mut out = serde_json::Map::new();
    for entry in fs::read_dir(&dir).expect("read autostart") {
        let entry = entry.expect("entry");
        let name = entry.file_name().into_string().expect("UTF-8 name");
        let value = if entry.file_type().expect("type").is_dir() {
            Value::Null
        } else {
            Value::String(fs::read_to_string(entry.path()).expect("read the entry"))
        };
        out.insert(name, value);
    }
    Value::Object(out)
}

/// Every path under `root`, relative to it.
fn tree(root: &Path) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        for entry in fs::read_dir(dir).expect("read the directory") {
            let path = entry.expect("entry").path();
            out.push(path.strip_prefix(root).expect("inside").display().to_string());
            if path.is_dir() {
                walk(root, &path, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

fn os(platform: &str) -> Os {
    match platform {
        "linux" => Os::Linux,
        "win32" => Os::Windows,
        "darwin" => Os::MacOs,
        _ => Os::Other,
    }
}

fn enabled(action: &Value) -> bool {
    action
        .pointer("/boot/autoLaunch")
        .or_else(|| action.pointer("/configChange/value"))
        .and_then(Value::as_bool)
        .expect("a boot or an autoLaunch change")
}

fn check_logs(name: &str, step: usize, expected: &[Log], got: &[(log::Level, String)]) {
    assert_eq!(got.len(), expected.len(), "{name} step {step}: {got:?}");
    for (want, (level, message)) in expected.iter().zip(got) {
        assert_eq!(level.as_str().to_lowercase(), want.level, "{name} step {step}");
        if want.os_error_follows {
            assert!(
                message.starts_with(&want.message) && message.len() > want.message.len(),
                "{name} step {step}: {message}"
            );
        } else {
            assert_eq!(message, &want.message, "{name} step {step}");
        }
    }
}

#[test]
fn every_scenario_registers_as_the_electron_build_does() {
    let fixture: Fixture =
        serde_json::from_str(&fs::read_to_string(FIXTURE).expect("read the fixture")).expect("parse");
    assert_eq!(fixture.autostart_path, "$HOME/.config/autostart/pipette.desktop");
    assert_eq!(fixture.scenarios.len(), 21);
    for scenario in &fixture.scenarios {
        // Removing the entry through an `autostart` that is a file fails
        // with ENOTDIR on Linux and macOS, but Windows reports the path as
        // missing, which counts as already removed. The Linux entry is never
        // written on Windows, so that host is left out of this one scenario.
        if cfg!(windows) && scenario.before == "autostart is a file" {
            continue;
        }
        let home = tempfile::tempdir().expect("temporary HOME");
        let xdg = tempfile::tempdir().expect("temporary XDG_CONFIG_HOME");
        prepare(home.path(), &scenario.before);
        let mut xdg_config_home = None;
        let mut appimage = None;
        for (key, value) in &scenario.env {
            match key.as_str() {
                "XDG_CONFIG_HOME" => {
                    assert_eq!(value, XDG_PLACEHOLDER);
                    xdg_config_home = Some(xdg.path().to_path_buf());
                }
                "APPIMAGE" => appimage = Some(OsString::from(value)),
                other => panic!("{}: unknown variable {other}", scenario.name),
            }
        }
        let env = Environment {
            os: os(&scenario.platform),
            packaged: scenario.is_packaged,
            home: Some(home.path().to_path_buf()),
            home_var: Some(home.path().as_os_str().to_owned()),
            passwd_home: None,
            xdg_config_home: xdg_config_home.clone(),
            appimage,
            current_exe: Ok(PathBuf::from(&fixture.exec_path)),
            dev_dir: None,
            user_data: home.path().join("user-data"),
            user_data_override: false,
        };
        for (index, step) in std::iter::once(&scenario.boot).chain(&scenario.steps).enumerate() {
            let on = enabled(&step.action);
            capture();
            let mut calls = Vec::new();
            match target(&env) {
                // The login item is the OS's: recorded, not made.
                Target::LoginItem => {
                    calls.push(json!({"call": "app.setLoginItemSettings", "args": [{"openAtLogin": on}]}))
                }
                other => run(other, on, &env),
            }
            let expected_calls: Vec<Value> =
                step.calls.iter().map(|call| json!({"call": call["call"], "args": call["args"]})).collect();
            assert_eq!(calls, expected_calls, "{} step {index}", scenario.name);
            check_logs(&scenario.name, index, &step.logs, &records());
            assert_eq!(autostart_tree(home.path()), step.autostart, "{} step {index}", scenario.name);
            match (&step.xdg_config_home, &xdg_config_home) {
                (Some(want), Some(dir)) => assert_eq!(&tree(dir), want, "{} step {index}", scenario.name),
                (None, None) => {}
                _ => panic!("{} step {index}: XDG_CONFIG_HOME recorded only on one side", scenario.name),
            }
        }
    }
}
