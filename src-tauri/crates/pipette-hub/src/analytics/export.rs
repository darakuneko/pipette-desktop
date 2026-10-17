// SPDX-License-Identifier: GPL-2.0-or-later
//! The Analyze post's export (`buildAnalyticsExport`, `collectData` and
//! `buildAppData` of src/main/hub/hub-analytics.ts): the
//! `analytics-export-v1.json` the Hub takes, built from the typing
//! analytics cache as the JavaScript values the Electron build serializes,
//! so its JSON text is the same byte for byte.
//!
//! The export holds derived data only: minute-level rows at the finest,
//! and the bigram intervals as bucketed histograms.

use std::collections::HashMap;

use pipette_js_json::{JsString, Object, Value};
use pipette_typing_analytics::bigram_aggregate::{aggregate_pair_totals, rank_by_count, rank_by_slow};
use pipette_typing_analytics_db::{AppAggregate, Gram, ScopeFilters, ToJs, TypingAnalyticsDb};

use super::layout::{LayoutComparisonInputs, layout_comparison_for_export};

/// The fixed size of the bigram rankings (`ANALYTICS_BIGRAM_TOP_LIMIT` /
/// `ANALYTICS_BIGRAM_SLOW_LIMIT`), and the fewest samples a pair needs for
/// the slow ranking (`ANALYTICS_BIGRAM_SLOW_MIN_SAMPLE`). They are not the
/// user's, so every post has the same size and privacy surface.
pub const ANALYTICS_BIGRAM_TOP_LIMIT: f64 = 100.0;
pub const ANALYTICS_BIGRAM_SLOW_LIMIT: f64 = 100.0;
pub const ANALYTICS_BIGRAM_SLOW_MIN_SAMPLE: f64 = 5.0;

/// `TYPING_APP_UNKNOWN_NAME`: the app usage bucket of minutes without one
/// app, which gets no per-app slice.
const TYPING_APP_UNKNOWN_NAME: &str = "__unknown__";

/// The devices whose data the export holds (`DeviceScope`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceScope {
    All,
    Own,
    Hash(String),
}

impl DeviceScope {
    /// `'all'`, `'own'` or `{ kind: 'hash', machineHash }`.
    pub fn to_js(&self) -> Value {
        match self {
            Self::All => Value::from("all"),
            Self::Own => Value::from("own"),
            Self::Hash(hash) => {
                let mut out = Object::new();
                out.insert("kind", Value::from("hash"));
                out.insert("machineHash", Value::from(hash.as_str()));
                out.into()
            }
        }
    }

    /// `resolveMachineHash`: the device the reads are narrowed to, `None`
    /// for every device.
    fn machine_hash<'a>(&'a self, own_hash: &'a str) -> Option<&'a str> {
        match self {
            Self::All => None,
            Self::Own => Some(own_hash),
            Self::Hash(hash) => Some(hash),
        }
    }
}

/// `BuildAnalyticsExportInput`. A keyboard field is `None` where the
/// renderer sent none, which leaves its key out of the export.
#[derive(Debug, Clone)]
pub struct ExportInput {
    pub uid: String,
    pub product_name: Option<Value>,
    pub vendor_id: Option<Value>,
    pub product_id: Option<Value>,
    /// The keymap snapshot of the window, as its file holds it.
    pub snapshot: Value,
    pub from_ms: f64,
    pub to_ms: f64,
    pub device_scope: DeviceScope,
    pub app_scopes: Vec<String>,
    /// The filters for the Hub, already projected
    /// (`projectFiltersForHub`).
    pub filters: Value,
    pub layout_comparison: Option<LayoutComparisonInputs>,
    /// `sanitizeFingerOverrides` of the renderer's finger assignments.
    pub finger_overrides: Option<HashMap<String, String>>,
    /// The categories picked in the upload dialog; `None` or none at all
    /// is every category. A name no category has still counts as a pick.
    pub categories: Option<Vec<String>>,
    /// The apps that get a per-app slice; `None` is every app, none at all
    /// is no slice.
    pub app_data_apps: Option<Vec<String>>,
}

