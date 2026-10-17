// SPDX-License-Identifier: GPL-2.0-or-later
//! The Analyze post export against the Electron preparation
//! (tests/fixtures/ts_hub_analytics_export.json and its seed, written by
//! `pnpm run generate:hub-fixtures`): on the same cache and userData, with
//! the same machine hash and time, each case must give the export as the
//! same JSON text with the same preview values, the same failure, or the
//! same thrown message. The cache groups days by local time, so the cases
//! run in a process of their own in the time zone they were recorded in.

#![allow(clippy::unwrap_used)]

mod common;

use std::path::Path;
use std::sync::Arc;

use common::{array, field, fixture, text};
use pipette_entry_store::{SystemClock, WriteLocks};
use pipette_hub::analytics::{PrepareError, Prepared, prepare_analytics_export, preview};
use pipette_hub::sources::{AnalyticsJob, AnalyticsSource, BoxFuture};
use pipette_js_json::{Value, stringify};
use pipette_keyboard_stores::StoreContext;
use pipette_time::test_util::in_each_time_zone;
use pipette_typing_analytics::DbActor;

const FIXTURE: &str = "ts_hub_analytics_export.json";

/// The seeded cache of the fixture, with its machine hash.
struct Seeded {
    db: DbActor,
    hash: String,
}

impl AnalyticsSource for Seeded {
    fn machine_hash(&self) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(std::future::ready(Ok(self.hash.clone())))
    }

    fn with_db(&self, job: AnalyticsJob) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { self.db.call(move |db| job(db)).await.map_err(|err| err.to_string()) })
    }
}

fn build_tree(dir: &Path, tree: &Value) {
    for (path, content) in tree.as_object().unwrap().iter() {
        let target = dir.join(path.as_str().unwrap());
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(target, text(content)).unwrap();
    }
}

fn seeded(hash: &str) -> Seeded {
    let seed = std::fs::read_to_string(format!(
        "{}/tests/fixtures/ts_hub_analytics_export_seed.jsonl",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let db = DbActor::open_in_memory().unwrap();
    db.call_blocking(move |db| db.apply_day_jsonl(&seed).map(|_| ())).unwrap().unwrap();
    Seeded { db, hash: hash.to_owned() }
}

fn check(case: &Value, got: Result<Prepared, PrepareError>) {
    let name = text(field(case, "name"));
    let expected = case.as_object().unwrap();
    if let Some(export_json) = expected.get("exportJson") {
        let Ok(prepared @ Prepared::Built(_)) = got else { panic!("{name}: no export: {got:?}") };
        let Prepared::Built(export) = &prepared else { unreachable!() };
        assert_eq!(export.to_json(), text(export_json), "{name}: export");
        assert_eq!(stringify(&preview(&prepared)), stringify(field(case, "preview")), "{name}: preview");
    } else if let Some(failed) = expected.get("failed") {
        let Ok(prepared @ Prepared::Failed { .. }) = got else { panic!("{name}: did not fail: {got:?}") };
        let Prepared::Failed { error, total_keystrokes, range_ms } = &prepared else { unreachable!() };
        assert_eq!(*error, text(field(failed, "error")), "{name}");
        assert_eq!(Value::Number(*total_keystrokes), *field(failed, "totalKeystrokes"), "{name}");
        assert_eq!(Value::Number(*range_ms), *field(failed, "rangeMs"), "{name}");
    } else {
        let Err(PrepareError(message)) = got else { panic!("{name}: did not throw: {got:?}") };
        assert_eq!(message, text(field(case, "thrown")), "{name}");
    }
}

#[test]
fn the_export_matches_typescript() {
    let golden = fixture(FIXTURE);
    let zone = text(field(&golden, "timeZone"));
    let Some(_) = in_each_time_zone("the_export_matches_typescript", &[zone]) else { return };

    let dir = tempfile::tempdir().unwrap();
    build_tree(dir.path(), field(&golden, "tree"));
    let store = StoreContext::new(
        dir.path(),
        Arc::new(SystemClock),
        Arc::new(WriteLocks::new()),
        Arc::new(|_: &str| {}),
    );
    let own_hash = text(field(&golden, "ownHash"));
    let Value::Number(now) = field(&golden, "nowMs") else { panic!("nowMs") };
    let source = seeded(own_hash);
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let cases = array(field(&golden, "cases"));
    assert!(cases.len() > 30);
    for case in cases {
        let params = field(case, "params");
        let got = runtime.block_on(prepare_analytics_export(params, &store, &source, *now as i64));
        check(case, got);
    }
}

/// Typing analytics that never get ready: neither the machine hash nor the
/// cache can be read.
struct NotReady;

impl AnalyticsSource for NotReady {
    fn machine_hash(&self) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(std::future::ready(Err("analytics not ready".to_owned())))
    }

    fn with_db(&self, _job: AnalyticsJob) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(std::future::ready(Err("analytics not ready".to_owned())))
    }
}

/// The machine hash is read once the saved filter has a range, as
/// `getMachineHash()` is in the TS: the checks before it answer without
/// the analytics, and a saved filter that passes them throws their error.
#[test]
fn the_machine_hash_is_read_after_the_saved_filter() {
    let golden = fixture(FIXTURE);
    let dir = tempfile::tempdir().unwrap();
    build_tree(dir.path(), field(&golden, "tree"));
    let store = StoreContext::new(
        dir.path(),
        Arc::new(SystemClock),
        Arc::new(WriteLocks::new()),
        Arc::new(|_: &str| {}),
    );
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let prepare = |params: &Value| runtime.block_on(prepare_analytics_export(params, &store, &NotReady, 0));
    let failed = |json: &str| match prepare(&pipette_js_json::parse(json).unwrap()) {
        Ok(Prepared::Failed { error, .. }) => error,
        other => panic!("{json}: {other:?}"),
    };
    assert_eq!(failed("{}"), "Invalid uid");
    assert_eq!(failed(r#"{"uid":"u"}"#), "Invalid entryId");
    assert_eq!(failed(r#"{"uid":"u","entryId":"missing"}"#), "Saved filter entry not found");
    let built = array(field(&golden, "cases"))
        .iter()
        .find(|case| case.as_object().unwrap().get("exportJson").is_some())
        .unwrap();
    let Err(PrepareError(message)) = prepare(field(built, "params")) else { panic!("did not throw") };
    assert_eq!(message, "analytics not ready");
}
