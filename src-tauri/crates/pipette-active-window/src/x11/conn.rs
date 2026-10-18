// SPDX-License-Identifier: GPL-2.0-or-later
//! A connection to an X server with the two core requests the lookup makes,
//! InternAtom and GetProperty, one at a time and in little-endian order. It
//! connects the way libxcb does (the abstract socket, then the socket file,
//! then TCP) and authorizes with the MIT-MAGIC-COOKIE-1 cookie of the
//! authority file, or with none.

use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::os::linux::net::SocketAddrExt;
use std::os::unix::net::{SocketAddr, UnixStream};
use std::path::Path;
use std::time::Duration;

use super::display::{AuthAddress, DisplayName, MIT_MAGIC_COOKIE, find_cookie, parse_authority};

/// How long one read or write may block. Xlib waits forever; a server that
/// stops answering would otherwise hold the analytics flush.
pub(crate) const IO_TIMEOUT: Duration = Duration::from_secs(2);

const X_TCP_PORT: u16 = 6000;

/// Predefined atoms.
pub(crate) const ATOM_STRING: u32 = 31;
pub(crate) const ATOM_WINDOW: u32 = 33;
pub(crate) const ATOM_WM_NAME: u32 = 39;
pub(crate) const ATOM_WM_CLASS: u32 = 67;
/// The `type` of GetProperty that takes a property of any type.
pub(crate) const ANY_PROPERTY_TYPE: u32 = 0;

#[derive(Debug)]
pub(crate) enum Error {
    /// The socket failed or timed out; the connection is unusable.
    Io(io::Error),
    /// The server answered the request with an X error of this code.
    X(u8),
    /// The display name or the server's answers make no sense, or the
    /// server refused the connection.
    Protocol(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Io(err) => write!(f, "X connection failed: {err}"),
            Error::X(code) => write!(f, "X error {code}"),
            Error::Protocol(reason) => write!(f, "X connection failed: {reason}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<io::Error> for Error {
    fn from(err: io::Error) -> Self {
        Error::Io(err)
    }
}

trait Socket: Read + Write + Send {}
impl Socket for UnixStream {}
impl Socket for TcpStream {}

/// A property as GetProperty returns it. `type_` is 0 (None) and `value`
/// empty when the window has no such property; when the property has another
/// type than the one asked for, `value` is empty too.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Property {
    pub type_: u32,
    pub format: u8,
    pub value: Vec<u8>,
}

pub(crate) struct Connection {
    socket: Box<dyn Socket>,
    sequence: u16,
    root: u32,
    #[cfg(test)]
    pub(super) ids: (u32, u32, u32),
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

const fn pad4(n: usize) -> usize {
    (4 - n % 4) % 4
}

fn open_socket(display: &DisplayName, hostname: &str) -> Result<(Box<dyn Socket>, AuthAddress), Error> {
    let local = AuthAddress::local(hostname);
    if display.is_local() {
        let path = format!("/tmp/.X11-unix/X{}", display.number);
        let abstract_name = SocketAddr::from_abstract_name(path.as_bytes())?;
        if let Ok(socket) = UnixStream::connect_addr(&abstract_name).or_else(|_| UnixStream::connect(&path)) {
            socket.set_read_timeout(Some(IO_TIMEOUT))?;
            socket.set_write_timeout(Some(IO_TIMEOUT))?;
            return Ok((Box::new(socket), local));
        }
        if display.protocol.is_some() || !display.host.is_empty() {
            return Err(Error::Protocol(format!("cannot connect to the socket {path}")));
        }
    }
    match display.protocol.as_deref() {
        None | Some("tcp" | "inet" | "inet6") => {}
        Some(other) => return Err(Error::Protocol(format!("unsupported protocol {other}"))),
    }
    let host = if display.host.is_empty() { "localhost" } else { display.host.as_str() };
    let port = X_TCP_PORT
        .checked_add(display.number)
        .ok_or_else(|| Error::Protocol("display number too large".into()))?;
    let mut last = io::Error::new(io::ErrorKind::NotFound, format!("no address for {host}"));
    for address in (host, port).to_socket_addrs()? {
        match TcpStream::connect_timeout(&address, IO_TIMEOUT) {
            Ok(socket) => {
                socket.set_read_timeout(Some(IO_TIMEOUT))?;
                socket.set_write_timeout(Some(IO_TIMEOUT))?;
                socket.set_nodelay(true)?;
                let auth = AuthAddress::for_peer(socket.peer_addr()?.ip(), hostname);
                return Ok((Box::new(socket), auth));
            }
            Err(err) => last = err,
        }
    }
    Err(Error::Io(last))
}

impl Connection {
    /// Opens `display` (a display name such as `:0`), authorizing with the
    /// cookie that `authority` (an authority file, if any) has for it.
    pub fn open(display: &str, authority: Option<&Path>, hostname: &str) -> Result<Self, Error> {
        let name = DisplayName::parse(display)
            .ok_or_else(|| Error::Protocol(format!("cannot parse the display name {display:?}")))?;
        let (socket, address) = open_socket(&name, hostname)?;
        let entries =
            authority.and_then(|path| std::fs::read(path).ok()).map(|bytes| parse_authority(&bytes));
        let cookie = entries.and_then(|entries| find_cookie(&entries, &address, name.number));
        Self::setup(socket, cookie.as_deref(), name.screen)
    }

