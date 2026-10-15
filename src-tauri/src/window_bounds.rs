// SPDX-License-Identifier: GPL-2.0-or-later
//! Geometry of the main window, in device-independent pixels (DIP, Tauri's
//! logical pixels): the nominal minimum size, and fitting a window into a
//! display's work area. Pure functions, the ones of
//! src/main/window-bounds.ts; tests/fixtures/window-bounds.json records the
//! TypeScript results they must match.

/// `MIN_WIDTH` / `MIN_HEIGHT` of src/main/app-config.ts: the minimum size of
/// the window wherever the work area is large enough.
pub const MIN_SIZE: Size = Size { width: 1280.0, height: 1024.0 };

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn size(&self) -> Size {
        Size { width: self.width, height: self.height }
    }
}

/// `Math.min(a, b)`: NaN when either is, and -0 below +0. `f64::min`
/// returns the other operand for a NaN.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// `Math.max(a, b)`: NaN when either is, and +0 above -0.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && a.is_sign_positive()) {
        a
    } else {
        b
    }
}

/// The minimum size actually enforceable on a work area of `work_area`: the
/// nominal minimum, shrunk to the work area where that is smaller.
pub fn effective_min_size(work_area: Size, min_width: f64, min_height: f64) -> Size {
    Size { width: js_min(min_width, work_area.width), height: js_min(min_height, work_area.height) }
}