impl ExportInput {
    /// `isSectionEnabled`.
    fn enabled(&self, category: &str) -> bool {
        match &self.categories {
            None => true,
            Some(picked) => picked.is_empty() || picked.iter().any(|c| c == category),
        }
    }
}

/// The export: the value to serialize and what its checks read.
#[derive(Debug, Clone, PartialEq)]
pub struct AnalyticsExport {
    value: Value,
    /// `snapshot.totalKeystrokes`.
    pub total_keystrokes: f64,
    /// `snapshot.range`.
    pub from_ms: f64,
    pub to_ms: f64,
}

impl AnalyticsExport {
    /// The export as `JSON.stringify` writes it, the text the post carries.
    pub fn to_json(&self) -> String {
        pipette_js_json::stringify(&self.value)
    }

    pub fn value(&self) -> &Value {
        &self.value
    }

    #[cfg(test)]
    pub(crate) fn for_tests(total_keystrokes: f64, from_ms: f64, to_ms: f64) -> Self {
        Self { value: Value::Object(Object::new()), total_keystrokes, from_ms, to_ms }
    }
}

/// Why the export could not be built: what the Electron builder throws
/// (a database error, a layout map entry the resolver cannot read, Layout
/// Comparison inputs it cannot iterate). The text is the error's message.
#[derive(Debug, thiserror::Error)]
pub enum ExportError {
    #[error(transparent)]
    Db(#[from] pipette_typing_analytics_db::Error),
    #[error("{0}")]
    Layout(String),
}

/// `buildAnalyticsExport` on `db`, with `own_hash` as this device and
/// `now_ms` as the export's time.
pub fn build_analytics_export(
    db: &TypingAnalyticsDb,
    input: &ExportInput,
    own_hash: &str,
    now_ms: i64,
) -> Result<AnalyticsExport, ExportError> {
    let hash = input.device_scope.machine_hash(own_hash);
    let (data, total_keystrokes) = collect_data(db, input, &input.app_scopes, hash)?;

    let mut keyboard = Object::new();
    keyboard.insert("uid", Value::from(input.uid.as_str()));
    for (key, value) in [
        ("productName", &input.product_name),
        ("vendorId", &input.vendor_id),
        ("productId", &input.product_id),
    ] {
        if let Some(value) = value {
            keyboard.insert(key, value.clone());
        }
    }
    let mut range = Object::new();
    range.insert("fromMs", Value::Number(input.from_ms));
    range.insert("toMs", Value::Number(input.to_ms));
    let mut snapshot = Object::new();
    snapshot.insert("keyboard", keyboard.into());
    snapshot.insert("deviceScope", input.device_scope.to_js());
    snapshot.insert("keymapSnapshot", input.snapshot.clone());
    snapshot.insert("range", range.into());
    snapshot.insert("totalKeystrokes", Value::Number(total_keystrokes));
    snapshot.insert("appScopes", strings(&input.app_scopes));

    let app_data = build_app_data(db, input, hash, &data)?;

    let mut out = Object::new();
    out.insert("version", Value::Number(1.0));
    out.insert("kind", Value::from("analytics"));
    out.insert("exportedAt", Value::from(pipette_time::iso_8601_millis(now_ms)));
    out.insert("snapshot", snapshot.into());
    out.insert("filters", input.filters.clone());
    out.insert("data", data.into());
    if let Some(app_data) = app_data {
        out.insert("appData", app_data.into());
    }
    Ok(AnalyticsExport { value: out.into(), total_keystrokes, from_ms: input.from_ms, to_ms: input.to_ms })
}

fn strings(items: &[String]) -> Value {
    Value::Array(items.iter().map(|s| Value::from(s.as_str())).collect())
}

/// `buildAppData`: per app of the window (at least two, the unknown bucket
/// left out), its own sections without sessions or a longest session, with
/// its own app usage and WPM rows. `None` when there are no slices.
fn build_app_data(
    db: &TypingAnalyticsDb,
    input: &ExportInput,
    hash: Option<&str>,
    aggregate: &Object,
) -> Result<Option<Object>, ExportError> {
    if input.app_data_apps.as_ref().is_some_and(Vec::is_empty) {
        return Ok(None);
    }
    let usage = rows(aggregate, "appUsage");
    let wpm = rows(aggregate, "wpmByApp");
    let apps: Vec<&str> = usage
        .iter()
        .filter_map(|row| row_name(row))
        .filter(|&name| name != TYPING_APP_UNKNOWN_NAME)
        .filter(|&name| input.app_data_apps.as_ref().is_none_or(|allowed| allowed.iter().any(|a| a == name)))
        .collect();
    if apps.len() < 2 {
        return Ok(None);
    }
    // A Map built from the rows: the last row of a name wins.
    let by_name = |list: &[Value], name: &str| -> Value {
        let row = list.iter().rev().find(|row| row_name(row) == Some(name));
        Value::Array(row.cloned().into_iter().collect())
    };
    let mut out = Object::new();
    for name in apps {
        let (mut data, _) = collect_data(db, input, &[name.to_owned()], hash)?;
        data.insert("sessions", Value::Array(Vec::new()));
        if let Some(Value::Object(peaks)) = data.get("peakRecords") {
            let mut peaks = peaks.clone();
            peaks.insert("longestSession", Value::Null);
            data.insert("peakRecords", peaks.into());
        }
        data.insert("appUsage", by_name(usage, name));
        data.insert("wpmByApp", by_name(wpm, name));
        out.insert(JsString::from(name), data.into());
    }
    Ok(Some(out))
}

fn rows<'a>(data: &'a Object, key: &str) -> &'a [Value] {
    match data.get(key) {
        Some(Value::Array(rows)) => rows,
        _ => &[],
    }
}

