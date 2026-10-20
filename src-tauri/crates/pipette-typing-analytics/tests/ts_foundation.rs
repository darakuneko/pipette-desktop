// SPDX-License-Identifier: GPL-2.0-or-later
//! The installation id, the sync state file and the cache freshness check
//! against what the TypeScript code did on the same userData directories
//! (the recorded goldens in tests/fixtures).

// Helpers outside #[test] functions unwrap fixture data too.
#![allow(clippy::unwrap_used)]

use std::cell::Cell;
use std::path::{Path, PathBuf};

use pipette_entry_store::{FixedClock, SequenceIds};
use pipette_js_json::Value;
use pipette_typing_analytics::ensure_cache_is_fresh;
use pipette_typing_analytics::identity::{installation_id_path, load_or_create_installation_id};
use pipette_typing_analytics::sync_state::{load_sync_state, save_sync_state, sync_state_path};

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    pipette_js_json::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.as_object().and_then(|object| object.get(key)).unwrap_or_else(|| panic!("no {key}"))
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    field(value, key).as_str().unwrap()
}

fn cases(fixture: &Value) -> &[Value] {
    match field(fixture, "cases") {
        Value::Array(cases) => cases,
        other => panic!("cases: {other:?}"),
    }
}

/// What a path holds, as the fixtures record it.
#[derive(Debug, PartialEq)]
enum Entry {
    Missing,
    Dir,
    File(Vec<u8>),
}

fn entry_of(value: &Value) -> Entry {
    match value {
        Value::Null => Entry::Missing,
        Value::Object(object) if object.contains_key("dir") => Entry::Dir,
        Value::Object(_) => Entry::File(from_hex(text(value, "hex"))),
        other => panic!("entry: {other:?}"),
    }
}

fn from_hex(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}

fn read_entry(path: &Path) -> Entry {
    match std::fs::symlink_metadata(path) {
        Err(_) => Entry::Missing,
        Ok(meta) if meta.is_dir() => Entry::Dir,
        Ok(_) => Entry::File(std::fs::read(path).unwrap()),
    }
}

fn write_entry(path: &Path, entry: &Entry) {
    match entry {
        Entry::Missing => {}
        Entry::Dir => std::fs::create_dir_all(path).unwrap(),
        Entry::File(bytes) => {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
    }
}

#[test]
fn installation_ids_match_typescript() {
    let fixture = fixture("installation_id.json");
    let new_id = text(&fixture, "newId");
    for case in cases(&fixture) {
        let name = text(case, "name");
        let dir = tempfile::tempdir().unwrap();
        let path = installation_id_path(dir.path());
        let local = path.parent().unwrap();
        write_entry(local, &entry_of(field(case, "local")));
        write_entry(&path, &entry_of(field(case, "file")));

        let id = load_or_create_installation_id(dir.path(), &SequenceIds::new([new_id])).ok();
        assert_eq!(id.as_deref(), field(case, "id").as_str(), "{name}");
        let after = field(case, "after");
        assert_eq!(read_entry(local), entry_of(field(after, "local")), "{name}: local");
        assert_eq!(read_entry(&path), entry_of(field(after, "file")), "{name}: file");
    }
}

#[test]
fn sync_states_match_typescript() {
    for case in cases(&fixture("sync_state.json")) {
        let name = text(case, "name");
        let dir = tempfile::tempdir().unwrap();
        let path = sync_state_path(dir.path());
        write_entry(&path, &entry_of(field(case, "file")));

        let state = load_sync_state(dir.path());
        assert_eq!(state.is_some(), matches!(field(case, "loaded"), Value::Bool(true)), "{name}");
        if let Some(state) = state {
            std::fs::remove_file(&path).unwrap();
            save_sync_state(dir.path(), &state).unwrap();
            assert_eq!(read_entry(&path), entry_of(field(case, "written")), "{name}");
        }
    }
}

#[test]
fn cache_freshness_matches_typescript() {
    let fixture = fixture("cache_freshness.json");
    let device = text(&fixture, "device");
    let Value::Number(now) = field(&fixture, "nowMs") else { panic!("nowMs") };
    for case in cases(&fixture) {
        let name = text(case, "name");
        let dir = tempfile::tempdir().unwrap();
        write_entry(&sync_state_path(dir.path()), &entry_of(field(case, "file")));

        let ran = Cell::new(false);
        let force = matches!(field(case, "force"), Value::Bool(true));
        let freshness =
            ensure_cache_is_fresh(dir.path(), device, force, &FixedClock::new(*now as i64), || {
                ran.set(true);
                Ok(())
            })
            .unwrap();
        let rebuilt = matches!(field(case, "rebuilt"), Value::Bool(true));
        assert_eq!((freshness.rebuilt, ran.get()), (rebuilt, rebuilt), "{name}");
        assert_eq!(read_entry(&sync_state_path(dir.path())), entry_of(field(case, "after")), "{name}");
    }
}
