// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the scenarios recorded from the TypeScript guard, sync-format
//! and password-check code by
//! scripts/sync-fixtures/record-preflight-fixtures.test.ts, and compares
//! every step with the recording: its result or error message, the Drive
//! requests it sent (with the bytes of the marker it created), the
//! validated password-check and the sync-format status events; then the
//! files left on Drive and the stored password. Also checks that
//! `SYNC_FORMAT_VERSION` is the TypeScript value.

#![allow(clippy::unwrap_used, clippy::panic)]

mod preflight_harness;

use std::path::Path;

use pipette_drive::fake::DriveOp;
use pipette_sync::format::SYNC_FORMAT_VERSION;
use pipette_sync::preflight::PreflightError;
use preflight_harness::{Harness, START_MS, Stored};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_preflight.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_else(|| panic!("no {key} in {value}")).to_owned()
}

fn stored_of(value: &Value) -> Stored {
    match value {
        Value::String(kind) if kind == "none" => Stored::None,
        Value::String(kind) if kind == "decryptFailed" => Stored::DecryptFailed,
        Value::String(kind) if kind == "keystoreUnavailable" => Stored::KeystoreUnavailable,
        other => Stored::Readable(text(other, "readable")),
    }
}

fn stored_json(stored: &Stored) -> Value {
    match stored {
        Stored::None => json!("none"),
        Stored::DecryptFailed => json!("decryptFailed"),
        Stored::KeystoreUnavailable => json!("keystoreUnavailable"),
        Stored::Readable(password) => json!({ "readable": password }),
    }
}

fn op_of(what: &str) -> DriveOp {
    match what {
        "list" => DriveOp::List,
        "download" => DriveOp::Download,
        "create" => DriveOp::Create,
        "delete" => DriveOp::Delete,
        other => panic!("unknown operation {other}"),
    }
}

fn outcome(result: Result<Value, PreflightError>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(err) => json!({ "error": err.to_string() }),
    }
}

/// Applies a step that sets the scene; false for a step under test.
async fn arrange(h: &Harness, step: &Value) -> bool {
    match step["op"].as_str().unwrap() {
        "advance" => h.advance(step["ms"].as_u64().unwrap()),
        "hideNew" => h.drive.hide_new(step["on"].as_bool().unwrap()),
        "failNext" => h.drive.fail_next(op_of(&text(step, "what"))),
        "localState" => h.local_state(step["content"].as_str()),
        "signedIn" => {
            h.sign_in.0.store(step["value"].as_bool().unwrap(), std::sync::atomic::Ordering::SeqCst)
        }
        "stored" => h.passwords.set(stored_of(&step["value"])),
        "seed" => {
            for seed in step["files"].as_array().unwrap() {
                match seed.get("raw") {
                    Some(raw) => {
                        h.drive.seed(&text(seed, "name"), raw.as_str().unwrap()).await;
                    }
                    None => {
                        h.drive.seed_password_check(&text(seed, "passwordCheck")).await;
                    }
                }
            }
        }
        "rewrite" => h.drive.rewrite_password_check(&text(step, "id"), &text(step, "password")).await,
        _ => return false,
    }
    true
}

fn status_json<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap()
}

