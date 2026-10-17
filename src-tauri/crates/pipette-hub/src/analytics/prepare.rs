// SPDX-License-Identifier: GPL-2.0-or-later
//! The preparation of an Analyze post's export, shared by the upload, the
//! update, the private upload and the preview
//! (src/main/hub/hub-ipc-analytics-prepare.ts): the saved filter condition
//! read and checked, the keymap snapshot of its window, its filters
//! projected for the Hub, and the export built on the typing analytics
//! cache.
//!
//! The parameters are the JavaScript value the renderer sent, read with the
//! handler's checks: a field of the wrong type gets the handler's answer for
//! it.

use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::{AnalyzeFilterError, StoreContext, load_analyze_filter};
use pipette_typing_analytics::keymap_snapshots::get_keymap_snapshot_for_range;

use super::export::{AnalyticsExport, DeviceScope, ExportInput, build_analytics_export};
use super::layout::{LayoutComparisonInputs, sanitize_finger_overrides};
use super::validate::{Validation, estimate_analytics_export_size_bytes, validate_analytics_export};
use crate::sources::AnalyticsSource;

/// What the preparation gives when it does not throw.
#[derive(Debug, Clone, PartialEq)]
pub enum Prepared {
    Built(Box<AnalyticsExport>),
    /// The export could not be assembled: the reason (the handler's
    /// `error`), and the totals the preview shows for it.
    Failed {
        error: &'static str,
        total_keystrokes: f64,
        range_ms: f64,
    },
}

/// What the preparation throws; the text is the error's message, which the
/// handlers answer as `error`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct PrepareError(pub String);

fn failed(error: &'static str, range_ms: f64) -> Prepared {
    Prepared::Failed { error, total_keystrokes: 0.0, range_ms }
}

/// The property `key` of `value` as JavaScript reads it from a JSON value:
/// only an object has the properties the preparation reads.
fn prop<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|o| o.get(key))
}

/// A non-empty string (`!v || typeof v !== 'string'` rejects the rest).
/// A string with a lone surrogate, which no store path can hold, is
/// rejected too.
fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// The string elements of a list, in order.
fn string_items(items: &[Value]) -> Vec<String> {
    items.iter().filter_map(Value::as_str).map(str::to_owned).collect()
}

/// `Math.max(0, n)`: NaN stays NaN.
fn js_max_zero(n: f64) -> f64 {
    if n.is_nan() { n } else { n.max(0.0) }
}

/// `prepareAnalyticsExport(params)` with `own_hash` as this device and
/// `now_ms` as the export's time: the saved filters read from `store`,
/// the snapshot from its userData, the export built on `source`'s cache.
pub async fn prepare_analytics_export(
    params: &Value,
    store: &StoreContext,
    source: &dyn AnalyticsSource,
    own_hash: &str,
    now_ms: i64,
) -> Result<Prepared, PrepareError> {
    let Some(uid) = text(prop(params, "uid")) else { return Ok(failed("Invalid uid", 0.0)) };
    let Some(entry_id) = text(prop(params, "entryId")) else { return Ok(failed("Invalid entryId", 0.0)) };
    let data = match load_analyze_filter(store, uid, entry_id) {
        Ok(data) => data,
        Err(AnalyzeFilterError::NotFound | AnalyzeFilterError::Deleted) => {
            return Ok(failed("Saved filter entry not found", 0.0));
        }
        Err(err) => return Err(thrown(&err.to_string())),
    };
    let Ok(payload) = pipette_js_json::parse(&data) else {
        return Ok(failed("Saved filter payload is not valid JSON", 0.0));
    };
    if !matches!(prop(&payload, "version"), Some(Value::Number(v)) if *v == 1.0) {
        return Ok(failed("Unsupported saved filter version", 0.0));
    }
    let range = prop(&payload, "range");
    let (Some(Value::Number(from_ms)), Some(Value::Number(to_ms))) =
        (range.and_then(|r| prop(r, "fromMs")), range.and_then(|r| prop(r, "toMs")))
    else {
        return Ok(failed("Saved filter has no range", 0.0));
    };
    let (from_ms, to_ms) = (*from_ms, *to_ms);
    let range_ms = js_max_zero(to_ms - from_ms);

    let filters = prop(&payload, "filters");
    let device_scope = device_scope(filters.and_then(|f| prop(f, "deviceScopes")));
    let app_scopes = match filters.and_then(|f| prop(f, "appScopes")) {
        Some(Value::Array(items)) => string_items(items),
        _ => Vec::new(),
    };

    // Only this device saves keymap snapshots.
    let snapshot = get_keymap_snapshot_for_range(store.user_data(), uid, own_hash, from_ms, to_ms)
        .map_err(|err| PrepareError(err.to_string()))?;
    if matches!(snapshot, Value::Null) {
        return Ok(failed("No keymap snapshot recorded for this range", range_ms));
    }

    let finger_overrides = prop(params, "fingerOverrides").unwrap_or(&Value::Null);
    let hub_filters = project_filters_for_hub(filters, finger_overrides);
    let layout_comparison = layout_comparison_inputs(prop(params, "layoutComparisonInputs"));
    let categories = match prop(params, "categories") {
        Some(Value::Array(items)) if !items.is_empty() => Some(string_items(items)),
        _ => None,
    };
    let app_data_apps = match prop(params, "appDataApps") {
        Some(Value::Array(items)) => Some(string_items(items)),
        _ => None,
    };
    let keyboard = match prop(params, "keyboard") {
        None => {
            return Err(PrepareError("Cannot read properties of undefined (reading 'productName')".into()));
        }
        Some(Value::Null) => {
            return Err(PrepareError("Cannot read properties of null (reading 'productName')".into()));
        }
        Some(keyboard) => keyboard,
    };
    let input = ExportInput {
        uid: uid.to_owned(),
        product_name: prop(keyboard, "productName").cloned(),
        vendor_id: prop(keyboard, "vendorId").cloned(),
        product_id: prop(keyboard, "productId").cloned(),
        snapshot,
        from_ms,
        to_ms,
        device_scope,
        app_scopes,
        filters: hub_filters,
        layout_comparison,
        finger_overrides: sanitize_finger_overrides(finger_overrides),
        categories,
        app_data_apps,
    };

    let (answer, answered) = tokio::sync::oneshot::channel();
    let own_hash = own_hash.to_owned();
    source
        .with_db(Box::new(move |db| {
            let built = build_analytics_export(db, &input, &own_hash, now_ms).map_err(|err| err.to_string());
            let _ = answer.send(built);
        }))
        .await
        .map_err(PrepareError)?;
    let built =
        answered.await.map_err(|_| PrepareError("the typing analytics read did not answer".into()))?;
    built.map(|export| Prepared::Built(Box::new(export))).map_err(PrepareError)
}

