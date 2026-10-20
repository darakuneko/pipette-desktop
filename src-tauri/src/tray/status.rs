// SPDX-License-Identifier: GPL-2.0-or-later
//! What the tray shows for the status the renderer reports
//! (`trayStatusUpdate`): its shape check, and the tooltip, the menu rows and
//! the number format.

use serde::Serialize;
use serde_json::Value;

/// The menu item ids of the rows that change with the status, and of the
/// two items that act.
pub const SHOW: &str = "show";
pub const QUIT: &str = "quit";
pub const KEYBOARD: &str = "keyboard";
pub const RECORDING: &str = "recording";
pub const COUNT: &str = "count";
pub const KPM: &str = "kpm";

/// The connected keyboard's name and the REC counters, as `TrayStatus` of
/// src/shared/types/vial-api.ts.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TrayStatus {
    pub keyboard_name: Option<String>,
    pub recording: bool,
    pub count: f64,
    pub kpm: f64,
}

impl TrayStatus {
    /// The status in `value`, or None when it fails the shape check: an
    /// object whose `keyboardName` is null or a string, `recording` a
    /// boolean, and `count` and `kpm` numbers. Other fields are ignored.
    pub fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let keyboard_name = match object.get("keyboardName")? {
            Value::Null => None,
            Value::String(name) => Some(name.clone()),
            _ => return None,
        };
        Some(Self {
            keyboard_name,
            recording: object.get("recording")?.as_bool()?,
            count: object.get("count")?.as_f64()?,
            kpm: object.get("kpm")?.as_f64()?,
        })
    }

    /// The keyboard name the tray shows: none for an empty one too.
    fn shown_name(&self) -> Option<&str> {
        self.keyboard_name.as_deref().filter(|name| !name.is_empty())
    }

    /// Which rows the menu has between its separators.
    pub fn layout(&self) -> Layout {
        Layout { name: self.shown_name().is_some(), recording: self.recording }
    }

    /// The tooltip of `formatTrayTooltip`.
    pub fn tooltip(&self) -> String {
        match self.shown_name() {
            None => "Pipette".to_owned(),
            Some(name) if !self.recording => format!("Pipette — {name}"),
            Some(name) => {
                format!(
                    "Pipette — {name} — Cnt: {} · KPM: {}",
                    format_count(self.count),
                    format_count(self.kpm)
                )
            }
        }
    }

    pub fn count_label(&self) -> String {
        format!("Cnt: {}", format_count(self.count))
    }

    pub fn kpm_label(&self) -> String {
        format!("KPM: {}", format_count(self.kpm))
    }

    /// The tray menu: Show, a separator, the disabled info rows and a
    /// separator after them when there are any, then Quit. The labels are
    /// fixed English.
    pub fn menu_rows(&self) -> Vec<MenuRow> {
        let mut rows = vec![MenuRow::item(SHOW, "Show", true), MenuRow::separator()];
        let mut info = Vec::new();
        if let Some(name) = self.shown_name() {
            info.push(MenuRow::item(KEYBOARD, name, false));
        }
        if self.recording {
            info.push(MenuRow::item(RECORDING, "Recording", false));
            info.push(MenuRow::item(COUNT, &self.count_label(), false));
            info.push(MenuRow::item(KPM, &self.kpm_label(), false));
        }
        if !info.is_empty() {
            rows.extend(info);
            rows.push(MenuRow::separator());
        }
        rows.push(MenuRow::item(QUIT, "Quit", true));
        rows
    }
}

/// The rows the menu holds besides Show and Quit: a menu with the same
/// layout takes a new status by changing the text of its rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layout {
    pub name: bool,
    pub recording: bool,
}

/// A tray menu row, as `dev_tray_state` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MenuRow {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub kind: RowKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RowKind {
    Normal,
    Separator,
}

impl MenuRow {
    fn item(id: &str, label: &str, enabled: bool) -> Self {
        Self { id: id.to_owned(), label: label.to_owned(), enabled, kind: RowKind::Normal }
    }

    /// A separator of the template; the live menu gives its separators ids
    /// of their own.
    fn separator() -> Self {
        Self { id: "separator".to_owned(), label: String::new(), enabled: true, kind: RowKind::Separator }
    }
}

