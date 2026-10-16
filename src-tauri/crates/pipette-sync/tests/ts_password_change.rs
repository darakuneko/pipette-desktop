// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the scenarios recorded from the TypeScript password change by
//! scripts/sync-fixtures/record-password-change-fixtures.test.ts and
//! compares every step with the recording: its result or error message,
//! the Drive requests it sent (with the bytes of each lock and marker it
//! created) and the waits of the lock's re-lists, the bytes of the state
//! file after it, whether the change keys read, and the stored password;
//! then the files left on Drive and the password that opens each one.

#![allow(clippy::unwrap_used, clippy::panic)]

mod password_change_harness;

use std::path::Path;

use password_change_harness::{Action, Machine, MachineOptions, NOW, SharedCodec, World};
use pipette_drive::fake::DriveOp;
use pipette_sync::password::change::PasswordChangeTuning;
use pipette_sync::password::change_error::PasswordChangeError;
use pipette_sync::scan::list_undecryptable_files;
use pipette_sync_format::Envelope;
use serde::Serialize;
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_password_change.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_else(|| panic!("no {key} in {value}"))
}

/// Every number as a double, so `5` and `5.0` compare equal.
fn normalize(value: Value) -> Value {
    match value {
        Value::Number(n) => {
            serde_json::Number::from_f64(n.as_f64().unwrap()).map_or(Value::Null, Value::Number)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(normalize).collect()),
        Value::Object(object) => Value::Object(object.into_iter().map(|(k, v)| (k, normalize(v))).collect()),
        other => other,
    }
}

fn ok<T: Serialize>(result: Result<T, PasswordChangeError>) -> Value {
    match result {
        Ok(value) => json!({ "ok": serde_json::to_value(value).unwrap() }),
        Err(err) => json!({ "error": err.to_string() }),
    }
}

fn op_of(what: &str) -> DriveOp {
    match what {
        "list" => DriveOp::List,
        "download" => DriveOp::Download,
        "create" => DriveOp::Create,
        "update" => DriveOp::Update,
        "rename" => DriveOp::Rename,
        "delete" => DriveOp::Delete,
        other => panic!("unknown operation {other}"),
    }
}

struct Scene {
    world: World,
    machine: Machine,
    options: MachineOptions,
}

impl Scene {
    async fn seed(&self, seed: &Value) {
        let world = &self.world;
        if let Some(unit) = seed["unit"].as_str() {
            world.seed_data(unit, text(seed, "password")).await;
        } else if let Some(password) = seed["passwordCheck"].as_str() {
            world.seed_password_check(password).await;
        } else if let Some(lock_id) = seed["lock"].as_str() {
            world.seed_lock(lock_id, seed["machineHash"].as_str().unwrap_or("golden-hash")).await;
        } else {
            world.drive.seed(text(seed, "name"), text(seed, "raw")).await;
        }
    }

    fn restart(&mut self) {
        self.machine = self.world.restart(&self.machine, self.options.clone());
    }

    /// Applies a step that sets the scene; false for a step under test.
    async fn arrange(&mut self, step: &Value) -> bool {
        match text(step, "op") {
            "seed" => {
                for seed in step["files"].as_array().unwrap() {
                    self.seed(seed).await;
                }
            }
            "stored" => self.machine.passwords.set(step["password"].as_str()),
            "signedIn" => self
                .machine
                .sign_in
                .0
                .store(step["value"].as_bool().unwrap(), std::sync::atomic::Ordering::SeqCst),
            "localState" => self.machine.write_state_file(step["content"].as_str()),
            "keys" => self.machine.store_keys(text(step, "old"), text(step, "new")).await,
            "failNext" => self.world.drive.fail_next(op_of(text(step, "what"))),
            "hideNew" => self.world.drive.hide_new(step["on"].as_bool().unwrap()),
            "afterUpdates" => {
                let action = match text(step, "action") {
                    "quit" => Action::Quit,
                    "deleteLocks" => Action::DeleteLocks,
                    other => panic!("unknown action {other}"),
                };
                self.world
                    .drive
                    .after_updates(u32::try_from(step["count"].as_u64().unwrap()).unwrap(), action);
            }
            "chunkSize" => {
                self.options.tuning.chunk_size = usize::try_from(step["size"].as_u64().unwrap()).unwrap();
                self.restart();
            }
            "restart" => self.restart(),
            _ => return false,
        }
        true
    }

