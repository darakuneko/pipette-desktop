// SPDX-License-Identifier: GPL-2.0-or-later
//! The Layout Comparison of an Analyze post's export: the metrics of the
//! typing analytics crate on the layouts and key geometry the renderer
//! sends, with the target names and the Hub's finger names.

use std::collections::HashMap;

use pipette_js_json::{Object, Value};
use pipette_typing_analytics::layout_comparison::{Options, compute_with_keys, is_pos_key};
use pipette_typing_analytics::layout_resolver::{FINGERS, KleKey};
use pipette_typing_analytics_db::{ScopeFilters, TypingAnalyticsDb};

use super::export::{ExportError, ExportInput};

const MINUTE_MS: f64 = 60_000.0;

/// The Layout Comparison part of the export input, as the renderer sent it
/// (`layoutComparisonInputs` with the metrics checked). The layouts, the
/// keys and the layer are read when the comparison is computed, only when
/// its category is picked.
#[derive(Debug, Clone, PartialEq)]
pub struct LayoutComparisonInputs {
    pub source: Value,
    pub targets: Value,
    /// The known metrics among those sent.
    pub metrics: Vec<&'static str>,
    pub kle_keys: Value,
    pub layer: Value,
}

/// The Hub's finger names (`FINGER_KEY_TO_HUB`).
const FINGER_KEY_TO_HUB: [(&str, &str); 10] = [
    ("left-pinky", "pinkyL"),
    ("left-ring", "ringL"),
    ("left-middle", "middleL"),
    ("left-index", "indexL"),
    ("left-thumb", "thumbL"),
    ("right-thumb", "thumbR"),
    ("right-index", "indexR"),
    ("right-middle", "middleR"),
    ("right-ring", "ringR"),
    ("right-pinky", "pinkyR"),
];

/// The entries of an object whose key is a `"row,col"` position and whose
/// value is one of the ten finger names; `None` when none is left. A value
/// that is not an object has no entries that could pass.
pub fn sanitize_finger_overrides(value: &Value) -> Option<HashMap<String, String>> {
    let Value::Object(entries) = value else { return None };
    let out: HashMap<String, String> = entries
        .iter()
        .filter_map(|(key, finger)| {
            let key = key.as_str().filter(|k| is_pos_key(k))?;
            let finger = finger.as_str().filter(|f| FINGERS.contains(f))?;
            Some((key.to_owned(), finger.to_owned()))
        })
        .collect();
    (!out.is_empty()).then_some(out)
}

/// The layer the renderer sent (`inputs.layer ?? 0`) as the database
/// matches it, and as an index into the snapshot's keymap: `None` where
/// JavaScript's `keymap[layer]` finds no layer. A value that is not a
/// number matches no layer.
fn layer(value: &Value) -> (f64, Option<usize>) {
    let n = match value {
        Value::Null => 0.0,
        Value::Number(n) => *n,
        _ => f64::NAN,
    };
    let index = (n >= 0.0 && n.fract() == 0.0 && n <= f64::from(u32::MAX)).then_some(n as usize);
    (n, index)
}

/// The comparison over the window widened to whole minutes, with each
/// target's name (the last target of an id names it) and the Hub's finger
/// names.
pub(super) fn layout_comparison_for_export(
    db: &TypingAnalyticsDb,
    input: &ExportInput,
    inputs: &LayoutComparisonInputs,
    app_scopes: &[String],
    hash: Option<&str>,
) -> Result<Value, ExportError> {
    let (layer_value, layer_index) = layer(&inputs.layer);
    let since = (input.from_ms / MINUTE_MS).floor() * MINUTE_MS;
    let until = (input.to_ms / MINUTE_MS).ceil() * MINUTE_MS;
    let filters = ScopeFilters { app_names: app_scopes.to_vec(), ..ScopeFilters::default() };
    let counts = db.matrix_counts_in_range(&input.uid, hash, layer_value, since, until, &filters)?;
    let Value::Array(targets) = &inputs.targets else {
        return Err(ExportError::Layout("input.targets is not iterable".into()));
    };
    let keys: Vec<KleKey> = match &inputs.kle_keys {
        Value::Array(keys) => keys.iter().filter_map(KleKey::from_value).collect(),
        _ => Vec::new(),
    };
    let options = Options {
        source: inputs.source.clone(),
        targets: targets.clone(),
        metrics: inputs.metrics.clone(),
        finger_overrides: input.finger_overrides.clone(),
    };
    let mut result = compute_with_keys(&counts, &input.snapshot, layer_index, &keys, &options)
        .map_err(|err| ExportError::Layout(err.to_string()))?;
    if let Value::Object(result) = &mut result
        && let Some(Value::Array(computed)) = result.get("targets")
    {
        let named: Vec<Value> = computed.iter().map(|target| named_target(target, targets)).collect();
        result.insert("targets", Value::Array(named));
    }
    Ok(result)
}

