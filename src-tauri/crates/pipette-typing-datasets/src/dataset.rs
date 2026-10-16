// SPDX-License-Identifier: GPL-2.0-or-later
//! What a dataset is made of and which one is in effect for a provider:
//! the checks of src/main/hub/hub-typing-dataset.ts (`isManifestEntry`,
//! `isValidModel`) and `isValidOverride` / `getEffectiveDataset` of
//! src/main/language-store.ts.

use pipette_js_json::{JsString, Object, Value};

use crate::providers::provider_default;

/// A dataset's `model`. Absent means pack-shaped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Model {
    /// Interchangeable word or sentence entries (monkeytype, tatoeba).
    Pack,
    /// Each entry is one whole work (aozora).
    Catalog,
}

/// `isValidModel`: absent, `"pack"` or `"catalog"`. `Err` for anything else.
pub(crate) fn model_of(object: &Object) -> Result<Option<Model>, ()> {
    match object.get("model") {
        None => Ok(None),
        Some(value) => match value.as_str() {
            Some("pack") => Ok(Some(Model::Pack)),
            Some("catalog") => Ok(Some(Model::Catalog)),
            _ => Err(()),
        },
    }
}

fn is_string(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::String(_)))
}

fn is_number(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Number(_)))
}

/// `isManifestEntry`.
pub(crate) fn is_manifest_entry(value: &Value) -> bool {
    let Value::Object(entry) = value else { return false };
    let optional_string = |key| entry.get(key).is_none() || is_string(entry.get(key));
    is_string(entry.get("name"))
        && is_number(entry.get("wordCount"))
        && matches!(entry.get("rightToLeft"), Some(Value::Bool(_)))
        && is_number(entry.get("fileSize"))
        && optional_string("title")
        && optional_string("author")
        && optional_string("authorKana")
}

/// `/^https:\/\//.test(value)` on a string value.
pub(crate) fn is_https_url(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(url)) => url.to_string_lossy().starts_with("https://"),
        _ => false,
    }
}

/// The checks every dataset passes, from the Hub or from the overrides
/// file: a string version, an https base URL, a known model and a list of
/// manifest entries.
pub(crate) fn has_dataset_shape(object: &Object) -> bool {
    is_string(object.get("version"))
        && is_https_url(object.get("downloadUrlBase"))
        && model_of(object).is_ok()
        && matches!(object.get("languages"), Some(Value::Array(entries)) if entries.iter().all(is_manifest_entry))
}

/// The dataset in effect for a provider, borrowed from the overrides or
/// the bundled defaults.
#[derive(Debug, Clone, Copy)]
pub struct Dataset<'a> {
    pub version: &'a JsString,
    pub download_url_base: &'a JsString,
    /// The override's model, else the bundled default's.
    pub model: Option<Model>,
    /// Manifest entries (objects), as they are in the file.
    pub languages: &'a [Value],
}

impl<'a> Dataset<'a> {
    /// The first entry named `name` (`languages.find`).
    pub fn entry(&self, name: &str) -> Option<&'a Object> {
        self.languages.iter().filter_map(Value::as_object).find(|entry| string_is(entry.get("name"), name))
    }

    /// The fields of a dataset `object` that passed [`has_dataset_shape`]
    /// (or a bundled default), with `model` in place of its own.
    fn of(object: &'a Object, model: Option<Model>) -> Option<Self> {
        let (Some(Value::String(version)), Some(Value::String(base)), Some(Value::Array(languages))) =
            (object.get("version"), object.get("downloadUrlBase"), object.get("languages"))
        else {
            return None;
        };
        Some(Self { version, download_url_base: base, model, languages })
    }
}

fn string_is(value: Option<&Value>, text: &str) -> bool {
    matches!(value, Some(Value::String(s)) if s == text)
}

/// `overrides[provider]`: an own property of an object, or an element of an
/// array for an index key, as reading the parsed file in JavaScript gives.
pub(crate) fn override_of<'a>(overrides: &'a Value, provider: &str) -> Option<&'a Value> {
    match overrides {
        Value::Object(object) => object.get(provider),
        Value::Array(items) => {
            let canonical = provider.parse::<u32>().ok().filter(|index| index.to_string() == provider)?;
            items.get(usize::try_from(canonical).ok()?)
        }
        _ => None,
    }
}

