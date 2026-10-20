// SPDX-License-Identifier: GPL-2.0-or-later
//! The Analyze post export builder on a seeded cache: the totals, the
//! device scopes, the category picker, the Layout Comparison and the size.
//! The byte-for-byte comparison with the recorded golden is
//! ts_hub_analytics_export.rs.

#![allow(clippy::unwrap_used)]

use pipette_hub::analytics::{
    AnalyticsExport, DeviceScope, ExportInput, LayoutComparisonInputs, build_analytics_export,
    estimate_analytics_export_size_bytes,
};
use pipette_js_json::{Value, parse};
use pipette_typing_analytics_db::TypingAnalyticsDb;

const OWN: &str = "f1f0f1f0f1f0f1f0f1f0f1f0f1f0f1f0f1f0f1f0f1f0f1f0f1f0f1f0f1f0f1f0";
const REMOTE: &str = "hash-remote";
/// 2026-10-15T09:30Z to 10:30Z, the minutes the seed has on that day.
const FROM: f64 = 1_792_056_600_000.0;
const TO: f64 = FROM + 3_600_000.0;
const NOW: i64 = 1_792_108_800_000;

fn seeded() -> TypingAnalyticsDb {
    let seed = std::fs::read_to_string(format!(
        "{}/tests/fixtures/ts_hub_analytics_export_seed.jsonl",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap();
    let mut db = TypingAnalyticsDb::open_in_memory().unwrap();
    db.apply_day_jsonl(&seed).unwrap();
    db
}

fn input() -> ExportInput {
    ExportInput {
        uid: "uid-a".into(),
        product_name: Some(Value::from("Alpha")),
        vendor_id: Some(Value::Number(65_261.0)),
        product_id: Some(Value::Number(1.0)),
        snapshot: parse(r#"{"keymap":[[["KC_A","KC_S"]]],"layout":{"keys":[]}}"#).unwrap(),
        from_ms: FROM,
        to_ms: TO,
        device_scope: DeviceScope::All,
        app_scopes: Vec::new(),
        filters: parse(r#"{"analysisTab":"summary"}"#).unwrap(),
        layout_comparison: None,
        finger_overrides: None,
        categories: None,
        app_data_apps: None,
    }
}

fn build(db: &TypingAnalyticsDb, input: &ExportInput) -> AnalyticsExport {
    build_analytics_export(db, input, OWN, NOW).unwrap()
}

fn at<'a>(export: &'a AnalyticsExport, path: &[&str]) -> &'a Value {
    path.iter().fold(export.value(), |value, key| value.as_object().unwrap().get(key).unwrap())
}

fn len(value: &Value) -> usize {
    match value {
        Value::Array(items) => items.len(),
        other => panic!("not an array: {other:?}"),
    }
}

#[test]
fn a_v1_export_with_the_keystrokes_summed_from_the_minutes() {
    let db = seeded();
    let export = build(&db, &input());
    assert_eq!(at(&export, &["version"]), &Value::Number(1.0));
    assert_eq!(at(&export, &["kind"]), &Value::from("analytics"));
    assert_eq!(at(&export, &["exportedAt"]), &Value::from("2026-10-16T00:00:00.000Z"));
    assert_eq!(at(&export, &["snapshot", "keyboard", "uid"]), &Value::from("uid-a"));
    assert_eq!(at(&export, &["snapshot", "deviceScope"]), &Value::from("all"));
    let minutes = match at(&export, &["data", "minuteStats"]) {
        Value::Array(rows) => rows.clone(),
        _ => panic!(),
    };
    let sum: f64 = minutes
        .iter()
        .map(|row| match row.as_object().unwrap().get("keystrokes") {
            Some(Value::Number(n)) => *n,
            _ => panic!(),
        })
        .sum();
    assert_eq!(export.total_keystrokes, sum);
    assert_eq!(at(&export, &["snapshot", "totalKeystrokes"]), &Value::Number(sum));
    assert!(export.value().as_object().unwrap().get("filters").is_some());
}

#[test]
fn reads_the_device_the_scope_names() {
    let db = seeded();
    let total =
        |scope: DeviceScope| build(&db, &ExportInput { device_scope: scope, ..input() }).total_keystrokes;
    let (all, own, remote) =
        (total(DeviceScope::All), total(DeviceScope::Own), total(DeviceScope::Hash(REMOTE.into())));
    assert!(own > 0.0 && remote > 0.0);
    assert_eq!(all, own + remote);
    assert_eq!(total(DeviceScope::Hash(OWN.into())), own);
}

#[test]
fn the_category_picker_empties_the_sections_not_picked_but_keeps_the_total() {
    let db = seeded();
    let every = build(&db, &input());
    let heatmap = build(&db, &ExportInput { categories: Some(vec!["heatmap".into()]), ..input() });
    assert_eq!(heatmap.total_keystrokes, every.total_keystrokes);
    assert!(len(at(&heatmap, &["data", "matrixCells"])) > 0);
    for section in
        ["minuteStats", "layerUsage", "matrixCellsByDay", "bigramTop", "bigramSlow", "sessions", "bksMinute"]
    {
        assert_eq!(len(at(&heatmap, &["data", section])), 0, "{section}");
        assert!(len(at(&every, &["data", section])) > 0, "{section}");
    }
    // The By App rows and the peaks are not categories.
    assert_eq!(at(&heatmap, &["data", "appUsage"]), at(&every, &["data", "appUsage"]));
    assert_eq!(at(&heatmap, &["data", "peakRecords"]), at(&every, &["data", "peakRecords"]));
    // A pick no category has turns every section off; no pick turns all on.
    let unknown = build(&db, &ExportInput { categories: Some(vec!["nope".into()]), ..input() });
    assert_eq!(len(at(&unknown, &["data", "matrixCells"])), 0);
    let none = build(&db, &ExportInput { categories: Some(Vec::new()), ..input() });
    assert_eq!(none.to_json(), every.to_json());
}

#[test]
fn the_layout_comparison_needs_its_inputs() {
    let db = seeded();
    let without = build(&db, &input());
    assert_eq!(at(&without, &["data", "layoutComparison"]), &Value::Null);
    let inputs = LayoutComparisonInputs {
        source: parse(r#"{"id":"qwerty","map":{}}"#).unwrap(),
        targets: parse(r#"[{"id":"colemak","name":"Colemak","map":{"KC_S":"R"}}]"#).unwrap(),
        metrics: vec!["fingerLoad"],
        kle_keys: Value::Array(Vec::new()),
        layer: Value::Null,
    };
    let with = build(&db, &ExportInput { layout_comparison: Some(inputs), ..input() });
    let comparison = pipette_js_json::stringify(at(&with, &["data", "layoutComparison"]));
    assert!(
        comparison.starts_with(r#"{"sourceLayoutId":"qwerty","targets":[{"layoutId":"colemak""#),
        "{comparison}"
    );
    assert!(comparison.ends_with(r#""layoutName":"Colemak"}]}"#), "{comparison}");
}

#[test]
fn per_app_slices_need_two_apps() {
    let db = seeded();
    let has_slices = |apps: Option<Vec<String>>| {
        build(&db, &ExportInput { app_data_apps: apps, ..input() })
            .value()
            .as_object()
            .unwrap()
            .contains_key("appData")
    };
    assert!(has_slices(None));
    assert!(!has_slices(Some(Vec::new())));
    assert!(!has_slices(Some(vec!["Code".into()])));
    assert!(has_slices(Some(vec!["Code".into(), "Slack".into()])));
    // The unknown bucket gets no slice.
    assert!(!has_slices(Some(vec!["Code".into(), "__unknown__".into()])));
}

#[test]
fn the_size_is_the_length_of_the_json_text() {
    let db = seeded();
    let export = build(&db, &input());
    let bytes = estimate_analytics_export_size_bytes(&export);
    assert_eq!(bytes, export.to_json().len());
    assert!(bytes > 100 && bytes < 50_000, "{bytes}");
}
