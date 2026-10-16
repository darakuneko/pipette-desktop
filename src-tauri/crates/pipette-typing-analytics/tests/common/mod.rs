// SPDX-License-Identifier: GPL-2.0-or-later
//! Reading the fixtures the TypeScript generators recorded
//! (scripts/analytics-db-fixtures): values with the parts JSON cannot carry
//! (tagged.ts) and userData trees, path → content
//! (scripts/keyboard-store-fixtures/fixture-tree.ts).

#![allow(dead_code, clippy::unwrap_used, clippy::panic)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use pipette_js_json::{JsString, Object, Value};

pub fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    pipette_js_json::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

pub fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.as_object().and_then(|object| object.get(key)).unwrap_or_else(|| panic!("no {key} in {value:?}"))
}

pub fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    field(value, key).as_str().unwrap_or_else(|| panic!("{key} is not text"))
}

pub fn js_text(value: &Value) -> &JsString {
    match value {
        Value::String(s) => s,
        other => panic!("not text: {other:?}"),
    }
}

pub fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    match field(value, key) {
        Value::Array(items) => items,
        other => panic!("{key}: {other:?}"),
    }
}

pub fn number(value: &Value) -> f64 {
    match untag(value) {
        Some(Value::Number(n)) => n,
        other => panic!("not a number: {other:?}"),
    }
}

/// The value tagged.ts recorded: `{ "$n": … }` back to the number,
/// `{ "$u": true }` (undefined) to `None`, left out of an object and null
/// in an array, as `JSON.stringify` writes it.
pub fn untag(value: &Value) -> Option<Value> {
    match value {
        Value::Object(object) if object.len() == 1 && object.contains_key("$u") => None,
        Value::Object(object) if object.len() == 1 && object.contains_key("$n") => {
            Some(Value::Number(match object.get("$n").and_then(Value::as_str) {
                Some("NaN") => f64::NAN,
                Some("Infinity") => f64::INFINITY,
                Some("-Infinity") => f64::NEG_INFINITY,
                Some("-0") => -0.0,
                other => panic!("unknown number tag {other:?}"),
            }))
        }
        Value::Object(object) => Some(Value::Object(
            object.iter().filter_map(|(key, v)| untag(v).map(|v| (key.clone(), v))).collect::<Object>(),
        )),
        Value::Array(items) => {
            Some(Value::Array(items.iter().map(|v| untag(v).unwrap_or(Value::Null)).collect()))
        }
        other => Some(other.clone()),
    }
}

/// A node of a userData tree: a directory or a file's bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    Dir,
    File(Vec<u8>),
}

fn from_hex(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}

/// A recorded tree: `path/` or `path` → null (a directory), UTF-8 text or
/// `{ hex }`.
pub fn tree_of(value: &Value) -> BTreeMap<String, Node> {
    let Value::Object(object) = value else { panic!("not a tree: {value:?}") };
    object
        .iter()
        .map(|(path, content)| {
            let path = path.to_string_lossy().trim_end_matches('/').to_owned();
            let node = match content {
                Value::Null => Node::Dir,
                Value::String(text) => Node::File(text.to_string_lossy().into_owned().into_bytes()),
                other => Node::File(from_hex(text(other, "hex"))),
            };
            (path, node)
        })
        .collect()
}

pub fn build_tree(dir: &Path, tree: &BTreeMap<String, Node>) {
    for (path, node) in tree {
        let target = dir.join(path);
        match node {
            Node::Dir => std::fs::create_dir_all(&target).unwrap(),
            Node::File(bytes) => {
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                std::fs::write(&target, bytes).unwrap();
            }
        }
    }
}

/// Every file and directory under `dir`, by `/`-separated relative path.
pub fn record_tree(dir: &Path) -> BTreeMap<String, Node> {
    let mut tree = BTreeMap::new();
    record_into(dir, "", &mut tree);
    tree
}

fn record_into(dir: &Path, prefix: &str, tree: &mut BTreeMap<String, Node>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let entry = entry.unwrap();
        let path = format!("{prefix}{}", entry.file_name().to_str().unwrap());
        if entry.file_type().unwrap().is_dir() {
            tree.insert(path.clone(), Node::Dir);
            record_into(&entry.path(), &format!("{path}/"), tree);
        } else {
            tree.insert(path, Node::File(std::fs::read(entry.path()).unwrap()));
        }
    }
}
