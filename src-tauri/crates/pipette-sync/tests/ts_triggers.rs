// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays tests/fixtures/ts_triggers.json, recorded from the TypeScript
//! sync code by scripts/sync-fixtures/record-trigger-fixtures.test.ts: flush
//! passes and poll passes (with the tidying of the names with several
//! copies) on the in-memory Drive seeded with the same files in the same
//! order (so the ids and the times match), one unit at a time, each step
//! compared on its progress reports, its Drive requests, the pending units,
//! the revisions recorded as handled, the files remembered as created, the
//! units reported as applied and when the flush timer fires afterwards;
//! then the userData tree and the Drive files.
//!
//! The clock is paused, so the timer is read to the millisecond.

#![allow(clippy::unwrap_used, clippy::panic)]

mod execute_harness;
mod golden_harness;
mod preflight_harness;

use std::sync::Arc;
use std::sync::atomic::Ordering;

use execute_harness::{KeyCachedCodec, Options, SharedCodec, World};
use golden_harness::{
    Failures, drive_after, fixture, inject_faults, pending_json, progress_json, read_tree, remote_json,
    request, seed_drive, seed_tree, tree_of,
};
use pipette_drive::DriveApi;
use pipette_sync::triggers::SyncTriggers;
use pipette_sync_format::drive_names::drive_file_name;
use preflight_harness::Stored;
use serde_json::{Value, json};

/// The scenarios the generator records; a fixture with fewer is truncated.
const SCENARIOS: usize = 3;

fn stored(value: &str, password: &str) -> Stored {
    match value {
        "ok" => Stored::Readable(password.to_owned()),
        "wrong" => Stored::Readable("wrong-password".to_owned()),
        "decryptFailed" => Stored::DecryptFailed,
        "keystoreUnavailable" => Stored::KeystoreUnavailable,
        "noPasswordFile" => Stored::None,
        other => panic!("no stored password {other}"),
    }
}

async fn run_step(
    world: &World,
    triggers: &SyncTriggers,
    codec: &Arc<KeyCachedCodec>,
    step: &Value,
    password: &str,
) -> Value {
    if let Some(sub) = step.get("sub") {
        *world.account.0.lock().unwrap() = sub.as_str().map(str::to_owned);
    }
    if let Some(on) = step["signedIn"].as_bool() {
        world.sign_in.0.store(on, Ordering::SeqCst);
    }
    if let Some(on) = step["autoSync"].as_bool() {
        triggers.set_auto_sync(on);
        // Only the setting: no polling runs during the replay.
        triggers.poller().stop_polling();
    }
    if let Some(value) = step["stored"].as_str() {
        world.passwords.set(stored(value, password));
    }
    if let Some(state) = step.get("localState") {
        match state.as_str() {
            Some(text) => world.write("local/auth/sync-password-change.json", text),
            None => {
                let _ = std::fs::remove_file(world.root.join("local/auth/sync-password-change.json"));
            }
        }
        world.preflight.forget_change_state_cache();
    }
    if let Some(rewrite) = step.get("rewrite") {
        let unit = rewrite["unit"].as_str().unwrap();
        let name = drive_file_name(unit);
        let file = world.drive.inner.files().into_iter().find(|f| f.file.name == name).unwrap().file;
        let content = codec.seal_text(rewrite["plaintext"].as_str().unwrap(), password, unit).await;
        world.drive.inner.update(file.id, content).await.unwrap();
    }
    inject_faults(world, &step["faults"]);
    world.requests();
    world.progress.lock().unwrap().clear();
    world.applied.0.lock().unwrap().clear();
    for unit in step["notify"].as_array().into_iter().flatten() {
        triggers.notify_change(unit.as_str().unwrap());
    }
    triggers.flusher().clear_timer();

    if step["run"] == "flush" {
        triggers.flush_pending().await;
    } else {
        triggers.poller().poll_for_remote_changes().await;
    }
    let timer = triggers.flusher().due_in().map(|due| due.as_millis());
    triggers.flusher().clear_timer();

    let progress: Vec<Value> = world.progress.lock().unwrap().iter().map(progress_json).collect();
    let (remote, created) = remote_json(world);
    json!({
        "progress": progress,
        "requests": world.requests().iter().map(|e| request(e)).collect::<Vec<_>>(),
        "pending": pending_json(world),
        "remote": remote,
        "created": created,
        "applied": world.applied.0.lock().unwrap().clone(),
        "timer": timer,
    })
}

#[tokio::test]
async fn flush_and_poll_passes_match_typescript() {
    let golden = fixture("ts_triggers.json");
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
        let world = World::with(options, |root| seed_tree(root, &tree)).await;
        assert_eq!(world.own_hash(), golden["ownHash"].as_str().unwrap(), "the machine hash");
        assert_eq!(golden["now"].as_i64(), Some(execute_harness::NOW), "the clock of the trash names");
        world.passwords.set(Stored::Readable(password.clone()));
        for seed in scenario["drive"].as_array().unwrap() {
            seed_drive(&world, &codec, seed, &password).await;
        }
        if let Some(owner) = scenario["owner"].as_str() {
            world.pending.adopt_for_account(Some(owner));
        }
        for unit in scenario["pending"].as_array().unwrap() {
            world.pending.notify_change(unit.as_str().unwrap());
        }
        let triggers = world.triggers(true);
        tokio::time::pause();
        for (i, want) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let got = run_step(&world, &triggers, &codec, &want["step"], &password).await;
            for key in ["progress", "requests", "pending", "remote", "created", "applied", "timer"] {
                let want = want.get(key).unwrap_or_else(|| panic!("{name} / step {i} has no {key}"));
                failures.check(format!("{name} / step {i} / {key}"), &got[key], want);
            }
        }
        tokio::time::resume();
        failures.check(format!("{name} / tree"), read_tree(&world.root), tree_of(&scenario["treeAfter"]));
        failures.check(
            format!("{name} / drive"),
            Value::Array(drive_after(&world, &codec, &password).await),
            scenario["driveAfter"].clone(),
        );
    }
    assert!(failures.0.is_empty(), "\n{}", failures.0.join("\n"));
}
