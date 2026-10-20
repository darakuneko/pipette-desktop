// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the recorded golden scenarios of the settings handlers: the
//! commands the shim makes run on the recorded userData files, and each
//! answer, the notified units and every file left behind are compared byte
//! for byte with the recorded run.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use common::{Harness, build, recorded, tree_of};
use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::{
    SettingsWrite, ensure_pipette_settings_dir, keyboard_settings_files_json, read_all_pipette_settings,
    read_pipette_settings, write_pipette_settings,
};

fn text(object: &Object, key: &str) -> String {
    object.get(key).unwrap().as_str().unwrap().to_owned()
}

/// The command's answer as a JSON value, or its error message.
fn run_command(h: &Harness, command: &str, args: &Object) -> Result<Value, String> {
    let uid = || text(args, "uid");
    match command {
        "pipette_settings_read" => {
            let file = read_pipette_settings(&h.ctx, &uid()).map_err(|err| err.to_string())?;
            let mut answer = Object::new();
            answer.insert("content", file.content.map_or(Value::Null, Value::from));
            answer.insert("etag", file.etag.into());
            Ok(Value::Object(answer))
        }
        "pipette_settings_write" => {
            let written = write_pipette_settings(&h.ctx, &uid(), &text(args, "content"), &text(args, "etag"))
                .map_err(|err| err.to_string())?;
            Ok(match written {
                SettingsWrite::Written => "written",
                SettingsWrite::Conflict => "conflict",
            }
            .into())
        }
        "pipette_settings_ensure_dir" => {
            ensure_pipette_settings_dir(&h.ctx, &uid()).map_err(|err| err.to_string())?;
            Ok(Value::Null)
        }
        "pipette_settings_read_all" => {
            let files = read_all_pipette_settings(&h.ctx).map_err(|err| err.to_string())?;
            Ok(pipette_js_json::parse(&keyboard_settings_files_json(&files)).unwrap())
        }
        other => panic!("unknown command {other}"),
    }
}

#[test]
fn the_shim_commands_leave_the_files_of_the_typescript_handlers() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_settings_store_scenarios.json");
    let fixture = pipette_js_json::parse(&fs::read_to_string(path).unwrap()).unwrap();
    let Value::Array(scenarios) = fixture else { panic!("not a list") };
    assert!(!scenarios.is_empty());
    for scenario in &scenarios {
        let scenario = scenario.as_object().unwrap();
        let name = text(scenario, "name");
        let h = Harness::new();
        build(h.user_data(), &tree_of(scenario.get("tree").unwrap()));

        let Some(Value::Array(commands)) = scenario.get("commands") else { panic!("{name}: no commands") };
        for (at, command) in commands.iter().enumerate() {
            let command = command.as_object().unwrap();
            let args = command.get("args").unwrap().as_object().unwrap();
            let got = run_command(&h, &text(command, "command"), args);
            let want = match (command.get("response"), command.get("error")) {
                (Some(response), None) => Ok(response.clone()),
                (None, Some(error)) => Err(error.as_str().unwrap().to_owned()),
                other => panic!("{name}: command {at}: {other:?}"),
            };
            assert_eq!(got, want, "{name}: command {at}");
        }

        let notified: Vec<String> = match scenario.get("notified") {
            Some(Value::Array(units)) => units.iter().map(|unit| unit.as_str().unwrap().to_owned()).collect(),
            other => panic!("{name}: notified {other:?}"),
        };
        assert_eq!(h.notified(), notified, "{name}: notified units");
        let want: BTreeMap<_, _> = tree_of(scenario.get("after").unwrap()).into_iter().collect();
        assert_eq!(recorded(h.user_data()), want, "{name}: files");
    }
}