async fn run_op(h: &Harness, step: &Value) -> Result<Value, PreflightError> {
    let p = &h.preflight;
    let password = || text(step, "password");
    match step["op"].as_str().unwrap() {
        "guard" => Ok(status_json(p.sync_block(None).await?)),
        "guardListing" => {
            let generation = p.sync_format_generation();
            let listing = h.list_all().await;
            Ok(status_json(p.sync_block(Some((&listing, generation))).await?))
        }
        "assertFormat" => p.assert_sync_format_supported(None).await.map(|()| Value::Null),
        "ensureMarker" => {
            let generation = p.sync_format_generation();
            let listing = h.list_all().await;
            p.ensure_sync_format_marker(&listing, generation).await.map(|()| Value::Null)
        }
        "ensureMarkerKnown" => p.ensure_sync_format_marker_known().await.map(|()| Value::Null),
        "formatStatus" => Ok(status_json(p.refresh_sync_format_status().await)),
        "cachedFormatStatus" => Ok(status_json(p.cached_sync_format_status())),
        "forgetAccount" => {
            p.forget_account();
            Ok(Value::Null)
        }
        "validate" => {
            let generation = p.sync_format_generation();
            let listing = h.list_all().await;
            p.validate_password_check(&password(), &listing, generation).await.map(|()| Value::Null)
        }
        "ensureValidated" => {
            let generation = p.sync_format_generation();
            let listing = h.list_all().await;
            p.ensure_password_check_validated(&password(), &listing, generation).await.map(|()| Value::Null)
        }
        "set" => p.set_password_and_validate(&password()).await.map(|()| Value::Null),
        "replace" => p.replace_password_and_validate(&password()).await.map(|()| Value::Null),
        "exists" => Ok(json!(p.password_check_exists().await?)),
        "resetCache" => {
            p.reset_password_check_cache();
            Ok(Value::Null)
        }
        "parallel" => {
            let steps = step["steps"].as_array().unwrap();
            let runs = steps.iter().map(|s| Box::pin(run_op(h, s)));
            let results = futures_join_all(runs).await;
            Ok(Value::Array(results.into_iter().map(outcome).collect()))
        }
        other => panic!("unknown step {other}"),
    }
}

/// Polls every future in turn until all are done, as `Promise.all` lets
/// each run to its first wait in the order given.
async fn futures_join_all<F: std::future::Future + Unpin>(
    futures: impl Iterator<Item = F>,
) -> Vec<F::Output> {
    let mut pending: Vec<(F, Option<F::Output>)> = futures.map(|f| (f, None)).collect();
    std::future::poll_fn(|cx| {
        let mut done = true;
        for (future, output) in &mut pending {
            if output.is_none() {
                match std::pin::Pin::new(future).poll(cx) {
                    std::task::Poll::Ready(value) => *output = Some(value),
                    std::task::Poll::Pending => done = false,
                }
            }
        }
        if done { std::task::Poll::Ready(()) } else { std::task::Poll::Pending }
    })
    .await;
    pending.into_iter().map(|(_, output)| output.unwrap()).collect()
}

fn validated_json(h: &Harness) -> Value {
    h.validated()
        .map_or(Value::Null, |(id, modified_time)| json!({ "id": id, "modifiedTime": modified_time }))
}

async fn replay(scenario: &Value) {
    let name = text(scenario, "name");
    let h = Harness::new();
    let mut steps = Vec::new();
    for step in scenario["steps"].as_array().unwrap() {
        let step = &step["step"];
        if arrange(&h, step).await {
            steps.push(json!({ "step": step }));
            continue;
        }
        h.drive.take_events();
        h.format_events.lock().unwrap().clear();
        let result = outcome(run_op(&h, step).await);
        let format_events: Vec<Value> = h.format_events.lock().unwrap().iter().map(status_json).collect();
        steps.push(json!({
            "step": step,
            "result": result,
            "drive": h.drive.take_events(),
            "validated": validated_json(&h),
            "formatEvents": format_events,
        }));
    }
    let files: Vec<Value> = h
        .drive
        .inner
        .files()
        .into_iter()
        .map(|f| json!({ "id": f.file.id, "name": f.file.name, "modifiedTime": f.file.modified_time }))
        .collect();
    let actual =
        json!({ "name": name, "steps": steps, "files": files, "stored": stored_json(&h.passwords.get()) });
    assert_eq!(actual, *scenario, "scenario {name:?}");
}

#[test]
fn the_sync_format_version_is_the_typescript_one() {
    let recorded = fixture();
    assert_eq!(recorded["syncFormatVersion"].as_u64(), Some(SYNC_FORMAT_VERSION));
    assert_eq!(recorded["startMs"].as_u64(), Some(START_MS));
    let constants = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../src/shared/constants/sync-format.ts"),
    )
    .unwrap();
    assert!(
        constants
            .lines()
            .any(|line| line == format!("export const SYNC_FORMAT_VERSION = {SYNC_FORMAT_VERSION}"))
    );
}

#[tokio::test]
async fn the_preflight_matches_the_typescript_recording() {
    for scenario in fixture()["scenarios"].as_array().unwrap() {
        replay(scenario).await;
    }
}
