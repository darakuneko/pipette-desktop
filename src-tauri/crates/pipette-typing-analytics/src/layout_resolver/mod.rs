// SPDX-License-Identifier: GPL-2.0-or-later
//! Where each recorded key would have been pressed on another keyboard
//! layout (with the layout maps of src/shared/keymap/layout-parse.ts): a
//! position's keycode on the
//! snapshot's layer gives the character the source layout types there,
//! the target layout gives the keycode that types that character, and the
//! snapshot gives where that keycode sits, with its finger, hand and row.
//!
//! Only the base character counts, lowercased; a masked keycode
//! (`LSFT(KC_A)`) counts as the keycode inside it.

mod ergonomics;
mod keycodes;

use std::collections::HashMap;

use pipette_js_json::{JsString, Value};

pub use ergonomics::{FINGERS, Hand, KleKey, hand_of_finger, pos_key};

/// Why an event has no target position (`SkipReason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    UnmappedKeycode,
    NoChar,
    NoTargetPosition,
}

/// Where an event lands on the target layout (`ResolveResult`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolved {
    Skipped(Skip),
    Placed {
        char: JsString,
        source_keycode: String,
        target_keycode: String,
        target_row: usize,
        target_col: usize,
        finger: Option<String>,
        hand: Option<Hand>,
        row_category: Option<&'static str>,
    },
}

/// A layout map entry that `parseLayoutEntry` cannot split (a truthy value
/// that is not a string), where the TypeScript handler throws.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("layout map entry {0} is not a string")]
pub struct BadLayoutEntry(pub String);

/// The base character of a layout display string (`parseLayoutEntry`):
/// the line after the first `\n` when there is one, up to the four spaces
/// before an AltGr label. A falsy value has none.
fn layout_entry_base(key: &JsString, raw: &Value) -> Result<JsString, BadLayoutEntry> {
    match raw {
        Value::String(text) => {
            let units = text.utf16_units();
            let mut lines = units.split(|&unit| unit == u16::from(b'\n'));
            let first = lines.next().unwrap_or_default();
            let line = lines.next().unwrap_or(first);
            let end = line.windows(4).position(|w| w == [0x20; 4]).unwrap_or(line.len());
            Ok(JsString::from_utf16(line[..end].to_vec()))
        }
        raw if !raw.is_truthy() => Ok(JsString::from("")),
        _ => Err(BadLayoutEntry(key.to_string_lossy().into_owned())),
    }
}

/// `firstCodePoint(s)?.toLowerCase()`; a lone surrogate stays as it is.
fn first_char_lowercase(s: &JsString) -> Option<JsString> {
    let units = s.utf16_units();
    let first = char::decode_utf16(units.iter().copied()).next()?;
    Some(match first {
        Ok(c) => JsString::from(c.to_lowercase().collect::<String>()),
        Err(lone) => JsString::from_utf16(vec![lone.unpaired_surrogate()]),
    })
}

/// A layout's qmkId → base character map: the QWERTY base of every
/// printable keycode, then the layout's own entries (`getForwardMap`).
/// An entry for a keycode already there keeps its place.
fn forward_map(map: &Value) -> Result<Vec<(JsString, JsString)>, BadLayoutEntry> {
    let mut out: Vec<(JsString, JsString)> = keycodes::PRINTABLE_KEYCODES
        .iter()
        .map(|&(id, base)| (JsString::from(id), JsString::from(base)))
        .collect();
    let mut index: HashMap<JsString, usize> =
        out.iter().enumerate().map(|(i, (id, _))| (id.clone(), i)).collect();
    let entries: Vec<(JsString, &Value)> = match map {
        Value::Object(object) => object.iter().map(|(key, value)| (key.clone(), value)).collect(),
        Value::Array(items) => {
            items.iter().enumerate().map(|(i, value)| (JsString::from(i.to_string()), value)).collect()
        }
        _ => Vec::new(),
    };
    for (id, raw) in entries {
        let base = layout_entry_base(&id, raw)?;
        match index.get(&id) {
            Some(&at) => out[at].1 = base,
            None => {
                index.insert(id.clone(), out.len());
                out.push((id, base));
            }
        }
    }
    Ok(out)
}

/// A layout map (`LayoutShape.map`) as the resolver uses it.
pub struct Layout {
    forward: HashMap<JsString, JsString>,
    /// Lowercased base character → the first qmkId that types it
    /// (`getReverseMap`).
    reverse: HashMap<JsString, JsString>,
}

impl Layout {
    pub fn new(map: &Value) -> Result<Self, BadLayoutEntry> {
        let forward = forward_map(map)?;
        let mut reverse = HashMap::new();
        for (id, base) in &forward {
            if let Some(char) = first_char_lowercase(base) {
                reverse.entry(char).or_insert_with(|| id.clone());
            }
        }
        Ok(Self { forward: forward.into_iter().collect(), reverse })
    }
}

