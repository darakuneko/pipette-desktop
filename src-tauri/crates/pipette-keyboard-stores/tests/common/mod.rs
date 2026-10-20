// SPDX-License-Identifier: GPL-2.0-or-later
//! A store context on a temporary userData directory with a settable clock
//! and the notified units recorded, and userData trees (path → node) to
//! build and compare.

#![allow(dead_code, clippy::unwrap_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use pipette_entry_store::{FixedClock, SequenceIds, WriteLocks};
use pipette_js_json::Value;
use pipette_keyboard_stores::StoreContext;
use tempfile::TempDir;

pub const T0: &str = "2026-10-16T12:00:00.000Z";
pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;

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
    /// New entries get the ids [`id`] 1, 2, ….
    pub fn new() -> Self {
        Self::with_ids((1..=500).map(id))
    }

    pub fn with_ids(ids: impl IntoIterator<Item = String>) -> Self {
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
        .with_ids(Arc::new(SequenceIds::new(ids)));
        Self { dir, clock, notified, ctx }
    }

    pub fn user_data(&self) -> &Path {
        self.dir.path()
    }

    pub fn meta_path(&self) -> PathBuf {
        self.user_data().join("sync/meta/keyboard-names.json")
    }

    pub fn write(&self, path: &str, content: &str) {
        let target = self.user_data().join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, content).unwrap();
    }

    pub fn read_meta(&self) -> String {
        fs::read_to_string(self.meta_path()).unwrap()
    }

    /// The entries of the names file, as `[uid, deviceName, deletedAt?]`.
    pub fn meta_entries(&self) -> Vec<Value> {
        let parsed = pipette_js_json::parse(&self.read_meta()).unwrap();
        let Some(Value::Array(entries)) = parsed.as_object().unwrap().get("entries").cloned() else {
            panic!()
        };
        entries
    }

    pub fn notified(&self) -> Vec<String> {
        self.notified.lock().unwrap().clone()
    }
}

/// What is at a path: a file's bytes, a symlink's target, or a directory
/// (the path ends in `/`).
#[derive(Debug, PartialEq)]
pub enum Node {
    File(Vec<u8>),
    Symlink(String),
    Dir,
}

fn text(value: &Value) -> String {
    value.as_str().unwrap().to_owned()
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}

/// A recorded tree, in its order.
pub fn tree_of(value: &Value) -> Vec<(String, Node)> {
    value
        .as_object()
        .unwrap()
        .iter()
        .map(|(path, node)| {
            let node = match node {
                Value::Null => Node::Dir,
                Value::String(content) => Node::File(content.as_str().unwrap().as_bytes().to_vec()),
                Value::Object(object) => match (object.get("hex"), object.get("symlink")) {
                    (Some(hex), None) => Node::File(hex_bytes(&text(hex))),
                    (None, Some(target)) => Node::Symlink(text(target)),
                    _ => panic!("unknown node {object:?}"),
                },
                other => panic!("unknown node {other:?}"),
            };
            (path.as_str().unwrap().to_owned(), node)
        })
        .collect()
}

/// Why this host cannot build `tree` under `dir` as it was recorded, if it
/// cannot (pipette_fs::test_util).
pub fn unsupported(dir: &Path, tree: &[(String, Node)]) -> Option<String> {
    let symlinks = tree.iter().any(|(_, node)| matches!(node, Node::Symlink(_)));
    pipette_fs::test_util::unsupported_tree(dir, tree.iter().map(|(path, _)| path.as_str()), symlinks)
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
            Node::Symlink(link) => symlink(link, &target),
        }
    }
}

#[cfg(unix)]
fn symlink(link: &str, target: &Path) {
    std::os::unix::fs::symlink(link, target).unwrap();
}

#[cfg(not(unix))]
fn symlink(_: &str, _: &Path) {
    panic!("the symlink scenarios need Unix");
}