/// `bounds` shrunk to fit inside `work_area` (never grown), then slid so the
/// whole rectangle lies within it. The size is settled first, so a rectangle
/// larger than the work area lands flush against its near edge.
pub fn clamp_bounds_to_work_area(bounds: Rect, work_area: Rect) -> Rect {
    let width = js_min(bounds.width, work_area.width);
    let height = js_min(bounds.height, work_area.height);
    let max_x = work_area.x + work_area.width - width;
    let max_y = work_area.y + work_area.height - height;
    Rect {
        x: js_min(js_max(bounds.x, work_area.x), max_x),
        y: js_min(js_max(bounds.y, work_area.y), max_y),
        width,
        height,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::path::Path;

    use super::*;

    pub(crate) const fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect { x, y, width, height }
    }

    /// tests/fixtures/window-bounds.json, written by
    /// scripts/app-config-fixtures/record-window-bounds-fixtures.test.ts.
    pub(crate) fn fixture() -> serde_json::Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/window-bounds.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    /// A fixture number: the generator writes NaN as the string "NaN".
    pub(crate) fn number(value: &serde_json::Value) -> f64 {
        if value == "NaN" { f64::NAN } else { value.as_f64().unwrap() }
    }

    pub(crate) fn rect_of(value: &serde_json::Value) -> Rect {
        rect(number(&value["x"]), number(&value["y"]), number(&value["width"]), number(&value["height"]))
    }

    fn size_of(value: &serde_json::Value) -> Size {
        Size { width: number(&value["width"]), height: number(&value["height"]) }
    }

    /// Equal as the TypeScript result is: NaN matches NaN. JSON keeps no
    /// sign of zero, so -0 matches +0.
    fn same(a: f64, b: f64) -> bool {
        a == b || (a.is_nan() && b.is_nan())
    }

    pub(crate) fn same_rect(a: Rect, b: Rect) -> bool {
        same(a.x, b.x) && same(a.y, b.y) && same(a.width, b.width) && same(a.height, b.height)
    }

    fn same_size(a: Size, b: Size) -> bool {
        same(a.width, b.width) && same(a.height, b.height)
    }

    #[test]
    fn the_minimum_size_is_the_electron_one() {
        assert_eq!(MIN_SIZE, size_of(&fixture()["minSize"]));
    }

    #[test]
    fn js_min_and_js_max_follow_math_min_and_max() {
        assert!(js_min(f64::NAN, 1.0).is_nan() && js_min(1.0, f64::NAN).is_nan());
        assert!(js_max(f64::NAN, 1.0).is_nan() && js_max(1.0, f64::NAN).is_nan());
        assert_eq!((js_min(1.0, 2.0), js_max(1.0, 2.0)), (1.0, 2.0));
        assert!(js_min(0.0, -0.0).is_sign_negative() && js_min(-0.0, 0.0).is_sign_negative());
        assert!(js_max(0.0, -0.0).is_sign_positive() && js_max(-0.0, 0.0).is_sign_positive());
        assert_eq!(js_min(f64::NEG_INFINITY, 0.0), f64::NEG_INFINITY);
    }

    #[test]
    fn the_typescript_tables_have_nan_cases() {
        let text = fixture().to_string();
        assert!(text.contains("\"NaN\""));
    }

    #[test]
    fn effective_min_size_matches_the_typescript_table() {
        let fixture = fixture();
        let cases = fixture["effectiveMinSize"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let result = effective_min_size(
                size_of(&case["workArea"]),
                number(&case["minWidth"]),
                number(&case["minHeight"]),
            );
            assert!(same_size(result, size_of(&case["result"])), "{case}: {result:?}");
        }
    }

    #[test]
    fn clamp_bounds_to_work_area_matches_the_typescript_table() {
        let fixture = fixture();
        let cases = fixture["clampBoundsToWorkArea"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let result = clamp_bounds_to_work_area(rect_of(&case["bounds"]), rect_of(&case["workArea"]));
            assert!(same_rect(result, rect_of(&case["result"])), "{case}: {result:?}");
        }
    }

    fn size(width: f64, height: f64) -> Size {
        Size { width, height }
    }

    #[test]
    fn effective_min_size_shrinks_to_the_work_area() {
        for (name, work_area, expected) in [
            ("work area larger than nominal min", size(1920.0, 1080.0), size(1280.0, 1024.0)),
            (
                "work area shorter than nominal min (macOS laptop Dock case)",
                size(1440.0, 900.0),
                size(1280.0, 900.0),
            ),
            ("work area smaller in both axes", size(1024.0, 768.0), size(1024.0, 768.0)),
            ("degenerate tiny work area", size(320.0, 240.0), size(320.0, 240.0)),
        ] {
            assert_eq!(effective_min_size(work_area, MIN_SIZE.width, MIN_SIZE.height), expected, "{name}");
        }
    }

    #[test]
    fn clamp_bounds_to_work_area_fits_the_window() {
        for (name, bounds, work_area, expected) in [
            (
                "already fully inside a larger work area: left untouched",
                rect(100.0, 50.0, 1440.0, 1024.0),
                rect(0.0, 0.0, 1920.0, 1080.0),
                rect(100.0, 50.0, 1440.0, 1024.0),
            ),
            (
                "taller than the work area: shrinks height and pins flush to its bottom edge",
                rect(50.0, 50.0, 1440.0, 1024.0),
                rect(0.0, 25.0, 1440.0, 900.0),
                rect(0.0, 25.0, 1440.0, 900.0),
            ),
            (
                "wider than the work area: shrinks width and lands flush left",
                rect(2500.0, 100.0, 1440.0, 800.0),
                rect(0.0, 0.0, 1280.0, 1024.0),
                rect(0.0, 100.0, 1280.0, 800.0),
            ),
            (
                "origin overflowing the right/bottom edge slides back inside",
                rect(1800.0, 1000.0, 1280.0, 1024.0),
                rect(0.0, 0.0, 1920.0, 1080.0),
                rect(640.0, 56.0, 1280.0, 1024.0),
            ),
            (
                "origin left/above the work area slides back inside",
                rect(-500.0, -300.0, 1280.0, 1024.0),
                rect(0.0, 0.0, 1920.0, 1080.0),
                rect(0.0, 0.0, 1280.0, 1024.0),
            ),
            (
                "negative-coordinate work area (secondary display left of primary)",
                rect(-100.0, 0.0, 1440.0, 1024.0),
                rect(-1920.0, 0.0, 1920.0, 1080.0),
                rect(-1440.0, 0.0, 1440.0, 1024.0),
            ),
            (
                "degenerate tiny work area: fits without negative size",
                rect(0.0, 0.0, 1280.0, 1024.0),
                rect(100.0, 100.0, 320.0, 240.0),
                rect(100.0, 100.0, 320.0, 240.0),
            ),
            (
                "smaller than the work area: never grown",
                rect(10.0, 10.0, 800.0, 600.0),
                rect(0.0, 0.0, 1920.0, 1080.0),
                rect(10.0, 10.0, 800.0, 600.0),
            ),
            (
                // A state saved on a large external monitor, restored on a
                // smaller built-in work area: both dimensions overflow, so
                // the window is pinned to the work area's own origin.
                "saved state larger than the work area in both axes: pinned to the work area origin",
                rect(-200.0, -50.0, 1920.0, 1080.0),
                rect(0.0, 0.0, 1440.0, 900.0),
                rect(0.0, 0.0, 1440.0, 900.0),
            ),
        ] {
            assert_eq!(clamp_bounds_to_work_area(bounds, work_area), expected, "{name}");
        }
    }
}
