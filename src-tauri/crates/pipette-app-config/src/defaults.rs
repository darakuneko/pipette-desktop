// SPDX-License-Identifier: GPL-2.0-or-later
//! The defaults, the keys the renderer may set and the zoom factor range,
//! as src/shared/types/app-config.ts defines them. data/defaults.json is a
//! recorded copy of those values.

use std::sync::LazyLock;

use pipette_js_json::{Object, Value};

const DEFAULTS_JSON: &str = include_str!("../data/defaults.json");

/// The parsed data/defaults.json.
pub struct Defaults {
    /// `DEFAULT_APP_CONFIG`, in its key order.
    pub values: Object,
    /// `SETTABLE_APP_CONFIG_KEYS`.
    pub settable_keys: Vec<String>,
    /// `ZOOM_FACTOR_MIN`, `ZOOM_FACTOR_MAX`, `ZOOM_FACTOR_DEFAULT`.
    pub zoom_min: f64,
    pub zoom_max: f64,
    pub zoom_default: f64,
}

/// data/defaults.json is part of the build, and a test reads it, so a
/// broken one fails the tests rather than a user's start.
pub static DEFAULTS: LazyLock<Defaults> =
    LazyLock::new(|| load(DEFAULTS_JSON).expect("data/defaults.json is a recorded defaults object"));

fn load(text: &str) -> Option<Defaults> {
    let Value::Object(root) = pipette_js_json::parse(text).ok()? else {
        return None;
    };
    let values = root.get("defaults")?.as_object()?.clone();
    let Value::Array(keys) = root.get("settableKeys")? else {
        return None;
    };
    let settable_keys = keys.iter().map(|key| key.as_str().map(str::to_owned)).collect::<Option<_>>()?;
    let zoom = root.get("zoomFactor")?.as_object()?;
    let number = |key: &str| match zoom.get(key) {
        Some(Value::Number(n)) => Some(*n),
        _ => None,
    };
    Some(Defaults {
        values,
        settable_keys,
        zoom_min: number("min")?,
        zoom_max: number("max")?,
        zoom_default: number("default")?,
    })
}

impl Defaults {
    pub fn is_settable(&self, key: &str) -> bool {
        self.settable_keys.iter().any(|settable| settable == key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_file_loads() {
        let defaults = &*DEFAULTS;
        assert_eq!(defaults.values.get("theme"), Some(&Value::from("system")));
        assert_eq!(defaults.values.keys().next(), Some(&"autoSync".into()));
        assert!(defaults.is_settable("trayResident"));
        assert!(!defaults.is_settable("windowState"));
        assert_eq!((defaults.zoom_min, defaults.zoom_max, defaults.zoom_default), (50.0, 200.0, 100.0));
    }
}
