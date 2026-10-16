// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the scenarios recorded from the TypeScript sync code by
//! scripts/sync-fixtures/record-sync-merge-fixtures.test.ts: each seeds a
//! userData tree and runs merges, pack GCs, bundles and unit collections
//! on it, and every step is compared with the recording: the outcome (the
//! error kind, or whether Drive needs this device's copy and the bundle it
//! would upload), the windows notified, the units reported for sync, the
//! Drive revisions forgotten and the tree left behind, byte for byte.

#![allow(clippy::unwrap_used, clippy::panic)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use pipette_entry_store::{FixedClock, WriteLocks};
use pipette_js_json::{Object, Value, parse, stringify};
use pipette_keyboard_stores::StoreContext;
use pipette_pack_stores::sync::run_pack_gc_after_pass;
use pipette_sync::bundle::{
    bundle_plaintext, bundle_sync_unit, collect_all_sync_units, collect_analytics_sync_units_for_uid,
};
use pipette_sync::merge::{MergeEnv, MergeError, MergeEvents, PackKind, PackRosters, merge_sync_unit};
use pipette_sync_format::drive_names::drive_file_name;
use pipette_sync_runtime::{RemoteMemory, RemoteRevision};

type Tree = BTreeMap<String, Option<String>>;

fn fixture() -> Vec<Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_sync_merge.json");
    match parse(&std::fs::read_to_string(path).unwrap()).unwrap() {
        Value::Array(items) => items,
        _ => panic!("not a list"),
    }
}

fn get<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.as_object().and_then(|o| o.get(key)).unwrap_or_else(|| panic!("no {key} in {}", stringify(value)))
}

fn opt<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|o| o.get(key))
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_else(|| panic!("not a string: {}", stringify(value))).to_owned()
}

fn strings(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => items.iter().map(text).collect(),
        _ => panic!("not a list"),
    }
}

fn tree_of(value: &Value) -> Tree {
    value
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.as_str().map(str::to_owned)))
        .collect()
}

fn write_tree(root: &Path, tree: &Tree) {
    for (path, content) in tree {
        let target = root.join(path.trim_end_matches('/'));
        match content {
            None => std::fs::create_dir_all(&target).unwrap(),
            Some(content) => {
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                std::fs::write(&target, content).unwrap();
            }
        }
    }
}

/// Every file (as UTF-8 text) and empty directory under `root`.
fn read_tree(root: &Path) -> Tree {
    fn walk(root: &Path, dir: &Path, tree: &mut Tree) {
        let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        if entries.is_empty() && dir != root {
            let rel = dir.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
            tree.insert(format!("{rel}/"), None);
        }
        for entry in entries {
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                walk(root, &path, tree);
            } else {
                let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                tree.insert(rel, Some(String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned()));
            }
        }
    }
    let mut tree = Tree::new();
    walk(root, root, &mut tree);
    tree
}

#[derive(Default)]
struct Recorded {
    events: Mutex<Vec<Value>>,
    pending: Mutex<Vec<String>>,
}

impl MergeEvents for Recorded {
    fn unit_applied(&self, unit: &str) {
        let mut payload = Object::new();
        payload.insert("syncUnit", unit.into());
        self.events
            .lock()
            .unwrap()
            .push(Value::Array(vec!["sync:unit-applied".into(), Value::Object(payload)]));
    }

    fn pack_changed(&self, kind: PackKind) {
        let channel = match kind {
            PackKind::I18n => "i18n-pack:changed",
            PackKind::Theme => "theme-pack:changed",
        };
        self.events.lock().unwrap().push(Value::Array(vec![channel.into(), Value::Null]));
    }
}

fn error_name(err: &MergeError) -> &'static str {
    match err {
        MergeError::Malformed(_) => "MalformedSyncBundleError",
        MergeError::PackMetaPending(_) => "PackMetaPendingError",
        MergeError::Type(_) => "TypeError",
        _ => "Error",
    }
}

/// The Drive names of the pack bodies a roster merge could forget: every
/// id the local rosters and the remote bundle name.
fn forget_candidates(root: &Path, bundle: &Value) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    let mut add = |dir: &str, metas: Option<&Value>| {
        if let Some(Value::Array(metas)) = metas {
            for id in metas.iter().filter_map(|m| opt(m, "id")).filter_map(Value::as_str) {
                names.insert(drive_file_name(&format!("{dir}/packs/{id}")));
            }
        }
    };
    for dir in ["i18n", "themes"] {
        if let Ok(Value::Object(index)) =
            std::fs::read_to_string(root.join("sync").join(dir).join("index.json"))
                .map_or(Ok(Value::Null), |t| parse(&t))
        {
            add(dir, index.get("metas"));
        }
        add(dir, opt(bundle, "index").and_then(|i| opt(i, "metas")));
    }
    names
}

struct Run<'a> {
    name: String,
    failures: &'a mut Vec<String>,
}

impl Run<'_> {
    fn check<T: PartialEq + std::fmt::Debug>(&mut self, what: String, got: T, want: T) {
        if got != want {
            self.failures.push(format!("{} / {what}:\n  got  {got:?}\n  want {want:?}", self.name));
        }
    }
}

