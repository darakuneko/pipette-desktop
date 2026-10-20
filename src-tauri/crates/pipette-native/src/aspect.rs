// SPDX-License-Identifier: GPL-2.0-or-later
//! The size a window takes while the user drags one of its edges with an
//! aspect ratio set, computed as Chromium's
//! `SizeRectToAspectRatioWithExcludedMargin` computes it, for every
//! `WM_SIZING` on Windows. The ratio is the one of the window less the excluded
//! margin; the dragged edge leads and the opposite edges stay where they
//! are.

/// The edge or corner being dragged (`WMSZ_*`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Edge {
    Left,
    Right,
    Top,
    TopLeft,
    TopRight,
    Bottom,
    BottomLeft,
    BottomRight,
}

impl Edge {
    /// The edge of a `WM_SIZING` `wParam`; None for anything else.
    pub(crate) fn from_wmsz(value: usize) -> Option<Self> {
        Some(match value {
            1 => Self::Left,
            2 => Self::Right,
            3 => Self::Top,
            4 => Self::TopLeft,
            5 => Self::TopRight,
            6 => Self::Bottom,
            7 => Self::BottomLeft,
            8 => Self::BottomRight,
            _ => return None,
        })
    }
}

/// A window rectangle in physical pixels, as a Win32 `RECT`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Bounds {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// A width and a height in physical pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Extent {
    pub width: i32,
    pub height: i32,
}

