// SPDX-License-Identifier: GPL-2.0-or-later
//! The Layout Comparison metrics (src/main/typing-analytics/
//! compute-layout-comparison.ts) and the check of their options
//! (`parseLayoutComparisonOptions`, typing-analytics-ipc-range.ts): each
//! recorded cell's count placed on every target layout, then summed per
//! finger, hand and row and divided by the placed events.
//!
//! The sums run in the order of the matrix counts and the shares keep the
//! keys in the order they first got a count, as the TypeScript objects do.

use std::collections::HashMap;

use pipette_js_json::{Object, Value};
use pipette_typing_analytics_db::MatrixCounts;

use crate::layout_resolver::{
    BadLayoutEntry, FINGERS, KleKey, Layout, Resolved, Resolver, SnapshotKeys, pos_key,
};

const METRICS: [&str; 4] = ["fingerLoad", "handBalance", "rowDist", "homeRow"];

/// The checked options: the layouts as they were sent (an object with a
/// non-empty string `id` and an object `map`), the known metrics, and the
/// finger overrides by target position.
#[derive(Debug, Clone, PartialEq)]
pub struct Options {
    pub source: Value,
    pub targets: Vec<Value>,
    pub metrics: Vec<&'static str>,
    pub finger_overrides: Option<HashMap<String, String>>,
}

/// `isLayoutInputLayout`.
fn is_input_layout(value: &Value) -> bool {
    let Some(object) = value.as_object() else { return false };
    let id_ok = matches!(object.get("id"), Some(Value::String(id)) if !id.is_empty());
    id_ok && matches!(object.get("map"), Some(Value::Object(_) | Value::Array(_)))
}

/// `/^\d+,\d+$/` (`POS_KEY_RE`, kle-ergonomics.ts): ASCII digits only.
pub fn is_pos_key(key: &str) -> bool {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    key.split_once(',').is_some_and(|(row, col)| digits(row) && digits(col))
}

/// `isValidFingerOverrides`: a plain object of position keys to finger
/// names, all or nothing.
fn finger_overrides(value: &Value) -> Option<HashMap<String, String>> {
    let Value::Object(object) = value else { return None };
    object
        .iter()
        .map(|(key, finger)| {
            let key = key.as_str().filter(|k| is_pos_key(k))?;
            let finger = finger.as_str().filter(|f| FINGERS.contains(f))?;
            Some((key.to_owned(), finger.to_owned()))
        })
        .collect()
}

/// `parseLayoutComparisonOptions`: `None` when the source, any target, the
/// metrics list or the finger overrides are malformed; unknown metrics are
/// dropped.
pub fn parse_options(value: &Value) -> Option<Options> {
    let object = value.as_object()?;
    let source = object.get("source").filter(|s| is_input_layout(s))?;
    let Some(Value::Array(targets)) = object.get("targets") else { return None };
    if !targets.iter().all(is_input_layout) {
        return None;
    }
    let Some(Value::Array(metrics)) = object.get("metrics") else { return None };
    let metrics = metrics
        .iter()
        .filter_map(|m| m.as_str().and_then(|m| METRICS.iter().find(|&&known| known == m)))
        .copied();
    let finger_overrides = match object.get("fingerOverrides") {
        None => None,
        Some(value) => Some(finger_overrides(value)?),
    };
    Some(Options {
        source: source.clone(),
        targets: targets.clone(),
        metrics: metrics.collect(),
        finger_overrides,
    })
}

fn layout_map(layout: &Value) -> &Value {
    layout.as_object().and_then(|o| o.get("map")).unwrap_or(&Value::Null)
}

/// The layout's `id`; `None` when it has none, which leaves the key out as
/// JSON leaves out an undefined property.
fn layout_id(layout: &Value) -> Option<Value> {
    layout.as_object().and_then(|o| o.get("id")).cloned()
}

/// `extractKleKeysFromSnapshot`: the KLE keys of the snapshot's
/// `layout.keys`, none when it has no such list. An element that is not an
/// object is left out: the app's snapshots hold the KLE parser's key
/// objects.
fn snapshot_kle_keys(snapshot: &Value) -> Vec<KleKey> {
    let keys = snapshot
        .as_object()
        .and_then(|s| s.get("layout"))
        .and_then(Value::as_object)
        .and_then(|l| l.get("keys"));
    match keys {
        Some(Value::Array(keys)) => keys.iter().filter_map(KleKey::from_value).collect(),
        _ => Vec::new(),
    }
}

