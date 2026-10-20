// SPDX-License-Identifier: GPL-2.0-or-later
//! Changes of the displays (a monitor plugged in or out, a work area resized by
//! a panel). Tauri has no event for them, so the displays are compared on the
//! window's own events and on a slow poll (mod.rs): a change seen then makes
//! the window take the new work area (`Controller::work_area_changed` of
//! compact.rs).

use crate::window_state::Display;

/// The displays as last seen.
#[derive(Debug, Default)]
pub struct DisplayWatch {
    last: Option<Vec<Display>>,
}

impl DisplayWatch {
    /// Keeps `displays` as the ones last seen; whether they differ from the
    /// ones seen before. The first look is no change: the window opened
    /// fitted into the displays of then.
    pub fn changed(&mut self, displays: &[Display]) -> bool {
        let changed = self.last.as_deref().is_some_and(|last| last != displays);
        self.last = Some(displays.to_vec());
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window_bounds::Rect;

    fn display(width: f64, work_height: f64) -> Display {
        let bounds = Rect { x: 0.0, y: 0.0, width, height: 1080.0 };
        Display { bounds, work_area: Rect { height: work_height, ..bounds } }
    }

    #[test]
    fn the_first_look_is_no_change() {
        assert!(!DisplayWatch::default().changed(&[display(1920.0, 1040.0)]));
    }

    #[test]
    fn the_same_displays_are_no_change() {
        let mut watch = DisplayWatch::default();
        watch.changed(&[display(1920.0, 1040.0)]);
        assert!(!watch.changed(&[display(1920.0, 1040.0)]));
    }

    #[test]
    fn a_work_area_a_monitor_or_the_order_changing_is_a_change() {
        let mut watch = DisplayWatch::default();
        let (a, b) = (display(1920.0, 1040.0), display(1024.0, 720.0));
        watch.changed(&[a]);
        assert!(watch.changed(&[display(1920.0, 1000.0)]));
        assert!(watch.changed(&[display(1920.0, 1000.0), b]));
        assert!(watch.changed(&[b, display(1920.0, 1000.0)]));
        assert!(watch.changed(&[]));
        assert!(!watch.changed(&[]));
    }
}