/// What the resolver reads from a keymap snapshot: each position's inner
/// keycode on one layer, the first position of each keycode, and the
/// geometry estimates of the snapshot's keys.
pub struct SnapshotKeys {
    inner: Vec<(usize, usize, &'static str)>,
    first_pos: HashMap<&'static str, (usize, usize)>,
    ergonomics: HashMap<String, ergonomics::Ergonomics>,
}

impl SnapshotKeys {
    /// `keymap` is the snapshot's `keymap` (layers of rows of serialized
    /// keycodes); `keys` its layout's KLE keys. A cell that is not a
    /// non-empty string has no keycode: the app's snapshots hold strings,
    /// where the TypeScript resolver would throw on another truthy value.
    pub fn new(keymap: &Value, layer: usize, keys: &[KleKey]) -> Self {
        let rows: &[Value] = match keymap {
            Value::Array(layers) => match layers.get(layer) {
                Some(Value::Array(rows)) => rows,
                _ => &[],
            },
            _ => &[],
        };
        let mut inner = Vec::new();
        let mut first_pos = HashMap::new();
        for (row, cols) in rows.iter().enumerate() {
            let Value::Array(cols) = cols else { continue };
            for (col, cell) in cols.iter().enumerate() {
                let Some(id) = cell.as_str().filter(|s| !s.is_empty()).and_then(keycodes::inner_qmk_id)
                else {
                    continue;
                };
                inner.push((row, col, id));
                first_pos.entry(id).or_insert((row, col));
            }
        }
        Self { inner, first_pos, ergonomics: ergonomics::ergonomics_by_pos(keys) }
    }
}

/// Every position's result from `source` to `target` (`buildLayoutResolver`),
/// by `posKey`; a position without one is `UnmappedKeycode`.
pub struct Resolver {
    results: HashMap<String, Resolved>,
}

impl Resolver {
    pub fn new(
        keys: &SnapshotKeys,
        source: &Layout,
        target: &Layout,
        finger_overrides: Option<&HashMap<String, String>>,
    ) -> Self {
        let mut results = HashMap::new();
        for &(row, col, source_keycode) in &keys.inner {
            let resolved = (|| {
                let char = source
                    .forward
                    .get(&JsString::from(source_keycode))
                    .and_then(first_char_lowercase)
                    .ok_or(Skip::NoChar)?;
                let target_keycode = target.reverse.get(&char).ok_or(Skip::NoChar)?;
                let target_keycode = target_keycode.to_string_lossy().into_owned();
                let &(target_row, target_col) =
                    keys.first_pos.get(target_keycode.as_str()).ok_or(Skip::NoTargetPosition)?;
                let target_pos = pos_key(target_row as f64, target_col as f64);
                let estimate = keys.ergonomics.get(&target_pos);
                let overridden = finger_overrides.and_then(|o| o.get(&target_pos));
                Ok(Resolved::Placed {
                    char,
                    source_keycode: source_keycode.to_owned(),
                    target_keycode,
                    target_row,
                    target_col,
                    finger: overridden.cloned().or_else(|| estimate.and_then(|e| e.finger.clone())),
                    hand: match overridden {
                        Some(finger) => Some(hand_of_finger(finger)),
                        None => estimate.map(|e| e.hand),
                    },
                    row_category: estimate.and_then(|e| e.row),
                })
            })();
            results.insert(pos_key(row as f64, col as f64), resolved.unwrap_or_else(Resolved::Skipped));
        }
        Self { results }
    }

