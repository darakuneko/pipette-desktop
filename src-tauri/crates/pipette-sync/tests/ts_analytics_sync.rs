// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays tests/fixtures/ts_analytics_sync.json, recorded from the
//! TypeScript sync code by
//! scripts/sync-fixtures/record-analytics-sync-fixtures.test.ts: the
//! Analyze sync of a keyboard and the Data modal's reads of the typing data
//! on Drive, on the in-memory Drive seeded with the same files in the same
//! order (so the ids and the times match), in the envelope format of the
//! Electron build and one unit at a time. Each step is compared on what it
//! answered, its Drive requests, the revisions recorded as handled, the
//! files remembered as created, the units reported as applied, the applies
//! of the own deleted ranges queued and the userData tree (byte for byte;
//! the cache file aside); each scenario on the Drive files left behind,
//! each data file by its decrypted plaintext.
//!
//! An error's message is compared only when it is a Drive failure or an
//! i18n key: other texts are V8's and Node's.

#![allow(clippy::unwrap_used, clippy::panic)]

mod execute_harness;
mod preflight_harness;

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use execute_harness::{KeyCachedCodec, Options, SharedCodec, World};
use pipette_drive::DriveApi;
use pipette_drive::fake::{DriveOp, Fault};
use pipette_sync::analytics::{AnalyticsSync, AnalyticsSyncDeps};
use pipette_sync::execute::PassHooks;
use pipette_sync::typing_remote::RemoteTyping;
use pipette_typing_analytics::DataOps;
use pipette_typing_analytics::deleted_ranges::apply::ResetHolds;
use preflight_harness::Stored;
use serde_json::{Value, json};

/// The scenarios the generator records; a fixture with fewer is truncated.
const SCENARIOS: usize = 2;

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_analytics_sync.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
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
    // The cache, which the recording keeps outside the userData, and the
    // pending file, which it does not write.
    tree.retain(|path, _| {
        !path.starts_with("local/typing-analytics.db") && path != "local/sync-pending.json"
    });
    tree
}

fn tree_json(tree: &Tree) -> Value {
    Value::Object(tree.iter().map(|(k, v)| (k.clone(), json!(v))).collect())
}

/// The request as the generator writes it.
fn request(event: &str) -> String {
    let (op, rest) = event.split_once(':').unwrap();
    match op {
        "create" => format!("create {}", rest.split_once(' ').map_or(rest, |(name, _)| name)),
        _ => format!("{op} {rest}"),
    }
}

/// An error's message when it is a Drive failure or an i18n key.
fn error_json(message: String) -> Value {
    let comparable = message.starts_with("Drive ") || message.starts_with("sync.");
    json!({ "error": if comparable { message } else { "<error>".to_owned() } })
}

fn recorded_result(result: &Value) -> Value {
    match result["error"].as_str() {
        Some(message) => error_json(message.to_owned()),
        None => result.clone(),
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
        let plaintext = codec.open_text(&stored.content, password).await.ok();
        let mut file = json!({ "id": stored.file.id, "name": stored.file.name, "modifiedTime": stored.file.modified_time });
        match plaintext {
            Some(plaintext) => file["plaintext"] = json!(plaintext),
            None => file["raw"] = json!(String::from_utf8_lossy(&stored.content)),
        }
        files.push(file);
    }
    files
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()
}

/// Counts the applies of the own deleted ranges queued, as the recording
/// does, without running them.
#[derive(Default)]
struct CountingHooks(AtomicUsize);

impl PassHooks for CountingHooks {
    fn schedule_flush_if_pending(&self, _: Option<Duration>) {}

    fn start_polling_if_auto_sync(&self) {}

