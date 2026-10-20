// SPDX-License-Identifier: GPL-2.0-or-later
//! Reading a config value: whatever is stored, converted to the expected
//! type, so a value the renderer wrote that is not that type still reads as
//! a usable one.

use pipette_js_json::Value;

use crate::defaults::DEFAULTS;

/// `clampZoomFactor(value)` of src/shared/types/app-config.ts: a number
/// rounded as `Math.round` does (halves up) and clamped to the zoom range;
/// the default for anything else.
pub fn clamp_zoom_factor(value: Option<&Value>) -> f64 {
    let n = match value {
        Some(Value::Number(n)) if !n.is_nan() => *n,
        _ => DEFAULTS.zoom_default,
    };
    js_round(n).clamp(DEFAULTS.zoom_min, DEFAULTS.zoom_max)
}

/// `Math.round`: the nearest integer, halves toward +∞. `x - floor(x)` is
/// exact for any finite f64, so a value just below a half stays below it.
fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_halves_up() {
        for (x, rounded) in [(0.5, 1.0), (-0.5, 0.0), (2.5, 3.0), (-2.5, -2.0), (0.49999999999999994, 0.0)] {
            assert_eq!(js_round(x), rounded, "{x}");
        }
    }
}