fn row_name(row: &Value) -> Option<&str> {
    row.as_object().and_then(|r| r.get("name")).and_then(Value::as_str)
}

/// `collectData`: the sections of the window for `app_scopes` and the
/// device `hash`, the ones of categories not picked empty, and the total
/// keystrokes, summed from every minute row whatever the categories so the
/// keystroke threshold holds on a narrowed upload.
fn collect_data(
    db: &TypingAnalyticsDb,
    input: &ExportInput,
    app_scopes: &[String],
    hash: Option<&str>,
) -> Result<(Object, f64), ExportError> {
    let (uid, from, to) = (input.uid.as_str(), input.from_ms, input.to_ms);
    let filters = ScopeFilters { app_names: app_scopes.to_vec(), ..ScopeFilters::default() };
    let on = |category: &str| input.enabled(category);
    let empty = || Value::Array(Vec::new());

    let minutes = db.minute_stats_in_range(uid, hash, from, to, &filters)?;
    let total_keystrokes = minutes.iter().fold(0.0, |sum, m| sum + m.keystrokes);
    let mut out = Object::with_capacity(12);
    let minute_stats = on("wpm") || on("interval") || on("activity");
    out.insert("minuteStats", if minute_stats { minutes.to_js() } else { empty() });
    let matrix = on("heatmap") || on("ergonomics") || on("layer");
    out.insert(
        "matrixCells",
        if matrix { db.matrix_cells(uid, hash, from, to, &filters)?.to_js() } else { empty() },
    );
    out.insert(
        "matrixCellsByDay",
        if on("ergonomics") {
            db.matrix_cells_by_day(uid, hash, from, to, &filters)?.to_js()
        } else {
            empty()
        },
    );
    out.insert(
        "layerUsage",
        if on("layer") { db.layer_usage(uid, hash, from, to, &filters)?.to_js() } else { empty() },
    );
    out.insert(
        "sessions",
        if on("activity") { db.sessions_in_range(uid, hash, from, to)?.to_js() } else { empty() },
    );
    out.insert(
        "bksMinute",
        if on("activity") || on("wpm") {
            db.backspace_minutes(uid, hash, from, to, &filters)?.to_js()
        } else {
            empty()
        },
    );
    let peak_records = db.peak_records(uid, hash, from, to, &filters)?.to_js();
    // The By App tab compares apps, so its rows are read without the app
    // filter.
    let app_usage = db.app_aggregate(AppAggregate::AppUsage, uid, hash, from, to)?.to_js();
    let wpm_by_app = db.app_aggregate(AppAggregate::WpmByApp, uid, hash, from, to)?.to_js();
    let (top, slow) = if on("bigrams") {
        let rows = db.ngram_minutes_in_range(Gram::Bigram, uid, hash, from, to, &filters)?;
        let totals = aggregate_pair_totals(&rows);
        let top = rank_by_count(&totals, ANALYTICS_BIGRAM_TOP_LIMIT);
        let slow = rank_by_slow(&totals, ANALYTICS_BIGRAM_SLOW_MIN_SAMPLE, ANALYTICS_BIGRAM_SLOW_LIMIT);
        (
            top.iter().map(|e| bigram_entry(e, &["count", "hist", "avgIki"])).collect(),
            slow.iter().map(|e| bigram_entry(e, &["count", "hist", "avgIki", "p95"])).collect(),
        )
    } else {
        (Vec::new(), Vec::new())
    };
    out.insert("bigramTop", Value::Array(top));
    out.insert("bigramSlow", Value::Array(slow));
    out.insert("appUsage", app_usage);
    out.insert("wpmByApp", wpm_by_app);
    out.insert("peakRecords", peak_records);
    let layout = match (&input.layout_comparison, on("layoutComparison")) {
        (Some(inputs), true) => layout_comparison_for_export(db, input, inputs, app_scopes, hash)?,
        _ => Value::Null,
    };
    out.insert("layoutComparison", layout);
    Ok((out, total_keystrokes))
}