/// The message of an error a store answers as `String(err)`: without the
/// `Error: ` / `TypeError: ` its text starts with.
fn thrown(text: &str) -> PrepareError {
    let message =
        ["Error: ", "TypeError: "].iter().find_map(|prefix| text.strip_prefix(prefix)).unwrap_or(text);
    PrepareError(message.to_owned())
}

/// `resolveDeviceScopeFromPayload`: the first scope of the list when it is
/// `'all'`, `'own'` or a hash scope with a non-empty hash, `'own'`
/// otherwise.
fn device_scope(scopes: Option<&Value>) -> DeviceScope {
    let first = match scopes {
        Some(Value::Array(items)) => items.first(),
        _ => None,
    };
    match first {
        Some(Value::String(s)) if s.as_str() == Some("all") => DeviceScope::All,
        Some(scope @ Value::Object(_)) => {
            let is_hash = matches!(prop(scope, "kind"), Some(Value::String(k)) if k == "hash");
            match text(prop(scope, "machineHash")) {
                Some(hash) if is_hash => DeviceScope::Hash(hash.to_owned()),
                _ => DeviceScope::Own,
            }
        }
        _ => DeviceScope::Own,
    }
}

const VALID_LAYOUT_METRICS: [&str; 4] = ["fingerLoad", "handBalance", "rowDist", "homeRow"];

/// `params.layoutComparisonInputs` when it is truthy, with its metrics
/// checked (`filterValidLayoutMetrics`).
fn layout_comparison_inputs(value: Option<&Value>) -> Option<LayoutComparisonInputs> {
    let inputs = value.filter(|v| v.is_truthy())?;
    let field = |key: &str| prop(inputs, key).cloned().unwrap_or(Value::Null);
    let metrics = match prop(inputs, "metrics") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|m| m.as_str().and_then(|m| VALID_LAYOUT_METRICS.iter().find(|&&known| known == m)))
            .copied()
            .collect(),
        _ => Vec::new(),
    };
    Some(LayoutComparisonInputs {
        source: field("source"),
        targets: field("targets"),
        metrics,
        kle_keys: field("kleKeys"),
        layer: field("layer"),
    })
}

/// `Object.keys(value).length > 0`: a non-empty object, list or string.
fn has_own_keys(value: &Value) -> bool {
    match value {
        Value::Object(o) => !o.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::String(s) => !s.is_empty(),
        _ => false,
    }
}

/// `projectFiltersForHub`: the Hub opens on the summary tab, the tab
/// filters go as saved (a key the saved filters lack is left out), the
/// bigram limits are fixed with the saved pair interval threshold, and the
/// renderer's finger assignments go as sent when there are any.
fn project_filters_for_hub(filters: Option<&Value>, finger_overrides: &Value) -> Value {
    let saved = |key: &str| filters.and_then(|f| prop(f, key)).cloned();
    let mut out = Object::new();
    out.insert("analysisTab", Value::from("summary"));
    for key in ["heatmap", "wpm", "interval", "activity", "layer", "ergonomics"] {
        if let Some(value) = saved(key) {
            out.insert(key, value);
        }
    }
    let mut bigrams = Object::new();
    bigrams.insert("topLimit", Value::Number(10.0));
    bigrams.insert("slowLimit", Value::Number(10.0));
    bigrams.insert("fingerLimit", Value::Number(20.0));
    if let Some(threshold @ Value::Number(_)) =
        saved("bigrams").as_ref().and_then(|b| prop(b, "pairIntervalThresholdMs"))
    {
        bigrams.insert("pairIntervalThresholdMs", threshold.clone());
    }
    out.insert("bigrams", bigrams.into());
    if let Some(value) = saved("layoutComparison") {
        out.insert("layoutComparison", value);
    }
    if has_own_keys(finger_overrides) {
        out.insert("fingerOverrides", finger_overrides.clone());
    }
    out.into()
}

