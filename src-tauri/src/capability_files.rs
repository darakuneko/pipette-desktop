// SPDX-License-Identifier: GPL-2.0-or-later
//! Checks the files the access control is built from. Every build grants
//! capabilities/main.json, which names only the permission sets of
//! permissions/<domain>.toml; together the sets allow each app command
//! once. Builds with the dev-tools feature also grant capabilities/dev/,
//! the only place the development commands are allowed (build.rs). None of
//! them reaches a remote page or a window other than the main one.
//!
//! The access control these files produce is exercised in ipc_contract.rs.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

include!("app_command_names.rs");
include!("dev_command_names.rs");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PermissionFile {
    set: Vec<PermissionSet>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PermissionSet {
    identifier: String,
    #[serde(rename = "description")]
    _description: String,
    permissions: Vec<String>,
}

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The paths of the files in `dir` with the extension `ext`, sorted.
fn files(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.is_file() && path.extension().is_some_and(|e| e == ext))
        .collect();
    paths.sort();
    paths
}

fn file_name(path: &Path) -> &str {
    path.file_name().unwrap().to_str().unwrap()
}

/// The permission sets of permissions/*.toml by identifier.
fn permission_sets() -> BTreeMap<String, Vec<String>> {
    let mut sets = BTreeMap::new();
    for path in files(&root().join("permissions"), "toml") {
        let text = std::fs::read_to_string(&path).unwrap();
        let file: PermissionFile =
            toml::from_str(&text).unwrap_or_else(|err| panic!("{}: {err}", path.display()));
        for set in file.set {
            assert_eq!(
                Some(set.identifier.as_str()),
                path.file_stem().unwrap().to_str(),
                "{}: a set is named after its file",
                path.display()
            );
            assert!(sets.insert(set.identifier, set.permissions).is_none());
        }
    }
    sets
}

fn capability(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The capability's permissions, as strings.
fn granted(capability: &Value) -> Vec<String> {
    capability["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|permission| permission.as_str().expect("a permission without a scope").to_owned())
        .collect()
}

/// The permission Tauri generates to allow `command` (build.rs).
fn allow(command: &str) -> String {
    format!("allow-{}", command.replace('_', "-"))
}

fn sorted(mut items: Vec<String>) -> Vec<String> {
    items.sort();
    items
}

/// A capability reaches local pages of the main window only.
fn assert_main_window_only(path: &Path, capability: &Value) {
    let keys: Vec<&str> = capability.as_object().unwrap().keys().map(String::as_str).collect();
    for key in &keys {
        assert!(
            ["$schema", "identifier", "description", "windows", "permissions", "platforms"].contains(key),
            "{}: unexpected key {key}",
            path.display()
        );
    }
    assert_eq!(capability["windows"], serde_json::json!(["main"]), "{}", path.display());
}

#[test]
fn every_build_grants_only_capabilities_main_json() {
    let release: Vec<String> =
        files(&root().join("capabilities"), "json").iter().map(|path| file_name(path).to_owned()).collect();
    assert_eq!(release, ["main.json"]);
}

#[test]
fn the_main_capability_grants_every_app_command_once_through_the_sets() {
    let path = root().join("capabilities/main.json");
    let main = capability(&path);
    assert_main_window_only(&path, &main);
    assert!(main.get("platforms").is_none());

    let sets = permission_sets();
    let names = granted(&main);
    let unknown: Vec<&String> = names.iter().filter(|name| !sets.contains_key(*name)).collect();
    assert!(unknown.is_empty(), "not a permission set: {unknown:?}");
    assert_eq!(sorted(names.clone()), sorted(sets.keys().cloned().collect()), "every set is granted once");

    let allowed: Vec<String> = names.iter().flat_map(|name| sets[name].clone()).collect();
    assert_eq!(sorted(allowed), sorted(APP_COMMANDS.iter().map(|command| allow(command)).collect()));
}

#[test]
fn the_development_capabilities_grant_exactly_the_development_commands() {
    let dev_commands: Vec<String> =
        DEV_COMMANDS.iter().chain(LINUX_DEV_COMMANDS).map(|command| allow(command)).collect();
    let mut allowed = Vec::new();
    for path in files(&root().join("capabilities/dev"), "json") {
        let dev = capability(&path);
        assert_main_window_only(&path, &dev);
        allowed.extend(granted(&dev));
    }
    assert_eq!(sorted(allowed), sorted(dev_commands.clone()));

    for (name, permissions) in permission_sets() {
        let leaked: Vec<&String> = permissions.iter().filter(|p| dev_commands.contains(p)).collect();
        assert!(leaked.is_empty(), "permission set {name} allows development commands: {leaked:?}");
    }
}
