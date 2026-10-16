// SPDX-License-Identifier: GPL-2.0-or-later
//! A store context on a temporary userData directory with a settable clock
//! and the notified units recorded, and userData trees (path → node) to
//! build and compare.

#![allow(dead_code, clippy::unwrap_used, clippy::panic)]

pub mod replay;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use pipette_entry_store::{FixedClock, SequenceIds, WriteLocks};
use pipette_js_json::Value;
use pipette_keyboard_stores::StoreContext;
use tempfile::TempDir;

pub const T0: &str = "2026-10-16T12:00:00.000Z";

pub fn ms(iso: &str) -> i64 {
    pipette_time::parse_date_time_string(iso).unwrap()
}

/// The `n`th id a [`Harness`] hands out, shaped like a random UUID.
pub fn id(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

pub struct Harness {
    pub dir: TempDir,
    pub clock: Arc<FixedClock>,
    pub notified: Arc<Mutex<Vec<String>>>,
    pub ctx: StoreContext,
}

impl Harness {
    /// New packs get the ids [`id`] 1, 2, ….
    pub fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let clock = Arc::new(FixedClock::new(ms(T0)));
        let notified = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&notified);
        let ctx = StoreContext::new(
            dir.path(),
            clock.clone(),
            Arc::new(WriteLocks::new()),
            Arc::new(move |unit: &str| record.lock().unwrap().push(unit.to_owned())),
        )
        .with_ids(Arc::new(SequenceIds::new((1..=500).map(id))));
        Self { dir, clock, notified, ctx }
    }

    pub fn user_data(&self) -> &Path {
        self.dir.path()
    }

    pub fn path(&self, relative: &str) -> PathBuf {
        self.user_data().join(relative)
    }

    pub fn write(&self, relative: &str, content: &str) {
        let target = self.path(relative);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, content).unwrap();
    }

    pub fn read(&self, relative: &str) -> String {
        fs::read_to_string(self.path(relative)).unwrap()
    }

    pub fn notified(&self) -> Vec<String> {
        self.notified.lock().unwrap().clone()
    }

    pub fn clear_notified(&self) {
        self.notified.lock().unwrap().clear();
    }
}

/// What is at a path: a file's bytes, a large file's SHA-256 and size, or a
/// directory (the path ends in `/`).
#[derive(Debug, PartialEq)]
pub enum Node {
    File(Vec<u8>),
    Hashed { sha256: String, size: usize },
    Dir,
}

fn text(value: &Value) -> String {
    value.as_str().unwrap().to_owned()
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}

/// The repository's root.
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// A recorded tree, in its order; `{copyOf}` reads a file of the repository.
pub fn tree_of(value: &Value) -> Vec<(String, Node)> {
    value
        .as_object()
        .unwrap()
        .iter()
        .map(|(path, node)| {
            let node = match node {
                Value::Null => Node::Dir,
                Value::String(content) => Node::File(content.as_str().unwrap().as_bytes().to_vec()),
                Value::Object(object) => {
                    if let Some(hex) = object.get("hex") {
                        Node::File(hex_bytes(&text(hex)))
                    } else if let Some(source) = object.get("copyOf") {
                        Node::File(fs::read(repo_root().join(text(source))).unwrap())
                    } else if let (Some(sha), Some(Value::Number(size))) =
                        (object.get("sha256"), object.get("size"))
                    {
                        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                        let size = *size as usize;
                        Node::Hashed { sha256: text(sha), size }
                    } else {
                        panic!("unknown node {object:?}")
                    }
                }
                other => panic!("unknown node {other:?}"),
            };
            (path.as_str().unwrap().to_owned(), node)
        })
        .collect()
}

/// Builds `tree` under `dir`, in its order.
pub fn build(dir: &Path, tree: &[(String, Node)]) {
    for (path, node) in tree {
        let target = dir.join(path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        match node {
            Node::Dir => fs::create_dir_all(&target).unwrap(),
            Node::File(bytes) => fs::write(&target, bytes).unwrap(),
            Node::Hashed { .. } => panic!("{path}: a hashed file cannot be built"),
        }
    }
}

/// Everything under `dir`, files larger than `inline_limit` bytes as their
/// hash.
pub fn recorded(dir: &Path, inline_limit: usize) -> BTreeMap<String, Node> {
    let mut tree = BTreeMap::new();
    record(dir, "", inline_limit, &mut tree);
    tree
}

fn record(dir: &Path, prefix: &str, inline_limit: usize, tree: &mut BTreeMap<String, Node>) {
    for item in fs::read_dir(dir).unwrap() {
        let item = item.unwrap();
        let name = item.file_name().into_string().unwrap();
        let path = item.path();
        if fs::symlink_metadata(&path).unwrap().is_dir() {
            tree.insert(format!("{prefix}{name}/"), Node::Dir);
            record(&path, &format!("{prefix}{name}/"), inline_limit, tree);
        } else {
            let bytes = fs::read(&path).unwrap();
            let node = if bytes.len() > inline_limit {
                let text = String::from_utf8(bytes).unwrap();
                Node::Hashed { sha256: pipette_entry_store::body_hash(&text), size: text.len() }
            } else {
                Node::File(bytes)
            };
            tree.insert(format!("{prefix}{name}"), node);
        }
    }
}