/// A map of keys to counts, in the order the keys first got one.
#[derive(Default)]
struct Counts(Vec<(String, f64)>);

impl Counts {
    fn add(&mut self, key: &str, count: f64) {
        match self.0.iter_mut().find(|(k, _)| k == key) {
            Some((_, total)) => *total += count,
            None => self.0.push((key.to_owned(), count)),
        }
    }

    /// Each count over `denominator`, as an object.
    fn shares(&self, denominator: f64) -> Value {
        self.0
            .iter()
            .map(|(key, count)| (key.as_str(), Value::Number(ratio(*count, denominator))))
            .collect::<Object>()
            .into()
    }
}

/// `TargetAccumulator`.
#[derive(Default)]
struct Accumulator {
    total_events: f64,
    skipped_events: f64,
    fingers: Counts,
    unmapped_finger: f64,
    left: f64,
    right: f64,
    rows: Counts,
    home_events: f64,
    cells: Counts,
}

impl Accumulator {
    fn record(&mut self, count: f64, resolved: &Resolved) {
        let Resolved::Placed { target_row, target_col, finger, hand, row_category, .. } = resolved else {
            self.skipped_events += count;
            return;
        };
        self.total_events += count;
        self.cells.add(&pos_key(*target_row as f64, *target_col as f64), count);
        match finger {
            Some(finger) => self.fingers.add(finger, count),
            None => self.unmapped_finger += count,
        }
        match hand.map(|h| h.name()) {
            Some("left") => self.left += count,
            Some(_) => self.right += count,
            None => {}
        }
        if let Some(row) = row_category {
            self.rows.add(row, count);
            if *row == "home" {
                self.home_events += count;
            }
        }
    }

    /// `finalizeTarget`.
    fn finish(self, layout_id: Option<Value>, metrics: &[&str]) -> Value {
        let mut out = Object::new();
        if let Some(id) = layout_id {
            out.insert("layoutId", id);
        }
        out.insert("totalEvents", Value::Number(self.total_events));
        out.insert("skippedEvents", Value::Number(self.skipped_events));
        let raw = self.total_events + self.skipped_events;
        out.insert("skipRate", Value::Number(ratio(self.skipped_events, raw)));
        if metrics.contains(&"fingerLoad") {
            out.insert("fingerLoad", self.fingers.shares(self.total_events));
            out.insert("unmappedFinger", Value::Number(ratio(self.unmapped_finger, self.total_events)));
        }
        if metrics.contains(&"handBalance") {
            let hands = self.left + self.right;
            let balance: Object = [
                ("left", Value::Number(ratio(self.left, hands))),
                ("right", Value::Number(ratio(self.right, hands))),
            ]
            .into_iter()
            .collect();
            out.insert("handBalance", balance.into());
        }
        if metrics.contains(&"rowDist") {
            out.insert("rowDist", self.rows.shares(self.total_events));
        }
        if metrics.contains(&"homeRow") {
            out.insert("homeRowStay", Value::Number(ratio(self.home_events, self.total_events)));
        }
        if !self.cells.0.is_empty() {
            let cells: Object =
                self.cells.0.into_iter().map(|(key, count)| (key, Value::Number(count))).collect();
            out.insert("cellCounts", cells.into());
        }
        out.into()
    }
}

fn ratio(numerator: f64, denominator: f64) -> f64 {
    if denominator > 0.0 { numerator / denominator } else { 0.0 }
}

/// `computeLayoutComparison` on layer 0 of `snapshot`, with the counts of
/// one heatmap aggregate. Fails where the TypeScript resolver throws: on a
/// layout map entry that is neither a string nor falsy.
pub fn compute(
    counts: &[MatrixCounts],
    snapshot: &Value,
    options: &Options,
) -> Result<Value, BadLayoutEntry> {
    compute_with_keys(counts, snapshot, Some(0), &snapshot_kle_keys(snapshot), options)
}