    pub fn resolve(&self, row: f64, col: f64) -> &Resolved {
        const UNMAPPED: Resolved = Resolved::Skipped(Skip::UnmappedKeycode);
        self.results.get(&pos_key(row, col)).unwrap_or(&UNMAPPED)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layout(json: &str) -> Layout {
        Layout::new(&pipette_js_json::parse(json).unwrap()).unwrap()
    }

    const COLEMAK: &str = r#"{"KC_E":"F","KC_R":"P","KC_T":"G","KC_S":"R","KC_D":"S","KC_F":"T"}"#;

    fn keymap(rows: &[&[&str]]) -> Value {
        let rows =
            rows.iter().map(|row| Value::Array(row.iter().map(|&id| Value::from(id)).collect())).collect();
        Value::Array(vec![Value::Array(rows)])
    }

    fn resolver(rows: &[&[&str]], keys: &[KleKey], overrides: Option<&HashMap<String, String>>) -> Resolver {
        let snapshot = SnapshotKeys::new(&keymap(rows), 0, keys);
        Resolver::new(&snapshot, &layout("{}"), &layout(COLEMAK), overrides)
    }

    fn placed(resolved: &Resolved) -> (&str, &str, usize, usize) {
        match resolved {
            Resolved::Placed { source_keycode, target_keycode, target_row, target_col, .. } => {
                (source_keycode, target_keycode, *target_row, *target_col)
            }
            Resolved::Skipped(skip) => panic!("skipped: {skip:?}"),
        }
    }

    fn grid() -> Vec<KleKey> {
        (0..4)
            .flat_map(|r| {
                (0..4).map(move |c| KleKey {
                    x: c as f64,
                    y: r as f64,
                    width: 1.0,
                    height: 1.0,
                    row: r as f64,
                    col: c as f64,
                })
            })
            .collect()
    }

    const GRID: [&[&str]; 4] = [
        &["KC_Q", "KC_W", "KC_E", "KC_R"],
        &["KC_A", "KC_S", "KC_D", "KC_F"],
        &["KC_Z", "KC_X", "KC_C", "KC_V"],
        &["KC_NO", "KC_NO", "KC_SPACE", "KC_NO"],
    ];

    #[test]
    fn translates_a_qwerty_press_to_the_target_position() {
        let r = resolver(&[&["KC_R", "KC_S", "KC_A"]], &[], None);
        assert_eq!(placed(r.resolve(0.0, 0.0)), ("KC_R", "KC_S", 0, 1));
        assert_eq!(placed(r.resolve(0.0, 2.0)), ("KC_A", "KC_A", 0, 2));
        let Resolved::Placed { char, .. } = r.resolve(0.0, 0.0) else { panic!() };
        assert_eq!(char, &JsString::from("r"));
    }

    #[test]
    fn unwraps_masked_keycodes_and_takes_the_first_position() {
        let r = resolver(&[&["KC_NO", "KC_NO", "KC_A"], &["LSFT(KC_A)"]], &[], None);
        assert_eq!(placed(r.resolve(1.0, 0.0)), ("KC_A", "KC_A", 0, 2));
    }

    #[test]
    fn skips_with_the_reason() {
        let skip = |rows: &[&[&str]]| resolver(rows, &[], None).resolve(0.0, 0.0).clone();
        assert_eq!(skip(&[&["MO(1)"]]), Resolved::Skipped(Skip::UnmappedKeycode));
        assert_eq!(skip(&[&["KC_NO"]]), Resolved::Skipped(Skip::NoChar));
        assert_eq!(skip(&[&["KC_S"]]), Resolved::Skipped(Skip::NoTargetPosition));
        assert_eq!(
            resolver(&[&["KC_A"]], &[], None).resolve(9.0, 9.0),
            &Resolved::Skipped(Skip::UnmappedKeycode)
        );
    }

    #[test]
    fn attaches_the_ergonomics_of_the_target_position_with_overrides() {
        let keys = grid();
        let plain = resolver(&GRID, &keys, None);
        let Resolved::Placed { target_row, target_col, row_category, hand, .. } =
            plain.resolve(1.0, 3.0).clone()
        else {
            panic!()
        };
        assert_eq!((target_row, target_col, row_category), (0, 2, Some("top")));
        assert!(hand.is_some());
        let overrides = HashMap::from([("0,2".to_owned(), "left-pinky".to_owned())]);
        let overridden = resolver(&GRID, &keys, Some(&overrides));
        let Resolved::Placed { finger, hand, row_category: overridden_row, .. } =
            overridden.resolve(1.0, 3.0).clone()
        else {
            panic!()
        };
        assert_eq!((finger.as_deref(), hand), (Some("left-pinky"), Some(Hand::Left)));
        assert_eq!(overridden_row, row_category);
    }

    #[test]
    fn parses_layout_entries() {
        let base = |raw: &str| layout_entry_base(&JsString::from("k"), &Value::from(raw)).unwrap();
        assert_eq!(base(""), JsString::from(""));
        assert_eq!(base("a"), JsString::from("a"));
        assert_eq!(base("?\n6"), JsString::from("6"));
        assert_eq!(base("Ç    ~"), JsString::from("Ç"));
        assert_eq!(base("\\\n/    |"), JsString::from("/"));
        assert_eq!(layout_entry_base(&JsString::from("k"), &Value::Null), Ok(JsString::from("")));
        assert!(layout_entry_base(&JsString::from("k"), &Value::Number(1.0)).is_err());
    }

    #[test]
    fn reverse_maps_take_the_first_keycode_of_a_lowercased_char() {
        let qwerty = layout("{}");
        assert_eq!(qwerty.reverse.get(&JsString::from("a")), Some(&JsString::from("KC_A")));
        let colemak = layout(COLEMAK);
        assert_eq!(colemak.reverse.get(&JsString::from("f")), Some(&JsString::from("KC_E")));
        // KC_F types "t" and comes before KC_T, which types "g".
        assert_eq!(colemak.reverse.get(&JsString::from("t")), Some(&JsString::from("KC_F")));
        let shifted = layout(r#"{"KC_1":"!\n1    ¹","KC_X":"İ"}"#);
        assert_eq!(shifted.reverse.get(&JsString::from("1")), Some(&JsString::from("KC_1")));
        assert_eq!(shifted.reverse.get(&JsString::from("i\u{307}")), Some(&JsString::from("KC_X")));
    }
}
