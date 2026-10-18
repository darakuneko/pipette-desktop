// SPDX-License-Identifier: GPL-2.0-or-later
//! Checks the X11 lookup against `@paymoapp/active-window`, recorded by
//! scripts/resident-fixtures/record-x11-active-window-fixtures.test.ts: each
//! case's properties are put on a window of a private Xvfb (test_server.rs)
//! the way the generator puts them, and the lookup's answer must be the
//! binding's. Skips when Xvfb is not installed (see `REQUIRE_VAR`).

use pipette_js_json::Value;

use super::conn::{ATOM_WINDOW, Connection};
use super::test_server::PrivateXServer;
use super::*;

fn fixture() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/x11_active_window.json");
    pipette_js_json::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.as_object().unwrap().get(key).unwrap_or_else(|| panic!("no {key}"))
}

fn text(value: &Value, key: &str) -> String {
    field(value, key).as_str().unwrap_or_else(|| panic!("{key} is not a string")).to_owned()
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

/// The requests the generator makes to set a case up, on a connection of
/// the test's own.
struct Setup {
    conn: Connection,
}

impl Setup {
    fn intern(&mut self, name: &str) -> u32 {
        self.conn.intern_atom(name, false).unwrap()
    }

    fn create_window(&mut self) -> u32 {
        let (base, mask, next) = &mut self.conn.ids;
        let id = *base | (*next * (*mask & mask.wrapping_neg()));
        *next += 1;
        let root = self.conn.root();
        let mut request = vec![1, 0, 0, 0];
        for field in [id, root, 0, 1 | (1 << 16)] {
            request.extend(field.to_le_bytes());
        }
        request.extend(0u16.to_le_bytes());
        request.extend(2u16.to_le_bytes()); // InputOnly, never mapped.
        request.extend(0u32.to_le_bytes());
        request.extend(0u32.to_le_bytes());
        self.conn.send(request).unwrap();
        id
    }

    fn destroy_window(&mut self, window: u32) {
        let mut request = vec![4, 0, 0, 0];
        request.extend(window.to_le_bytes());
        self.conn.send(request).unwrap();
    }

    fn change_property(&mut self, window: u32, property: u32, type_: u32, format: u8, data: &[u8]) {
        let mut request = vec![18, 0, 0, 0];
        for field in [window, property, type_] {
            request.extend(field.to_le_bytes());
        }
        request.extend([format, 0, 0, 0]);
        request.extend((data.len() as u32 / u32::from(format / 8)).to_le_bytes());
        request.extend(data);
        self.conn.send(request).unwrap();
    }

    fn delete_property(&mut self, window: u32, property: u32) {
        let mut request = vec![19, 0, 0, 0];
        request.extend(window.to_le_bytes());
        request.extend(property.to_le_bytes());
        self.conn.send(request).unwrap();
    }

    /// GetInputFocus as the round trip that surfaces the errors of the
    /// requests before it.
    fn sync(&mut self) {
        let sequence = self.conn.send(vec![43, 0, 0, 0]).unwrap();
        self.conn.reply(sequence).unwrap();
    }

    fn set_up(&mut self, case: &Value) {
        let active = text(case, "active");
        if active == "no-atom" {
            assert_eq!(self.conn.intern_atom("_NET_ACTIVE_WINDOW", true).unwrap(), 0);
            return;
        }
        let atom = self.intern("_NET_ACTIVE_WINDOW");
        let root = self.conn.root();
        let target = match active.as_str() {
            "unset" => {
                self.delete_property(root, atom);
                self.sync();
                return;
            }
            "none" => 0,
            "destroyed" => {
                let window = self.create_window();
                self.destroy_window(window);
                window
            }
            "window" => {
                let window = self.create_window();
                let Value::Array(props) = field(case, "props") else { panic!("props") };
                for prop in props {
                    let name = self.intern(&text(prop, "name"));
                    let type_ = self.intern(&text(prop, "type"));
                    let Value::Number(format) = field(prop, "format") else { panic!("format") };
                    self.change_property(window, name, type_, *format as u8, &hex(&text(prop, "hex")));
                }
                window
            }
            other => panic!("unknown active {other}"),
        };
        self.change_property(root, atom, ATOM_WINDOW, 32, &target.to_le_bytes());
        self.sync();
    }
}

#[test]
fn the_lookup_matches_the_binding_on_a_private_x_server() {
    let Some(server) = PrivateXServer::start() else { return };
    let mut setup = Setup { conn: Connection::open(&server.display, Some(&server.authority), "").unwrap() };
    // One lookup for every case, as the app keeps one for its lifetime.
    let mut lookup = X11Backend::open(&server.display, Some(server.authority.clone())).unwrap();
    let fixture = fixture();
    let Value::Array(cases) = field(&fixture, "cases") else { panic!("cases") };
    assert_eq!(cases.len(), 29);
    let mut failures = Vec::new();
    for case in cases {
        setup.set_up(case);
        let answer = field(case, "answer");
        let got = match lookup.active_window() {
            Ok(Some(info)) => {
                format!("window {:?} {:?}", info.application.to_string_lossy(), info.title.to_string_lossy())
            }
            Ok(None) => "no window".to_owned(),
            Err(err) => format!("throws Error: {err}"),
        };
        let expected = match text(answer, "kind").as_str() {
            "window" => format!("window {:?} {:?}", text(answer, "application"), text(answer, "title")),
            "throws" => format!("throws {}", text(answer, "error")),
            kind => panic!("unknown answer {kind}"),
        };
        if got != expected {
            failures.push(format!("{}: got {got}, expected {expected}", text(case, "name")));
        }
    }
    drop(setup);
    drop(server);
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn a_display_that_cannot_be_opened_fails_to_load() {
    // A display number no server takes, through the local socket only (the
    // unix protocol has no TCP fallback); no Xvfb is needed.
    assert!(X11Backend::open("unix/:65535", None).is_err());
    assert!(X11Backend::open("not a display", None).is_err());
}
