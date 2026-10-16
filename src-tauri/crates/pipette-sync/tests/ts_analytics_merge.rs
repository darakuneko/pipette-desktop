// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the scenarios recorded from the TypeScript sync code by
//! scripts/sync-fixtures/record-analytics-merge-fixtures.test.ts
//! (tests/fixtures/ts_analytics_merge.json):
//!
//! - the merges of typing-analytics day and deleted-ranges bundles and the
//!   apply queued after a pass, each step compared on its outcome, the
//!   units the analytics announced, the userData tree (byte for byte; the
//!   cache file aside) and every cache table;
//! - the own-hash reconcile on the in-memory Drive seeded with the same
//!   files, compared on the days found, whether Drive changed, the state,
//!   the requests, the files left on Drive and the tree.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::sync::Arc;
use std::sync::atomic::Ordering;

use common::{
    DriveLog, Harness, NoWaits, Tree, get, opt, read_tree, strings, table_dump, text, tree_of, write_tree,
};
use pipette_drive::DriveApi;
use pipette_drive::canonical::Listing;
use pipette_drive::client::DriveClient;
use pipette_drive::fake::{DriveOp, Fault, InMemoryDrive};
use pipette_entry_store::FixedClock;
use pipette_js_json::{Value, parse, stringify};
use pipette_sync::bundle::{bundle_plaintext, bundle_sync_unit};
use pipette_sync::merge::{AnalyticsMerge, MergeError, merge_analytics_unit, queue_own_deleted_ranges_apply};
use pipette_sync::typing_remote::{collect_remote_own_hash_days, reconcile_own_hash_typing_analytics};

/// The scenarios the generator records; a fixture with fewer is truncated.
const MERGE_SCENARIOS: usize = 7;
const RECONCILE_SCENARIOS: usize = 6;

fn fixture() -> Value {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_analytics_merge.json");
    parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn items(value: &Value) -> &[Value] {
    match value {
        Value::Array(items) => items,
        _ => panic!("not a list: {}", stringify(value)),
    }
}

fn number(value: &Value) -> f64 {
    match value {
        Value::Number(n) => *n,
        _ => panic!("not a number: {}", stringify(value)),
    }
}

struct Failures(Vec<String>);

impl Failures {
    fn check<T: PartialEq + std::fmt::Debug>(&mut self, what: String, got: T, want: T) {
        if got != want {
            self.0.push(format!("{what}:\n  got  {got:?}\n  want {want:?}"));
        }
    }
}

fn error_name(err: &MergeError) -> &'static str {
    match err {
        MergeError::Malformed(_) => "MalformedSyncBundleError",
        MergeError::Type(_) => "TypeError",
        _ => "Error",
    }
}

/// The userData tree without the cache, which the TypeScript recording
/// keeps outside userData.
fn tree_without_cache(root: &std::path::Path) -> Tree {
    let mut tree = read_tree(root);
    tree.retain(|path, _| !path.starts_with("local/typing-analytics.db"));
    tree
}

/// `{ ok: null }`, `{ needsUpload }` or `{ error }` of a step.
fn outcome(result: Result<Option<AnalyticsMerge>, MergeError>) -> (Option<String>, Option<bool>) {
    match result {
        Ok(merge) => (None, merge.map(|m| m.remote_needs_update)),
        Err(err) => (Some(error_name(&err).to_owned()), None),
    }
}

#[tokio::test]
async fn merges_match_typescript() {
    let golden = fixture();
    let own_hash = text(get(&golden, "ownHash"));
    let machine_id = text(get(&golden, "machineId"));
    let now = number(get(&golden, "now")) as i64;
    let scenarios = items(get(&golden, "merges"));
    assert_eq!(scenarios.len(), MERGE_SCENARIOS, "the fixture's merge scenarios");
    let mut failures = Failures(Vec::new());
    for scenario in scenarios {
        let name = text(get(scenario, "name"));
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_tree(root, &tree_of(get(scenario, "tree")));
        let harness = Harness::new(root, &machine_id, now);
        let seeds = strings(get(scenario, "cache"));
        if !seeds.is_empty() {
            let ready = harness.ops.analytics().ready().await.unwrap();
            for text in seeds {
                ready.db.call(move |db| db.apply_day_jsonl(&text)).await.unwrap().unwrap();
            }
        }
        for (i, item) in items(get(scenario, "steps")).iter().enumerate() {
            let (step, want) = (get(item, "step"), get(item, "result"));
            harness.notified.lock().unwrap().clear();
            let label = format!("{name} / step {i}");
            if let Some(units) = opt(step, "bundle") {
                for (unit, want) in strings(units).iter().zip(items(get(want, "bundles"))) {
                    let got = bundle_sync_unit(&harness.ctx, unit).unwrap().map(|b| bundle_plaintext(&b));
                    failures.check(
                        format!("{label} bundle {unit}"),
                        got,
                        get(want, "plaintext").as_str().map(str::to_owned),
                    );
                }
                continue;
            }
            harness.held.store(opt(step, "holds") == Some(&Value::Bool(true)), Ordering::SeqCst);
            let env = harness.env();
            let (error, needs_upload) = if opt(step, "queueOwn").is_some() {
                queue_own_deleted_ranges_apply(harness.ops.clone(), env.holds.clone()).await.unwrap();
                (None, None)
            } else {
                let merge = opt(step, "day").or_else(|| opt(step, "ranges")).unwrap();
                let unit = text(get(merge, "unit"));
                let bundle = parse(&text(get(merge, "plaintext"))).unwrap();
                let result = merge_analytics_unit(&env, &unit, &bundle, &own_hash).await;
                let result = match result {
                    Ok(mut merge) => {
                        if let Some(apply) = merge.own_apply.take() {
                            apply.await.unwrap();
                        }
                        Ok(opt(step, "ranges").map(|_| merge))
                    }
                    Err(err) => Err(err),
                };
                outcome(result)
            };
            harness.held.store(false, Ordering::SeqCst);
            failures.check(format!("{label}: error"), error, opt(want, "error").map(text));
            failures.check(
                format!("{label}: needsUpload"),
                needs_upload,
                match opt(want, "needsUpload") {
                    Some(Value::Bool(b)) => Some(*b),
                    _ => None,
                },
            );
            failures.check(
                format!("{label}: notified"),
                harness.notified.lock().unwrap().clone(),
                strings(get(want, "notified")),
            );
            failures.check(format!("{label}: tree"), tree_without_cache(root), tree_of(get(want, "tree")));
            let tables = get(want, "tables").as_object().unwrap();
            for (table, rows) in tables.iter() {
                let table = table.to_string_lossy();
                failures.check(format!("{label}: {table}"), table_dump(root, &table), strings(rows));
            }
        }
    }
    assert!(failures.0.is_empty(), "{} mismatches:\n{}", failures.0.len(), failures.0.join("\n"));
}