/// `n.toLocaleString('en-US')`: the shortest decimal that reads back as `n`
/// (JavaScript's `String(n)` digits, never in exponent form) rounded to three
/// fractional digits, half away from zero, without trailing zeros, the
/// integer part grouped by threes with commas. A negative number keeps its
/// sign even when it rounds to zero (`-0`). Only finite numbers reach this:
/// JSON carries no other.
pub fn format_count(n: f64) -> String {
    // Rust prints a float as its shortest round-trip decimal, in full.
    let digits = format!("{}", n.abs());
    let (int, frac) = digits.split_once('.').unwrap_or((&digits, ""));
    let mut int: Vec<u8> = int.bytes().map(|b| b - b'0').collect();
    let mut frac: Vec<u8> = frac.bytes().map(|b| b - b'0').collect();
    let round_up = frac.get(3).is_some_and(|&digit| digit >= 5);
    frac.truncate(3);
    if round_up && !increment(&mut frac) && !increment(&mut int) {
        int.insert(0, 1);
    }
    while frac.last() == Some(&0) {
        frac.pop();
    }

    let mut out = String::new();
    if n.is_sign_negative() {
        out.push('-');
    }
    for (i, digit) in int.iter().enumerate() {
        if i > 0 && (int.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(char::from(b'0' + digit));
    }
    if !frac.is_empty() {
        out.push('.');
        out.extend(frac.iter().map(|digit| char::from(b'0' + digit)));
    }
    out
}

/// Adds one to the last digit of `digits`, carrying; false when it carries
/// out of the first digit (every digit was 9, now 0).
fn increment(digits: &mut [u8]) -> bool {
    for digit in digits.iter_mut().rev() {
        if *digit == 9 {
            *digit = 0;
        } else {
            *digit += 1;
            return true;
        }
    }
    false
}

/// The tray's rows as the golden records them: `{label, click}` for
/// Show and Quit, `{label, enabled: false}` for the info rows,
/// `{type: "separator"}`.
#[cfg(test)]
pub fn as_template(rows: &[MenuRow]) -> Value {
    rows.iter()
        .map(|row| match (row.kind, row.id.as_str()) {
            (RowKind::Separator, _) => serde_json::json!({"type": "separator"}),
            (RowKind::Normal, SHOW | QUIT) => serde_json::json!({"label": row.label, "click": true}),
            (RowKind::Normal, _) => serde_json::json!({"label": row.label, "enabled": row.enabled}),
        })
        .collect()
}

/// The longest start of `text` that is at most `max` UTF-16 units, ending
/// on a character boundary.
pub fn truncate_utf16(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > max {
            return &text[..index];
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_tooltip_is_cut_on_a_character_boundary() {
        assert_eq!(truncate_utf16("Pipette", 127), "Pipette");
        assert_eq!(truncate_utf16("Pipette", 7), "Pipette");
        assert_eq!(truncate_utf16("Pipette", 3), "Pip");
        // "—" is one unit, "🎹" two.
        assert_eq!(truncate_utf16("a—b", 2), "a—");
        assert_eq!(truncate_utf16("a🎹b", 2), "a");
        assert_eq!(truncate_utf16("a🎹b", 3), "a🎹");
        let long = format!("Pipette — {} — Cnt: 1,234 · KPM: 56", "K".repeat(200));
        assert_eq!(truncate_utf16(&long, 127).encode_utf16().count(), 127);
    }

    fn golden() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/resident/tray.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn status(name: Option<&str>, recording: bool, count: f64, kpm: f64) -> TrayStatus {
        TrayStatus { keyboard_name: name.map(str::to_owned), recording, count, kpm }
    }

    #[test]
    fn numbers_format_as_the_golden_records() {
        let golden = golden();
        let table = golden["formatCount"].as_array().unwrap();
        assert!(table.len() > 200);
        for entry in table {
            let value = entry["value"].as_f64().unwrap();
            assert_eq!(format_count(value), entry["text"].as_str().unwrap(), "{value:e}");
        }
    }

    #[test]
    fn numbers_round_half_away_from_zero_on_the_shortest_digits() {
        assert_eq!(format_count(1.0005), "1.001");
        assert_eq!(format_count(0.0025), "0.003");
        assert_eq!(format_count(999.9995), "1,000");
        assert_eq!(format_count(-0.0004), "-0");
        assert_eq!(format_count(-0.0005), "-0.001");
        assert_eq!(format_count(1e21), "1,000,000,000,000,000,000,000");
    }

    #[test]
    fn the_shape_check_is_the_golden_one() {
        let golden = golden();
        for entry in golden["isValidTrayStatus"].as_array().unwrap() {
            let valid = entry["valid"].as_bool().unwrap();
            assert_eq!(TrayStatus::parse(&entry["input"]).is_some(), valid, "{}", entry["input"]);
        }
    }

    #[test]
    fn a_status_reads_its_fields() {
        let parsed = TrayStatus::parse(
            &json!({"keyboardName": "K", "recording": true, "count": 3, "kpm": 1.5, "x": 0}),
        );
        assert_eq!(parsed, Some(status(Some("K"), true, 3.0, 1.5)));
        let parsed =
            TrayStatus::parse(&json!({"keyboardName": null, "recording": false, "count": 0, "kpm": 0}));
        assert_eq!(parsed, Some(TrayStatus::default()));
    }

    #[test]
    fn an_empty_name_shows_no_name_but_keeps_the_rec_rows() {
        let rec = status(Some(""), true, 10.0, 2.0);
        assert_eq!(rec.tooltip(), "Pipette");
        assert_eq!(rec.layout(), Layout { name: false, recording: true });
        let labels: Vec<_> = rec.menu_rows().into_iter().map(|row| row.label).collect();
        assert_eq!(labels, ["Show", "", "Recording", "Cnt: 10", "KPM: 2", "", "Quit"]);
    }

    #[test]
    fn a_menu_without_info_rows_has_one_separator() {
        let kinds: Vec<_> = TrayStatus::default().menu_rows().into_iter().map(|row| row.kind).collect();
        assert_eq!(kinds, [RowKind::Normal, RowKind::Separator, RowKind::Normal]);
    }

    /// Plays the golden's tray scenarios on the cache and the tray's
    /// existence, as tray.rs keeps them: every tooltip and menu the golden
    /// records is the one this status gives, and a dropped status
    /// leaves both alone.
    #[test]
    fn the_tray_scenarios_give_the_golden_tooltips_and_menus() {
        let golden = golden();
        let mut checked = 0;
        for scenario in golden["scenarios"].as_array().unwrap() {
            let name = scenario["name"].as_str().unwrap();
            let mut cached = TrayStatus::default();
            let mut active = scenario["boot"]["config"]["trayResident"] == json!(true);
            if active {
                assert_tray_calls(name, &scenario["bootCalls"], Some(&cached));
            }
            for step in scenario["steps"].as_array().unwrap() {
                let action = &step["action"];
                let calls = &step["calls"];
                if let Some(value) = action.get("trayStatusUpdate") {
                    match TrayStatus::parse(value) {
                        Some(status) => {
                            cached = status;
                            assert_tray_calls(name, calls, active.then_some(&cached));
                        }
                        None => assert_tray_calls(name, calls, None),
                    }
                    checked += 1;
                } else if action["configChange"]["key"] == "trayResident" {
                    let on = action["configChange"]["value"] == json!(true);
                    let created = on && !active;
                    active = on;
                    assert_tray_calls(name, calls, created.then_some(&cached));
                    checked += 1;
                }
            }
        }
        assert!(checked > 20);
    }

    /// The tooltip and menu among `calls` are those of `expected`, or there
    /// are none when it is None.
    fn assert_tray_calls(scenario: &str, calls: &Value, expected: Option<&TrayStatus>) {
        let find =
            |call: &str| calls.as_array().unwrap().iter().find(|c| c["call"] == call).map(|c| &c["args"][1]);
        match expected {
            Some(status) => {
                assert_eq!(find("tray.setToolTip"), Some(&json!(status.tooltip())), "{scenario}");
                assert_eq!(
                    find("tray.setContextMenu"),
                    Some(&as_template(&status.menu_rows())),
                    "{scenario}"
                );
            }
            None => {
                assert_eq!(find("tray.setToolTip"), None, "{scenario}");
                assert_eq!(find("tray.setContextMenu"), None, "{scenario}");
            }
        }
    }
}
