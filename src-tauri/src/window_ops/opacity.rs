// SPDX-License-Identifier: GPL-2.0-or-later
//! The opacity of the Typing Test's view-only window. Electron's
//! `setOpacity` does nothing on Linux, and neither does this build there;
//! on Windows and macOS it goes through native.rs.

use serde_json::Value;
use tauri::{Runtime, Window};

/// `VIEW_ONLY_OPACITY_MIN` / `_MAX` / `_DEFAULT` of
/// src/shared/types/pipette-settings.ts.
const MIN: f64 = 0.5;
const MAX: f64 = 1.0;
const DEFAULT: f64 = 1.0;

/// `clampViewOnlyOpacity`: a number within 0.5..=1, or 1 for anything that
/// is not a number. JSON carries no NaN or infinity.
pub fn clamp_view_only_opacity(raw: &Value) -> f64 {
    raw.as_f64().map_or(DEFAULT, |opacity| opacity.clamp(MIN, MAX))
}

/// Sets the opacity of `window` to `raw`, clamped.
pub fn set_opacity<R: Runtime>(window: &Window<R>, raw: &Value) {
    super::native::set_opacity(window, clamp_view_only_opacity(raw));
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_clamp_matches_the_electron_calls() {
        let fixture = crate::window_ops::compact::tests::fixture();
        let scenario =
            fixture["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == "opacity").unwrap();
        let steps = scenario["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 14);
        for step in steps {
            let raw = &step["action"]["args"][0];
            let applied = step["calls"][0]["args"][0].as_f64().unwrap();
            assert_eq!(clamp_view_only_opacity(raw), applied, "{raw}");
        }
    }

    #[test]
    fn a_missing_opacity_is_the_default() {
        assert_eq!(clamp_view_only_opacity(&Value::Null), 1.0);
        assert_eq!(clamp_view_only_opacity(&json!(0.75)), 0.75);
    }
}
