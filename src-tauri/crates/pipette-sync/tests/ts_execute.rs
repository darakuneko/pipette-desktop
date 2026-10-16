// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays tests/fixtures/ts_execute.json, recorded from the TypeScript
//! sync code by scripts/sync-fixtures/record-execute-fixtures.test.ts:
//!
//! - the scope truth table (`matchesScope`, `shouldDownloadSyncUnit`);
//! - full passes on the in-memory Drive seeded with the same files in the
//!   same order (so the ids and the times match), in the envelope format
//!   of the Electron build (each key derived once per salt; the format's
//!   own goldens compare the bytes) and one unit at a time, each step
//!   compared on its result,
//!   its progress reports, its Drive requests, the pending units, the
//!   revisions recorded as handled, the files remembered as created, the
//!   units reported as applied, the flushes asked for, the backfills and
//!   the applies of the own deleted ranges queued;
//!   then the userData tree (byte for byte; the cache file aside) and the
//!   Drive files, each data file by its decrypted plaintext.
//!
//! A unit's failure message is compared only when it is a Drive failure:
//! the texts of a JSON or decryption error are V8's and Node's.

#![allow(clippy::unwrap_used, clippy::panic)]

mod execute_harness;
mod preflight_harness;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use execute_harness::{KeyCachedCodec, Options, SharedCodec, World};
use pipette_drive::DriveApi;
use pipette_drive::fake::{DriveOp, Fault};
use pipette_sync::execute::SyncExecuteResult;
use pipette_sync::merge::queue_own_deleted_ranges_apply;
use pipette_sync::scope::{SyncScope, matches_scope, should_download_sync_unit};

use pipette_sync_runtime::{SyncDirection, SyncProgress, SyncStatus};
use preflight_harness::Stored;
use serde_json::{Map, Value, json};

/// The scenarios the generator records; a fixture with fewer is truncated.
const SCENARIOS: usize = 4;

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_execute.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn scope_of(value: &Value) -> SyncScope {
    SyncScope::from_json(value).unwrap_or_else(|| panic!("not a scope: {value}"))
}

#[test]
fn the_scopes_match_typescript() {
    let golden = fixture();
    let local = ["kbA".to_owned()].into();
    let mut failures = Vec::new();
    for row in golden["scopes"].as_array().unwrap() {
        let scope = scope_of(&row["scope"]);
        for cell in row["units"].as_array().unwrap() {
            let unit = cell["unit"].as_str();
            let got = (matches_scope(unit, &scope), should_download_sync_unit(unit, &scope, &local));
            let want = (cell["matches"].as_bool().unwrap(), cell["download"].as_bool().unwrap());
            if got != want {
                failures.push(format!("{scope:?} {unit:?}: got {got:?}, want {want:?}"));
            }
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

type Tree = BTreeMap<String, Option<String>>;

fn read_tree(root: &Path) -> Tree {
    fn walk(root: &Path, dir: &Path, tree: &mut Tree) {
        let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        let rel = |path: &Path| path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        if entries.is_empty() && dir != root {
            tree.insert(format!("{}/", rel(dir)), None);
        }
        for entry in entries {
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                walk(root, &path, tree);
            } else {
                tree.insert(
                    rel(&path),
                    Some(String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned()),
                );
            }
        }
    }
    let mut tree = Tree::new();
    walk(root, root, &mut tree);
    // The cache, which the recording does not keep, and the pending file,
    // which it does not write (its state is compared step by step).
    tree.retain(|path, _| {
        !path.starts_with("local/typing-analytics.db") && path != "local/sync-pending.json"
    });
    tree
}

fn tree_of(value: &Value) -> Tree {
    value.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().map(str::to_owned))).collect()
}

struct Failures(Vec<String>);

impl Failures {
    fn check<T: PartialEq + std::fmt::Debug>(&mut self, what: String, got: T, want: T) {
        if got != want {
            self.0.push(format!("{what}:\n  got  {got:?}\n  want {want:?}"));
        }
    }
}

/// The request as the generator writes it.
fn request(event: &str) -> String {
    let (op, rest) = event.split_once(':').unwrap();
    match op {
        "list" => "list".to_owned(),
        "create" => format!("create {}", rest.split_once(' ').map_or(rest, |(name, _)| name)),
        _ => format!("{op} {rest}"),
    }
}

/// The progress report as the renderer receives it.
fn progress_json(p: &SyncProgress) -> Value {
    let mut object = Map::new();
    object.insert(
        "direction".into(),
        json!(if p.direction == SyncDirection::Upload { "upload" } else { "download" }),
    );
    let status = match p.status {
        SyncStatus::Idle => "idle",
        SyncStatus::Syncing => "syncing",
        SyncStatus::Error => "error",
        SyncStatus::Success => "success",
        SyncStatus::Partial => "partial",
    };
    object.insert("status".into(), json!(status));
    if let Some(message) = &p.message {
        object.insert("message".into(), json!(message));
    }
    if let Some(unit) = &p.sync_unit {
        object.insert("syncUnit".into(), json!(unit));
    }
    if let Some(current) = p.current {
        object.insert("current".into(), json!(current));
    }
    if let Some(total) = p.total {
        object.insert("total".into(), json!(total));
    }
    if let Some(units) = &p.failed_units {
        object.insert("failedUnits".into(), json!(units));
    }
    if let Some(reason) = p.reason {
        object.insert("reason".into(), json!(reason.as_str()));
    }
    Value::Object(object)
}

