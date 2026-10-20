// SPDX-License-Identifier: GPL-2.0-or-later
//! The bundled provider defaults, `TYPING_TEST_PROVIDER_DEFAULTS` of
//! src/shared/data/typing-test-providers.ts, recorded in
//! data/provider-defaults.json. src/shared/__tests__/rust-data-copies.test.ts
//! fails when the two differ: a change to one has to be made to the other.

use std::sync::OnceLock;

use pipette_js_json::{Object, Value};

/// `DEFAULT_TYPING_TEST_PROVIDER`: the provider of a call that names none.
pub const DEFAULT_PROVIDER: &str = "monkeytype";

const DEFAULTS_JSON: &str = include_str!("../data/provider-defaults.json");

/// The default dataset of each provider, in the file's order.
fn defaults() -> &'static [Object] {
    static DEFAULTS: OnceLock<Vec<Object>> = OnceLock::new();
    DEFAULTS.get_or_init(|| {
        // The file is generated and checked by the tests, so a failure here
        // is a build that cannot have passed them.
        let Ok(Value::Array(items)) = pipette_js_json::parse(DEFAULTS_JSON) else {
            panic!("data/provider-defaults.json is not a list");
        };
        items
            .into_iter()
            .map(|item| match item {
                Value::Object(object) => object,
                _ => panic!("data/provider-defaults.json has an entry that is not an object"),
            })
            .collect()
    })
}

/// `getProviderDefault`: the bundled default of a registered provider.
pub fn provider_default(provider: &str) -> Option<&'static Object> {
    defaults().iter().find(|default| default.get("provider").is_some_and(|p| p.as_str() == Some(provider)))
}

/// Whether `provider` is registered (has a bundled default).
pub fn is_registered(provider: &str) -> bool {
    provider_default(provider).is_some()
}

/// The languages a provider ships with the app (`bundledLanguages`).
pub fn is_bundled(provider: &str, name: &str) -> bool {
    match provider_default(provider).and_then(|default| default.get("bundledLanguages")) {
        Some(Value::Array(names)) => names.iter().any(|bundled| bundled.as_str() == Some(name)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_three_providers_ship_with_their_defaults() {
        let names: Vec<_> = defaults()
            .iter()
            .map(|d| d.get("provider").and_then(Value::as_str).unwrap_or_default())
            .collect();
        assert_eq!(names, ["monkeytype", "tatoeba", "aozora"]);

        let monkeytype = provider_default("monkeytype").unwrap();
        let version = monkeytype.get("version").and_then(Value::as_str).unwrap();
        let base = monkeytype.get("downloadUrlBase").and_then(Value::as_str).unwrap();
        assert!(base.contains(version), "the commit is in both: {base}");
        assert!(is_bundled("monkeytype", "english"));
        assert!(!is_bundled("monkeytype", "german"));
        assert!(!is_bundled("tatoeba", "english"));
        assert!(!is_bundled("nope", "english"));

        let aozora = provider_default("aozora").unwrap();
        assert_eq!(aozora.get("model").and_then(Value::as_str), Some("catalog"));
        assert!(!is_registered("Monkeytype"));
        assert!(!is_registered(""));
    }
}
