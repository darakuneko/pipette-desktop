// SPDX-License-Identifier: GPL-2.0-or-later
//! Geometry of the main window, in device-independent pixels (DIP, Tauri's
//! logical pixels): the nominal minimum size, and fitting a window into a
//! display's work area. Pure functions, the ones of
//! src/main/window-bounds.ts; tests/fixtures/window-bounds.json records the
//! TypeScript results they must match.

/// `MIN_WIDTH` / `MIN_HEIGHT` of src/main/app-config.ts: the minimum size of
/// the window wherever the work area is large enough.
pub const MIN_SIZE: Size = Size { width: 1280.0, height: 1024.0 };

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize)]
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

/// The minimum size actually enforceable on a work area of `work_area`: the
/// nominal minimum, shrunk to the work area where that is smaller.
pub fn effective_min_size(work_area: Size, min_width: f64, min_height: f64) -> Size {
    Size { width: min_width.min(work_area.width), height: min_height.min(work_area.height) }
}

/// `bounds` shrunk to fit inside `work_area` (never grown), then slid so the
/// whole rectangle lies within it. The size is settled first, so a rectangle
/// larger than the work area lands flush against its near edge.
pub fn clamp_bounds_to_work_area(bounds: Rect, work_area: Rect) -> Rect {
    let width = bounds.width.min(work_area.width);
    let height = bounds.height.min(work_area.height);
    let max_x = work_area.x + work_area.width - width;
    let max_y = work_area.y + work_area.height - height;
    Rect { x: bounds.x.max(work_area.x).min(max_x), y: bounds.y.max(work_area.y).min(max_y), width, height }
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

    fn from<T: serde::de::DeserializeOwned>(value: &serde_json::Value) -> T {
        serde_json::from_value(value.clone()).unwrap()
    }

    #[test]
    fn the_minimum_size_is_the_electron_one() {
        assert_eq!(MIN_SIZE, from::<Size>(&fixture()["minSize"]));
    }

    #[test]
    fn effective_min_size_matches_the_typescript_table() {
        let fixture = fixture();
        let cases = fixture["effectiveMinSize"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let result = effective_min_size(
                from(&case["workArea"]),
                case["minWidth"].as_f64().unwrap(),
                case["minHeight"].as_f64().unwrap(),
            );
            assert_eq!(result, from::<Size>(&case["result"]), "{case}");
        }
    }

    #[test]
    fn clamp_bounds_to_work_area_matches_the_typescript_table() {
        let fixture = fixture();
        let cases = fixture["clampBoundsToWorkArea"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let result = clamp_bounds_to_work_area(from(&case["bounds"]), from(&case["workArea"]));
            assert_eq!(result, from::<Rect>(&case["result"]), "{case}");
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
