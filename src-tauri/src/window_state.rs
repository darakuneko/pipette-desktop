// SPDX-License-Identifier: GPL-2.0-or-later
//! The saved `windowState` of the main window and where the window opens,
//! as `loadWindowState` / `saveWindowState` of src/main/app-config.ts and
//! `createWindow` of src/main/index.ts decide them. Pure functions over
//! device-independent pixels (DIP); main_window.rs converts the monitors and
//! the window from Tauri's physical pixels.
//!
//! `windowState` is `{x, y, width, height}`. `x` and `y` both -1 is the
//! marker of a state with no position: the window then opens centered.

use pipette_app_config::{Object, Value};

use crate::window_bounds::{MIN_SIZE, Rect, Size, clamp_bounds_to_work_area, effective_min_size, js_max};

/// The state of a window that never saved one (`DEFAULT_STATE` of
/// src/main/app-config.ts): no position, and wider than the minimum, as the
/// keymap editor of a full-size keyboard needs.
pub const DEFAULT_STATE: Rect = Rect { x: -1.0, y: -1.0, width: 1440.0, height: MIN_SIZE.height };

/// A monitor in DIP.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Display {
    pub bounds: Rect,
    pub work_area: Rect,
}

/// The rectangle of `x, y, width, height` physical pixels at `scale`, in DIP.
pub fn to_dip(x: f64, y: f64, width: f64, height: f64, scale: f64) -> Rect {
    Rect { x: x / scale, y: y / scale, width: width / scale, height: height / scale }
}

pub fn has_saved_position(state: &Rect) -> bool {
    state.x != -1.0 || state.y != -1.0
}

/// The stored `windowState` when it is an object whose four fields are
/// numbers, whatever else it holds.
fn stored_rect(stored: Option<&Value>) -> Option<Rect> {
    let object = stored?.as_object()?;
    let number = |key: &str| match object.get(key) {
        Some(Value::Number(n)) => Some(*n),
        _ => None,
    };
    Some(Rect { x: number("x")?, y: number("y")?, width: number("width")?, height: number("height")? })
}

/// `loadWindowState()`: the stored state grown to the minimum size, or
/// [`DEFAULT_STATE`] when there is none, it is malformed, or its center is on
/// none of `displays` (the displays' full bounds).
pub fn load_window_state(stored: Option<&Value>, displays: &[Rect]) -> Rect {
    let Some(state) = stored_rect(stored) else {
        return DEFAULT_STATE;
    };
    let state = Rect {
        width: js_max(state.width, MIN_SIZE.width),
        height: js_max(state.height, MIN_SIZE.height),
        ..state
    };
    let (center_x, center_y) = (state.x + state.width / 2.0, state.y + state.height / 2.0);
    let visible = displays.iter().any(|display| {
        center_x >= display.x
            && center_x < display.x + display.width
            && center_y >= display.y
            && center_y < display.y + display.height
    });
    if visible { state } else { DEFAULT_STATE }
}

/// How the window opens.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    /// The size, and the position when `positioned`.
    pub bounds: Rect,
    /// False: the window opens centered and `bounds.x` / `bounds.y` mean
    /// nothing.
    pub positioned: bool,
    pub min_size: Size,
}

/// `createWindow`'s placement of `saved` (a [`load_window_state`] result):
/// a saved position picks the display it overlaps most, otherwise the
/// primary one (`primary`, an index into `displays`, or the first display);
/// the minimum size shrinks to that display's work area and the window is
/// fitted into it. With no display known, `saved` as it is.
pub fn place(saved: Rect, displays: &[Display], primary: Option<usize>) -> Placement {
    let positioned = has_saved_position(&saved);
    let display = if positioned {
        display_matching(&saved, displays).or_else(|| primary_display(displays, primary))
    } else {
        primary_display(displays, primary)
    };
    let Some(display) = display else {
        return Placement { bounds: saved, positioned, min_size: MIN_SIZE };
    };
    let work_area = display.work_area;
    let to_clamp = if positioned { saved } else { Rect { x: work_area.x, y: work_area.y, ..saved } };
    Placement {
        bounds: clamp_bounds_to_work_area(to_clamp, work_area),
        positioned,
        min_size: effective_min_size(work_area.size(), MIN_SIZE.width, MIN_SIZE.height),
    }
}

