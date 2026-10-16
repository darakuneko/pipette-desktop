// SPDX-License-Identifier: GPL-2.0-or-later
//! The finger, hand and row of each key estimated from its KLE geometry
//! (`buildErgonomicsByPos` and the helpers it uses, src/shared/kle/
//! kle-ergonomics.ts): keys clustered into rows by their center height,
//! the hands split at a center gap or at the middle of the home row, and
//! the fingers counted from the middle of each hand.
//!
//! The sorts are stable and compare as JavaScript's numeric comparators
//! do (a NaN difference compares equal), so the clusters come out in the
//! same order.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use pipette_js_json::Value;

use crate::bigram_aggregate::js_number;

/// A key's geometry and matrix position (`KleKey`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KleKey {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub row: f64,
    pub col: f64,
}

impl KleKey {
    /// The key a layout's JSON holds; a field that is not a number reads as
    /// NaN. The app's snapshots hold numbers (they come from the KLE
    /// parser), so the JavaScript coercions of other values (a string's
    /// concatenation, `undefined === undefined`) are not reproduced.
    pub fn from_value(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let number = |key: &str| match object.get(key) {
            Some(Value::Number(n)) => *n,
            _ => f64::NAN,
        };
        Some(Self {
            x: number("x"),
            y: number("y"),
            width: number("width"),
            height: number("height"),
            row: number("row"),
            col: number("col"),
        })
    }

    fn center_x(&self) -> f64 {
        self.x + self.width / 2.0
    }

    fn center_y(&self) -> f64 {
        self.y + self.height / 2.0
    }

    fn same_position(&self, other: &Self) -> bool {
        self.row == other.row && self.col == other.col
    }
}

/// `posKey(row, col)` (src/shared/kle/pos-key.ts).
pub fn pos_key(row: f64, col: f64) -> String {
    format!("{},{}", js_number(row), js_number(col))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hand {
    Left,
    Right,
}

impl Hand {
    pub fn name(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
        }
    }
}

/// `FingerType`, in `FINGER_LIST` order.
pub const FINGERS: [&str; 10] = [
    "left-pinky",
    "left-ring",
    "left-middle",
    "left-index",
    "left-thumb",
    "right-thumb",
    "right-index",
    "right-middle",
    "right-ring",
    "right-pinky",
];

/// `HAND_OF_FINGER`, for a name of [`FINGERS`].
pub fn hand_of_finger(finger: &str) -> Hand {
    if finger.starts_with("left-") { Hand::Left } else { Hand::Right }
}

/// The estimate of one key; each part is absent when the geometry does
/// not decide it (`ErgonomicsMeta`). Fingers and rows are their names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ergonomics {
    pub finger: Option<String>,
    pub hand: Hand,
    pub row: Option<&'static str>,
}

const ROW_CLUSTER_Y_THRESHOLD: f64 = 0.5;
const SPLIT_GAP_MIN_UNITS: f64 = 1.5;
const SPLIT_GAP_RATIO: f64 = 1.5;

/// `a - b` as a sort comparator: NaN compares equal.
fn by(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

/// `clusterRowsByY`: rows top to bottom, each left to right.
fn cluster_rows_by_y(keys: &[KleKey]) -> Vec<Vec<KleKey>> {
    let mut sorted = keys.to_vec();
    sorted.sort_by(|a, b| by(a.center_y(), b.center_y()));
    let mut clusters: Vec<Vec<KleKey>> = Vec::new();
    for key in sorted {
        match clusters.last_mut() {
            Some(prev)
                if prev
                    .last()
                    .is_some_and(|last| key.center_y() - last.center_y() < ROW_CLUSTER_Y_THRESHOLD) =>
            {
                prev.push(key);
            }
            _ => clusters.push(vec![key]),
        }
    }
    for cluster in &mut clusters {
        cluster.sort_by(|a, b| by(a.center_x(), b.center_x()));
    }
    clusters
}

/// `detectSplitGap`: the middle of the widest gap between key centers
/// when it is at least 1.5 units and 1.5 times the next widest.
fn detect_split_mid_x(keys: &[KleKey]) -> Option<f64> {
    if keys.len() < 2 {
        return None;
    }
    let mut xs: Vec<f64> = keys.iter().map(KleKey::center_x).collect();
    xs.sort_by(|a, b| by(*a, *b));
    let (mut max_gap, mut mid_x) = (0.0, 0.0);
    let mut gaps = Vec::with_capacity(xs.len() - 1);
    for pair in xs.windows(2) {
        let gap = pair[1] - pair[0];
        gaps.push(gap);
        if gap > max_gap {
            max_gap = gap;
            mid_x = (pair[1] + pair[0]) / 2.0;
        }
    }
    if gaps.len() < 2 {
        return None;
    }
    gaps.sort_by(|a, b| by(*b, *a));
    let second = gaps[1];
    (max_gap >= SPLIT_GAP_MIN_UNITS && max_gap > second * SPLIT_GAP_RATIO).then_some(mid_x)
}

/// `computeHandMidX`: between the two middle keys of the home row (the
/// third row from the bottom), else the middle of the key centers.
fn hand_mid_x(clusters: &[Vec<KleKey>], keys: &[KleKey]) -> f64 {
    if let Some(home) = clusters.len().checked_sub(3).map(|i| &clusters[i])
        && home.len() >= 2
    {
        let mut sorted = home.clone();
        sorted.sort_by(|a, b| by(a.center_x(), b.center_x()));
        let mid = sorted.len() / 2;
        return (sorted[mid - 1].center_x() + sorted[mid].center_x()) / 2.0;
    }
    let (mut min_x, mut max_x) = (f64::INFINITY, f64::NEG_INFINITY);
    for key in keys {
        let cx = key.center_x();
        if cx < min_x {
            min_x = cx;
        }
        if cx > max_x {
            max_x = cx;
        }
    }
    (min_x + max_x) / 2.0
}

/// `rowCategoryForIndex`.
fn row_category(index: usize, total: usize) -> Option<&'static str> {
    const ABOVE_THUMB: [&str; 5] = ["bottom", "home", "top", "number", "function"];
    let bottom = total - 1;
    if index == bottom { Some("thumb") } else { ABOVE_THUMB.get(bottom - index - 1).copied() }
}

