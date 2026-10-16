// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the keyboard-name scenarios recorded from the TypeScript code by
//! scripts/sync-fixtures/record-keyboard-meta-fixtures.test.ts: each seeds a
//! userData tree and runs tombstones and backfills on it, and every step is
//! compared with the recording: the outcome (or the kind of error), the
//! windows notified, the Drive files downloaded and the tree after it,
//! byte for byte. The recording's Drive hands out plaintexts; here they are
//! encrypted with the password for real, and a file marked `wrong` with
//! another one.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use common::{NoWaits, get, opt, read_tree, text, tree_of, write_tree};
use pipette_drive::canonical::Listing;
use pipette_drive::client::DriveClient;
use pipette_drive::{DriveApi, DriveError, DriveFile, DriveFuture, FileList, ListQuery, UploadedFile};
use pipette_entry_store::{FixedClock, WriteLocks};
use pipette_js_json::{Object, Value, parse, stringify};
use pipette_keyboard_stores::{
    StoreContext, StoreError, TombstoneOutcome, tombstone_all_keyboard_meta, tombstone_keyboard_meta,
};
use pipette_sync::merge::{MergeEvents, PackKind};
use pipette_sync::meta_backfill::{BackfillResult, backfill_keyboard_meta};
use pipette_sync_format::crypto::{encrypt_with_key, key_for};

const PASSWORD: &str = "pw";

fn fixture() -> Vec<Value> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_keyboard_meta.json");
    match parse(&std::fs::read_to_string(path).unwrap()).unwrap() {
        Value::Array(items) => items,
        _ => panic!("not a list"),
    }
}

fn items(value: &Value) -> &[Value] {
    match value {
        Value::Array(items) => items,
        _ => panic!("not a list: {}", stringify(value)),
    }
}

type DownloadHook = Box<dyn Fn(&str) + Send + Sync>;

/// A Drive that only downloads: each file's envelope by id, a 404 for any
/// other id. It logs the ids asked for and runs `on_download` with each id
/// before answering.
#[derive(Default)]
struct DownloadOnly {
    files: HashMap<String, Vec<u8>>,
    downloads: Mutex<Vec<String>>,
    on_download: Option<DownloadHook>,
}

impl DriveApi for DownloadOnly {
    fn list_page(&self, _: ListQuery) -> DriveFuture<'_, FileList> {
        panic!("the backfill lists nothing")
    }

    fn download(&self, id: String) -> DriveFuture<'_, Vec<u8>> {
        self.downloads.lock().unwrap().push(id.clone());
        if let Some(hook) = &self.on_download {
            hook(&id);
        }
        let found = self.files.get(&id).cloned();
        Box::pin(async move {
            found.ok_or(DriveError::Status { status: 404, body: "not found".into(), retry_after: None })
        })
    }

    fn create(&self, _: String, _: String) -> DriveFuture<'_, UploadedFile> {
        panic!("the backfill writes nothing to Drive")
    }

    fn create_raw(&self, _: String, _: String) -> DriveFuture<'_, String> {
        panic!("the backfill writes nothing to Drive")
    }

    fn update(&self, _: String, _: String) -> DriveFuture<'_, UploadedFile> {
        panic!("the backfill writes nothing to Drive")
    }

    fn rename(&self, _: String, _: String) -> DriveFuture<'_, DriveFile> {
        panic!("the backfill writes nothing to Drive")
    }

    fn delete(&self, _: String) -> DriveFuture<'_, ()> {
        panic!("the backfill writes nothing to Drive")
    }
}

#[derive(Default)]
struct Events(Mutex<Vec<Value>>);

impl MergeEvents for Events {
    fn unit_applied(&self, unit: &str) {
        let payload: Object = [("syncUnit", Value::from(unit))].into_iter().collect();
        self.0.lock().unwrap().push(Value::Array(vec!["sync:unit-applied".into(), Value::Object(payload)]));
    }

    fn pack_changed(&self, _: PackKind) {
        panic!("the backfill changes no pack");
    }
}

fn error_name(err: &StoreError) -> &'static str {
    match err {
        StoreError::NullEntry(_) | StoreError::PrimitiveEntry(..) => "TypeError",
        _ => "Error",
    }
}

fn recorded<T>(result: Result<T, StoreError>, value: impl FnOnce(T) -> Value) -> Value {
    let (key, value) = match result {
        Ok(v) => ("value", value(v)),
        Err(err) => ("error", Value::from(error_name(&err))),
    };
    Value::Object([(key, value)].into_iter().collect())
}

fn backfill_value(result: BackfillResult) -> Value {
    #[allow(clippy::cast_precision_loss)]
    let resolved = Value::Number(result.resolved as f64);
    let failed = Value::Array(result.failed.into_iter().map(Value::from).collect());
    Value::Object([("resolved", resolved), ("failed", failed)].into_iter().collect())
}

const SALT: [u8; 16] = [7; 16];

/// The envelope of `plaintext` sealed with `key` (derived from a password
/// and [`SALT`]), with the `n`th IV.
fn seal(plaintext: &str, key: &[u8; 32], n: usize) -> Vec<u8> {
    let mut iv = [0u8; 12];
    iv[..8].copy_from_slice(&(n as u64).to_le_bytes());
    let envelope =
        encrypt_with_key(plaintext, key, "keyboards/x/snapshots", &SALT, &iv, "2026-10-01T00:00:00.000Z")
            .unwrap();
    serde_json::to_vec(&envelope).unwrap()
}