/// `bounds` resized for a drag of `edge` so that the window less `margin`
/// (the frame) has `ratio` (width / height), at most `max_size` and at least
/// `min_size` (the window's maximum and minimum sizes, frame included; zero
/// for none; the minimum wins where they disagree) without leaving the
/// ratio. Dragging the left or right edge sets the height from the width;
/// any other edge or a corner sets the width from the height.
pub(crate) fn fit(
    edge: Edge,
    ratio: f32,
    min_size: Extent,
    max_size: Extent,
    margin: Extent,
    bounds: Bounds,
) -> Bounds {
    let content = |outer: i32, margin: i32| outer.saturating_sub(margin).max(0) as f32;
    let mut width = content(bounds.right.saturating_sub(bounds.left), margin.width);
    let mut height = content(bounds.bottom.saturating_sub(bounds.top), margin.height);
    let min_width = content(min_size.width, margin.width);
    let min_height = content(min_size.height, margin.height);
    if matches!(edge, Edge::Left | Edge::Right) {
        height = (width / ratio).round();
    } else {
        width = (height * ratio).round();
    }
    let max_width = content(max_size.width, margin.width);
    let max_height = content(max_size.height, margin.height);
    if max_size.width > 0 && width > max_width {
        width = max_width;
        height = (width / ratio).round();
    }
    if max_size.height > 0 && height > max_height {
        height = max_height;
        width = (height * ratio).round();
    }
    if width < min_width {
        width = min_width;
        height = (width / ratio).round();
    }
    if height < min_height {
        height = min_height;
        width = (height * ratio).round();
    }
    // `as` saturates at the ends of i32.
    let width = (width as i32).saturating_add(margin.width);
    let height = (height as i32).saturating_add(margin.height);
    let (left, top) = match edge {
        Edge::Right | Edge::Bottom | Edge::BottomRight => (bounds.left, bounds.top),
        Edge::Top | Edge::TopRight => (bounds.left, bounds.bottom.saturating_sub(height)),
        Edge::Left | Edge::BottomLeft => (bounds.right.saturating_sub(width), bounds.top),
        Edge::TopLeft => (bounds.right.saturating_sub(width), bounds.bottom.saturating_sub(height)),
    };
    Bounds { left, top, right: left.saturating_add(width), bottom: top.saturating_add(height) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: Extent = Extent { width: 0, height: 0 };
    /// A Windows 11 frame at 100 %: the invisible borders and the title bar.
    const FRAME: Extent = Extent { width: 16, height: 39 };

    fn bounds(left: i32, top: i32, width: i32, height: i32) -> Bounds {
        Bounds { left, top, right: left + width, bottom: top + height }
    }

    #[test]
    fn the_sides_set_the_height_and_the_rest_the_width() {
        let start = bounds(100, 50, 800, 300);
        assert_eq!(fit(Edge::Right, 2.0, NONE, NONE, NONE, start), bounds(100, 50, 800, 400));
        assert_eq!(fit(Edge::Left, 2.0, NONE, NONE, NONE, start), bounds(100, 50, 800, 400));
        assert_eq!(fit(Edge::Bottom, 2.0, NONE, NONE, NONE, start), bounds(100, 50, 600, 300));
        assert_eq!(fit(Edge::BottomRight, 2.0, NONE, NONE, NONE, start), bounds(100, 50, 600, 300));
    }

    #[test]
    fn the_edges_opposite_the_drag_stay() {
        let start = bounds(100, 50, 800, 300);
        let right = 900;
        let bottom = 350;
        assert_eq!(
            fit(Edge::Top, 2.0, NONE, NONE, NONE, start),
            Bounds { left: 100, top: 50, right: 700, bottom }
        );
        assert_eq!(
            fit(Edge::TopRight, 2.0, NONE, NONE, NONE, start),
            Bounds { left: 100, top: 50, right: 700, bottom }
        );
        assert_eq!(
            fit(Edge::Left, 2.0, NONE, NONE, NONE, start),
            Bounds { left: 100, top: 50, right, bottom: 450 }
        );
        assert_eq!(
            fit(Edge::BottomLeft, 2.0, NONE, NONE, NONE, start),
            Bounds { left: 300, top: 50, right, bottom }
        );
        assert_eq!(
            fit(Edge::TopLeft, 2.0, NONE, NONE, NONE, start),
            Bounds { left: 300, top: 50, right, bottom }
        );
        assert_eq!(fit(Edge::Top, 1.0, NONE, NONE, NONE, bounds(0, 0, 100, 300)), bounds(0, 0, 300, 300));
        assert_eq!(
            fit(Edge::TopLeft, 3.0, NONE, NONE, NONE, bounds(0, 0, 100, 100)),
            Bounds { left: -200, top: 0, right: 100, bottom: 100 }
        );
    }

    #[test]
    fn the_ratio_is_the_one_of_the_window_less_the_margin() {
        let fitted = fit(Edge::Right, 2.0, NONE, NONE, FRAME, bounds(0, 0, 816, 100));
        assert_eq!(fitted, bounds(0, 0, 816, 439));
        let fitted = fit(Edge::Bottom, 2.5, NONE, NONE, FRAME, bounds(0, 0, 100, 239));
        assert_eq!(fitted, bounds(0, 0, 516, 239));
    }

    #[test]
    fn the_minimum_size_grows_both_sides() {
        let min = Extent { width: 316, height: 139 };
        let fitted = fit(Edge::Right, 2.0, min, NONE, FRAME, bounds(0, 0, 116, 500));
        assert_eq!(fitted, bounds(0, 0, 316, 189));
        let fitted = fit(Edge::Bottom, 4.0, min, NONE, FRAME, bounds(0, 0, 900, 60));
        assert_eq!(fitted, bounds(0, 0, 416, 139));
    }

    #[test]
    fn the_maximum_size_shrinks_both_sides_and_the_minimum_wins() {
        let max = Extent { width: 616, height: 339 };
        let fitted = fit(Edge::Right, 2.0, NONE, max, FRAME, bounds(0, 0, 1016, 100));
        assert_eq!(fitted, bounds(0, 0, 616, 339));
        let fitted = fit(Edge::Bottom, 1.0, NONE, max, FRAME, bounds(0, 0, 100, 539));
        assert_eq!(fitted, bounds(0, 0, 316, 339));
        let fitted = fit(Edge::TopLeft, 2.0, NONE, max, FRAME, bounds(0, 0, 100, 539));
        assert_eq!(fitted, Bounds { left: -516, top: 200, right: 100, bottom: 539 });
        let min = Extent { width: 816, height: 139 };
        let fitted = fit(Edge::Right, 2.0, min, max, FRAME, bounds(0, 0, 1016, 100));
        assert_eq!(fitted, bounds(0, 0, 816, 439));
    }

    #[test]
    fn halves_round_away_from_zero() {
        assert_eq!(fit(Edge::Right, 2.0, NONE, NONE, NONE, bounds(0, 0, 5, 1)), bounds(0, 0, 5, 3));
        assert_eq!(fit(Edge::Bottom, 2.5, NONE, NONE, NONE, bounds(0, 0, 1, 3)), bounds(0, 0, 8, 3));
    }

    #[test]
    fn a_window_smaller_than_its_margin_is_its_margin() {
        assert_eq!(fit(Edge::Right, 2.0, NONE, NONE, FRAME, bounds(10, 10, 4, 4)), bounds(10, 10, 16, 39));
    }

    #[test]
    fn extreme_sizes_saturate() {
        let fitted = fit(Edge::Right, 1e-30, NONE, NONE, NONE, bounds(0, 0, i32::MAX, 1));
        assert_eq!(fitted.bottom, i32::MAX);
        let fitted = fit(Edge::TopLeft, 1e30, NONE, NONE, NONE, bounds(0, 0, 1, 10));
        assert_eq!(fitted.left, i32::MIN + 2);
    }

    #[test]
    fn the_wmsz_values_are_the_edges() {
        let edges: Vec<_> = (0..=9).map(Edge::from_wmsz).collect();
        assert_eq!(edges[0], None);
        assert_eq!(edges[1], Some(Edge::Left));
        assert_eq!(edges[4], Some(Edge::TopLeft));
        assert_eq!(edges[8], Some(Edge::BottomRight));
        assert_eq!(edges[9], None);
    }
}