/// A ranked pair as the Hub names it: `bigramId` for the ranking's
/// `ngramId`, then `fields`.
fn bigram_entry(entry: &Value, fields: &[&str]) -> Value {
    let get = |key: &str| entry.as_object().and_then(|e| e.get(key)).cloned().unwrap_or(Value::Null);
    let mut out = Object::with_capacity(fields.len() + 1);
    out.insert("bigramId", get("ngramId"));
    for &field in fields {
        out.insert(field, get(field));
    }
    out.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_the_device_scopes() {
        let text = |scope: DeviceScope| pipette_js_json::stringify(&scope.to_js());
        assert_eq!(text(DeviceScope::All), r#""all""#);
        assert_eq!(text(DeviceScope::Own), r#""own""#);
        assert_eq!(text(DeviceScope::Hash("h".into())), r#"{"kind":"hash","machineHash":"h"}"#);
        assert_eq!(DeviceScope::Own.machine_hash("own"), Some("own"));
        assert_eq!(DeviceScope::All.machine_hash("own"), None);
        assert_eq!(DeviceScope::Hash("h".into()).machine_hash("own"), Some("h"));
    }

    #[test]
    fn renames_the_ranked_pairs() {
        let entry = pipette_js_json::parse(
            r#"{"ngramId":"4_5","count":3,"hist":[1,2],"avgIki":null,"sd":1,"p95":7,"overlapCount":1}"#,
        )
        .unwrap();
        assert_eq!(
            pipette_js_json::stringify(&bigram_entry(&entry, &["count", "hist", "avgIki", "p95"])),
            r#"{"bigramId":"4_5","count":3,"hist":[1,2],"avgIki":null,"p95":7}"#
        );
    }
}