async fn backfill(ctx: &StoreContext, files: &[Value], events: &Events) -> (Value, Vec<String>) {
    let right = key_for(PASSWORD, &SALT);
    let wrong = key_for("another password", &SALT);
    let mut drive = DownloadOnly::default();
    let mut listed = Vec::new();
    for (n, file) in files.iter().enumerate() {
        let id = text(get(file, "id"));
        if let Some(plaintext) = opt(file, "plaintext") {
            let key = if opt(file, "wrong").is_some() { &wrong } else { &right };
            drive.files.insert(id.clone(), seal(&text(plaintext), key, n));
        }
        listed.push(DriveFile {
            id,
            name: text(get(file, "name")),
            modified_time: text(get(file, "modifiedTime")),
            created_time: None,
        });
    }
    let drive = Arc::new(drive);
    let client = DriveClient::new(drive.clone(), Arc::new(NoWaits));
    let result = backfill_keyboard_meta(ctx, &client, PASSWORD, &Listing::new(listed), events).await;
    let mut downloads = drive.downloads.lock().unwrap().clone();
    downloads.sort();
    (recorded(result, backfill_value), downloads)
}

#[tokio::test]
async fn tombstones_and_backfills_as_the_typescript_code_does() {
    for scenario in fixture() {
        let name = text(get(&scenario, "name"));
        let root = tempfile::tempdir().unwrap();
        write_tree(root.path(), &tree_of(get(&scenario, "tree")));
        #[allow(clippy::cast_possible_truncation)]
        let now = match get(&scenario, "now") {
            Value::Number(n) => *n as i64,
            _ => panic!("no time"),
        };
        let ctx = StoreContext::new(
            root.path(),
            Arc::new(FixedClock::new(now)),
            Arc::new(WriteLocks::new()),
            Arc::new(|_: &str| {}),
        );
        for (at, step) in items(get(&scenario, "steps")).iter().enumerate() {
            let what = get(step, "step");
            let events = Events::default();
            let (result, downloads) = if let Some(uid) = opt(what, "tombstone") {
                let outcome = tombstone_keyboard_meta(&ctx, &text(uid));
                let value = |o| {
                    Value::from(if o == TombstoneOutcome::Tombstoned { "tombstoned" } else { "unchanged" })
                };
                (recorded(outcome, value), Vec::new())
            } else if opt(what, "tombstoneAll").is_some() {
                #[allow(clippy::cast_precision_loss)]
                let value = |n: usize| Value::Number(n as f64);
                (recorded(tombstone_all_keyboard_meta(&ctx), value), Vec::new())
            } else {
                backfill(&ctx, items(get(what, "backfill")), &events).await
            };
            let label = format!("{name}: step {at}");
            assert_eq!(stringify(&result), stringify(get(step, "result")), "{label}: result");
            let events = Value::Array(events.0.into_inner().unwrap());
            assert_eq!(stringify(&events), stringify(get(step, "events")), "{label}: events");
            let expected: Vec<String> = items(get(step, "downloads")).iter().map(text).collect();
            assert_eq!(downloads, expected, "{label}: downloads");
            assert_eq!(read_tree(root.path()), tree_of(get(step, "tree")), "{label}: tree");
        }
    }
}

/// A keyboard deleted while the backfill looks its name up on Drive keeps
/// its tombstone; the others are still named.
#[tokio::test]
async fn a_keyboard_deleted_during_the_backfill_stays_deleted() {
    let root = tempfile::tempdir().unwrap();
    let ctx = StoreContext::new(
        root.path(),
        Arc::new(FixedClock::new(1_790_000_000_000)),
        Arc::new(WriteLocks::new()),
        Arc::new(|_: &str| {}),
    );
    let key = key_for(PASSWORD, &SALT);
    let bundle = |name: &str| {
        format!(
            r#"{{"type":"layout","key":"x","index":{{"entries":[{{"id":"s","label":"","filename":"{name}_2026-01-01.pipette","savedAt":"2026-10-01T00:00:00.000Z"}}]}},"files":{{}}}}"#
        )
    };
    let tombstone_ctx = ctx.clone();
    let drive = DownloadOnly {
        files: [
            ("gone".to_owned(), seal(&bundle("Gone"), &key, 0)),
            ("kept".to_owned(), seal(&bundle("Kept"), &key, 1)),
        ]
        .into_iter()
        .collect(),
        on_download: Some(Box::new(move |id| {
            if id == "gone" {
                assert_eq!(
                    tombstone_keyboard_meta(&tombstone_ctx, "0xGone").unwrap(),
                    TombstoneOutcome::Tombstoned
                );
            }
        })),
        ..DownloadOnly::default()
    };
    let listed = [("gone", "0xGone"), ("kept", "0xKept")]
        .map(|(id, uid)| DriveFile {
            id: id.to_owned(),
            name: format!("keyboards_{uid}_snapshots.enc"),
            modified_time: "2026-10-01T00:00:00.000Z".to_owned(),
            created_time: None,
        })
        .to_vec();
    let client = DriveClient::new(Arc::new(drive), Arc::new(NoWaits));
    let events = Events::default();

    let result =
        backfill_keyboard_meta(&ctx, &client, PASSWORD, &Listing::new(listed), &events).await.unwrap();

    assert_eq!(result, BackfillResult { resolved: 1, failed: Vec::new() });
    assert_eq!(events.0.into_inner().unwrap().len(), 1);
    let names =
        parse(&std::fs::read_to_string(root.path().join("sync/meta/keyboard-names.json")).unwrap()).unwrap();
    let entry = |uid: &str| {
        items(get(&names, "entries")).iter().find(|e| text(get(e, "uid")) == uid).cloned().unwrap()
    };
    let gone = entry("0xGone");
    assert_eq!(text(get(&gone, "deviceName")), "");
    assert!(opt(&gone, "deletedAt").is_some(), "{}", stringify(&gone));
    let kept = entry("0xKept");
    assert_eq!(text(get(&kept, "deviceName")), "Kept");
    assert!(opt(&kept, "deletedAt").is_none());
}
