// SPDX-License-Identifier: GPL-2.0-or-later
//! The main window's size constraints: its minimum size and aspect ratio,
//! owned here and nowhere else.
//!
//! On Linux both are GTK geometry hints, and a window has one set of them:
//! `gtk_window_set_geometry_hints` replaces the whole set each time, so a
//! minimum size applied on its own (tao's `set_min_size`) would drop the
//! aspect ratio, and the other way round. Every change therefore goes
//! through [`Geometry`], which applies the minimum size and the aspect ratio
//! together as one set ([`Hints`]). The app sets no maximum size, so the set
//! has none, as tao's has none then.
//!
//! The aspect ratio is the ratio of the window's size less the frame (outer
//! minus content size). GTK applies the hints to the size of the GTK window, which
//! is its content size: the window manager draws its frame outside it, and
//! the webview fills it. So the ratio applies as it is, with nothing to take
//! off; GTK ignores the `geometry_widget` argument (since 3.20), so that is
//! no way to leave anything out. On X11 the window manager applies the ratio
//! to the size less the base size (ICCCM `WM_NORMAL_HINTS`), and GTK fills
//! in the minimum size as the base size when the hints give none, so a set
//! with an aspect ratio also gives a base size of 0 × 0. Windows and macOS
//! take the minimum size through tao and the aspect ratio through
//! pipette-native, the content's in both cases (native.rs).

use crate::window_bounds::Size;

/// The constraints as last applied. `min_size` is None until one is known:
/// the window's opening one is read from main_window.rs when the state is
/// first needed.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Geometry {
    pub min_size: Option<Size>,
    pub aspect_ratio: Option<f64>,
}

/// One set of geometry hints, in logical pixels: what `Geometry` applies.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hints {
    /// The minimum width and height, or None for a set without one.
    pub min_size: Option<(i32, i32)>,
    /// Both the minimum and the maximum aspect ratio (width / height), with
    /// a base size of 0 × 0.
    pub aspect: Option<f64>,
}

impl Hints {
    /// The GDK flags of the set, by name: `MIN_SIZE`, then `BASE_SIZE` and
    /// `ASPECT` together.
    #[cfg(any(test, feature = "dev-tools"))]
    pub fn mask(&self) -> Vec<&'static str> {
        let mut mask = Vec::new();
        if self.min_size.is_some() {
            mask.push("MIN_SIZE");
        }
        if self.aspect.is_some() {
            mask.extend(["BASE_SIZE", "ASPECT"]);
        }
        mask
    }
}

/// The hints for `geometry`. A minimum size becomes whole pixels (an integer
/// conversion that drops the fraction); every minimum size the app applies is at least 1.
pub fn hints(geometry: &Geometry) -> Hints {
    Hints {
        min_size: geometry.min_size.map(|size| (size.width as i32, size.height as i32)),
        aspect: geometry.aspect_ratio,
    }
}

/// What a change of the geometry was, for the window's log and its tests:
/// the hints applied are the whole set either way.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Change {
    MinSize(Size),
    /// An aspect ratio, and the frame it leaves out; None releases it.
    AspectRatio(Option<(f64, Size)>),
}

/// Where the hints go.
pub trait ApplyHints {
    fn apply_hints(&self, hints: Hints, change: Change) -> Result<(), String>;
}

impl Geometry {
    /// Applies `min_size` unless it is the one applied last. Kept as the last one
    /// only when it applied, so a failure is tried again.
    pub fn apply_min_size_if_changed(
        &mut self,
        target: &dyn ApplyHints,
        min_size: Size,
    ) -> Result<(), String> {
        if self.min_size == Some(min_size) {
            return Ok(());
        }
        let next = Geometry { min_size: Some(min_size), ..*self };
        target.apply_hints(hints(&next), Change::MinSize(min_size))?;
        *self = next;
        Ok(())
    }

