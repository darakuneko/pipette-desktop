// SPDX-License-Identifier: GPL-2.0-or-later
//! Compact mode of the Typing Test's view-only window and the minimum size
//! and bounds around it (the compact mode switch, its bounds animation, the
//! minimum size, and what a move or a change of the displays does), as
//! decisions over a [`WindowPort`]. The caller reads the window (its bounds,
//! the display they are on) and runs the animation's ticks;
//! tests/fixtures/resident/window_ops.json records the golden window calls,
//! which the tests below replay.
//!
//! Bounds are the window's outer bounds in DIP; `frame` is the outer minus
//! the content size.

use crate::window_bounds::{MIN_SIZE, Rect, Size, clamp_bounds_to_work_area, effective_min_size, js_max};
use crate::window_state::Display;

use super::geometry::{ApplyHints, Geometry, Hints, hints};

/// The minimum size while compact mode is on.
pub const COMPACT_MIN_SIZE: Size = Size { width: 300.0, height: 100.0 };

/// How long the animations into and out of compact mode take, and the time
/// between their steps.
pub const ENTER_MS: f64 = 200.0;
pub const LEAVE_MS: f64 = 300.0;
pub const STEP_MS: u64 = 16;

/// What the decisions do to the window.
pub trait WindowPort: ApplyHints {
    fn set_bounds(&self, bounds: Rect);
    fn is_destroyed(&self) -> bool;
}

/// `Math.round`: halves round up, toward +∞.
pub fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// One run of the bounds animation.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Animation {
    generation: u64,
    from: Rect,
    to: Rect,
    steps: u32,
    step: u32,
    finish: Finish,
}

/// What a completed animation does last.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Finish {
    Nothing,
    /// Leaving compact mode: the window's minimum size again, and no normal
    /// size kept.
    Leave {
        min_size: Size,
    },
}

/// After a step: more to come, or done (`completed` false when a later
/// animation or the window's end cut it short).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Tick {
    Continue,
    Done { completed: bool },
}

/// What leaving compact mode answers and whether it animates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Leave {
    /// The size before leaving, the handler's answer.
    pub size: Size,
    /// The animation to run to the end before answering.
    pub animation: Option<Animation>,
}

/// The state the handlers share for the one window.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Controller {
    pub geometry: Geometry,
    /// The size the window had before compact mode, while compact mode is
    /// on.
    normal_size: Option<Size>,
    /// Bumped by each animation that starts; an older one stops at its next
    /// step.
    generation: u64,
    /// While an animation runs, and after leaving compact mode until the
    /// next aspect ratio arrives, the window's own hints leave the aspect
    /// ratio out ([`Controller::window_hints`]).
    animating: bool,
    aspect_held: bool,
}

/// The minimum size the work area of `display` allows; the nominal one
/// without a display.
pub fn min_size_for(display: Option<&Display>) -> Size {
    display.map_or(MIN_SIZE, |display| {
        effective_min_size(display.work_area.size(), MIN_SIZE.width, MIN_SIZE.height)
    })
}

fn clamp_to(bounds: Rect, display: Option<&Display>) -> Rect {
    display.map_or(bounds, |display| clamp_bounds_to_work_area(bounds, display.work_area))
}

/// The bounds saved when the window closes: its normal size while compact
/// mode is on, at the position it is at.
pub fn bounds_to_save(bounds: Rect, normal_size: Option<Size>) -> Rect {
    match normal_size {
        Some(size) => Rect { width: size.width, height: size.height, ..bounds },
        None => bounds,
    }
}

impl Controller {
    pub fn new(min_size: Option<Size>) -> Self {
        Self { geometry: Geometry { min_size, aspect_ratio: None }, ..Self::default() }
    }

    pub fn normal_size(&self) -> Option<Size> {
        self.normal_size
    }

    /// Whether compact mode is on, so it owns the minimum size and bounds.
    pub fn in_compact_mode(&self) -> bool {
        self.normal_size.is_some()
    }

