// SPDX-License-Identifier: GPL-2.0-or-later
//! Checks the X11 lookup against `@paymoapp/active-window`, recorded by
//! scripts/resident-fixtures/record-x11-active-window-fixtures.test.ts: each
//! case's properties are put on a window of a private Xvfb (test_server.rs)
//! the way the generator puts them, and the lookup's answer must be the
//! binding's. Skips when Xvfb is not installed (see `REQUIRE_VAR`).

use pipette_js_json::Value;
use x11rb::protocol::xproto::{CreateWindowAux, PropMode, WindowClass};
use x11rb::wrapper::ConnectionExt as _;

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
/// the test's own. Each is checked, so an X error fails the test.
struct Setup {
    conn: Conn,
    root: u32,
}

impl Setup {
    fn intern(&self, name: &str) -> u32 {
        self.conn.intern_atom(false, name.as_bytes()).unwrap().reply().unwrap().atom
    }

    /// An InputOnly window that is never mapped.
    fn create_window(&self) -> u32 {
        let window = self.conn.generate_id().unwrap();
        self.conn
            .create_window(
                0,
                window,
                self.root,
                0,
                0,
                1,
                1,
                0,
                WindowClass::INPUT_ONLY,
                0,
                &CreateWindowAux::new(),
            )
            .unwrap()
            .check()
            .unwrap();
        window
    }

    fn change_property(&self, window: u32, property: u32, type_: u32, format: u8, data: &[u8]) {
        let items = data.len() as u32 / u32::from(format / 8);
        self.conn
            .change_property(PropMode::REPLACE, window, property, type_, format, items, data)
            .unwrap()
            .check()
            .unwrap();
    }

    fn set_up(&self, case: &Value) {
        self.conn.stream().set_deadline(Instant::now() + LOOKUP_TIMEOUT);
        let active = text(case, "active");
        if active == "no-atom" {
            let atom = self.conn.intern_atom(true, b"_NET_ACTIVE_WINDOW").unwrap().reply().unwrap().atom;
            assert_eq!(atom, 0);
            return;
        }
        let atom = self.intern("_NET_ACTIVE_WINDOW");
        let target = match active.as_str() {
            "unset" => {
                self.conn.delete_property(self.root, atom).unwrap().check().unwrap();
                return;
            }
            "none" => 0,
            "destroyed" => {
                let window = self.create_window();
                self.conn.destroy_window(window).unwrap().check().unwrap();
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
        self.conn
            .change_property32(PropMode::REPLACE, self.root, atom, AtomEnum::WINDOW, &[target])
            .unwrap()
            .check()
            .unwrap();
    }
}

#[test]
fn the_lookup_matches_the_binding_on_a_private_x_server() {
    let Some(server) = PrivateXServer::start() else { return };
    let auth = Auth::Cookie(server.cookie.to_vec());
    let (conn, screen) = connect(Some(&server.display), &auth, Instant::now() + LOOKUP_TIMEOUT).unwrap();
    let root = conn.setup().roots[screen].root;
    let setup = Setup { conn, root };
    // One lookup for every case, as the app keeps one for its lifetime.
    let mut lookup = X11Backend::with_cookie(&server.display, &server.cookie).unwrap();
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
    drop(lookup);
    drop(server);
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn a_display_that_cannot_be_opened_fails_to_load() {
    // A display number no server takes, through the local socket only (the
    // unix protocol has no TCP fallback); no Xvfb is needed.
    assert!(X11Backend::with_cookie("unix/:65535", b"").is_err());
    assert!(X11Backend::with_cookie("not a display", b"").is_err());
}

#[test]
fn a_tcp_connect_past_its_deadline_gives_up_without_connecting() {
    let error = connect_tcp("127.0.0.1", 9, Instant::now()).unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
}
