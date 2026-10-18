// SPDX-License-Identifier: GPL-2.0-or-later
//! The X11 lookup of the active window, as the Linux part of
//! `@paymoapp/active-window` does it: the window named by `_NET_ACTIVE_WINDOW`
//! on the root window, its title from `WM_NAME` and its application from the
//! class in `WM_CLASS` (text.rs). `_NET_WM_NAME` is not read.

mod stream;
mod text;

use std::collections::HashMap;
use std::io;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Instant;

use pipette_js_json::JsString;
use x11rb::connection::Connection as _;
use x11rb::errors::{ConnectError, ReplyError};
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _, GetPropertyReply};
use x11rb::reexports::x11rb_protocol::parse_display::{ConnectAddress, parse_display};
use x11rb::reexports::x11rb_protocol::xauth::get_auth;
use x11rb::rust_connection::{DefaultStream, RustConnection};

use self::stream::{LOOKUP_TIMEOUT, TimedStream};
use self::text::TitleEncoding;
use crate::{NativeBackend, NativeError, WindowInfo};

/// The error of a lookup that finds no active window, in the binding's words.
const NO_ACTIVE_WINDOW: &str = "Failed to get active window";

/// How much of each property is read, in 4-byte units, as Xlib asks:
/// `sizeof(Window)` for `_NET_ACTIVE_WINDOW` (only the first window is used),
/// `BUFSIZ` for `WM_CLASS` (`XGetClassHint`), 1,000,000 for `WM_NAME`
/// (`XGetTextProperty`).
const ACTIVE_WINDOW_LENGTH: u32 = 8;
const WM_CLASS_LENGTH: u32 = 8192;
const WM_NAME_LENGTH: u32 = 1_000_000;

type Conn = RustConnection<TimedStream>;

/// The authorization sent when connecting.
enum Auth {
    /// The MIT-MAGIC-COOKIE-1 entry x11rb finds in `XAUTHORITY` (or
    /// `$HOME/.Xauthority`) for the address connected to, else none.
    Xauthority,
    /// This cookie.
    #[cfg(test)]
    Cookie(Vec<u8>),
}

/// A TCP connection to `host:port` that gives up at `deadline` (x11rb's
/// own connect has no limit). Resolving the host name is not limited.
fn connect_tcp(host: &str, port: u16, deadline: Instant) -> io::Result<TcpStream> {
    let mut last = io::Error::new(io::ErrorKind::NotFound, format!("no address for {host}"));
    for address in (host, port).to_socket_addrs()? {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(io::ErrorKind::TimedOut, format!("cannot connect to {host} in time")));
        }
        match TcpStream::connect_timeout(&address, remaining) {
            Ok(stream) => return Ok(stream),
            Err(err) => last = err,
        }
    }
    Err(last)
}

/// Connects as x11rb's `RustConnection::connect` does (each address of the
/// display name in turn), giving up waiting on the server at `deadline`.
/// `display` `None` is `DISPLAY`.
fn connect(display: Option<&str>, auth: &Auth, deadline: Instant) -> Result<(Conn, usize), ConnectError> {
    let parsed = parse_display(display)?;
    let screen = usize::from(parsed.screen);
    let mut last = None;
    for address in parsed.connect_instruction() {
        let connected = match &address {
            ConnectAddress::Hostname(host, port) => {
                connect_tcp(host, *port, deadline).and_then(DefaultStream::from_tcp_stream)
            }
            _ => DefaultStream::connect(&address),
        };
        let (socket, (family, peer)) = match connected {
            Ok(connected) => connected,
            Err(err) => {
                last = Some(err);
                continue;
            }
        };
        let (name, data) = match auth {
            Auth::Xauthority => get_auth(family, &peer, parsed.display).ok().flatten().unwrap_or_default(),
            #[cfg(test)]
            Auth::Cookie(cookie) => (b"MIT-MAGIC-COOKIE-1".to_vec(), cookie.clone()),
        };
        let socket = TimedStream::new(socket, deadline);
        let conn = RustConnection::connect_to_stream_with_auth_info(socket, screen, name, data)?;
        return Ok((conn, screen));
    }
    Err(last.map_or(ConnectError::UnknownError, ConnectError::IoError))
}

/// A connection and the atoms found on its server. Atoms are only cached
/// once the server has them; one that is missing is asked for again.
struct Session {
    conn: Conn,
    root: u32,
    atoms: HashMap<&'static str, u32>,
}

impl Session {
    fn open(display: Option<&str>, auth: &Auth, deadline: Instant) -> Result<Self, ConnectError> {
        let (conn, screen) = connect(display, auth, deadline)?;
        let root = conn.setup().roots[screen].root;
        Ok(Self { conn, root, atoms: HashMap::new() })
    }