/// A unit's failure message other than a Drive failure, which is V8's or
/// Node's text there.
fn without_foreign_messages(mut progress: Value) -> Value {
    let is_unit_error = progress["status"] == "error" && progress.get("syncUnit").is_some();
    let foreign = progress["message"].as_str().is_some_and(|m| !m.starts_with("Drive "));
    if is_unit_error && foreign {
        progress["message"] = json!("<error>");
    }
    progress
}

fn result_json(result: Result<SyncExecuteResult, impl std::fmt::Display>) -> Value {
    match result {
        Ok(SyncExecuteResult::Completed) => json!({ "status": "completed" }),
        Ok(SyncExecuteResult::Skipped(reason)) => {
            json!({ "status": "skipped", "skipReason": reason.as_str() })
        }
        Ok(SyncExecuteResult::Partial(units)) => json!({ "status": "partial", "failedUnits": units }),
        Err(err) => json!({ "error": err.to_string() }),
    }
}

fn op_of(name: &str) -> DriveOp {
    match name {
        "list" => DriveOp::List,
        "download" => DriveOp::Download,
        "create" => DriveOp::Create,
        "update" => DriveOp::Update,
        "delete" => DriveOp::Delete,
        other => panic!("no operation {other}"),
    }
}

async fn seed_drive(world: &World, codec: &Arc<KeyCachedCodec>, seed: &Value, password: &str) {
    let name = seed["name"].as_str().unwrap();
    if seed.get("passwordCheck").is_some() {
        world.drive.seed_password_check(password).await;
    } else if let Some(raw) = seed["raw"].as_str() {
        world.drive.seed(name, raw).await;
    } else {
        let content = codec
            .seal_text(seed["plaintext"].as_str().unwrap(), password, seed["unit"].as_str().unwrap())
            .await;
        world.drive.seed(name, &content).await;
    }
}

/// The Drive files as the generator writes them.
async fn drive_after(world: &World, codec: &Arc<KeyCachedCodec>, password: &str) -> Vec<Value> {
    let mut files = Vec::new();
    for stored in world.drive.inner.files() {
        let text = String::from_utf8_lossy(&stored.content).into_owned();
        let plaintext = codec.open_text(&stored.content, password).await.ok();
        let mut file = json!({ "id": stored.file.id, "name": stored.file.name, "modifiedTime": stored.file.modified_time });
        match plaintext {
            Some(plaintext) => file["plaintext"] = json!(plaintext),
            None => file["raw"] = json!(text),
        }
        files.push(file);
    }
    files
}

fn pending_json(world: &World) -> Value {
    let held: Vec<Value> = world
        .pending
        .held()
        .into_iter()
        .map(|(sub, units)| {
            json!([
                sub.to_string_lossy(),
                units.iter().map(|u| u.to_string_lossy().into_owned()).collect::<Vec<_>>()
            ])
        })
        .collect();
    json!({
        "units": world.pending_units(),
        "owner": world.pending.owner().map(|o| o.to_string_lossy().into_owned()),
        "held": held,
    })
}

