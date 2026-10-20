// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the recorded golden pending transitions: the same launch, the same
//! settles, cancels, hand-overs, sign-ins and sign-outs, then after each step
//! the pending state (owner, units with their generations, held units), the
//! file's text and the statuses told to the renderer, compared with the
//! recording.

#![allow(clippy::unwrap_used)]

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pipette_sync::account::{AccountSwitcher, SignedInAccount};
use pipette_sync_pending::{PendingStateCopy, PendingStore, Scheduler};
use pipette_sync_runtime::SyncRuntime;
use serde_json::Value;
use tempfile::TempDir;

type Task = Box<dyn FnOnce() + Send>;

/// Keeps the delayed writes until a step lets the delay pass.
#[derive(Default)]
struct ManualScheduler(Mutex<Vec<Task>>);

impl Scheduler for ManualScheduler {
    fn schedule(&self, _: Duration, task: Task) {
        self.0.lock().unwrap().push(task);
    }
}

impl ManualScheduler {
    fn advance(&self) {
        let tasks = std::mem::take(&mut *self.0.lock().unwrap());
        tasks.into_iter().for_each(|task| task());
    }
}

/// The stored sign-in: the account each step names.
#[derive(Default)]
struct Account(Mutex<Option<String>>);

impl SignedInAccount for Account {
    async fn account_sub(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }

    async fn sign_out(&self) {
        *self.0.lock().unwrap() = None;
    }
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|unit| text(unit).unwrap()).collect()
}

const PENDING: &str = "local/sync-pending.json";

fn pending_file(dir: &Path) -> Value {
    let path = dir.join(PENDING);
    match std::fs::symlink_metadata(&path) {
        Err(_) => Value::Null,
        Ok(meta) if meta.is_dir() => Value::String("<blocked>".to_owned()),
        Ok(_) => Value::String(std::fs::read_to_string(path).unwrap()),
    }
}

/// The state after a step, in the recorded shape. The held accounts are
/// compared by name: the order of a JavaScript Map is not what the file
/// shows, and the file is compared byte for byte.
/// The owner, the units with their generations, and the held units.
type State = (Option<String>, Vec<(String, u64)>, BTreeMap<String, Vec<String>>);

fn state_of(store: &PendingStore) -> State {
    let units = store
        .snapshot_generations()
        .into_iter()
        .map(|(unit, generation)| (unit.as_str().unwrap().to_owned(), generation))
        .collect();
    let held = store
        .held()
        .into_iter()
        .map(|(sub, units)| {
            (
                sub.as_str().unwrap().to_owned(),
                units.iter().map(|unit| unit.as_str().unwrap().to_owned()).collect(),
            )
        })
        .collect();
    (store.owner().map(|owner| owner.as_str().unwrap().to_owned()), units, held)
}

fn recorded_state(step: &Value) -> State {
    let units = step["units"]
        .as_array()
        .unwrap()
        .iter()
        .map(|pair| (text(&pair[0]).unwrap(), pair[1].as_u64().unwrap()))
        .collect();
    let held =
        step["held"].as_object().unwrap().iter().map(|(sub, units)| (sub.clone(), strings(units))).collect();
    (text(&step["owner"]), units, held)
}