    /// The geometry hints the window gets now: those of `geometry`, without
    /// the aspect ratio while an animation runs or since compact mode was
    /// left. GTK constrains the app's own resizes to the aspect ratio
    /// (Chromium leaves it to the window manager, which applies it to the
    /// user's resizes only), so with it the animation and the size it ends
    /// at would be bent to the ratio; the renderer releases the ratio only
    /// once leaving has answered.
    pub fn window_hints(&self) -> Hints {
        let hints = hints(&self.geometry);
        if self.animating || self.aspect_held { Hints { aspect: None, ..hints } } else { hints }
    }

    /// Sets or releases the aspect ratio (`Geometry::set_aspect_ratio`); the
    /// window takes it again after leaving compact mode.
    pub fn set_aspect_ratio(&mut self, port: &dyn WindowPort, ratio: f64, frame: Size) {
        self.aspect_held = false;
        self.geometry.set_aspect_ratio(port, ratio, frame);
    }

    fn animate(&mut self, from: Rect, to: Rect, duration: f64, finish: Finish) -> Animation {
        self.animating = true;
        self.generation += 1;
        let steps = js_max(1.0, js_round(duration / STEP_MS as f64)) as u32;
        Animation { generation: self.generation, from, to, steps, step: 0, finish }
    }

    /// Enters compact mode, or resizes it when it is on already: the first
    /// time it keeps the normal size and sets the compact minimum size;
    /// a `compact_size` with a positive width and height (the content size)
    /// is animated to, centred on the window, at least the compact minimum.
    /// The caller runs the first step at once.
    pub fn enter(
        &mut self,
        port: &dyn WindowPort,
        bounds: Rect,
        frame: Size,
        compact_size: Option<Size>,
    ) -> Option<Animation> {
        if self.normal_size.is_none() {
            self.normal_size = Some(bounds.size());
            self.apply_min_size(port, COMPACT_MIN_SIZE);
        }
        let size = compact_size.filter(|size| size.width > 0.0 && size.height > 0.0)?;
        let width = js_max(size.width + frame.width, COMPACT_MIN_SIZE.width);
        let height = js_max(size.height + frame.height, COMPACT_MIN_SIZE.height);
        let to = Rect {
            x: bounds.x + js_round((bounds.width - width) / 2.0),
            y: bounds.y + js_round((bounds.height - height) / 2.0),
            width,
            height,
        };
        Some(self.animate(bounds, to, ENTER_MS, Finish::Nothing))
    }

    /// Leaves compact mode: back to the normal size (at least the minimum
    /// size of `display`, the display of `bounds`), centred and fitted into
    /// the work area, the minimum size restored when that animation
    /// completes. Without a normal size, the minimum size of `display`, and
    /// the window grown to it only when it is smaller.
    pub fn leave(&mut self, port: &dyn WindowPort, bounds: Rect, display: Option<&Display>) -> Leave {
        self.aspect_held = true;
        let size = bounds.size();
        let min_size = min_size_for(display);
        let Some(normal) = self.normal_size else {
            self.apply_min_size(port, min_size);
            if size.width < min_size.width || size.height < min_size.height {
                let grown = Rect {
                    width: js_max(size.width, min_size.width),
                    height: js_max(size.height, min_size.height),
                    ..bounds
                };
                port.set_bounds(clamp_to(grown, display));
            }
            return Leave { size, animation: None };
        };
        let width = js_max(normal.width, min_size.width);
        let height = js_max(normal.height, min_size.height);
        let target = Rect {
            x: bounds.x - js_round((width - bounds.width) / 2.0),
            y: bounds.y - js_round((height - bounds.height) / 2.0),
            width,
            height,
        };
        let animation = self.animate(bounds, clamp_to(target, display), LEAVE_MS, Finish::Leave { min_size });
        Leave { size, animation: Some(animation) }
    }

    /// One step of `animation`.
    pub fn tick(&mut self, port: &dyn WindowPort, animation: &mut Animation) -> Tick {
        if animation.generation != self.generation || port.is_destroyed() {
            return Tick::Done { completed: false };
        }
        animation.step += 1;
        let progress = f64::from(animation.step.min(animation.steps)) / f64::from(animation.steps);
        let t = 1.0 - (1.0 - progress).powi(2);
        let lerp = |a: f64, b: f64| js_round(a + (b - a) * t);
        let (from, to) = (animation.from, animation.to);
        port.set_bounds(Rect {
            x: lerp(from.x, to.x),
            y: lerp(from.y, to.y),
            width: lerp(from.width, to.width),
            height: lerp(from.height, to.height),
        });
        if animation.step < animation.steps {
            return Tick::Continue;
        }
        // After the last bounds: a close in between saves the normal size.
        if let Finish::Leave { min_size } = animation.finish {
            self.apply_min_size(port, min_size);
            self.normal_size = None;
        }
        self.animating = false;
        Tick::Done { completed: true }
    }