/// `computeLayoutComparison` with the keycodes of `snapshot.keymap[layer]`
/// (none when `layer` is `None` or past the last layer, as for an index
/// JavaScript finds nothing at) and the KLE keys `keys`. A layout without
/// an `id` gives a result without the id's key, as JSON leaves out an
/// undefined property.
pub fn compute_with_keys(
    counts: &[MatrixCounts],
    snapshot: &Value,
    layer: Option<usize>,
    keys: &[KleKey],
    options: &Options,
) -> Result<Value, BadLayoutEntry> {
    let keymap = snapshot.as_object().and_then(|s| s.get("keymap")).unwrap_or(&Value::Null);
    let keys = SnapshotKeys::new(keymap, layer.unwrap_or(usize::MAX), keys);
    let source = Layout::new(layout_map(&options.source))?;
    let mut targets = Vec::with_capacity(options.targets.len());
    for target in &options.targets {
        let resolver = Resolver::new(
            &keys,
            &source,
            &Layout::new(layout_map(target))?,
            options.finger_overrides.as_ref(),
        );
        let mut accumulator = Accumulator::default();
        for cell in counts {
            if cell.total.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater)
                || !cell.row.is_finite()
                || !cell.col.is_finite()
            {
                continue;
            }
            accumulator.record(cell.total, resolver.resolve(cell.row, cell.col));
        }
        targets.push(accumulator.finish(layout_id(target), &options.metrics));
    }
    let mut out = Object::new();
    if let Some(id) = layout_id(&options.source) {
        out.insert("sourceLayoutId", id);
    }
    out.insert("targets", Value::Array(targets));
    Ok(out.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const QWERTY: &str = r#"{"id":"qwerty","map":{}}"#;
    const COLEMAK: &str =
        r#"{"id":"colemak","map":{"KC_E":"F","KC_R":"P","KC_T":"G","KC_S":"R","KC_D":"S","KC_F":"T"}}"#;
    const ALL: &str = r#"["fingerLoad","handBalance","rowDist","homeRow"]"#;

    fn options(targets: &[&str], metrics: &str, extra: &str) -> Options {
        let json =
            format!(r#"{{"source":{QWERTY},"targets":[{}],"metrics":{metrics}{extra}}}"#, targets.join(","));
        parse_options(&pipette_js_json::parse(&json).unwrap()).unwrap()
    }

    fn snapshot(rows: &[&[&str]], grid: bool) -> Value {
        let keymap: Vec<String> = rows
            .iter()
            .map(|row| {
                format!("[{}]", row.iter().map(|id| format!("\"{id}\"")).collect::<Vec<_>>().join(","))
            })
            .collect();
        let keys: Vec<String> = if grid {
            (0..4)
                .flat_map(|r| {
                    (0..4).map(move |c| {
                        format!(r#"{{"x":{c},"y":{r},"width":1,"height":1,"row":{r},"col":{c}}}"#)
                    })
                })
                .collect()
        } else {
            Vec::new()
        };
        let json =
            format!(r#"{{"keymap":[[{}]],"layout":{{"keys":[{}]}}}}"#, keymap.join(","), keys.join(","));
        pipette_js_json::parse(&json).unwrap()
    }

    fn counts(cells: &[(f64, f64, f64)]) -> Vec<MatrixCounts> {
        cells.iter().map(|&(row, col, total)| MatrixCounts { row, col, total, tap: 0.0, hold: 0.0 }).collect()
    }

    fn text(value: &Value) -> String {
        pipette_js_json::stringify(value)
    }

    const GRID: [&[&str]; 4] = [
        &["KC_Q", "KC_W", "KC_E", "KC_R"],
        &["KC_A", "KC_S", "KC_D", "KC_F"],
        &["KC_Z", "KC_X", "KC_C", "KC_V"],
        &["KC_NO", "KC_NO", "KC_SPACE", "KC_NO"],
    ];

    #[test]
    fn counts_placed_and_skipped_events_per_target() {
        let no_targets =
            compute(&counts(&[(0.0, 0.0, 1.0)]), &snapshot(&[&["KC_A"]], false), &options(&[], ALL, ""));
        assert_eq!(text(&no_targets.unwrap()), r#"{"sourceLayoutId":"qwerty","targets":[]}"#);
        let skipped = compute(
            &counts(&[(0.0, 0.0, 4.0)]),
            &snapshot(&[&["KC_S"]], false),
            &options(&[COLEMAK], "[]", ""),
        );
        assert_eq!(
            text(&skipped.unwrap()),
            r#"{"sourceLayoutId":"qwerty","targets":[{"layoutId":"colemak","totalEvents":0,"skippedEvents":4,"skipRate":1}]}"#
        );
        let both = compute(
            &counts(&[(0.0, 0.0, 3.0), (0.0, 1.0, 7.0), (0.0, 2.0, 0.0)]),
            &snapshot(&[&["KC_A", "KC_S", "KC_D"]], false),
            &options(&[QWERTY, COLEMAK], "[]", ""),
        );
        assert_eq!(
            text(&both.unwrap()),
            concat!(
                r#"{"sourceLayoutId":"qwerty","targets":["#,
                r#"{"layoutId":"qwerty","totalEvents":10,"skippedEvents":0,"skipRate":0,"cellCounts":{"0,0":3,"0,1":7}},"#,
                r#"{"layoutId":"colemak","totalEvents":10,"skippedEvents":0,"skipRate":0,"cellCounts":{"0,0":3,"0,2":7}}]}"#,
            )
        );
    }

    #[test]
    fn computes_the_requested_shares_on_a_grid() {
        let all =
            compute(&counts(&[(0.0, 3.0, 10.0)]), &snapshot(&GRID, true), &options(&[COLEMAK], ALL, ""));
        assert_eq!(
            text(&all.unwrap()),
            concat!(
                r#"{"sourceLayoutId":"qwerty","targets":[{"layoutId":"colemak","totalEvents":10,"skippedEvents":0,"skipRate":0,"#,
                r#""fingerLoad":{"left-index":1},"unmappedFinger":0,"handBalance":{"left":1,"right":0},"rowDist":{"home":1},"#,
                r#""homeRowStay":1,"cellCounts":{"1,1":10}}]}"#,
            )
        );
        let overridden = compute(
            &counts(&[(0.0, 3.0, 10.0)]),
            &snapshot(&GRID, true),
            &options(
                &[COLEMAK],
                r#"["handBalance","fingerLoad","nope"]"#,
                r#","fingerOverrides":{"1,1":"right-index"}"#,
            ),
        );
        let target = &text(&overridden.unwrap());
        assert!(target.contains(r#""fingerLoad":{"right-index":1}"#), "{target}");
        assert!(target.contains(r#""handBalance":{"left":0,"right":1}"#), "{target}");
        assert!(!target.contains("rowDist"));
    }

    #[test]
    fn checks_the_options() {
        let parse = |json: &str| parse_options(&pipette_js_json::parse(json).unwrap());
        let ok = format!(r#"{{"source":{QWERTY},"targets":[{COLEMAK}],"metrics":[]}}"#);
        assert!(parse(&ok).is_some());
        for bad in [
            r#"{"source":{"id":"","map":{}},"targets":[],"metrics":[]}"#,
            r#"{"source":{"id":"q","map":null},"targets":[],"metrics":[]}"#,
            r#"{"source":{"id":"q","map":{}},"targets":[{"id":"x"}],"metrics":[]}"#,
            r#"{"source":{"id":"q","map":{}},"targets":{},"metrics":[]}"#,
            r#"{"source":{"id":"q","map":{}},"targets":[]}"#,
            r#"{"source":{"id":"q","map":{}},"targets":[],"metrics":[],"fingerOverrides":{"a,1":"left-index"}}"#,
            r#"{"source":{"id":"q","map":{}},"targets":[],"metrics":[],"fingerOverrides":{"1,1":"left-toe"}}"#,
            r#"{"source":{"id":"q","map":{}},"targets":[],"metrics":[],"fingerOverrides":"1,1"}"#,
            r#"{"source":{"id":"q","map":{}},"targets":[],"metrics":[],"fingerOverrides":["left-index"]}"#,
            r#"{"source":{"id":"q","map":{}},"targets":[],"metrics":[],"fingerOverrides":null}"#,
            "[]",
        ] {
            assert_eq!(parse(bad), None, "{bad}");
        }
        let overrides = parse(
            r#"{"source":{"id":"q","map":[]},"targets":[],"metrics":[],"fingerOverrides":{"0,12":"left-index"}}"#,
        );
        assert_eq!(
            overrides.unwrap().finger_overrides,
            Some(HashMap::from([("0,12".into(), "left-index".into())]))
        );
        assert!(!is_pos_key("1,2\n") && !is_pos_key(",1") && !is_pos_key("١,1"));
    }

    #[test]
    fn a_map_entry_that_is_not_text_fails() {
        let bad = r#"{"id":"bad","map":{"KC_A":5}}"#;
        assert!(compute(&counts(&[]), &snapshot(&[&["KC_A"]], false), &options(&[bad], "[]", "")).is_err());
    }
}