    fn setup(mut socket: Box<dyn Socket>, cookie: Option<&[u8]>, screen: usize) -> Result<Self, Error> {
        let (auth_name, auth_data) = match cookie {
            Some(cookie) => (MIT_MAGIC_COOKIE, cookie),
            None => (&b""[..], &b""[..]),
        };
        let mut request = vec![b'l', 0];
        request.extend(11u16.to_le_bytes());
        request.extend(0u16.to_le_bytes());
        request.extend((auth_name.len() as u16).to_le_bytes());
        request.extend((auth_data.len() as u16).to_le_bytes());
        request.extend([0, 0]);
        for field in [auth_name, auth_data] {
            request.extend(field);
            request.extend(std::iter::repeat_n(0, pad4(field.len())));
        }
        socket.write_all(&request)?;

        let mut head = [0u8; 8];
        socket.read_exact(&mut head)?;
        let mut body = vec![0u8; usize::from(u16_at(&head, 6)) * 4];
        socket.read_exact(&mut body)?;
        match head[0] {
            1 => {}
            0 => {
                let reason = body.get(..usize::from(head[1])).unwrap_or_default();
                return Err(Error::Protocol(format!(
                    "the server refused the connection: {}",
                    String::from_utf8_lossy(reason).trim_end()
                )));
            }
            _ => return Err(Error::Protocol("the server asks for another authorization".into())),
        }
        let malformed = || Error::Protocol("malformed connection setup".into());
        if body.len() < 32 {
            return Err(malformed());
        }
        let vendor = usize::from(u16_at(&body, 16));
        let screens = usize::from(body[20]);
        let formats = usize::from(body[21]);
        let mut at = 32 + vendor + pad4(vendor) + formats * 8;
        if screen >= screens {
            return Err(Error::Protocol(format!("the server has no screen {screen}")));
        }
        for _ in 0..screen {
            let depths = usize::from(*body.get(at + 39).ok_or_else(malformed)?);
            at += 40;
            for _ in 0..depths {
                let visuals = usize::from(u16_at(body.get(at..at + 4).ok_or_else(malformed)?, 2));
                at += 8 + visuals * 24;
            }
        }
        let root = u32_at(body.get(at..at + 4).ok_or_else(malformed)?, 0);
        Ok(Self {
            socket,
            sequence: 0,
            root,
            #[cfg(test)]
            ids: (u32_at(&body, 4), u32_at(&body, 8), 1),
        })
    }

    /// The root window of the display's screen.
    pub fn root(&self) -> u32 {
        self.root
    }

    /// Sends a request whose length in 4-byte units is filled in here.
    pub(super) fn send(&mut self, mut request: Vec<u8>) -> Result<u16, Error> {
        request.resize(request.len() + pad4(request.len()), 0);
        let units =
            u16::try_from(request.len() / 4).map_err(|_| Error::Protocol("request too long".into()))?;
        request[2..4].copy_from_slice(&units.to_le_bytes());
        self.socket.write_all(&request)?;
        self.sequence = self.sequence.wrapping_add(1);
        Ok(self.sequence)
    }

    /// The reply to request `sequence`. Events are skipped. An error for an
    /// earlier request (one without a reply) is returned after the reply has
    /// been read, so the stream stays in step.
    pub(super) fn reply(&mut self, sequence: u16) -> Result<Vec<u8>, Error> {
        let mut earlier = None;
        loop {
            let mut packet = vec![0u8; 32];
            self.socket.read_exact(&mut packet)?;
            let seq = u16_at(&packet, 2);
            match packet[0] {
                0 if seq == sequence => return Err(Error::X(packet[1])),
                0 => {
                    earlier.get_or_insert(packet[1]);
                }
                kind => {
                    let extra =
                        if kind == 1 || kind & 0x7f == 35 { u32_at(&packet, 4) as usize * 4 } else { 0 };
                    let mut rest = vec![0u8; extra];
                    self.socket.read_exact(&mut rest)?;
                    if kind == 1 && seq == sequence {
                        packet.extend(rest);
                        return match earlier {
                            Some(code) => Err(Error::X(code)),
                            None => Ok(packet),
                        };
                    }
                }
            }
        }
    }

    /// InternAtom: the atom named `name`, or 0 when `only_if_exists` and the
    /// server has no such atom.
    pub fn intern_atom(&mut self, name: &str, only_if_exists: bool) -> Result<u32, Error> {
        let length = u16::try_from(name.len()).map_err(|_| Error::Protocol("atom name too long".into()))?;
        let mut request = vec![16, u8::from(only_if_exists), 0, 0];
        request.extend(length.to_le_bytes());
        request.extend([0, 0]);
        request.extend(name.as_bytes());
        let sequence = self.send(request)?;
        Ok(u32_at(&self.reply(sequence)?, 8))
    }

    /// GetProperty without deleting: up to `long_length` 4-byte units of
    /// `property` on `window` if it has type `type_` (or any type, with
    /// [`ANY_PROPERTY_TYPE`]).
    pub fn get_property(
        &mut self,
        window: u32,
        property: u32,
        type_: u32,
        long_length: u32,
    ) -> Result<Property, Error> {
        let mut request = vec![20, 0, 0, 0];
        for field in [window, property, type_, 0, long_length] {
            request.extend(field.to_le_bytes());
        }
        let sequence = self.send(request)?;
        let reply = self.reply(sequence)?;
        let format = reply[1];
        let items = u32_at(&reply, 16) as usize;
        let bytes = items * usize::from(format / 8);
        let value =
            reply.get(32..32 + bytes).ok_or_else(|| Error::Protocol("short GetProperty reply".into()))?;
        Ok(Property { type_: u32_at(&reply, 8), format, value: value.to_vec() })
    }
}