/// The preview of hub-ipc-analytics.ts for what the preparation gave:
/// `{ totalKeystrokes, rangeMs, estimatedBytes, validation }`. A failed
/// preparation is a failed validation with its reason and no size.
pub fn preview(prepared: &Prepared) -> Value {
    let (total, range_ms, bytes, validation) = match prepared {
        Prepared::Built(export) => (
            export.total_keystrokes,
            export.to_ms - export.from_ms,
            estimate_analytics_export_size_bytes(export) as f64,
            validate_analytics_export(export),
        ),
        Prepared::Failed { error, total_keystrokes, range_ms } => {
            (*total_keystrokes, *range_ms, 0.0, Validation::Failed(error))
        }
    };
    let mut out = Object::new();
    out.insert("totalKeystrokes", Value::Number(total));
    out.insert("rangeMs", Value::Number(range_ms));
    out.insert("estimatedBytes", Value::Number(bytes));
    out.insert("validation", validation.to_js());
    out.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Value {
        pipette_js_json::parse(json).unwrap()
    }

    #[test]
    fn resolves_the_device_scope_from_the_first_entry() {
        let scope = |json: &str| device_scope(Some(&parse(json)));
        assert_eq!(scope(r#"["all","own"]"#), DeviceScope::All);
        assert_eq!(scope(r#"["own"]"#), DeviceScope::Own);
        assert_eq!(scope(r#"[{"kind":"hash","machineHash":"h"}]"#), DeviceScope::Hash("h".into()));
        for own in [
            r#"[]"#,
            r#""all""#,
            r#"["mine"]"#,
            r#"[{"kind":"hash","machineHash":""}]"#,
            r#"[{"kind":"own"}]"#,
            r#"[null]"#,
        ] {
            assert_eq!(scope(own), DeviceScope::Own, "{own}");
        }
        assert_eq!(device_scope(None), DeviceScope::Own);
    }

    #[test]
    fn projects_the_filters_for_the_hub() {
        let project = |filters: &str, overrides: &str| {
            let filters = parse(filters);
            pipette_js_json::stringify(&project_filters_for_hub(Some(&filters), &parse(overrides)))
        };
        assert_eq!(
            project(
                r#"{"wpm":{"a":1},"heatmap":null,"bigrams":{"pairIntervalThresholdMs":150,"topLimit":3},"x":1}"#,
                "{}"
            ),
            r#"{"analysisTab":"summary","heatmap":null,"wpm":{"a":1},"bigrams":{"topLimit":10,"slowLimit":10,"fingerLimit":20,"pairIntervalThresholdMs":150}}"#
        );
        assert_eq!(
            project(r#"{"bigrams":{"pairIntervalThresholdMs":"150"}}"#, r#"{"bad":"x"}"#),
            r#"{"analysisTab":"summary","bigrams":{"topLimit":10,"slowLimit":10,"fingerLimit":20},"fingerOverrides":{"bad":"x"}}"#
        );
        assert!(project("{}", r#""ab""#).ends_with(r#""fingerOverrides":"ab"}"#));
        assert!(!project("{}", "5").contains("fingerOverrides"));
        assert!(!project("{}", "[]").contains("fingerOverrides"));
    }

    #[test]
    fn keeps_the_known_layout_metrics() {
        let inputs = layout_comparison_inputs(Some(&parse(
            r#"{"source":{"id":"q"},"targets":[],"metrics":["rowDist","nope",3,"fingerLoad","rowDist"]}"#,
        )))
        .unwrap();
        assert_eq!(inputs.metrics, ["rowDist", "fingerLoad", "rowDist"]);
        assert_eq!(inputs.layer, Value::Null);
        assert_eq!(layout_comparison_inputs(Some(&Value::Null)), None);
        assert_eq!(layout_comparison_inputs(None), None);
        assert!(
            layout_comparison_inputs(Some(&parse(r#"{"metrics":"rowDist"}"#))).unwrap().metrics.is_empty()
        );
    }

    #[test]
    fn strips_the_error_name_of_a_thrown_store_error() {
        assert_eq!(thrown("Error: Invalid uid").0, "Invalid uid");
        assert_eq!(thrown("TypeError: bad").0, "bad");
        assert_eq!(thrown("plain").0, "plain");
    }

    #[test]
    fn keeps_nan_in_the_range_length() {
        assert!(js_max_zero(f64::NAN).is_nan());
        assert_eq!(js_max_zero(-5.0), 0.0);
        assert_eq!(js_max_zero(5.0), 5.0);
    }
}