fn id_of(layout: &Value) -> Option<&Value> {
    layout.as_object().and_then(|o| o.get("id"))
}

/// A computed target with the name of its layout (`layoutName`, when it is
/// truthy) and its finger loads under the Hub's finger names.
fn named_target(target: &Value, inputs: &[Value]) -> Value {
    let Value::Object(target) = target else { return target.clone() };
    let mut out = target.clone();
    let id = target.get("layoutId");
    let name = inputs
        .iter()
        .rev()
        .find(|input| id_of(input) == id)
        .and_then(|input| input.as_object().and_then(|o| o.get("name")));
    if let Some(name) = name.filter(|name| name.is_truthy()) {
        out.insert("layoutName", name.clone());
    }
    if let Some(Value::Object(load)) = target.get("fingerLoad") {
        out.insert("fingerLoad", remap_finger_keys(load).into());
    }
    out.into()
}

/// `load` with each finger key renamed to the Hub's name
/// (`FINGER_KEY_TO_HUB`); any other key stays.
fn remap_finger_keys(load: &Object) -> Object {
    load.iter()
        .map(|(key, value)| {
            let hub = key.as_str().and_then(|k| FINGER_KEY_TO_HUB.iter().find(|(from, _)| *from == k));
            (hub.map_or_else(|| key.clone(), |(_, to)| (*to).into()), value.clone())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Value {
        pipette_js_json::parse(json).unwrap()
    }

    #[test]
    fn keeps_only_position_keys_with_finger_names() {
        assert_eq!(sanitize_finger_overrides(&Value::Null), None);
        assert_eq!(sanitize_finger_overrides(&parse("{}")), None);
        assert_eq!(
            sanitize_finger_overrides(&parse(r#"{"0,0":"left-index","1,3":"right-pinky"}"#)),
            Some(HashMap::from([("0,0".into(), "left-index".into()), ("1,3".into(), "right-pinky".into())]))
        );
        assert_eq!(
            sanitize_finger_overrides(&parse(r#"{"not-a-pos":"left-index","0,0":"left-index"}"#)),
            Some(HashMap::from([("0,0".into(), "left-index".into())]))
        );
        assert_eq!(
            sanitize_finger_overrides(&parse(r#"{"0,0":"left-elbow","0,1":"right-thumb"}"#)),
            Some(HashMap::from([("0,1".into(), "right-thumb".into())]))
        );
        assert_eq!(sanitize_finger_overrides(&parse(r#"{"bad-key":"not-a-finger"}"#)), None);
        assert_eq!(sanitize_finger_overrides(&parse(r#"["left-index"]"#)), None);
        assert_eq!(sanitize_finger_overrides(&parse(r#""0,0""#)), None);
    }

    #[test]
    fn reads_the_layer_as_javascript_indexes_the_keymap() {
        assert_eq!(layer(&Value::Null), (0.0, Some(0)));
        assert_eq!(layer(&Value::Number(1.0)), (1.0, Some(1)));
        assert_eq!(layer(&Value::Number(-0.0)).1, Some(0));
        assert_eq!(layer(&Value::Number(0.5)).1, None);
        assert_eq!(layer(&Value::Number(-1.0)).1, None);
        assert!(layer(&Value::from("1")).0.is_nan());
    }

    #[test]
    fn names_the_targets_and_their_fingers_for_the_hub() {
        let inputs = [
            parse(r#"{"id":"a","name":"First"}"#),
            parse(r#"{"id":"a","name":"Second"}"#),
            parse(r#"{"id":"b","name":""}"#),
        ];
        let target =
            parse(r#"{"layoutId":"a","fingerLoad":{"left-index":0.5,"right-thumb":0.5,"x":1},"skipRate":0}"#);
        assert_eq!(
            pipette_js_json::stringify(&named_target(&target, &inputs)),
            r#"{"layoutId":"a","fingerLoad":{"indexL":0.5,"thumbR":0.5,"x":1},"skipRate":0,"layoutName":"Second"}"#
        );
        let unnamed = parse(r#"{"layoutId":"b","totalEvents":0}"#);
        assert_eq!(
            pipette_js_json::stringify(&named_target(&unnamed, &inputs)),
            r#"{"layoutId":"b","totalEvents":0}"#
        );
    }
}