/// The geometry every key's estimate shares (`ErgonomicsContext`).
struct Context {
    clusters: Vec<Vec<KleKey>>,
    thumbs: HashSet<String>,
    hand_mid_x: f64,
}

impl Context {
    fn new(keys: &[KleKey]) -> Option<Self> {
        if keys.is_empty() {
            return None;
        }
        let split_mid_x = detect_split_mid_x(keys);
        let clusters = cluster_rows_by_y(keys);
        // `detectThumbSet`: the bottom row, when there are two or more.
        let thumbs = match clusters.as_slice() {
            [_, .., bottom] => bottom.iter().map(|k| pos_key(k.row, k.col)).collect(),
            _ => HashSet::new(),
        };
        let hand_mid_x = split_mid_x.unwrap_or_else(|| hand_mid_x(&clusters, keys));
        Some(Self { clusters, thumbs, hand_mid_x })
    }

    fn cluster_of(&self, key: &KleKey) -> Option<(usize, &Vec<KleKey>)> {
        self.clusters.iter().enumerate().find(|(_, row)| row.iter().any(|k| k.same_position(key)))
    }

    /// `estimateFingerFromXY`.
    fn finger(&self, key: &KleKey, hand: Hand) -> Option<String> {
        if self.thumbs.contains(&pos_key(key.row, key.col)) {
            return Some(format!("{}-thumb", hand.name()));
        }
        let (_, row) = self.cluster_of(key)?;
        let hand_keys: Vec<&KleKey> = row
            .iter()
            .filter(|k| {
                let cx = k.center_x();
                let same_hand = match hand {
                    Hand::Left => cx <= self.hand_mid_x,
                    Hand::Right => cx > self.hand_mid_x,
                };
                same_hand && !self.thumbs.contains(&pos_key(k.row, k.col))
            })
            .collect();
        let index = hand_keys.iter().position(|k| k.same_position(key))?;
        let distance = match hand {
            Hand::Left => hand_keys.len() - 1 - index,
            Hand::Right => index,
        };
        let role = match distance {
            0 | 1 => "index",
            2 => "middle",
            3 => "ring",
            _ => "pinky",
        };
        Some(format!("{}-{role}", hand.name()))
    }

    /// `estimateErgonomicsWithContext`.
    fn estimate(&self, key: &KleKey) -> Ergonomics {
        let hand = if key.center_x() <= self.hand_mid_x { Hand::Left } else { Hand::Right };
        let row = if self.clusters.len() < 2 {
            None
        } else {
            self.cluster_of(key).and_then(|(index, _)| row_category(index, self.clusters.len()))
        };
        Ergonomics { finger: self.finger(key, hand), hand, row }
    }
}