/// `getEffectiveDataset`: the provider's override when it has the dataset
/// shape (its model falling back to the default's when absent), else the
/// bundled default; `None` for a provider with neither.
pub fn effective_dataset<'a>(overrides: &'a Value, provider: &str) -> Option<Dataset<'a>> {
    let default = provider_default(provider);
    let default_model = default.and_then(|d| model_of(d).ok().flatten());
    if let Some(Value::Object(ov)) = override_of(overrides, provider)
        && has_dataset_shape(ov)
    {
        let model = model_of(ov).ok().flatten().or(default_model);
        return Dataset::of(ov, model);
    }
    default.and_then(|d| Dataset::of(d, default_model))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Value {
        pipette_js_json::parse(text).unwrap()
    }

    #[test]
    fn manifest_entries_need_the_four_fields_and_string_texts() {
        let ok = r#"{"name":"x","wordCount":1,"rightToLeft":false,"fileSize":2}"#;
        assert!(is_manifest_entry(&parse(ok)));
        assert!(is_manifest_entry(&parse(
            r#"{"name":"x","wordCount":1.5,"rightToLeft":true,"fileSize":-1,"title":"t","author":"a","authorKana":"k","other":null}"#
        )));
        for bad in [
            r#"{"name":1,"wordCount":1,"rightToLeft":false,"fileSize":2}"#,
            r#"{"name":"x","wordCount":"1","rightToLeft":false,"fileSize":2}"#,
            r#"{"name":"x","wordCount":1,"rightToLeft":0,"fileSize":2}"#,
            r#"{"name":"x","wordCount":1,"rightToLeft":false}"#,
            r#"{"name":"x","wordCount":1,"rightToLeft":false,"fileSize":2,"title":null}"#,
            r#"{"name":"x","wordCount":1,"rightToLeft":false,"fileSize":2,"author":5}"#,
            r#"{"name":"x","wordCount":1,"rightToLeft":false,"fileSize":2,"authorKana":[]}"#,
            "null",
            "[]",
            r#""x""#,
        ] {
            assert!(!is_manifest_entry(&parse(bad)), "{bad}");
        }
    }

    #[test]
    fn an_override_with_the_dataset_shape_wins_over_the_default() {
        let overrides = parse(
            r#"{"tatoeba":{"version":"t1","downloadUrlBase":"https://h","languages":[{"name":"a","wordCount":1,"rightToLeft":false,"fileSize":1}]},
                "aozora":{"version":"a1","downloadUrlBase":"https://h","languages":[]},
                "monkeytype":{"version":"m1","downloadUrlBase":"http://h","languages":[]}}"#,
        );
        let tatoeba = effective_dataset(&overrides, "tatoeba").unwrap();
        assert_eq!(*tatoeba.version, *"t1");
        assert_eq!(tatoeba.model, None);
        assert!(tatoeba.entry("a").is_some());
        assert!(tatoeba.entry("b").is_none());
        // No model in the override: the default's catalog.
        assert_eq!(effective_dataset(&overrides, "aozora").unwrap().model, Some(Model::Catalog));
        // Not https: the bundled default.
        let monkeytype = effective_dataset(&overrides, "monkeytype").unwrap();
        assert_ne!(*monkeytype.version, *"m1");
        assert!(monkeytype.languages.len() > 100);
        assert!(effective_dataset(&overrides, "custom").is_none());
    }

    #[test]
    fn an_array_of_overrides_is_read_by_index() {
        let overrides = parse(r#"[{"version":"x"},"b"]"#);
        assert_eq!(override_of(&overrides, "1"), Some(&Value::from("b")));
        assert_eq!(override_of(&overrides, "01"), None);
        assert_eq!(override_of(&overrides, "2"), None);
        assert_eq!(override_of(&overrides, "monkeytype"), None);
        assert_eq!(override_of(&Value::Null, "monkeytype"), None);
    }
}
