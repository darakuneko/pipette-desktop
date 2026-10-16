// SPDX-License-Identifier: GPL-2.0-or-later
//! Reading the fixtures the TypeScript generators recorded
//! (scripts/analytics-db-fixtures): values with the parts JSON cannot carry
//! (tagged.ts), userData trees, path → content
//! (scripts/keyboard-store-fixtures/fixture-tree.ts), and the cache tables
//! in the canonical text of canonical.ts; and the flush timer the
//! recording scenarios drive.

#![allow(dead_code, clippy::unwrap_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fmt::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pipette_entry_store::{Clock, FixedClock};
use pipette_typing_analytics::FlushTimer;
use rusqlite::types::ValueRef;

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

type Task = Box<dyn FnOnce() + Send>;

/// A timer driven by the test: its tasks run when [`ManualTimer::advance`]
/// moves the clock past their time.
pub struct ManualTimer {
    clock: Arc<FixedClock>,
    tasks: Mutex<Vec<(i64, Task)>>,
}

impl FlushTimer for ManualTimer {
    fn schedule(&self, delay: Duration, task: Task) {
        let due = self.clock.now_ms() + delay.as_millis() as i64;
        self.tasks.lock().unwrap().push((due, task));
    }
}

impl ManualTimer {
    pub fn new(clock: Arc<FixedClock>) -> Self {
        Self { clock, tasks: Mutex::new(Vec::new()) }
    }

    /// Moves the clock by `ms` and runs the tasks due by then, in the order
    /// they are due.
    pub fn advance(&self, ms: i64) {
        let now = self.clock.now_ms() + ms;
        self.clock.set(now);
        let mut due: Vec<_> = {
            let mut tasks = self.tasks.lock().unwrap();
            let (due, later) = tasks.drain(..).partition(|(at, _)| *at <= now);
            *tasks = later;
            due
        };
        due.sort_by_key(|(at, _)| *at);
        for (_, task) in due {
            task();
        }
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut s, b| {
        write!(s, "{b:02x}").unwrap();
        s
    })
}

fn cell(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => "n".to_owned(),
        ValueRef::Integer(i) => format!("i:{i}"),
        ValueRef::Real(r) => format!("r:{:016x}", r.to_bits()),
        ValueRef::Text(t) => format!("t:{}", hex(t)),
        ValueRef::Blob(b) => format!("b:{}", hex(b)),
    }
}

/// The rows of `table` ordered by its primary key, in the canonical text
/// of canonical.ts.
pub fn table_rows(conn: &rusqlite::Connection, table: &str) -> Vec<String> {
    let mut info = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap();
    let mut columns: Vec<(String, i64)> =
        info.query_map([], |r| Ok((r.get("name")?, r.get("pk")?))).unwrap().map(Result::unwrap).collect();
    let names = columns.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(", ");
    columns.retain(|(_, pk)| *pk > 0);
    columns.sort_by_key(|(_, pk)| *pk);
    let order = columns.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().join(", ");
    let mut stmt = conn.prepare(&format!("SELECT {names} FROM {table} ORDER BY {order}")).unwrap();
    let width = stmt.column_count();
    stmt.query_map([], |r| Ok((0..width).map(|i| cell(r.get_ref(i).unwrap())).collect::<Vec<_>>().join("|")))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}