    fn atom(&mut self, name: &'static str) -> Result<Option<u32>, ReplyError> {
        if let Some(&atom) = self.atoms.get(name) {
            return Ok(Some(atom));
        }
        let atom = self.conn.intern_atom(true, name.as_bytes())?.reply()?.atom;
        if atom == 0 {
            return Ok(None);
        }
        self.atoms.insert(name, atom);
        Ok(Some(atom))
    }

    /// A property of `window`, or `None` when reading it gives an X error
    /// (a window destroyed in the meantime), as Xlib's callers treat it.
    fn property(
        &self,
        window: u32,
        property: impl Into<u32>,
        type_: AtomEnum,
        length: u32,
    ) -> Result<Option<GetPropertyReply>, ReplyError> {
        match self.conn.get_property(false, window, property, type_, 0, length)?.reply() {
            Ok(prop) => Ok(Some(prop)),
            Err(ReplyError::X11Error(_)) => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// The active window and its title and application; `None` when there is
    /// no active window. Gives up waiting on the server at `deadline`.
    fn lookup(&mut self, deadline: Instant) -> Result<Option<WindowInfo>, ReplyError> {
        self.conn.stream().set_deadline(deadline);
        let Some(active) = self.atom("_NET_ACTIVE_WINDOW")? else { return Ok(None) };
        let window = match self.property(self.root, active, AtomEnum::WINDOW, ACTIVE_WINDOW_LENGTH)? {
            Some(prop) if prop.type_ == u32::from(AtomEnum::WINDOW) => {
                prop.value32().and_then(|mut windows| windows.next()).unwrap_or(0)
            }
            _ => 0,
        };
        if window == 0 {
            return Ok(None);
        }
        let title = match self.property(window, AtomEnum::WM_NAME, AtomEnum::ANY, WM_NAME_LENGTH)? {
            Some(prop) if prop.type_ != 0 => {
                let encoding = self.title_encoding(prop.type_)?;
                text::title(encoding, prop.format, &prop.value)
            }
            _ => String::new(),
        };
        let application =
            match self.property(window, AtomEnum::WM_CLASS, AtomEnum::STRING, WM_CLASS_LENGTH)? {
                Some(prop) if prop.type_ == u32::from(AtomEnum::STRING) && prop.format == 8 => {
                    text::application(&prop.value)
                }
                _ => String::new(),
            };
        Ok(Some(WindowInfo { application: JsString::from(application), title: JsString::from(title) }))
    }

    fn title_encoding(&mut self, type_: u32) -> Result<TitleEncoding, ReplyError> {
        if type_ == u32::from(AtomEnum::STRING) {
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

/// The X11 lookup on one display. The connection is opened when the backend
/// is made; when it breaks (the server goes away or stops answering), the
/// lookup fails and the next one opens it again.
pub struct X11Backend {
    display: Option<String>,
    auth: Auth,
    session: Option<Session>,
}

impl X11Backend {
    /// Opens the display Xlib's `XOpenDisplay(NULL)` opens: `DISPLAY`, with
    /// the cookie of the authority file of `XAUTHORITY` or `HOME`.
    pub fn from_env() -> Result<Self, NativeError> {
        Self::open(None, Auth::Xauthority)
    }

    /// Opens `display` with `cookie`.
    #[cfg(test)]
    fn with_cookie(display: &str, cookie: &[u8]) -> Result<Self, NativeError> {
        Self::open(Some(display.to_owned()), Auth::Cookie(cookie.to_vec()))
    }

    fn open(display: Option<String>, auth: Auth) -> Result<Self, NativeError> {
        let session = Session::open(display.as_deref(), &auth, Instant::now() + LOOKUP_TIMEOUT)?;
        Ok(Self { display, auth, session: Some(session) })
    }
}

impl NativeBackend for X11Backend {
    /// Reopening a broken connection and the lookup share one deadline,
    /// [`LOOKUP_TIMEOUT`] from the call.
    fn active_window(&mut self) -> Result<Option<WindowInfo>, NativeError> {
        let deadline = Instant::now() + LOOKUP_TIMEOUT;
        let mut session = match self.session.take() {
            Some(session) => session,
            None => Session::open(self.display.as_deref(), &self.auth, deadline)?,
        };
        match session.lookup(deadline) {
            Ok(Some(info)) => {
                self.session = Some(session);
                Ok(Some(info))
            }
            Ok(None) => {
                self.session = Some(session);
                Err(NO_ACTIVE_WINDOW.into())
            }
            Err(err @ ReplyError::X11Error(_)) => {
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