    async fn run(&self, step: &Value) -> Value {
        let change = &self.machine.change;
        match text(step, "op") {
            "start" => ok(change.start(text(step, "password")).await),
            "resume" => ok(change.resume().await),
            "revert" => ok(change.revert().await),
            "abandon" => ok(change.abandon().await),
            "deleteUndecryptable" => {
                let ids: Vec<String> = step["ids"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|id| id.as_str().unwrap().to_owned())
                    .collect();
                ok(change.delete_undecryptable(&ids).await)
            }
            "recover" => ok(Ok(change.recover_on_startup().await)),
            "status" => ok(Ok(change.status().await)),
            "lockStatus" => ok(change.lock_status().await),
            "release" => ok(change.release_locks().await),
            "listUndecryptable" => {
                let codec = SharedCodec(self.world.codec.clone());
                ok(list_undecryptable_files(&self.machine.preflight, &codec)
                    .await
                    .map_err(PasswordChangeError::from))
            }
            other => panic!("unknown step {other}"),
        }
    }

    async fn file_content(&self, id: &str, recorded: &Value, passwords: &[&str]) -> Value {
        let content = self.world.drive.content(id).unwrap();
        if recorded.get("raw").is_some() {
            return json!({ "raw": String::from_utf8(content).unwrap() });
        }
        let Some(password) = self.world.opener(id, passwords).await else { return json!({ "opens": null }) };
        let envelope: Envelope = serde_json::from_slice(&content).unwrap();
        let plaintext = self.world.codec.open_text(&content, &password).await.unwrap();
        json!({ "opens": password, "syncUnit": envelope.sync_unit, "plaintext": plaintext })
    }
}

async fn replay(scenario: &Value) {
    let name = text(scenario, "name");
    let options = MachineOptions {
        tuning: PasswordChangeTuning { concurrency: 1, ..PasswordChangeTuning::default() },
        ..MachineOptions::default()
    };
    let world = World::new();
    let machine = world.machine("pc", options.clone());
    let mut scene = Scene { world, machine, options };
    for (index, recorded) in scenario["steps"].as_array().unwrap().iter().enumerate() {
        let step = &recorded["step"];
        if scene.arrange(step).await {
            continue;
        }
        scene.world.drive.take_events();
        let result = scene.run(step).await;
        let at = format!("{name}: step {index} {step}");
        assert_eq!(normalize(result), normalize(recorded["result"].clone()), "{at}: result");
        assert_eq!(json!(scene.world.drive.take_events()), recorded["drive"], "{at}: requests");
        assert_eq!(json!(scene.machine.state_file()), recorded["state"], "{at}: state file");
        assert_eq!(json!(scene.machine.keys_summary().await), recorded["keys"], "{at}: keys");
        assert_eq!(json!(scene.machine.passwords.get()), recorded["stored"], "{at}: stored password");
    }
    let passwords: Vec<&str> =
        scenario["passwords"].as_array().unwrap().iter().map(|p| p.as_str().unwrap()).collect();
    let mut files = Vec::new();
    for stored in scene.world.drive.inner.files() {
        let file = &stored.file;
        let recorded = scenario["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["id"] == file.id.as_str())
            .unwrap_or_else(|| panic!("{name}: {} is not in the recording", file.id));
        files.push(json!({
            "id": file.id,
            "name": file.name,
            "modifiedTime": file.modified_time,
            "createdTime": file.created_time,
            "content": scene.file_content(&file.id, &recorded["content"], &passwords).await,
        }));
    }
    assert_eq!(json!(files), scenario["files"], "{name}: files left on Drive");
}

#[tokio::test]
async fn the_password_change_matches_the_typescript_recording() {
    let fixture = fixture();
    assert_eq!(fixture["now"].as_u64(), Some(NOW));
    assert_eq!(fixture["machineHash"], "golden-hash");
    // The scenarios are independent; they run at once so their key
    // derivations share the blocking threads.
    futures_util::future::join_all(fixture["scenarios"].as_array().unwrap().iter().map(replay)).await;
}