#[test]
fn scenarios_match() {
    let mut failures = Vec::new();
    for scenario in fixture() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_tree(root, &tree_of(get(&scenario, "tree")));
        for (path, ms) in get(&scenario, "mtimes").as_object().unwrap().iter() {
            let Value::Number(ms) = ms else { panic!() };
            let time = UNIX_EPOCH + Duration::from_millis(*ms as u64);
            let file = std::fs::File::options()
                .write(true)
                .open(root.join(path.to_string_lossy().as_ref()))
                .unwrap();
            file.set_modified(time).unwrap();
        }
        let Value::Number(now) = get(&scenario, "now") else { panic!() };
        let recorded = Arc::new(Recorded::default());
        let notifier = {
            let recorded = recorded.clone();
            Arc::new(move |unit: &str| recorded.pending.lock().unwrap().push(unit.to_owned()))
        };
        let ctx = StoreContext::new(
            root,
            Arc::new(FixedClock::new(*now as i64)),
            Arc::new(WriteLocks::new()),
            notifier,
        );
        let remote = RemoteMemory::default();
        let rosters = PackRosters::default();
        let own_hash = text(get(&scenario, "ownHash"));
        let typing_uids = strings(get(&scenario, "typingUids"));
        let mut run = Run { name: text(get(&scenario, "name")), failures: &mut failures };

        let Value::Array(steps) = get(&scenario, "steps") else { panic!() };
        for (i, item) in steps.iter().enumerate() {
            recorded.events.lock().unwrap().clear();
            recorded.pending.lock().unwrap().clear();
            let step = get(item, "step");
            let want = get(item, "result");
            if let Some(merge) = opt(step, "merge") {
                let unit = text(get(merge, "unit"));
                let bundle = parse(&text(get(merge, "plaintext"))).unwrap();
                let modified = text(get(merge, "modifiedTime"));
                let candidates = forget_candidates(root, &bundle);
                for name in &candidates {
                    remote.record(name, RemoteRevision { id: "known".into(), modified_time: "t".into() });
                }
                let env =
                    MergeEnv { ctx: &ctx, events: recorded.as_ref(), remote: &remote, rosters: &rosters };
                let label = format!("step {i} merge {unit}");
                match merge_sync_unit(&env, &unit, &bundle, &modified) {
                    Ok(needs) => {
                        run.check(format!("{label}: error"), None, opt(want, "error").map(text));
                        run.check(
                            format!("{label}: needsUpload"),
                            Value::Bool(needs),
                            get(want, "needsUpload").clone(),
                        );
                        if needs {
                            let uploaded =
                                bundle_sync_unit(&ctx, &unit).unwrap().map(|b| bundle_plaintext(&b));
                            run.check(
                                format!("{label}: uploaded"),
                                uploaded,
                                get(want, "uploaded").as_str().map(str::to_owned),
                            );
                        }
                        rosters.mark_synced(&unit);
                    }
                    Err(err) => {
                        run.check(
                            format!("{label}: error ({err})"),
                            Some(error_name(&err).to_owned()),
                            opt(want, "error").map(text),
                        );
                    }
                }
                let forgotten: Vec<String> =
                    candidates.iter().filter(|n| !remote.is_known(n, "known", "t")).cloned().collect();
                run.check(format!("{label}: forgotten"), forgotten, strings(get(want, "forgotten")));
                run.check(
                    format!("{label}: events"),
                    stringify(&Value::Array(recorded.events.lock().unwrap().clone())),
                    stringify(get(want, "events")),
                );
                run.check(
                    format!("{label}: pending"),
                    recorded.pending.lock().unwrap().clone(),
                    strings(get(want, "pending")),
                );
                run.check(format!("{label}: tree"), read_tree(root), tree_of(get(want, "tree")));
            } else if let Some(gc) = opt(step, "gc") {
                run_pack_gc_after_pass(&ctx, &strings(get(gc, "attempted")), &strings(get(gc, "failed")));
                run.check(
                    format!("step {i} gc: pending"),
                    recorded.pending.lock().unwrap().clone(),
                    strings(get(want, "pending")),
                );
                run.check(format!("step {i} gc: tree"), read_tree(root), tree_of(get(want, "tree")));
            } else if let Some(Value::Array(units)) = opt(step, "bundle") {
                let Value::Array(bundles) = get(want, "bundles") else { panic!() };
                for (unit, want) in units.iter().map(text).zip(bundles) {
                    let got = match bundle_sync_unit(&ctx, &unit) {
                        Ok(b) => b.map(|b| bundle_plaintext(&b)).map_or(Value::Null, Value::from),
                        Err(_) => Value::from("<error>"),
                    };
                    let want = opt(want, "plaintext").cloned().unwrap_or_else(|| Value::from("<error>"));
                    run.check(format!("step {i} bundle {unit}"), got, want);
                }
                run.check(format!("step {i} bundle: tree"), read_tree(root), tree_of(get(want, "tree")));
            } else if let Some(collect) = opt(step, "collect") {
                let all = collect_all_sync_units::<String>(&ctx, Ok((own_hash.clone(), typing_uids.clone())));
                run.check(format!("step {i} collect: all"), all, strings(get(want, "all")));
                let uid = text(get(collect, "uid"));
                let for_uid =
                    collect_analytics_sync_units_for_uid::<String>(&ctx, &uid, Ok(own_hash.clone()));
                run.check(format!("step {i} collect: for uid"), for_uid, strings(get(want, "forUid")));
            }
        }
    }
    assert!(failures.is_empty(), "{} mismatches:\n{}", failures.len(), failures.join("\n"));
}
