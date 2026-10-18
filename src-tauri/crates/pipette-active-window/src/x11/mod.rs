// SPDX-License-Identifier: GPL-2.0-or-later
//! The X11 lookup of the active window, as the Linux part of
//! `@paymoapp/active-window` does it: the window named by `_NET_ACTIVE_WINDOW`
//! on the root window, its title from `WM_NAME` and its application from the
//! class in `WM_CLASS` (text.rs). `_NET_WM_NAME` is not read.

mod conn;
mod display;
mod text;

use std::collections::HashMap;
use std::path::PathBuf;

use pipette_js_json::JsString;

use self::conn::{
    ANY_PROPERTY_TYPE, ATOM_STRING, ATOM_WINDOW, ATOM_WM_CLASS, ATOM_WM_NAME, Connection, Error,
};
use self::text::TitleEncoding;
use crate::{NativeBackend, NativeError, WindowInfo};

/// The error of a lookup that finds no active window, in the binding's words.
pub const NO_ACTIVE_WINDOW: &str = "Failed to get active window";

/// How much of each property is read, in 4-byte units, as Xlib asks:
/// `sizeof(Window)` for `_NET_ACTIVE_WINDOW` (only the first window is used),
/// `BUFSIZ` for `WM_CLASS` (`XGetClassHint`), 1,000,000 for `WM_NAME`
/// (`XGetTextProperty`).
const ACTIVE_WINDOW_LENGTH: u32 = 8;
const WM_CLASS_LENGTH: u32 = 8192;
const WM_NAME_LENGTH: u32 = 1_000_000;

/// A connection and the atoms found on its server. Atoms are only cached
/// once the server has them; one that is missing is asked for again.
struct Session {
    conn: Connection,
    atoms: HashMap<&'static str, u32>,
}

impl Session {
    fn atom(&mut self, name: &'static str) -> Result<Option<u32>, Error> {
        if let Some(&atom) = self.atoms.get(name) {
            return Ok(Some(atom));
        }
        let atom = self.conn.intern_atom(name, true)?;
        if atom == 0 {
            return Ok(None);
        }
        self.atoms.insert(name, atom);
        Ok(Some(atom))
    }

    /// A property of `window`, or `None` when reading it gives an X error
    /// (a window destroyed in the meantime), as Xlib's callers treat it.
    fn property(
        &mut self,
        window: u32,
        property: u32,
        type_: u32,
        length: u32,
    ) -> Result<Option<conn::Property>, Error> {
        match self.conn.get_property(window, property, type_, length) {
            Ok(prop) => Ok(Some(prop)),
            Err(Error::X(_)) => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// The active window and its title and application; `None` when there is
    /// no active window.
    fn lookup(&mut self) -> Result<Option<WindowInfo>, Error> {
        let Some(active) = self.atom("_NET_ACTIVE_WINDOW")? else { return Ok(None) };
        let root = self.conn.root();
        let window = match self.property(root, active, ATOM_WINDOW, ACTIVE_WINDOW_LENGTH)? {
            Some(prop) if prop.type_ == ATOM_WINDOW && prop.format == 32 && prop.value.len() >= 4 => {
                u32::from_le_bytes([prop.value[0], prop.value[1], prop.value[2], prop.value[3]])
            }
            _ => 0,
        };
        if window == 0 {
            return Ok(None);
        }
        let title = match self.property(window, ATOM_WM_NAME, ANY_PROPERTY_TYPE, WM_NAME_LENGTH)? {
            Some(prop) if prop.type_ != 0 => {
                let encoding = self.title_encoding(prop.type_)?;
                text::title(encoding, prop.format, &prop.value)
            }
            _ => String::new(),
        };
        let application = match self.property(window, ATOM_WM_CLASS, ATOM_STRING, WM_CLASS_LENGTH)? {
            Some(prop) if prop.type_ == ATOM_STRING && prop.format == 8 => text::application(&prop.value),
            _ => String::new(),
        };
        Ok(Some(WindowInfo { application: JsString::from(application), title: JsString::from(title) }))
    }

    fn title_encoding(&mut self, type_: u32) -> Result<TitleEncoding, Error> {
        if type_ == ATOM_STRING {
            return Ok(TitleEncoding::String);
        }
        if self.atom("UTF8_STRING")? == Some(type_) {
            return Ok(TitleEncoding::Utf8String);
        }
        if self.atom("COMPOUND_TEXT")? == Some(type_) {
            return Ok(TitleEncoding::CompoundText);
        }
        Ok(TitleEncoding::Other)
    }
}

/// The X11 lookup on one display. The connection is opened by
/// [`X11Backend::open`]; when it breaks (the server goes away or stops
/// answering), the lookup fails and the next one opens it again.
pub struct X11Backend {
    display: String,
    authority: Option<PathBuf>,
    hostname: String,
    session: Option<Session>,
}

impl X11Backend {
    /// Opens `display` with the cookie of the authority file `authority`.
    pub fn open(display: &str, authority: Option<PathBuf>) -> Result<Self, NativeError> {
        let mut backend =
            Self { display: display.to_owned(), authority, hostname: display::hostname(), session: None };
        backend.session = Some(backend.connect()?);
        Ok(backend)
    }

    /// Opens the display Xlib's `XOpenDisplay(NULL)` opens: `DISPLAY`, with
    /// the authority file of `XAUTHORITY` or `HOME`.
    pub fn from_env() -> Result<Self, NativeError> {
        let var = |name| std::env::var(name).ok();
        let display = var("DISPLAY").filter(|d| !d.is_empty()).ok_or("Failed to open display")?;
        let authority = display::authority_path(var("XAUTHORITY").as_deref(), var("HOME").as_deref());
        Self::open(&display, authority)
    }

    fn connect(&self) -> Result<Session, Error> {
        let conn = Connection::open(&self.display, self.authority.as_deref(), &self.hostname)?;
        Ok(Session { conn, atoms: HashMap::new() })
    }
}

impl NativeBackend for X11Backend {
    fn active_window(&mut self) -> Result<Option<WindowInfo>, NativeError> {
        let mut session = match self.session.take() {
            Some(session) => session,
            None => self.connect()?,
        };
        match session.lookup() {
            Ok(Some(info)) => {
                self.session = Some(session);
                Ok(Some(info))
            }
            Ok(None) => {
                self.session = Some(session);
                Err(NO_ACTIVE_WINDOW.into())
            }
            Err(err @ Error::X(_)) => {
                self.session = Some(session);
                Err(err.into())
            }
            Err(err) => Err(err.into()),
        }
    }
}

#[cfg(test)]
mod golden_tests;
#[cfg(test)]
mod test_server;