async fn run_step(world: &World, codec: &Arc<KeyCachedCodec>, step: &Value) -> Value {
    if let Some(sub) = step.get("sub") {
        *world.account.0.lock().unwrap() = sub.as_str().map(str::to_owned);
    }
    if let Some(n) = step["backfill"].as_u64() {
        world.backfill.resolves.store(usize::try_from(n).unwrap(), Ordering::SeqCst);
    }
    if let Some(state) = step.get("localState") {
        let path = world.root.join("local/auth/sync-password-change.json");
        match state.as_str() {
            Some(text) => execute_harness::write(&world.root, "local/auth/sync-password-change.json", text),
            None => {
                let _ = std::fs::remove_file(path);
            }
        }
        world.preflight.forget_change_state_cache();
    }
    if let Some(name) = step["dropDrive"].as_str() {
        for stored in world.drive.inner.files().into_iter().filter(|f| f.file.name == name) {
            world.drive.inner.delete(stored.file.id).await.unwrap();
        }
    }
    if let Some(seed) = step.get("addDrive") {
        seed_drive(world, codec, seed, "").await;
    }
    for fault in step["faults"].as_array().into_iter().flatten() {
        let status = u16::try_from(fault["status"].as_u64().unwrap()).unwrap();
        world.drive.inner.inject(Fault {
            count: u32::try_from(fault["count"].as_u64().unwrap()).unwrap(),
            only: Some(op_of(fault["only"].as_str().unwrap())),
            ..Fault::with_status(status)
        });
    }
    world.requests();
    world.progress.lock().unwrap().clear();
    world.hooks.0.lock().unwrap().clear();
    world.hooks.1.store(0, Ordering::SeqCst);
    world.applied.0.lock().unwrap().clear();
    world.backfill.calls.store(0, Ordering::SeqCst);

    let execute = &step["execute"];
    let direction =
        if execute["direction"] == "download" { SyncDirection::Download } else { SyncDirection::Upload };
    let result = world.executor.execute_sync(direction, &scope_of(&execute["scope"])).await;
    let flushes: Vec<String> = world.hooks.0.lock().unwrap().clone();
    let progress: Vec<Value> =
        world.progress.lock().unwrap().iter().map(|p| without_foreign_messages(progress_json(p))).collect();
    json!({
        "result": result_json(result),
        "progress": progress,
        "requests": world.requests().iter().map(|e| request(e)).collect::<Vec<_>>(),
        "pending": pending_json(world),
        "remote": world.runtime().remote().handled_revisions().into_iter()
            .map(|(name, r)| json!([name, r.id, r.modified_time])).collect::<Vec<_>>(),
        "created": world.runtime().remote().created_files().into_iter()
            .map(|(name, id)| json!([name, id])).collect::<Vec<_>>(),
        "applied": world.applied.0.lock().unwrap().clone(),
        "flushes": flushes,
        "backfills": world.backfill.calls.load(Ordering::SeqCst),
        "queuedApplies": world.hooks.1.load(Ordering::SeqCst),
    })
}

/// The recorded step in the shape [`run_step`] builds.
fn recorded_step(want: &Value) -> Value {
    let flushes: Vec<String> = want["flushes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| format!("flush {:?}", f.as_u64().map(Duration::from_millis)))
        .collect();
    let progress: Vec<Value> =
        want["progress"].as_array().unwrap().iter().cloned().map(without_foreign_messages).collect();
    json!({
        "result": want["result"],
        "progress": progress,
        "requests": want["requests"],
        "pending": want["pending"],
        "remote": want["remote"],
        "created": want["created"],
        "applied": want["applied"],
        "flushes": flushes,
        "backfills": want["backfills"],
        "queuedApplies": want["queuedApplies"],
    })
}

#[tokio::test]
async fn passes_match_typescript() {
    let golden = fixture();
    let password = golden["password"].as_str().unwrap().to_owned();
    let scenarios = golden["scenarios"].as_array().unwrap();
    assert_eq!(scenarios.len(), SCENARIOS, "the fixture's scenarios");
    let mut failures = Failures(Vec::new());
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let tree = tree_of(&scenario["tree"]);
        let codec = Arc::new(KeyCachedCodec::default());
        let options = Options {
            codec: Some(Arc::new(SharedCodec(codec.clone()))),
            concurrency: 1,
            password: false,
            marker: false,
            store_backfill: false,
        };
        let world = World::with(options, |root| {
            for (path, content) in &tree {
                match content {
                    Some(content) => execute_harness::write(root, path, content),
                    None => std::fs::create_dir_all(root.join(path)).unwrap(),
                }
            }
        })
        .await;
        assert_eq!(world.own_hash(), golden["ownHash"].as_str().unwrap(), "the machine hash");
        world.passwords.set(Stored::Readable(password.clone()));
        for seed in scenario["drive"].as_array().unwrap() {
            seed_drive(&world, &codec, seed, &password).await;
        }
        let days: Vec<String> = scenario["typing"]["days"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d.as_str().unwrap().to_owned())
            .collect();
        let ready = world.ops.analytics().ready().await.unwrap();
        for text in days {
            ready.db.call(move |db| db.apply_day_jsonl(&text)).await.unwrap().unwrap();
        }
        for unit in scenario["pending"].as_array().unwrap() {
            world.pending.notify_change(unit.as_str().unwrap());
        }
        for (i, want) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let got = run_step(&world, &codec, &want["step"]).await;
            let want = recorded_step(want);
            for key in [
                "result",
                "progress",
                "requests",
                "pending",
                "remote",
                "created",
                "applied",
                "flushes",
                "backfills",
                "queuedApplies",
            ] {
                failures.check(format!("{name} / step {i} / {key}"), &got[key], &want[key]);
            }
        }
        // The applies queued after the passes run on the flush chain; this
        // one ends after them.
        queue_own_deleted_ranges_apply(world.ops.clone(), world.units.holds()).await.unwrap();
        failures.check(format!("{name} / tree"), read_tree(&world.root), tree_of(&scenario["treeAfter"]));
        failures.check(
            format!("{name} / drive"),
            Value::Array(drive_after(&world, &codec, &password).await),
            scenario["driveAfter"].clone(),
        );
    }
    assert!(failures.0.is_empty(), "\n{}", failures.0.join("\n"));
}