/// `buildErgonomicsByPos`: the estimate of every key by `posKey`; a later
/// key at the same position replaces an earlier one. Empty without keys.
pub fn ergonomics_by_pos(keys: &[KleKey]) -> HashMap<String, Ergonomics> {
    let Some(context) = Context::new(keys) else { return HashMap::new() };
    keys.iter().map(|key| (pos_key(key.row, key.col), context.estimate(key))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The keys of KLE rows as the KLE parser places them: each row one
    /// unit down, each key after the previous one plus its `gap`.
    fn kle(rows: &[&[(f64, f64)]]) -> Vec<KleKey> {
        let mut keys = Vec::new();
        for (r, row) in rows.iter().enumerate() {
            let mut x = 0.0;
            for (c, &(gap, width)) in row.iter().enumerate() {
                x += gap;
                keys.push(KleKey { x, y: r as f64, width, height: 1.0, row: r as f64, col: c as f64 });
                x += width;
            }
        }
        keys
    }

    fn units(n: usize) -> Vec<(f64, f64)> {
        vec![(0.0, 1.0); n]
    }

    /// The ANSI 60% layout of the TypeScript tests: 14 + 14 + 13 + 12 + 8
    /// keys.
    fn ansi60() -> Vec<KleKey> {
        let row0 = [units(13), vec![(0.0, 2.0)]].concat();
        let row1 = [vec![(0.0, 1.5)], units(12), vec![(0.0, 1.5)]].concat();
        let row2 = [vec![(0.0, 1.75)], units(11), vec![(0.0, 2.25)]].concat();
        let row3 = [vec![(0.0, 2.25)], units(10), vec![(0.0, 2.75)]].concat();
        let row4 = [vec![(0.0, 1.25); 3], vec![(0.0, 6.25)], vec![(0.0, 1.25); 4]].concat();
        kle(&[&row0, &row1, &row2, &row3, &row4])
    }

    fn split() -> Vec<KleKey> {
        let half = [units(6), vec![(3.0, 1.0)], units(5)].concat();
        let thumbs = [(3.0, 1.0), (0.0, 1.0), (5.0, 1.0), (0.0, 1.0)];
        kle(&[&half, &half, &thumbs])
    }

    #[test]
    fn classifies_the_ansi_60_keys() {
        let keys = ansi60();
        let by_pos = ergonomics_by_pos(&keys);
        assert_eq!(by_pos.len(), keys.len());
        let cases = [
            ((1, 1), "left-pinky", Hand::Left, "top"),
            ((1, 2), "left-ring", Hand::Left, "top"),
            ((1, 3), "left-middle", Hand::Left, "top"),
            ((1, 4), "left-index", Hand::Left, "top"),
            ((1, 5), "left-index", Hand::Left, "top"),
            ((1, 6), "right-index", Hand::Right, "top"),
            ((1, 7), "right-index", Hand::Right, "top"),
            ((1, 8), "right-middle", Hand::Right, "top"),
            ((1, 9), "right-ring", Hand::Right, "top"),
            ((1, 10), "right-pinky", Hand::Right, "top"),
            ((2, 1), "left-pinky", Hand::Left, "home"),
            ((2, 4), "left-index", Hand::Left, "home"),
            ((2, 5), "left-index", Hand::Left, "home"),
            ((2, 6), "right-index", Hand::Right, "home"),
            ((2, 8), "right-middle", Hand::Right, "home"),
            ((3, 1), "left-pinky", Hand::Left, "bottom"),
            ((3, 5), "left-index", Hand::Left, "bottom"),
            ((3, 6), "right-index", Hand::Right, "bottom"),
            ((4, 0), "left-thumb", Hand::Left, "thumb"),
            ((4, 2), "left-thumb", Hand::Left, "thumb"),
            ((4, 3), "right-thumb", Hand::Right, "thumb"),
            ((4, 4), "right-thumb", Hand::Right, "thumb"),
        ];
        for ((row, col), finger, hand, category) in cases {
            let meta = &by_pos[&format!("{row},{col}")];
            assert_eq!(
                meta,
                &Ergonomics { finger: Some(finger.into()), hand, row: Some(category) },
                "{row},{col}"
            );
        }
        assert_eq!(by_pos["0,0"].row, Some("number"));
    }

    #[test]
    fn splits_the_hands_at_a_center_gap() {
        let keys = split();
        assert_eq!(detect_split_mid_x(&keys), Some(7.5));
        assert_eq!(detect_split_mid_x(&ansi60()), None);
        let by_pos = ergonomics_by_pos(&keys);
        assert_eq!(by_pos["0,0"].hand, Hand::Left);
        assert_eq!(by_pos["0,6"].hand, Hand::Right);
        assert_eq!((by_pos["2,0"].finger.as_deref(), by_pos["2,0"].row), (Some("left-thumb"), Some("thumb")));
        assert_eq!(
            (by_pos["2,3"].finger.as_deref(), by_pos["2,3"].row),
            (Some("right-thumb"), Some("thumb"))
        );
    }

    #[test]
    fn a_single_row_has_a_hand_but_no_row_and_no_keys_nothing() {
        assert!(ergonomics_by_pos(&[]).is_empty());
        let one = ergonomics_by_pos(&kle(&[&units(1)]));
        assert_eq!(one["0,0"].row, None);
        assert_eq!(one["0,0"].hand, Hand::Left);
    }

    #[test]
    fn reads_keys_from_json() {
        let value =
            pipette_js_json::parse(r#"{"x":1,"y":2,"width":1.5,"height":1,"row":0,"col":"3"}"#).unwrap();
        let key = KleKey::from_value(&value).unwrap();
        assert_eq!((key.x, key.width, key.row), (1.0, 1.5, 0.0));
        assert!(key.col.is_nan());
        assert_eq!(KleKey::from_value(&Value::Null), None);
        assert_eq!(hand_of_finger("left-thumb"), Hand::Left);
        assert_eq!(hand_of_finger(FINGERS[9]), Hand::Right);
    }
}
