// SPDX-License-Identifier: GPL-2.0-or-later
//! The rules of a key label's content: the label maps and the body file
//! read back or imported. The name rules are those of crate::entry_index.

use pipette_js_json::{Object, Value};

use super::KeyLabelError;
use crate::entry_files::method_type_error_text;

/// Keys a label map may not have.
const DANGEROUS_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// Whether `value` is a label map: an object (an array counts, its keys
/// being indices) whose values are all strings, with none of
/// [`DANGEROUS_KEYS`].
pub(crate) fn is_label_map(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.iter().all(|(key, value)| {
            matches!(value, Value::String(_)) && !DANGEROUS_KEYS.iter().any(|d| key == *d)
        }),
        Value::Array(items) => items.iter().all(|item| matches!(item, Value::String(_))),
        _ => false,
    }
}

/// `a ?? b` of two properties.
fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        None | Some(Value::Null) => b,
        some => some,
    }
}

/// A body file read back or imported: `{name, map, compositeLabels?,
/// keymapApplicable?}`, taking the Hub download's `composite_labels` /
/// `keymap_applicable` when the camel-case field is missing or null. `None`
/// when the name is not a string, the map or the composite labels are not
/// label maps. Only a literal `true` keeps `keymapApplicable`: the keymap
/// rewrite re-derives applicability from the map before using the flag, so
/// a malformed flag reads as "not applicable" instead of refusing the
/// label.
pub(crate) fn normalize_file(parsed: &Value) -> Option<Object> {
    let Value::Object(file) = parsed else { return None };
    let name = file.get("name").filter(|name| matches!(name, Value::String(_)))?;
    let map = file.get("map").filter(|map| is_label_map(map))?;
    let composite = match nullish(file.get("compositeLabels"), file.get("composite_labels")) {
        None | Some(Value::Null) => None,
        Some(labels) if is_label_map(labels) => Some(labels),
        Some(_) => return None,
    };
    let applicable = nullish(file.get("keymapApplicable"), file.get("keymap_applicable"));

    let mut out = Object::new();
    out.insert("name", name.clone());
    out.insert("map", map.clone());
    if let Some(composite) = composite {
        out.insert("compositeLabels", composite.clone());
    }
    if applicable == Some(&Value::Bool(true)) {
        out.insert("keymapApplicable", true.into());
    }
    Some(out)
}

/// The TypeError JavaScript throws when it calls the string method `method`
/// on `value` (missing for undefined) read as `receiver`.
pub(crate) fn method_type_error(value: Option<&Value>, receiver: &str, method: &str) -> KeyLabelError {
    KeyLabelError::Type(method_type_error_text(value, receiver, method))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn object(text: &str) -> Value {
        pipette_js_json::parse(text).unwrap()
    }

    #[test]
    fn label_maps_are_objects_or_arrays_of_strings_without_dangerous_keys() {
        assert!(is_label_map(&object(r#"{"KC_A":"A"}"#)));
        assert!(is_label_map(&object("{}")));
        assert!(is_label_map(&object(r#"["a","b"]"#)));
        for bad in [
            r#"{"KC_A":1}"#,
            r#"{"__proto__":"x"}"#,
            r#"{"constructor":"x"}"#,
            r#"{"prototype":"x"}"#,
            r"[1]",
            "null",
            r#""text""#,
            "5",
        ] {
            assert!(!is_label_map(&object(bad)), "{bad}");
        }
    }

    #[test]
    fn a_file_takes_the_snake_case_aliases_when_the_camel_case_fields_are_missing_or_null() {
        let file = object(
            r#"{"x":1,"map":{"a":"b"},"name":"N","compositeLabels":null,"composite_labels":{"c":"d"},"keymap_applicable":true}"#,
        );
        assert_eq!(
            pipette_js_json::stringify(&Value::Object(normalize_file(&file).unwrap())),
            r#"{"name":"N","map":{"a":"b"},"compositeLabels":{"c":"d"},"keymapApplicable":true}"#
        );
        let camel = object(
            r#"{"name":"N","map":{},"compositeLabels":{},"composite_labels":5,"keymapApplicable":false,"keymap_applicable":true}"#,
        );
        assert_eq!(
            pipette_js_json::stringify(&Value::Object(normalize_file(&camel).unwrap())),
            r#"{"name":"N","map":{},"compositeLabels":{}}"#
        );
    }

    #[test]
    fn a_file_without_a_string_name_or_label_maps_is_refused() {
        for bad in [
            r#"{"map":{}}"#,
            r#"{"name":5,"map":{}}"#,
            r#"{"name":"N"}"#,
            r#"{"name":"N","map":{"a":1}}"#,
            r#"{"name":"N","map":{},"compositeLabels":"x"}"#,
            r#"{"name":"N","map":{},"composite_labels":{"constructor":"x"}}"#,
            r#"["name","map"]"#,
            "null",
        ] {
            assert_eq!(normalize_file(&object(bad)), None, "{bad}");
        }
    }
}