    /// Sets the aspect ratio to `ratio` with `frame` left out, or releases
    /// it when `ratio <= 0`, as the WINDOW_SET_ASPECT_RATIO handler does.
    /// Applied every time, even when it does not change.
    pub fn set_aspect_ratio(&mut self, target: &dyn ApplyHints, ratio: f64, frame: Size) {
        let aspect = (ratio > 0.0).then_some((ratio, frame));
        let next = Geometry { aspect_ratio: aspect.map(|(ratio, _)| ratio), ..*self };
        match target.apply_hints(hints(&next), Change::AspectRatio(aspect)) {
            Ok(()) => *self = next,
            Err(err) => log::error!("[window] failed to set the aspect ratio: {err}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    #[derive(Default)]
    struct Recorder {
        applied: RefCell<Vec<(Hints, Change)>>,
        fail: bool,
    }

    impl ApplyHints for Recorder {
        fn apply_hints(&self, hints: Hints, change: Change) -> Result<(), String> {
            if self.fail {
                return Err("no window".into());
            }
            self.applied.borrow_mut().push((hints, change));
            Ok(())
        }
    }

    const fn size(width: f64, height: f64) -> Size {
        Size { width, height }
    }

    const NO_FRAME: Size = size(0.0, 0.0);

    fn last(recorder: &Recorder) -> Hints {
        recorder.applied.borrow().last().unwrap().0
    }

    #[test]
    fn a_minimum_size_alone_is_a_min_size_set() {
        let recorder = Recorder::default();
        let mut geometry = Geometry::default();
        geometry.apply_min_size_if_changed(&recorder, size(1280.0, 1024.0)).unwrap();
        assert_eq!(last(&recorder), Hints { min_size: Some((1280, 1024)), aspect: None });
        assert_eq!(last(&recorder).mask(), ["MIN_SIZE"]);
    }

    #[test]
    fn the_aspect_ratio_keeps_the_minimum_size_in_the_set() {
        let recorder = Recorder::default();
        let mut geometry = Geometry { min_size: Some(size(300.0, 100.0)), aspect_ratio: None };
        geometry.set_aspect_ratio(&recorder, 3.2, NO_FRAME);
        assert_eq!(last(&recorder), Hints { min_size: Some((300, 100)), aspect: Some(3.2) });
        assert_eq!(last(&recorder).mask(), ["MIN_SIZE", "BASE_SIZE", "ASPECT"]);
    }

    #[test]
    fn a_minimum_size_keeps_the_aspect_ratio_in_the_set() {
        let recorder = Recorder::default();
        let mut geometry = Geometry { min_size: Some(size(300.0, 100.0)), aspect_ratio: Some(2.5) };
        geometry.apply_min_size_if_changed(&recorder, size(1280.0, 760.0)).unwrap();
        assert_eq!(last(&recorder), Hints { min_size: Some((1280, 760)), aspect: Some(2.5) });
    }

    #[test]
    fn releasing_the_aspect_ratio_leaves_the_minimum_size() {
        let recorder = Recorder::default();
        let mut geometry = Geometry { min_size: Some(size(300.0, 100.0)), aspect_ratio: Some(2.5) };
        for ratio in [0.0, -1.0] {
            geometry.set_aspect_ratio(&recorder, ratio, size(10.0, 40.0));
            assert_eq!(last(&recorder), Hints { min_size: Some((300, 100)), aspect: None });
            assert_eq!(recorder.applied.borrow().last().unwrap().1, Change::AspectRatio(None));
        }
        assert_eq!(geometry.aspect_ratio, None);
    }

    #[test]
    fn an_aspect_ratio_before_any_minimum_size_is_an_aspect_set() {
        let recorder = Recorder::default();
        let mut geometry = Geometry::default();
        geometry.set_aspect_ratio(&recorder, 1e-9, NO_FRAME);
        assert_eq!(last(&recorder), Hints { min_size: None, aspect: Some(1e-9) });
        assert_eq!(last(&recorder).mask(), ["BASE_SIZE", "ASPECT"]);
    }

    #[test]
    fn the_same_minimum_size_is_not_applied_again_but_the_aspect_ratio_is() {
        let recorder = Recorder::default();
        let mut geometry = Geometry::default();
        geometry.apply_min_size_if_changed(&recorder, size(800.0, 600.0)).unwrap();
        geometry.apply_min_size_if_changed(&recorder, size(800.0, 600.0)).unwrap();
        geometry.set_aspect_ratio(&recorder, 1.0, NO_FRAME);
        geometry.set_aspect_ratio(&recorder, 1.0, NO_FRAME);
        let changes: Vec<Change> = recorder.applied.borrow().iter().map(|(_, change)| *change).collect();
        assert_eq!(
            changes,
            [
                Change::MinSize(size(800.0, 600.0)),
                Change::AspectRatio(Some((1.0, NO_FRAME))),
                Change::AspectRatio(Some((1.0, NO_FRAME)))
            ]
        );
    }

    #[test]
    fn fractional_minimum_sizes_drop_the_fraction() {
        let geometry = Geometry { min_size: Some(size(1.5, 2.5)), aspect_ratio: None };
        assert_eq!(hints(&geometry).min_size, Some((1, 2)));
    }

    #[test]
    fn a_failed_change_keeps_the_last_applied_set() {
        let recorder = Recorder { fail: true, ..Recorder::default() };
        let mut geometry = Geometry { min_size: Some(size(1280.0, 1024.0)), aspect_ratio: Some(2.0) };
        assert!(geometry.apply_min_size_if_changed(&recorder, size(300.0, 100.0)).is_err());
        geometry.set_aspect_ratio(&recorder, 0.0, NO_FRAME);
        assert_eq!(geometry, Geometry { min_size: Some(size(1280.0, 1024.0)), aspect_ratio: Some(2.0) });
    }
}