fn primary_display(displays: &[Display], primary: Option<usize>) -> Option<&Display> {
    primary.and_then(|index| displays.get(index)).or_else(|| displays.first())
}

/// `screen.getDisplayMatching(rect)`: the first display with the largest
/// area in common with `rect`, if any has some.
pub fn display_matching<'a>(rect: &Rect, displays: &'a [Display]) -> Option<&'a Display> {
    let mut best: Option<(&Display, f64)> = None;
    for display in displays {
        let area = intersection_area(rect, &display.bounds);
        if area > 0.0 && best.is_none_or(|(_, best_area)| area > best_area) {
            best = Some((display, area));
        }
    }
    best.map(|(display, _)| display)
}

fn intersection_area(a: &Rect, b: &Rect) -> f64 {
    let width = (a.x + a.width).min(b.x + b.width) - a.x.max(b.x);
    let height = (a.y + a.height).min(b.y + b.height) - a.y.max(b.y);
    if width > 0.0 && height > 0.0 { width * height } else { 0.0 }
}

/// The state to save for a window at `current` (DIP), rounded to whole
/// pixels as Electron's bounds are. Without a known position (Wayland, where
/// a window cannot read its position), the position of `previous`, the
/// stored state, is kept, or the no-position marker when there is none.
pub fn state_to_save(current: Rect, position_known: bool, previous: Option<&Value>) -> Rect {
    let (x, y) = if position_known {
        (current.x.round(), current.y.round())
    } else {
        stored_rect(previous).map_or((DEFAULT_STATE.x, DEFAULT_STATE.y), |state| (state.x, state.y))
    };
    Rect { x, y, width: current.width.round(), height: current.height.round() }
}

