// SPDX-License-Identifier: GPL-2.0-or-later
//! The Drive client sends the requests google-drive.ts sends, waits as
//! drive-retry.ts waits and ends each step as it does: the scenarios of
//! tests/fixtures/request_log.json, recorded from the TypeScript code
//! against the Node fake Drive (scripts/sync-fixtures/record-drive-fixtures.test.ts),
//! run here against the in-memory Drive.

#![allow(clippy::unwrap_used)]

mod common;

use std::sync::Arc;
use std::sync::atomic::Ordering;

use common::{DriveServer, ServerHandle, TestEnv, Token, file_json};
use pipette_drive::DriveApi;
use pipette_drive::client::{BulkOutcome, DriveClient};
use pipette_drive::fake::{DriveOp, Fault};
use pipette_drive::retry::DriveFailure;
use serde_json::{Value, json};

const LOG: &str = include_str!("fixtures/request_log.json");

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap().to_owned()
}

fn op_of(name: &str) -> DriveOp {
    match name {
        "list" => DriveOp::List,
        "download" => DriveOp::Download,
        "create" => DriveOp::Create,
        "update" => DriveOp::Update,
        "rename" => DriveOp::Rename,
        "delete" => DriveOp::Delete,
        other => panic!("unknown operation {other}"),
    }
}

/// The files of a scenario's `seed` (drive-request-log.ts `seedFiles`).
fn seed_files(seed: &Value) -> Vec<(String, String)> {
    let Some(seed) = seed.as_array() else { return Vec::new() };
    seed.iter()
        .flat_map(|file| match file["name"].as_str() {
            Some(name) => vec![(name.to_owned(), text(file, "content"))],
            None => (0..file["count"].as_u64().unwrap())
                .map(|index| (format!("{}{index:04}.enc", text(file, "namePrefix")), text(file, "content")))
                .collect(),
        })
        .collect()
}

fn bulk_json(outcome: BulkOutcome) -> Value {
    let mut value = json!({ "attempted": outcome.attempted, "failed": outcome.failed });
    if let Some(first) = outcome.first_error {
        value["firstError"] = json!(first);
    }
    value
}

fn result<T>(answer: Result<T, DriveFailure>, to_json: impl FnOnce(T) -> Value) -> Value {
    match answer {
        Ok(value) => json!({ "ok": to_json(value) }),
        Err(err) => json!({ "error": err.to_string() }),
    }
}

async fn run_step(client: &DriveClient, step: &Value, summary_over: usize) -> Value {
    let id = || text(step, "id");
    match step["op"].as_str().unwrap() {
        "list" => result(client.list_files(step["nameContains"].as_str()).await, |files| {
            let all: Vec<Value> = files.iter().map(file_json).collect();
            if all.len() <= summary_over {
                return json!(all);
            }
            json!({ "count": all.len(), "head": all[..2], "tail": all[all.len() - 2..] })
        }),
        "download" => result(client.download(&id()).await, |bytes| json!(String::from_utf8(bytes).unwrap())),
        "upload" => {
            let existing = step["id"].as_str();
            let create_if_missing = step["createIfMissing"].as_bool().unwrap_or(false);
            let answer = client
                .upload_file(&text(step, "name"), &text(step, "content"), existing, create_if_missing)
                .await;
            result(answer, |file| json!({ "id": file.id, "modifiedTime": file.modified_time }))
        }
        "createRaw" => result(
            client.create_raw_file(&text(step, "name"), &text(step, "content")).await,
            |id| json!({ "id": id }),
        ),
        "rename" => result(client.rename_file(&id(), &text(step, "name")).await, |file| {
            file.map_or(
                Value::Null,
                |file| json!({ "id": file.id, "name": file.name, "modifiedTime": file.modified_time }),
            )
        }),
        "delete" => result(client.delete_file(&id()).await, |()| Value::Null),
        "deleteById" => {
            let ids: Vec<String> =
                step["ids"].as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_owned()).collect();
            json!({ "ok": bulk_json(client.delete_files_by_id(&ids).await) })
        }
        "deleteByPrefix" => result(client.delete_files_by_prefix(&text(step, "prefix")).await, bulk_json),
        other => panic!("unknown step {other}"),
    }
}

fn sorted(mut log: Vec<Value>) -> Vec<Value> {
    log.sort_by_key(Value::to_string);
    log
}

async fn run_scenario(golden: &Value, scenario: &Value) {
    let name = text(scenario, "name");
    let token = Token::new("fixture-token");
    let server: ServerHandle = DriveServer::start(token.clone());
    for (file, content) in seed_files(&scenario["seed"]) {
        server.0.drive.create(file, content).await.unwrap();
    }
    let env = TestEnv::new(golden["nowMs"].as_i64().unwrap(), golden["random"].as_f64().unwrap());
    let client = DriveClient::new(Arc::new(server.http_drive()), env.clone());
    let summary_over = usize::try_from(golden["listSummaryOver"].as_u64().unwrap()).unwrap();
    let mut results = Vec::new();
    for step in scenario["steps"].as_array().unwrap() {
        match step["op"].as_str().unwrap() {
            "fault" => {
                let status = u16::try_from(step["status"].as_u64().unwrap()).unwrap();
                let mut fault =
                    if status == 429 { Fault::rate_limit(None) } else { Fault::with_status(status) };
                fault.retry_after = step["retryAfter"].as_str().map(str::to_owned);
                fault.count = u32::try_from(step["count"].as_u64().unwrap()).unwrap();
                fault.only = step["only"].as_str().map(op_of);
                if let Some(body) = step["body"].as_str() {
                    fault.body = body.to_owned();
                }
                server.0.drive.inject(fault);
            }
            "token" => token.set(step["value"].as_str()),
            "quitOnNextWait" => env.quit_on_next_wait.store(true, Ordering::SeqCst),
            _ => results.push(run_step(&client, step, summary_over).await),
        }
    }
    let mut requests = server.take_log();
    let mut expected: Vec<Value> = scenario["requests"].as_array().unwrap().clone();
    if scenario["unordered"].as_bool() == Some(true) {
        requests = sorted(requests);
        expected = sorted(expected);
    }
    assert_eq!(requests.len(), expected.len(), "{name}: {requests:#?}");
    for (index, (got, want)) in requests.iter().zip(&expected).enumerate() {
        assert_eq!(got, want, "{name}: request {index}");
    }
    let sleeps: Vec<f64> =
        scenario["sleeps"].as_array().unwrap().iter().map(|ms| ms.as_f64().unwrap()).collect();
    assert_eq!(env.sleeps(), sleeps, "{name}: waits");
    assert_eq!(results, *scenario["results"].as_array().unwrap(), "{name}: results");
}

#[tokio::test]
async fn sends_the_requests_of_google_drive_ts() {
    let golden: Value = serde_json::from_str(LOG).unwrap();
    let scenarios = golden["scenarios"].as_array().unwrap();
    assert_eq!(scenarios.len(), 12);
    for scenario in scenarios {
        run_scenario(&golden, scenario).await;
    }
}
