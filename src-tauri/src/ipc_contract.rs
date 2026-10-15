// SPDX-License-Identifier: GPL-2.0-or-later
//! The Rust half of the IPC contract tests. The invoke fixtures
//! (tests/fixtures/ipc/<domain>.json) record, for a shim member, the command
//! it invokes, the arguments it passes and a response; the shim's tests
//! (src/tauri-shim/__tests__/ipc-fixtures.test.ts) replay them against the
//! shim. Here each `invokeArgs` must deserialize into the command's argument
//! types, by the camelCase keys Tauri reads, and each `response` must be a
//! value of the command's return type that serializes back unchanged.
//!
//! The command names are also exported for the shim's command table
//! (src/tauri-shim/commands.ts), whose test compares the two.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::definition::{CompressedDefinition, DecompressedDefinition};
use crate::hid_commands::{DeviceInfoDto, HidData};

include!("app_command_names.rs");

/// One recorded call; `member` and `args` are the shim side's.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    member: String,
    #[serde(rename = "args")]
    _args: Vec<Value>,
    command: String,
    invoke_args: Map<String, Value>,
    response: Value,
}

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ipc")
}

fn entries() -> Vec<Entry> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(fixture_dir())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    paths
        .iter()
        .flat_map(|path| {
            let text = std::fs::read_to_string(path).unwrap();
            serde_json::from_str::<Vec<Entry>>(&text)
                .unwrap_or_else(|err| panic!("{}: {err}", path.display()))
        })
        .collect()
}

/// Removes the argument `key` and deserializes it as `T`.
fn take<T: DeserializeOwned>(args: &mut Map<String, Value>, key: &str) -> T {
    let value = args.remove(key).unwrap_or_else(|| panic!("missing argument {key}"));
    serde_json::from_value(value).unwrap_or_else(|err| panic!("argument {key}: {err}"))
}

/// `response` read as `T` and written back is `response` again.
fn round_trips<T: DeserializeOwned + Serialize>(response: &Value) {
    let value: T = serde_json::from_value(response.clone()).unwrap_or_else(|err| panic!("response: {err}"));
    assert_eq!(&serde_json::to_value(value).unwrap(), response);
}

/// The argument and return types of each command, as in its signature;
/// managed state and the window are not arguments the caller passes.
fn check(entry: &Entry) {
    let mut args = entry.invoke_args.clone();
    match entry.command.as_str() {
        "list_devices" => round_trips::<Vec<DeviceInfoDto>>(&entry.response),
        "open_device" => {
            take::<u16>(&mut args, "vendorId");
            take::<u16>(&mut args, "productId");
            round_trips::<bool>(&entry.response);
        }
        "close_device" => round_trips::<()>(&entry.response),
        "send_receive" => {
            take::<HidData>(&mut args, "data");
            round_trips::<Vec<u8>>(&entry.response);
        }
        "send" => {
            take::<HidData>(&mut args, "data");
            round_trips::<()>(&entry.response);
        }
        "is_device_open" => round_trips::<bool>(&entry.response),
        "decompress_definition" => {
            take::<CompressedDefinition>(&mut args, "data");
            round_trips::<DecompressedDefinition>(&entry.response);
        }
        other => panic!("no argument types for {other}"),
    }
    assert!(args.is_empty(), "unexpected arguments {:?}", args.keys().collect::<Vec<_>>());
}

#[test]
fn fixtures_match_the_command_signatures() {
    for entry in entries() {
        assert!(APP_COMMANDS.contains(&entry.command.as_str()), "{}: unknown command", entry.member);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| check(&entry)));
        assert!(result.is_ok(), "{} ({}) does not match the command", entry.member, entry.command);
    }
}

#[test]
fn every_app_command_has_a_fixture() {
    let entries = entries();
    for command in APP_COMMANDS {
        assert!(entries.iter().any(|entry| entry.command == *command), "{command} has no fixture");
    }
}

/// Written next to the ts-rs declarations, so the same freshness check
/// covers it.
#[test]
fn export_app_command_names() {
    let path = Path::new(env!("TS_RS_EXPORT_DIR")).join("app-command-names.json");
    let mut text = serde_json::to_string_pretty(APP_COMMANDS).unwrap();
    text.push('\n');
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, text).unwrap();
}