/// `[[day, name, live id or null]…]` by uid, as the generator records it.
fn collected(listing: &Listing, hash: &str) -> Value {
    let per_uid = collect_remote_own_hash_days(listing, hash);
    Value::Object(
        per_uid
            .iter()
            .map(|(uid, days)| {
                let days = days
                    .iter()
                    .map(|(day, remote)| {
                        Value::Array(vec![
                            day.as_str().into(),
                            remote.name.into(),
                            remote.live.map_or(Value::Null, |file| file.id.as_str().into()),
                        ])
                    })
                    .collect();
                (uid.clone(), Value::Array(days))
            })
            .collect(),
    )
}

#[tokio::test]
async fn reconciles_match_typescript() {
    let golden = fixture();
    let own_hash = text(get(&golden, "ownHash"));
    let now = number(get(&golden, "now")) as i64;
    let scenarios = items(get(&golden, "reconciles"));
    assert_eq!(scenarios.len(), RECONCILE_SCENARIOS, "the fixture's reconcile scenarios");
    let mut failures = Failures(Vec::new());
    for scenario in scenarios {
        let name = text(get(scenario, "name"));
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write_tree(root, &tree_of(get(scenario, "tree")));

        let drive = Arc::new(DriveLog::new(InMemoryDrive::new()));
        for file in items(get(scenario, "listing")) {
            drive.inner().create(text(get(file, "name")), "{}".into()).await.unwrap();
        }
        let client = DriveClient::new(drive.clone(), Arc::new(NoWaits));
        let listing = Listing::new(client.list_files(None).await.unwrap());
        let listed: Vec<Value> = listing
            .files()
            .iter()
            .map(|f| {
                Value::Object(
                    [
                        ("id", f.id.as_str().into()),
                        ("name", f.name.as_str().into()),
                        ("modifiedTime", f.modified_time.as_str().into()),
                    ]
                    .into_iter()
                    .collect(),
                )
            })
            .collect();
        failures.check(
            format!("{name}: listing"),
            stringify(&Value::Array(listed)),
            stringify(get(scenario, "listing")),
        );
        let collected_got = Value::Object(
            [("own", collected(&listing, &own_hash)), ("remote", collected(&listing, "remote-hash-1"))]
                .into_iter()
                .collect(),
        );
        failures.check(
            format!("{name}: collected"),
            stringify(&collected_got),
            stringify(get(scenario, "collected")),
        );

        if let Some(fail) = opt(scenario, "failDeletes").filter(|f| **f != Value::Null) {
            let mut fault = Fault::with_status(number(get(fail, "status")) as u16);
            fault.count = number(get(fail, "count")) as u32;
            fault.only = Some(DriveOp::Delete);
            drive.inner().inject(fault);
        }
        let clock = FixedClock::new(now);
        let reconciled =
            reconcile_own_hash_typing_analytics(&client, &listing, root, &own_hash, &clock).await.unwrap();
        failures.check(
            format!("{name}: mutated"),
            Value::Bool(reconciled.mutated),
            get(scenario, "mutated").clone(),
        );
        failures.check(format!("{name}: state"), reconciled.state.to_text(), text(get(scenario, "state")));
        let mut requests = drive.requests();
        requests.sort();
        failures.check(format!("{name}: requests"), requests, strings(get(scenario, "requests")));
        let after: Vec<(String, String)> =
            drive.inner().files().into_iter().map(|stored| (stored.file.id, stored.file.name)).collect();
        let want_after: Vec<(String, String)> = items(get(scenario, "driveAfter"))
            .iter()
            .map(|f| (text(get(f, "id")), text(get(f, "name"))))
            .collect();
        failures.check(format!("{name}: drive after"), after, want_after);
        failures.check(format!("{name}: tree"), read_tree(root), tree_of(get(scenario, "treeAfter")));
    }
    assert!(failures.0.is_empty(), "{} mismatches:\n{}", failures.0.len(), failures.0.join("\n"));
}
