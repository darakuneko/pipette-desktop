// SPDX-License-Identifier: GPL-2.0-or-later
//! The resets, deletes and trash actions against the recording of the
//! TypeScript handlers (tests/fixtures/ts_reset.json, from
//! scripts/sync-fixtures/record-reset-fixtures.test.ts): the same userData,
//! pending file, Drive and steps give the same answers, calls, changed
//! units, pending units, userData tree (path → bytes) and Drive files.
//!
//! The Tauri build also removes this userData's key store entry with
//! `local/auth/` (`forgetKey`), which the Electron build has none of; that
//! call is left out of the comparison.

#![allow(clippy::unwrap_used, clippy::panic)]

mod preflight_harness;
mod reset_harness;

use pipette_drive::DriveApi;
use pipette_drive::trash_names::trash_file_name;
use pipette_sync::data_error::DataError;
use pipette_sync::reset::targets::{LocalResetTargets, SyncResetTargets, file_id_arg, file_ids_arg, uid_arg};
use pipette_sync::trash::manual::{delete_trash, list_trash_files, restore_trash};
use reset_harness::{NOW, Options, World, read_tree, write};
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("fixtures/ts_reset.json");

/// The answer of a handler wrapped by `wrapIpc`.
fn answer(result: Result<Value, DataError>) -> Value {
    match result {
        Ok(Value::Object(payload)) => {
            // `success` first, as the wrapper spreads the payload after it.
            let mut ordered = serde_json::Map::new();
            ordered.insert("success".into(), true.into());
            ordered.extend(payload.into_iter().filter(|(key, _)| key != "success"));
            Value::Object(ordered)
        }
        Ok(_) => json!({ "success": true }),
        Err(err) => match err.reason() {
            Some(reason) => json!({ "success": false, "error": err.to_string(), "reason": reason }),
            None => json!({ "success": false, "error": err.to_string() }),
        },
    }
}

fn refused(message: String) -> Result<Value, DataError> {
    Err(DataError::Other(message))
}

async fn run_step(w: &World, step: &Value) -> Value {
    let arg = step.get("arg");
    let done = |result: Result<(), DataError>| result.map(|()| Value::Null);
    answer(match step["op"].as_str().unwrap() {
        "resetTargets" => match SyncResetTargets::from_json(arg) {
            Ok(targets) => done(w.resets.reset_sync_targets(&targets).await),
            Err(err) => refused(err),
        },
        "resetKeyboard" => match uid_arg(arg) {
            Ok(uid) => done(w.resets.reset_keyboard_data(&uid).await),
            Err(err) => refused(err),
        },
        "resetLocal" => match LocalResetTargets::from_json(arg) {
            Ok(targets) => done(w.resets.reset_local_targets(&targets).await),
            Err(err) => refused(err),
        },
        "deleteFiles" => match file_ids_arg(arg) {
            Ok(ids) => done(w.resets.delete_files(&ids).await),
            Err(err) => refused(err),
        },
        "listTrash" => list_trash_files(&w.trash_env(NOW))
            .await
            .map(|files| json!({ "files": serde_json::to_value(files).unwrap() })),
        "restoreTrash" => match file_id_arg(arg) {
            Ok(id) => done(restore_trash(&w.trash_env(NOW), &id).await),
            Err(err) => refused(err),
        },
        "deleteTrash" => match file_ids_arg(arg) {
            Ok(ids) => {
                delete_trash(&w.trash_env(NOW), &ids).await.map(|done| serde_json::to_value(done).unwrap())
            }
            Err(err) => refused(err),
        },
        other => panic!("unknown op {other}"),
    })
}

fn pending_state(w: &World) -> Value {
    let held: Vec<Value> = w
        .pending
        .held()
        .into_iter()
        .map(|(sub, units)| {
            let mut units: Vec<String> = units.iter().map(|u| u.to_string_lossy().into_owned()).collect();
            units.sort();
            json!([sub.to_string_lossy(), units])
        })
        .collect();
    json!({
        "owner": w.pending.owner().map(|owner| owner.to_string_lossy().into_owned()),
        "units": w.pending_units(),
        "held": held,
    })
}

/// The calls the Electron build logs: a typing cleanup with its scope,
/// always every device's rows here.
fn calls(w: &World) -> Vec<String> {
    w.log()
        .into_iter()
        .filter(|call| call != "forgetKey")
        .map(|call| match call.strip_prefix("typing:") {
            Some(uid) => format!("typing:{uid}:all"),
            None => call,
        })
        .collect()
}

async fn seed_drive(w: &World, seeds: &[Value]) {
    for seed in seeds {
        let file = w.add(seed["name"].as_str().unwrap()).await;
        if let Some(at) = seed.get("trashAt").and_then(Value::as_i64) {
            w.drive.inner.rename(file.id.clone(), trash_file_name(&file, at).unwrap()).await.unwrap();
        }
    }
}

#[tokio::test]
async fn the_resets_match_the_typescript_recording() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    assert_eq!(fixture["now"].as_i64(), Some(NOW));
    assert_eq!(fixture["ownHash"], reset_harness::OWN_HASH);
    for scenario in fixture["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let sub = scenario["sub"].as_str().map(str::to_owned);
        let tree = scenario["tree"].as_object().unwrap();
        let w = World::with(Options { account: Some(sub) }, |root| {
            for (path, content) in tree {
                write(root, path, content.as_str().unwrap());
            }
        });
        let cache: Vec<String> = scenario["typingCache"]
            .as_array()
            .unwrap()
            .iter()
            .map(|uid| uid.as_str().unwrap().to_owned())
            .collect();
        *w.hooks.typing_keyboards.lock().unwrap() = Ok(cache);
        seed_drive(&w, scenario["drive"].as_array().unwrap()).await;

        for (index, expected) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let at = format!("{name}, step {index} ({})", expected["step"]);
            w.hooks.log.lock().unwrap().clear();
            w.notified.lock().unwrap().clear();
            let result = run_step(&w, &expected["step"]).await;
            w.pending.persist_now();

            assert_eq!(result, expected["result"], "answer of {at}");
            assert_eq!(json!(calls(&w)), expected["calls"], "calls of {at}");
            assert_eq!(json!(*w.notified.lock().unwrap()), expected["notified"], "changed units of {at}");
            assert_eq!(pending_state(&w), expected["pending"], "pending units of {at}");
            let tree: serde_json::Map<String, Value> =
                read_tree(&w.root).into_iter().map(|(path, content)| (path, json!(content))).collect();
            let expected_tree = expected["tree"].as_object().unwrap();
            for (path, content) in expected_tree {
                assert_eq!(tree.get(path), Some(content), "{path} after {at}");
            }
            let extra: Vec<&String> = tree.keys().filter(|path| !expected_tree.contains_key(*path)).collect();
            assert!(extra.is_empty(), "{extra:?} left after {at}");
            let drive: Vec<Value> = w.names().into_iter().map(|(id, name)| json!([id, name])).collect();
            assert_eq!(json!(drive), expected["drive"], "Drive after {at}");
            assert!(!w.runtime.is_syncing(), "the lock is released after {at}");
        }
    }
}