/// `{x, y, width, height}`, the stored form.
pub fn to_value(state: Rect) -> Value {
    let mut object = Object::new();
    object.insert("x", Value::Number(state.x));
    object.insert("y", Value::Number(state.y));
    object.insert("width", Value::Number(state.width));
    object.insert("height", Value::Number(state.height));
    Value::Object(object)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window_bounds::tests::{fixture, rect, rect_of};

    fn display(bounds: Rect, work_area: Rect) -> Display {
        Display { bounds, work_area }
    }

    fn parse(text: &str) -> Value {
        pipette_js_json::parse(text).unwrap()
    }

    #[test]
    fn load_window_state_matches_the_typescript_table() {
        let fixture = fixture();
        let cases = fixture["loadWindowState"].as_array().unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let stored = case["stored"].as_str().map(parse);
            let displays: Vec<Rect> = case["displays"].as_array().unwrap().iter().map(rect_of).collect();
            let expected = rect_of(&case["result"]);
            assert_eq!(load_window_state(stored.as_ref(), &displays), expected, "{case}");
        }
    }

    #[test]
    fn the_default_state_is_the_one_load_window_state_falls_back_to() {
        let fixture = fixture();
        let missing = &fixture["loadWindowState"][0];
        assert!(missing["stored"].is_null());
        let expected = rect_of(&missing["result"]);
        assert_eq!(DEFAULT_STATE, expected);
    }

    #[test]
    fn has_saved_position_is_false_only_for_the_marker() {
        assert!(!has_saved_position(&DEFAULT_STATE));
        assert!(has_saved_position(&rect(-1.0, 0.0, 1.0, 1.0)));
        assert!(has_saved_position(&rect(0.0, -1.0, 1.0, 1.0)));
        assert!(has_saved_position(&rect(-1920.0, -1080.0, 1.0, 1.0)));
    }

    const PRIMARY: Rect = rect(0.0, 0.0, 1920.0, 1080.0);
    const PRIMARY_WORK: Rect = rect(0.0, 0.0, 1920.0, 1040.0);
    const LEFT: Rect = rect(-1440.0, 0.0, 1440.0, 900.0);
    const LEFT_WORK: Rect = rect(-1440.0, 25.0, 1440.0, 875.0);

    fn two_displays() -> Vec<Display> {
        vec![display(LEFT, LEFT_WORK), display(PRIMARY, PRIMARY_WORK)]
    }

    #[test]
    fn a_window_without_a_position_opens_centered_on_the_primary_display() {
        let placement = place(DEFAULT_STATE, &two_displays(), Some(1));
        assert_eq!(
            placement,
            Placement {
                bounds: rect(0.0, 0.0, 1440.0, 1024.0),
                positioned: false,
                min_size: Size { width: 1280.0, height: 1024.0 },
            }
        );
    }

    #[test]
    fn without_a_primary_display_the_first_one_is_used() {
        let placement = place(DEFAULT_STATE, &two_displays(), None);
        assert_eq!(placement.bounds, rect(-1440.0, 25.0, 1440.0, 875.0));
        assert_eq!(placement.min_size, Size { width: 1280.0, height: 875.0 });
    }

    #[test]
    fn a_saved_position_opens_on_the_display_it_overlaps_most() {
        // Mostly on the smaller display on the left: the size shrinks to its
        // work area, and so does the minimum height.
        let placement = place(rect(-1200.0, 100.0, 1440.0, 1024.0), &two_displays(), Some(1));
        assert_eq!(
            placement,
            Placement {
                bounds: rect(-1440.0, 25.0, 1440.0, 875.0),
                positioned: true,
                min_size: Size { width: 1280.0, height: 875.0 },
            }
        );
        let placement = place(rect(-200.0, 10.0, 1300.0, 1024.0), &two_displays(), Some(1));
        assert_eq!(placement.bounds, rect(0.0, 10.0, 1300.0, 1024.0));
        assert_eq!(placement.min_size, Size { width: 1280.0, height: 1024.0 });
    }

    #[test]
    fn a_saved_position_on_no_display_falls_back_to_the_primary_one() {
        let placement = place(rect(5000.0, 5000.0, 1300.0, 1024.0), &two_displays(), Some(1));
        assert_eq!(placement.bounds, rect(620.0, 16.0, 1300.0, 1024.0));
        assert!(placement.positioned);
    }

    #[test]
    fn with_no_display_known_the_saved_state_is_used_as_it_is() {
        let saved = rect(10.0, 20.0, 1500.0, 1100.0);
        assert_eq!(
            place(saved, &[], None),
            Placement { bounds: saved, positioned: true, min_size: MIN_SIZE }
        );
    }

    #[test]
    fn display_matching_takes_the_first_of_equal_overlaps() {
        let displays = [display(LEFT, LEFT_WORK), display(rect(0.0, 0.0, 1440.0, 900.0), PRIMARY_WORK)];
        let straddling = rect(-100.0, 0.0, 200.0, 100.0);
        assert_eq!(display_matching(&straddling, &displays), Some(&displays[0]));
        assert_eq!(display_matching(&rect(5000.0, 0.0, 10.0, 10.0), &displays), None);
        // Touching edges have no area in common.
        assert_eq!(display_matching(&rect(-10.0, 900.0, 20.0, 10.0), &displays), None);
    }

    #[test]
    fn to_dip_divides_by_the_scale() {
        assert_eq!(to_dip(3840.0, -200.0, 2560.0, 1440.0, 2.0), rect(1920.0, -100.0, 1280.0, 720.0));
        assert_eq!(to_dip(1000.0, 500.0, 1600.0, 1280.0, 1.25), rect(800.0, 400.0, 1280.0, 1024.0));
    }

    #[test]
    fn the_saved_state_is_rounded_to_whole_pixels() {
        let saved = state_to_save(rect(800.8, -0.4, 1280.4, 1023.6), true, None);
        assert_eq!(saved, rect(801.0, -0.0, 1280.0, 1024.0));
        assert_eq!(
            pipette_js_json::stringify(&to_value(saved)),
            r#"{"x":801,"y":0,"width":1280,"height":1024}"#
        );
    }

    #[test]
    fn without_a_known_position_the_stored_one_is_kept() {
        let current = rect(0.0, 0.0, 1500.0, 1100.0);
        let previous = parse(r#"{"x":-1500,"y":300,"width":1400,"height":1050}"#);
        assert_eq!(state_to_save(current, false, Some(&previous)), rect(-1500.0, 300.0, 1500.0, 1100.0));
        for previous in [None, Some(parse("null")), Some(parse(r#"{"x":"1","y":2,"width":3,"height":4}"#))] {
            assert_eq!(state_to_save(current, false, previous.as_ref()), rect(-1.0, -1.0, 1500.0, 1100.0));
        }
    }

    #[test]
    fn the_stored_form_is_the_electron_one() {
        assert_eq!(
            pipette_js_json::stringify(&to_value(DEFAULT_STATE)),
            r#"{"x":-1,"y":-1,"width":1440,"height":1024}"#
        );
    }
}