    fn apply_min_size(&mut self, port: &dyn WindowPort, min_size: Size) {
        if let Err(err) = self.geometry.apply_min_size_if_changed(port, min_size) {
            log::error!("[window] failed to set the minimum size: {err}");
        }
    }

    /// The minimum size the WINDOW_SET_MIN_SIZE handler applies: each side
    /// at least 1 (`Math.max`), fractions kept.
    pub fn set_min_size(&mut self, port: &dyn WindowPort, width: f64, height: f64) {
        self.apply_min_size(port, Size { width: js_max(width, 1.0), height: js_max(height, 1.0) });
    }

    /// The `display-metrics-changed` listener: unless compact mode is on or
    /// the window is maximized or full screen, the minimum size of the
    /// work area of `display` (the display of `bounds`), then the bounds
    /// fitted into it when they are not.
    pub fn work_area_changed(
        &mut self,
        port: &dyn WindowPort,
        bounds: Rect,
        display: Option<&Display>,
        maximized_or_full_screen: bool,
    ) {
        if self.in_compact_mode() || maximized_or_full_screen {
            return;
        }
        self.apply_min_size(port, min_size_for(display));
        let clamped = clamp_to(bounds, display);
        if clamped != bounds {
            port.set_bounds(clamped);
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use std::cell::{Cell, RefCell};
    use std::path::Path;

    use serde_json::{Value, json};

    use super::*;
    use crate::window_ops::geometry::{Change, Hints};
    use crate::window_ops::opacity::clamp_view_only_opacity;
    use crate::window_state::display_matching;

    pub(crate) fn fixture() -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/resident/window_ops.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn rect_of(value: &Value) -> Rect {
        let n = |key: &str| value[key].as_f64().unwrap();
        Rect { x: n("x"), y: n("y"), width: n("width"), height: n("height") }
    }

    fn size_of(value: &Value) -> Size {
        Size { width: value["width"].as_f64().unwrap(), height: value["height"].as_f64().unwrap() }
    }

    fn display_of(value: &Value) -> Display {
        Display { bounds: rect_of(&value["bounds"]), work_area: rect_of(&value["workArea"]) }
    }

    /// The harness's window: it records what is done to it at the fake
    /// clock's time.
    struct FakeWindow {
        now: Cell<u64>,
        bounds: Cell<Rect>,
        destroyed: Cell<bool>,
        calls: RefCell<Vec<Value>>,
    }

    impl FakeWindow {
        fn record(&self, call: &str, args: Value) {
            self.calls.borrow_mut().push(json!({ "t": self.now.get(), "call": call, "args": args }));
        }
    }

    /// A number as JSON writes it: integers without a fraction.
    fn num(value: f64) -> Value {
        if value.fract() == 0.0 && value.abs() < 1e15 { json!(value as i64) } else { json!(value) }
    }

    fn size_json(size: Size) -> Value {
        json!({ "width": num(size.width), "height": num(size.height) })
    }

    impl ApplyHints for FakeWindow {
        fn apply_hints(&self, _hints: Hints, change: Change) -> Result<(), String> {
            match change {
                Change::MinSize(size) => {
                    self.record("window.setMinimumSize", json!([num(size.width), num(size.height)]))
                }
                Change::AspectRatio(Some((ratio, frame))) => {
                    self.record("window.setAspectRatio", json!([num(ratio), size_json(frame)]));
                }
                Change::AspectRatio(None) => self.record("window.setAspectRatio", json!([0])),
            }
            Ok(())
        }
    }

    impl WindowPort for FakeWindow {
        fn set_bounds(&self, bounds: Rect) {
            self.record(
                "window.setBounds",
                json!([{ "x": num(bounds.x), "y": num(bounds.y), "width": num(bounds.width), "height": num(bounds.height) }]),
            );
            self.bounds.set(bounds);
        }

        fn is_destroyed(&self) -> bool {
            self.destroyed.get()
        }
    }

    /// A running animation, its next step's time, and the pending answer of
    /// the leave it belongs to.
    struct Running {
        animation: Animation,
        due: u64,
        answer: Option<Size>,
    }

    /// One scenario of the golden replayed on [`Controller`].
    struct Replay {
        window: FakeWindow,
        controller: Controller,
        displays: Vec<Display>,
        frame: Size,
        maximized: bool,
        full_screen: bool,
        listening: bool,
        running: Vec<Running>,
        /// Answers of leaves whose animation ended, by the order they ended.
        settled: Vec<Size>,
    }

    impl Replay {
        fn boot(scenario: &Value) -> Self {
            let boot = &scenario["boot"];
            let created = scenario["bootCalls"]
                .as_array()
                .unwrap()
                .iter()
                .find(|call| call["call"] == "BrowserWindow.new")
                .unwrap()["args"][0]
                .clone();
            let displays = boot["displays"].as_array().map_or_else(
                || {
                    vec![display_of(&json!({
                        "bounds": { "x": 0, "y": 0, "width": 1920, "height": 1080 },
                        "workArea": { "x": 0, "y": 0, "width": 1920, "height": 1040 },
                    }))]
                },
                |list| list.iter().map(display_of).collect(),
            );
            let min_size = Size {
                width: created["minWidth"].as_f64().unwrap(),
                height: created["minHeight"].as_f64().unwrap(),
            };
            Self {
                window: FakeWindow {
                    now: Cell::new(0),
                    bounds: Cell::new(rect_of(&created)),
                    destroyed: Cell::new(false),
                    calls: RefCell::new(Vec::new()),
                },
                controller: Controller::new(Some(min_size)),
                displays,
                frame: size_of(&boot["frame"]),
                maximized: false,
                full_screen: false,
                listening: true,
                running: Vec::new(),
                settled: Vec::new(),
            }
        }

        fn display(&self, bounds: Rect) -> Option<Display> {
            display_matching(&bounds, &self.displays).or(self.displays.first()).copied()
        }

        /// Runs the first step of `animation` now and keeps the rest.
        fn start(&mut self, mut animation: Animation, answer: Option<Size>) {
            let tick = self.controller.tick(&self.window, &mut animation);
            self.after_tick(Running { animation, due: self.window.now.get() + STEP_MS, answer }, tick);
        }

        fn after_tick(&mut self, running: Running, tick: Tick) {
            match tick {
                Tick::Continue => self.running.push(running),
                Tick::Done { .. } => self.settled.extend(running.answer),
            }
        }

        /// Lets `ms` of the fake clock pass, running the steps due meanwhile
        /// in time order.
        fn advance(&mut self, ms: u64) {
            let end = self.window.now.get() + ms;
            while let Some(index) = (0..self.running.len())
                .filter(|&i| self.running[i].due <= end)
                .min_by_key(|&i| self.running[i].due)
            {
                let mut running = self.running.remove(index);
                self.window.now.set(running.due);
                let tick = self.controller.tick(&self.window, &mut running.animation);
                running.due += STEP_MS;
                self.after_tick(running, tick);
            }
            self.window.now.set(end);
        }

        fn compact(&mut self, args: &[Value]) -> Option<Value> {
            let bounds = self.window.bounds.get();
            if args[0].as_bool().unwrap() {
                let compact_size = args.get(1).map(size_of);
                if let Some(animation) = self.controller.enter(&self.window, bounds, self.frame, compact_size)
                {
                    self.start(animation, None);
                }
                return Some(Value::Null);
            }
            let display = self.display(bounds);
            let leave = self.controller.leave(&self.window, bounds, display.as_ref());
            match leave.animation {
                None => Some(size_json(leave.size)),
                Some(animation) => {
                    self.start(animation, Some(leave.size));
                    None
                }
            }
        }

        /// Runs `action` and answers the step's `result`.
        fn run(&mut self, action: &Value) -> Value {
            let advance = action["advanceMs"].as_u64();
            if let Some(ipc) = action["ipc"].as_str() {
                let args = action["args"].as_array().unwrap();
                let undefined = json!({ "value": "undefined" });
                return match ipc {
                    "WINDOW_SET_COMPACT_MODE" => {
                        let before = self.settled.len();
                        let answer = self.compact(args);
                        self.advance(advance.unwrap());
                        match answer {
                            Some(value) => json!({ "value": value }),
                            None if self.settled.len() > before => {
                                json!({ "value": size_json(self.settled.remove(before)) })
                            }
                            None => json!({ "pending": true }),
                        }
                    }
                    "WINDOW_SET_ASPECT_RATIO" => {
                        self.controller.set_aspect_ratio(&self.window, args[0].as_f64().unwrap(), self.frame);
                        undefined
                    }
                    "WINDOW_SET_ALWAYS_ON_TOP" => {
                        self.window.record("window.setAlwaysOnTop", json!([args[0]]));
                        undefined
                    }
                    "WINDOW_SET_OPACITY" => {
                        let opacity = clamp_view_only_opacity(&args[0]);
                        self.window.record("window.setOpacity", json!([num(opacity)]));
                        undefined
                    }
                    "WINDOW_SET_MIN_SIZE" => {
                        let n = |v: &Value| v.as_f64().unwrap();
                        self.controller.set_min_size(&self.window, n(&args[0]), n(&args[1]));
                        undefined
                    }
                    other => panic!("unknown ipc {other}"),
                };
            }
            if action.get("settle").is_some() {
                let before = self.settled.len();
                self.advance(advance.unwrap());
                assert!(self.settled.len() > before, "the leave did not settle");
                return json!({ "value": size_json(self.settled.remove(before)) });
            }
            if let Some(ms) = advance {
                self.advance(ms);
                return json!({});
            }
            if let Some(state) = action.get("windowState") {
                if let Some(maximized) = state["maximized"].as_bool() {
                    self.maximized = maximized;
                }
                if let Some(full_screen) = state["fullScreen"].as_bool() {
                    self.full_screen = full_screen;
                }
                if state.get("bounds").is_some() {
                    self.window.bounds.set(rect_of(&state["bounds"]));
                }
                return Value::Null;
            }
            if let Some(list) = action.get("displayMetricsChanged") {
                self.displays = list.as_array().unwrap().iter().map(display_of).collect();
                if self.listening {
                    let bounds = self.window.bounds.get();
                    let display = self.display(bounds);
                    self.controller.work_area_changed(
                        &self.window,
                        bounds,
                        display.as_ref(),
                        self.maximized || self.full_screen,
                    );
                }
                return Value::Null;
            }
            if action.get("destroyWindow").is_some() {
                self.window.record("window.destroy", json!([]));
                self.window.destroyed.set(true);
                self.close();
                return Value::Null;
            }
            match action["windowEvent"].as_str().unwrap() {
                // The `moved` listener; main_window::update_min_size adds a
                // check of the monitor in front of it.
                "moved" if !self.controller.in_compact_mode() => {
                    let display = self.display(self.window.bounds.get());
                    self.controller.apply_min_size(&self.window, min_size_for(display.as_ref()));
                }
                "moved" => {}
                "close" => {
                    let saved = bounds_to_save(self.window.bounds.get(), self.controller.normal_size());
                    self.window.record(
                        "saveWindowState",
                        json!([{ "x": num(saved.x), "y": num(saved.y), "width": num(saved.width), "height": num(saved.height) }]),
                    );
                }
                "closed" => self.close(),
                other => panic!("unknown window event {other}"),
            }
            Value::Null
        }

        /// The window's `closed`: the screen listener goes, and so does the
        /// state of compact mode.
        fn close(&mut self) {
            self.listening = false;
            self.controller = Controller::new(None);
        }
    }

    #[test]
    fn compact_mode_and_the_window_listeners_make_the_recorded_calls() {
        let fixture = fixture();
        let scenarios = fixture["scenarios"].as_array().unwrap();
        assert_eq!(scenarios.len(), 21);
        for scenario in scenarios {
            let name = scenario["name"].as_str().unwrap();
            let mut replay = Replay::boot(scenario);
            for (index, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
                replay.window.calls.borrow_mut().clear();
                let result = replay.run(&step["action"]);
                let expected_result = step.get("result").cloned().unwrap_or(Value::Null);
                assert_eq!(result, expected_result, "{name} step {index}: the answer");
                let calls = replay.window.calls.borrow().clone();
                assert_eq!(Value::Array(calls), step["calls"], "{name} step {index}: the calls");
            }
            assert!(
                replay.running.iter().all(|running| running.answer.is_none()),
                "{name}: a leave left pending"
            );
        }
    }

    #[test]
    fn the_compact_minimum_size_is_the_recorded_one() {
        assert_eq!(COMPACT_MIN_SIZE, size_of(&fixture()["compactMinSize"]));
    }

    #[test]
    fn js_round_rounds_halves_up() {
        for (value, rounded) in [
            (0.5, 1.0),
            (-0.5, 0.0),
            (1.5, 2.0),
            (-1.5, -1.0),
            (2.4999, 2.0),
            (-2.6, -3.0),
            (12.5, 13.0),
            (18.75, 19.0),
        ] {
            assert_eq!(js_round(value), rounded, "{value}");
        }
    }

    #[test]
    fn the_saved_bounds_take_the_normal_size_in_compact_mode() {
        let bounds = Rect { x: 600.0, y: 442.0, width: 400.0, height: 157.0 };
        let normal = Size { width: 1400.0, height: 1040.0 };
        assert_eq!(
            bounds_to_save(bounds, Some(normal)),
            Rect { x: 600.0, y: 442.0, width: 1400.0, height: 1040.0 }
        );
        assert_eq!(bounds_to_save(bounds, None), bounds);
    }

    /// A window that records nothing, for the hints the window gets.
    struct Quiet;

    impl ApplyHints for Quiet {
        fn apply_hints(&self, _hints: Hints, _change: Change) -> Result<(), String> {
            Ok(())
        }
    }

    impl WindowPort for Quiet {
        fn set_bounds(&self, _bounds: Rect) {}
        fn is_destroyed(&self) -> bool {
            false
        }
    }

    fn run_to_end(controller: &mut Controller, mut animation: Animation) {
        while controller.tick(&Quiet, &mut animation) == Tick::Continue {}
    }

    const WINDOW: Rect = Rect { x: 100.0, y: 0.0, width: 1400.0, height: 1040.0 };
    const NO_FRAME: Size = Size { width: 0.0, height: 0.0 };

    #[test]
    fn the_aspect_ratio_waits_for_the_animation_into_compact_mode() {
        let mut controller = Controller::new(Some(MIN_SIZE));
        controller.set_aspect_ratio(&Quiet, 2.0, NO_FRAME);
        let animation =
            controller.enter(&Quiet, WINDOW, NO_FRAME, Some(Size { width: 400.0, height: 200.0 })).unwrap();
        assert_eq!(controller.window_hints().aspect, None);
        controller.set_aspect_ratio(&Quiet, 2.5, NO_FRAME);
        assert_eq!(controller.window_hints().aspect, None);
        run_to_end(&mut controller, animation);
        assert_eq!(controller.window_hints(), Hints { min_size: Some((300, 100)), aspect: Some(2.5) });
    }

    #[test]
    fn leaving_compact_mode_holds_the_aspect_ratio_back_until_the_next_one() {
        let mut controller = Controller::new(Some(MIN_SIZE));
        let animation =
            controller.enter(&Quiet, WINDOW, NO_FRAME, Some(Size { width: 400.0, height: 200.0 })).unwrap();
        run_to_end(&mut controller, animation);
        controller.set_aspect_ratio(&Quiet, 2.0, NO_FRAME);
        assert_eq!(controller.window_hints().aspect, Some(2.0));
        let bounds = Rect { x: 600.0, y: 420.0, width: 400.0, height: 200.0 };
        let leave = controller.leave(&Quiet, bounds, None);
        assert_eq!(controller.window_hints().aspect, None);
        run_to_end(&mut controller, leave.animation.unwrap());
        assert_eq!(controller.window_hints(), Hints { min_size: Some((1280, 1024)), aspect: None });
        assert_eq!(controller.geometry.aspect_ratio, Some(2.0));
        controller.set_aspect_ratio(&Quiet, 1.5, NO_FRAME);
        assert_eq!(controller.window_hints().aspect, Some(1.5));
    }

    #[test]
    fn a_superseded_animation_leaves_the_newer_one_holding_the_aspect_ratio() {
        let mut controller = Controller::new(Some(MIN_SIZE));
        controller.set_aspect_ratio(&Quiet, 2.0, NO_FRAME);
        let size = Some(Size { width: 400.0, height: 200.0 });
        let mut first = controller.enter(&Quiet, WINDOW, NO_FRAME, size).unwrap();
        let second = controller.enter(&Quiet, WINDOW, NO_FRAME, size).unwrap();
        assert_eq!(controller.tick(&Quiet, &mut first), Tick::Done { completed: false });
        assert_eq!(controller.window_hints().aspect, None);
        run_to_end(&mut controller, second);
        assert_eq!(controller.window_hints().aspect, Some(2.0));
    }

    /// A window that keeps the bounds it was last given.
    struct Sized(Cell<Rect>);

    impl ApplyHints for Sized {
        fn apply_hints(&self, _hints: Hints, _change: Change) -> Result<(), String> {
            Ok(())
        }
    }

    impl WindowPort for Sized {
        fn set_bounds(&self, bounds: Rect) {
            self.0.set(bounds);
        }
        fn is_destroyed(&self) -> bool {
            false
        }
    }

    fn run_on(controller: &mut Controller, window: &Sized, mut animation: Animation) {
        while controller.tick(window, &mut animation) == Tick::Continue {}
    }

    /// Enters compact mode at `size` on a macOS window with a title bar
    /// `title_bar` high, then leaves it; answers the content size compact
    /// mode had, the size the renderer saves from its viewport, with the
    /// frame the decision was given.
    fn compact_round_trip(
        controller: &mut Controller,
        window: &Sized,
        title_bar: f64,
        frame: Size,
        size: Size,
    ) -> Size {
        let animation = controller.enter(window, window.0.get(), frame, Some(size)).unwrap();
        run_on(controller, window, animation);
        let outer = window.0.get();
        let content = Size { width: outer.width, height: outer.height - title_bar };
        let leave = controller.leave(window, outer, None);
        run_on(controller, window, leave.animation.unwrap());
        content
    }

    #[test]
    fn a_saved_compact_size_comes_back_after_leaving_and_entering_again() {
        // The renderer saves the viewport after entering and enters with
        // it again (after a disconnect, the view mode restores it): with
        // the title bar as the frame, the size stays.
        const TITLE_BAR: f64 = 32.0;
        let title_bar = Size { width: 0.0, height: TITLE_BAR };
        let window = Sized(Cell::new(WINDOW));
        let mut controller = Controller::new(Some(MIN_SIZE));
        let mut size = Size { width: 310.0, height: 308.0 };
        for _ in 0..3 {
            size = compact_round_trip(&mut controller, &window, TITLE_BAR, title_bar, size);
            assert_eq!(size, Size { width: 310.0, height: 308.0 });
            assert_eq!(window.0.get().size(), WINDOW.size());
        }
        // Without it, each entry loses the title bar's height.
        let first = compact_round_trip(&mut controller, &window, TITLE_BAR, NO_FRAME, size);
        let second = compact_round_trip(&mut controller, &window, TITLE_BAR, NO_FRAME, first);
        assert_eq!((first.height, second.height), (276.0, 244.0));
    }

    #[test]
    fn the_normal_size_stays_until_the_last_step_of_leaving() {
        let mut controller = Controller::new(Some(MIN_SIZE));
        let animation =
            controller.enter(&Quiet, WINDOW, NO_FRAME, Some(Size { width: 400.0, height: 200.0 })).unwrap();
        run_to_end(&mut controller, animation);
        let mut leave = controller.leave(&Quiet, WINDOW, None).animation.unwrap();
        while controller.tick(&Quiet, &mut leave) == Tick::Continue {
            assert_eq!(controller.normal_size(), Some(WINDOW.size()));
        }
        assert_eq!(controller.normal_size(), None);
    }
}