#[tokio::test]
async fn the_transitions_match_the_recorded_golden() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_pending_transitions.json");
    let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let scenarios = fixture.as_array().unwrap();
    assert!(scenarios.len() >= 10);
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let dir = TempDir::new().unwrap();
        for uid in strings(&scenario["keyboards"]) {
            std::fs::create_dir_all(dir.path().join("sync").join("keyboards").join(uid)).unwrap();
        }
        if let Some(content) = scenario["file"].as_str() {
            std::fs::create_dir_all(dir.path().join("local")).unwrap();
            std::fs::write(dir.path().join(PENDING), content).unwrap();
        }
        let scheduler = Arc::new(ManualScheduler::default());
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let told = Arc::clone(&statuses);
        let store = PendingStore::restore(
            dir.path(),
            Arc::clone(&scheduler) as Arc<dyn Scheduler>,
            Box::new(move |pending| told.lock().unwrap().push(pending)),
        );
        scheduler.advance();
        let account = Arc::new(Account::default());
        let switcher = AccountSwitcher::new(SyncRuntime::new(), store.clone(), Arc::clone(&account));
        let mut generations = BTreeMap::new();
        let mut copy: Option<PendingStateCopy> = None;

        for (index, step) in scenario["recorded"].as_array().unwrap().iter().enumerate() {
            let input = &scenario["steps"][index];
            let op = input["op"].as_str().unwrap();
            assert_eq!(step["op"], op, "{name}: step {index}");
            statuses.lock().unwrap().clear();
            let error = match op {
                "notify" => {
                    store.notify_change(input["unit"].as_str().unwrap());
                    false
                }
                "advance" => {
                    scheduler.advance();
                    false
                }
                "snapshot" => {
                    generations = generations_of(&store);
                    false
                }
                "settle" => {
                    let unit = input["unit"].as_str().unwrap();
                    store.settle(unit, generations.get(unit).copied().unwrap_or(0));
                    false
                }
                "broadcast" => {
                    store.broadcast_status();
                    false
                }
                "cancel" => {
                    let prefixes = input.get("prefixes").map(strings);
                    let prefixes: Option<Vec<&str>> =
                        prefixes.as_ref().map(|list| list.iter().map(String::as_str).collect());
                    let write_always = input.get("writeAlways").and_then(Value::as_bool).unwrap_or(false);
                    store.cancel(prefixes.as_deref(), write_always).is_err()
                }
                "copy" => {
                    copy = Some(store.copy_state());
                    false
                }
                "restore" => {
                    store.restore_cancelled(copy.as_ref().unwrap());
                    false
                }
                "adopt" => {
                    *account.0.lock().unwrap() = text(&input["sub"]);
                    switcher.adopt_pending_for_signed_in_account().await;
                    false
                }
                "markPendingFor" => {
                    store.mark_pending_for(input["owner"].as_str(), input["unit"].as_str().unwrap());
                    false
                }
                "signIn" => {
                    *account.0.lock().unwrap() = text(&input["current"]);
                    let sub = text(&input["sub"]);
                    let stored = Arc::clone(&account);
                    let new_sub = sub.clone();
                    let store_tokens = async move {
                        *stored.0.lock().unwrap() = new_sub;
                        Ok(())
                    };
                    switcher.switch_account_keeping_pending(store_tokens, sub).await.is_err()
                }
                "signOut" => {
                    *account.0.lock().unwrap() = text(&input["current"]);
                    switcher.sign_out_keeping_pending().await.is_err()
                }
                "blockWrites" => {
                    let _ = std::fs::remove_file(dir.path().join(PENDING));
                    std::fs::create_dir_all(dir.path().join(PENDING).join("blocker")).unwrap();
                    false
                }
                "unblockWrites" => {
                    std::fs::remove_dir_all(dir.path().join(PENDING)).unwrap();
                    false
                }
                other => panic!("{name}: unknown step {other}"),
            };
            assert_eq!(Value::Bool(error), step["error"], "{name}: step {index} {op}: error");
            assert_eq!(state_of(&store), recorded_state(step), "{name}: step {index} {op}: state");
            assert_eq!(pending_file(dir.path()), step["file"], "{name}: step {index} {op}: file");
            let told: Vec<Value> =
                statuses.lock().unwrap().iter().map(|pending| Value::Bool(*pending)).collect();
            assert_eq!(Value::Array(told), step["statuses"], "{name}: step {index} {op}: statuses");
        }
    }
}

fn generations_of(store: &PendingStore) -> BTreeMap<String, u64> {
    store
        .snapshot_generations()
        .into_iter()
        .map(|(unit, generation)| (unit.as_str().unwrap().to_owned(), generation))
        .collect()
}