    fn queue_own_deleted_ranges_apply(&self, _: Arc<DataOps>, _: ResetHolds) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

struct Calls {
    analytics: AnalyticsSync,
    remote: RemoteTyping,
    hooks: Arc<CountingHooks>,
}

async fn run_call(calls: &Calls, call: &Value) -> Value {
    let value = |v: Value| json!({ "value": v });
    if let Some(uid) = call["analyticsSync"].as_str() {
        return value(json!(calls.analytics.execute_analytics_sync(uid).await));
    }
    let answer = if call.get("hasRemote").is_some() {
        calls.remote.has_any_remote_typing_data().await.map(|v| json!(v))
    } else if let Some(uid) = call["hashes"].as_str() {
        calls.remote.list_remote_typing_hashes(uid).await.map(|v| json!(v))
    } else if let Some(args) = call.get("days") {
        let args = strings(args);
        calls.remote.list_remote_typing_days(&args[0], &args[1]).await.map(|v| json!(v))
    } else if let Some(args) = call.get("fetch") {
        let args = strings(args);
        calls.remote.fetch_remote_typing_day(&args[0], &args[1], &args[2]).await.map(|v| json!(v))
    } else {
        let names = calls.remote.remote_data_file_names().await;
        return match names {
            Ok(names) => value(json!(names.map(|names| {
                let mut names: Vec<String> = names.into_iter().collect();
                names.sort();
                names
            }))),
            Err(err) => error_json(err.to_string()),
        };
    };
    match answer {
        Ok(v) => value(v),
        Err(err) => error_json(err.to_string()),
    }
}

async fn run_step(world: &World, calls: &Calls, codec: &Arc<KeyCachedCodec>, step: &Value) -> Value {
    if let Some(on) = step["signedIn"].as_bool() {
        world.sign_in.0.store(on, Ordering::SeqCst);
    }
    if let Some(password) = step["password"].as_str() {
        world.passwords.set(Stored::Readable(password.to_owned()));
    }
    if let Some(state) = step.get("localState") {
        match state.as_str() {
            Some(text) => execute_harness::write(&world.root, "local/auth/sync-password-change.json", text),
            None => {
                let _ = std::fs::remove_file(world.root.join("local/auth/sync-password-change.json"));
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
    if let Some(path) = step["removeLocal"].as_str() {
        std::fs::remove_file(world.root.join(path)).unwrap();
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
    calls.hooks.0.store(0, Ordering::SeqCst);
    world.applied.0.lock().unwrap().clear();

    let result = run_call(calls, &step["call"]).await;
    world.settle_flush_chain().await;
    json!({
        "result": result,
        "requests": world.requests().iter().map(|e| request(e)).collect::<Vec<_>>(),
        "remote": world.runtime().remote().handled_revisions().into_iter()
            .map(|(name, r)| json!([name, r.id, r.modified_time])).collect::<Vec<_>>(),
        "created": world.runtime().remote().created_files().into_iter()
            .map(|(name, id)| json!([name, id])).collect::<Vec<_>>(),
        "applied": world.applied.0.lock().unwrap().clone(),
        "queuedApplies": calls.hooks.0.load(Ordering::SeqCst),
        "tree": tree_json(&read_tree(&world.root)),
    })
}

#[tokio::test]
async fn analytics_syncs_and_remote_reads_match_typescript() {
    let golden = fixture();
    let password = golden["password"].as_str().unwrap().to_owned();
    let scenarios = golden["scenarios"].as_array().unwrap();
    assert_eq!(scenarios.len(), SCENARIOS, "the fixture's scenarios");
    let mut failures = Vec::new();
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let tree: Tree = scenario["tree"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().map(str::to_owned)))
            .collect();
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
        let hooks = Arc::new(CountingHooks::default());
        let calls = Calls {
            analytics: AnalyticsSync::new(AnalyticsSyncDeps {
                preflight: world.preflight.clone(),
                units: world.units.clone(),
                hooks: hooks.clone(),
            })
            .with_concurrency(1),
            remote: RemoteTyping::new(world.preflight.clone(), world.units.clone()),
            hooks,
        };
        for (i, want) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let got = run_step(&world, &calls, &codec, &want["step"]).await;
            let mut want = want.clone();
            want["result"] = recorded_result(&want["result"]);
            for key in ["result", "requests", "remote", "created", "applied", "queuedApplies", "tree"] {
                if got[key] != want[key] {
                    failures.push(format!(
                        "{name} / step {i} / {key}:\n  got  {}\n  want {}",
                        got[key], want[key]
                    ));
                }
            }
        }
        let drive = Value::Array(drive_after(&world, &codec, &password).await);
        if drive != scenario["driveAfter"] {
            failures.push(format!("{name} / drive:\n  got  {drive}\n  want {}", scenario["driveAfter"]));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