/// Everything under `dir`.
pub fn recorded(dir: &Path) -> BTreeMap<String, Node> {
    let mut tree = BTreeMap::new();
    record(dir, "", &mut tree);
    tree
}

fn record(dir: &Path, prefix: &str, tree: &mut BTreeMap<String, Node>) {
    for item in fs::read_dir(dir).unwrap() {
        let item = item.unwrap();
        let name = item.file_name().into_string().unwrap();
        let path = item.path();
        let kind = fs::symlink_metadata(&path).unwrap().file_type();
        if kind.is_symlink() {
            let link = fs::read_link(&path).unwrap().into_os_string().into_string().unwrap();
            tree.insert(format!("{prefix}{name}"), Node::Symlink(link));
        } else if kind.is_dir() {
            tree.insert(format!("{prefix}{name}/"), Node::Dir);
            record(&path, &format!("{prefix}{name}/"), tree);
        } else {
            tree.insert(format!("{prefix}{name}"), Node::File(fs::read(&path).unwrap()));
        }
    }
}

/// A string field of a recorded step.
pub fn step_text(step: &pipette_js_json::Object, key: &str) -> String {
    step.get(key).unwrap().as_str().unwrap().to_owned()
}

/// `got` with an error text the crate does not copy replaced as the
/// recorded goldens have it: a file-system
/// error's as `<os error>` (every `Error: …` but the store's own `known`
/// ones), a body that is not JSON as `<syntax error>`.
pub fn as_recorded(got: String, known: &[&str]) -> String {
    let parsed = pipette_js_json::parse(&got).unwrap();
    let error = parsed.as_object().unwrap().get("error").and_then(Value::as_str).unwrap_or_default();
    if error.starts_with("Error: ") && !known.contains(&error) {
        return r#"{"success":false,"error":"<os error>"}"#.to_owned();
    }
    if error.starts_with("SyntaxError: ") {
        return r#"{"success":false,"error":"<syntax error>"}"#.to_owned();
    }
    got
}

/// The scenarios of the fixture `name` (under tests/fixtures).
pub fn fixture_scenarios(name: &str) -> Vec<Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    let fixture = pipette_js_json::parse(&fs::read_to_string(path).unwrap()).unwrap();
    let Value::Array(scenarios) = fixture else { panic!("not a list") };
    assert!(!scenarios.is_empty());
    scenarios
}

/// Replays the scenarios of the fixture `name` (under tests/fixtures)
/// recorded for a store: the
/// same userData files and clock, each step run by `run_step` (`None` for
/// a clock move, which it makes) and its answer compared as
/// [`as_recorded`] with `known`, then the notified units and every file
/// left behind. `harness` makes each scenario's harness; the scenarios
/// named in `skip` are left to the caller.
pub fn replay_scenarios(
    name: &str,
    skip: &[&str],
    harness: impl Fn(&pipette_js_json::Object) -> Harness,
    known: &[&str],
    run_step: impl Fn(&Harness, &pipette_js_json::Object) -> Option<String>,
) {
    for scenario in &fixture_scenarios(name) {
        let scenario = scenario.as_object().unwrap();
        let name = step_text(scenario, "name");
        if skip.contains(&name.as_str()) {
            continue;
        }
        let h = harness(scenario);
        h.clock.set(ms(&step_text(scenario, "time")));
        build(h.user_data(), &tree_of(scenario.get("tree").unwrap()));

        let Some(Value::Array(steps)) = scenario.get("steps") else { panic!("{name}: no steps") };
        let Some(Value::Array(outcomes)) = scenario.get("outcomes") else { panic!("{name}: no outcomes") };
        assert_eq!(steps.len(), outcomes.len(), "{name}");
        for (at, (step, want)) in steps.iter().zip(outcomes).enumerate() {
            let got = run_step(&h, step.as_object().unwrap()).map(|got| as_recorded(got, known));
            assert_eq!(got.as_deref(), want.as_str(), "{name}: step {at}");
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
