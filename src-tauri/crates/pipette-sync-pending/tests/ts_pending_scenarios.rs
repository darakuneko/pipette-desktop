// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the recorded golden scenarios of the pending store: the
//! same userData files, the restore, the same changes and writes, then
//! every file left behind compared byte for byte, after the restore and
//! after the steps, with the generations of the units.

#![allow(clippy::unwrap_used)]

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use common::Harness;
use pipette_js_json::Value;

/// Path → what is there: a file's bytes, a symlink's target, or a directory
/// (the path ends in `/`).
#[derive(Debug, PartialEq)]
enum Node {
    File(Vec<u8>),
    Symlink(String),
    Dir,
}

type Tree = BTreeMap<String, Node>;

fn text(value: &Value) -> String {
    value.as_str().unwrap().to_owned()
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}

fn tree_of(value: &Value) -> Tree {
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

fn build(dir: &Path, tree: &Tree) {
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

fn record(dir: &Path, prefix: &str, tree: &mut Tree) {
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

fn recorded(dir: &Path) -> Tree {
    let mut tree = Tree::new();
    record(dir, "", &mut tree);
    tree
}

#[test]
fn the_scenarios_match_the_golden() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_pending_scenarios.json");
    let fixture = pipette_js_json::parse(&fs::read_to_string(path).unwrap()).unwrap();
    let Value::Array(scenarios) = fixture else { panic!("not a list") };
    assert!(!scenarios.is_empty());
    for scenario in &scenarios {
        let scenario = scenario.as_object().unwrap();
        let name = text(scenario.get("name").unwrap());
        let h = Harness::new();
        let tree = tree_of(scenario.get("tree").unwrap());
        let symlinks = tree.values().any(|node| matches!(node, Node::Symlink(_)));
        let paths = tree.keys().map(String::as_str);
        if let Some(reason) = pipette_fs::test_util::unsupported_tree(h.user_data(), paths, symlinks) {
            eprintln!("SKIPPED {name}: {reason}");
            continue;
        }
        build(h.user_data(), &tree);

        let store = h.restore();
        h.scheduler.advance();
        assert_eq!(
            recorded(h.user_data()),
            tree_of(scenario.get("restored").unwrap()),
            "{name}: after the restore"
        );
        if name == "the directory is removed after the restore" {
            fs::remove_dir_all(h.user_data().join("local")).unwrap();
        }

        let Some(Value::Array(steps)) = scenario.get("steps") else { panic!("{name}: no steps") };
        for step in steps {
            let step = step.as_object().unwrap();
            match text(step.get("op").unwrap()).as_str() {
                "notify" => store.notify_change(&text(step.get("unit").unwrap())),
                "advance" => h.scheduler.advance(),
                "persistNow" => store.persist_now(),
                op => panic!("{name}: unknown step {op}"),
            }
        }
        assert_eq!(
            Value::Bool(store.has_pending_changes()),
            *scenario.get("hasPending").unwrap(),
            "{name}: pending"
        );
        let Some(Value::Array(generations)) = scenario.get("generations") else { panic!("{name}") };
        for pair in generations {
            let Value::Array(pair) = pair else { panic!("{name}") };
            // A unit with a lone surrogate can only come from the file; its
            // bytes are compared below.
            let Some(unit) = pair[0].as_str() else { continue };
            let Value::Number(generation) = pair[1] else { panic!("{name}") };
            assert_eq!(store.pending_generation_of(unit) as f64, generation, "{name}: generation of {unit}");
        }

        h.scheduler.advance();
        assert_eq!(
            recorded(h.user_data()),
            tree_of(scenario.get("after").unwrap()),
            "{name}: after the steps"
        );
    }
}
