// SPDX-License-Identifier: GPL-2.0-or-later
//! Where an X display is and the cookie to open it with, found from the
//! display name and the authority file the way Xlib (through libxcb) finds
//! them.

use std::net::IpAddr;
use std::path::{Path, PathBuf};

/// A display name `[protocol/][host]:number[.screen]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DisplayName {
    pub protocol: Option<String>,
    pub host: String,
    pub number: u16,
    pub screen: usize,
}

impl DisplayName {
    /// Parses `name` as libxcb's `xcb_parse_display` does: the display
    /// number after the last `:`, an optional `.screen` after it, an IPv6
    /// host in brackets. `None` for what it rejects, and for the forms Xlib
    /// on Linux does not use either (a socket path, DECnet's `host::n`).
    pub fn parse(name: &str) -> Option<Self> {
        if name.starts_with('/') {
            return None;
        }
        let (protocol, rest) = match name.split_once('/') {
            Some((protocol, rest)) if !protocol.contains(':') => (Some(protocol.to_owned()), rest),
            _ => (None, name),
        };
        let (host, display) = rest.rsplit_once(':')?;
        if host.ends_with(':') {
            return None;
        }
        let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
        let (number, screen) = match display.split_once('.') {
            Some((number, screen)) => (number, Some(screen)),
            None => (display, None),
        };
        let number = parse_digits(number)?.try_into().ok()?;
        let screen = match screen {
            Some(screen) => parse_digits(screen)?,
            None => 0,
        };
        Some(Self { protocol, host: host.to_owned(), number, screen })
    }

    /// Whether the display is reached through the local socket first: no
    /// host, `unix` as the host or the protocol.
    pub fn is_local(&self) -> bool {
        self.host.is_empty() || self.host == "unix" || self.protocol.as_deref() == Some("unix")
    }
}

fn parse_digits(text: &str) -> Option<usize> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

pub(crate) const FAMILY_INTERNET: u16 = 0;
pub(crate) const FAMILY_INTERNET6: u16 = 6;
pub(crate) const FAMILY_LOCAL: u16 = 256;
pub(crate) const FAMILY_WILD: u16 = 65535;

pub(crate) const MIT_MAGIC_COOKIE: &[u8] = b"MIT-MAGIC-COOKIE-1";

/// One entry of an authority file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AuthEntry {
    pub family: u16,
    pub address: Vec<u8>,
    pub number: Vec<u8>,
    pub name: Vec<u8>,
    pub data: Vec<u8>,
}

/// The entries of an authority file, up to the first one that is cut short.
pub(crate) fn parse_authority(bytes: &[u8]) -> Vec<AuthEntry> {
    fn take<'a>(bytes: &mut &'a [u8], n: usize) -> Option<&'a [u8]> {
        if bytes.len() < n {
            return None;
        }
        let (head, tail) = bytes.split_at(n);
        *bytes = tail;
        Some(head)
    }
    fn u16_be(bytes: &mut &[u8]) -> Option<u16> {
        take(bytes, 2).map(|b| u16::from_be_bytes([b[0], b[1]]))
    }
    fn field(bytes: &mut &[u8]) -> Option<Vec<u8>> {
        let length = u16_be(bytes)?;
        take(bytes, usize::from(length)).map(<[u8]>::to_vec)
    }
    let mut rest = bytes;
    let mut entries = Vec::new();
    while !rest.is_empty() {
        let entry = (|| {
            Some(AuthEntry {
                family: u16_be(&mut rest)?,
                address: field(&mut rest)?,
                number: field(&mut rest)?,
                name: field(&mut rest)?,
                data: field(&mut rest)?,
            })
        })();
        match entry {
            Some(entry) => entries.push(entry),
            None => break,
        }
    }
    entries
}

/// The address the authority file is searched with, as libxcb gives it
/// for a connection: the host name for the local socket and for a loopback
/// TCP peer, the peer's address otherwise.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AuthAddress {
    pub family: u16,
    pub address: Vec<u8>,
}

impl AuthAddress {
    pub fn local(hostname: &str) -> Self {
        Self { family: FAMILY_LOCAL, address: hostname.as_bytes().to_vec() }
    }

    pub fn for_peer(peer: IpAddr, hostname: &str) -> Self {
        let peer = match peer {
            IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
            v4 => v4,
        };
        match peer {
            peer if peer.is_loopback() => Self::local(hostname),
            IpAddr::V4(v4) => Self { family: FAMILY_INTERNET, address: v4.octets().to_vec() },
            IpAddr::V6(v6) => Self { family: FAMILY_INTERNET6, address: v6.octets().to_vec() },
        }
    }
}

/// The MIT-MAGIC-COOKIE-1 cookie for display `number` at `address`, as
/// `XauGetBestAuthByAddr` picks it: the first entry whose family is
/// FamilyWild or whose family and address match, and whose display number
/// is empty or matches. The only authorization sent is that cookie.
pub(crate) fn find_cookie(entries: &[AuthEntry], address: &AuthAddress, number: u16) -> Option<Vec<u8>> {
    let number = number.to_string();
    entries
        .iter()
        .find(|entry| {
            let host = entry.family == FAMILY_WILD
                || (entry.family == address.family && entry.address == address.address);
            let display = entry.number.is_empty() || entry.number == number.as_bytes();
            host && display && entry.name == MIT_MAGIC_COOKIE
        })
        .map(|entry| entry.data.clone())
}

/// The authority file Xlib reads: `XAUTHORITY` when set and not empty,
/// else `.Xauthority` in `HOME`.
pub(crate) fn authority_path(xauthority: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    match xauthority {
        Some(path) if !path.is_empty() => Some(PathBuf::from(path)),
        _ => home.map(|home| Path::new(home).join(".Xauthority")),
    }
}

/// The host name that `FamilyLocal` entries are keyed by (`gethostname`).
pub(crate) fn hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .map(|name| name.trim_end_matches('\n').to_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(protocol: Option<&str>, host: &str, number: u16, screen: usize) -> Option<DisplayName> {
        Some(DisplayName { protocol: protocol.map(str::to_owned), host: host.to_owned(), number, screen })
    }

    #[test]
    fn display_names_parse_as_libxcb_does() {
        assert_eq!(DisplayName::parse(":0"), display(None, "", 0, 0));
        assert_eq!(DisplayName::parse(":90.1"), display(None, "", 90, 1));
        assert_eq!(DisplayName::parse("unix:3"), display(None, "unix", 3, 0));
        assert_eq!(DisplayName::parse("unix/:3"), display(Some("unix"), "", 3, 0));
        assert_eq!(DisplayName::parse("localhost:10.0"), display(None, "localhost", 10, 0));
        assert_eq!(DisplayName::parse("tcp/example.org:1"), display(Some("tcp"), "example.org", 1, 0));
        assert_eq!(DisplayName::parse("[::1]:2"), display(None, "::1", 2, 0));
        assert_eq!(DisplayName::parse("::1:2"), display(None, "::1", 2, 0));
        for bad in ["", "0", ":", ":x", ":0.", ":0.x", "host::0", "/tmp/launch/org.x:0", ":70000"] {
            assert_eq!(DisplayName::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn only_a_hostless_or_unix_display_is_local() {
        let local = |name: &str| DisplayName::parse(name).map(|d| d.is_local());
        assert_eq!(local(":0"), Some(true));
        assert_eq!(local("unix/:0"), Some(true));
        assert_eq!(local("unix:0"), Some(true));
        assert_eq!(local("localhost:0"), Some(false));
    }

    fn entry(family: u16, address: &[u8], number: &str, name: &[u8], data: &[u8]) -> AuthEntry {
        AuthEntry {
            family,
            address: address.to_vec(),
            number: number.as_bytes().to_vec(),
            name: name.to_vec(),
            data: data.to_vec(),
        }
    }

    fn encode(entries: &[AuthEntry]) -> Vec<u8> {
        let mut out = Vec::new();
        for e in entries {
            out.extend(e.family.to_be_bytes());
            for field in [&e.address, &e.number, &e.name, &e.data] {
                out.extend((field.len() as u16).to_be_bytes());
                out.extend(field);
            }
        }
        out
    }

    #[test]
    fn authority_files_parse_up_to_a_cut_entry() {
        let entries = vec![
            entry(FAMILY_LOCAL, b"box", "0", MIT_MAGIC_COOKIE, &[1, 2]),
            entry(FAMILY_WILD, b"", "", MIT_MAGIC_COOKIE, &[3]),
        ];
        let bytes = encode(&entries);
        assert_eq!(parse_authority(&bytes), entries);
        assert_eq!(parse_authority(&bytes[..bytes.len() - 1]), entries[..1].to_vec());
        assert_eq!(parse_authority(&[]), Vec::new());
    }

    #[test]
    fn the_cookie_is_the_first_matching_entry() {
        let local = AuthAddress::local("box");
        let entries = vec![
            entry(FAMILY_LOCAL, b"other", "0", MIT_MAGIC_COOKIE, b"other host"),
            entry(FAMILY_LOCAL, b"box", "1", MIT_MAGIC_COOKIE, b"other display"),
            entry(FAMILY_LOCAL, b"box", "0", b"XDM-AUTHORIZATION-1", b"other scheme"),
            entry(FAMILY_LOCAL, b"box", "0", MIT_MAGIC_COOKIE, b"match"),
            entry(FAMILY_WILD, b"", "", MIT_MAGIC_COOKIE, b"wild"),
        ];
        assert_eq!(find_cookie(&entries, &local, 0), Some(b"match".to_vec()));
        assert_eq!(find_cookie(&entries, &local, 1), Some(b"other display".to_vec()));
        assert_eq!(find_cookie(&entries, &local, 7), Some(b"wild".to_vec()));
        assert_eq!(find_cookie(&entries[..3], &local, 7), None);
        let any_number = [entry(FAMILY_LOCAL, b"box", "", MIT_MAGIC_COOKIE, b"any")];
        assert_eq!(find_cookie(&any_number, &local, 42), Some(b"any".to_vec()));
    }

    #[test]
    fn tcp_peers_are_looked_up_by_address_or_as_local_on_loopback() {
        let v4: IpAddr = "192.0.2.7".parse().unwrap_or(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED));
        assert_eq!(
            AuthAddress::for_peer(v4, "box"),
            AuthAddress { family: FAMILY_INTERNET, address: vec![192, 0, 2, 7] }
        );
        let mapped: IpAddr = "::ffff:192.0.2.7".parse().unwrap_or(v4);
        assert_eq!(AuthAddress::for_peer(mapped, "box").family, FAMILY_INTERNET);
        let v6: IpAddr = "2001:db8::1".parse().unwrap_or(v4);
        assert_eq!(AuthAddress::for_peer(v6, "box").family, FAMILY_INTERNET6);
        for loopback in ["127.0.0.1", "::1", "::ffff:127.0.0.1"] {
            let peer: IpAddr = loopback.parse().unwrap_or(v4);
            assert_eq!(AuthAddress::for_peer(peer, "box"), AuthAddress::local("box"), "{loopback}");
        }
    }

    #[test]
    fn the_authority_file_is_xauthority_or_the_one_in_home() {
        assert_eq!(authority_path(Some("/a/auth"), Some("/home/u")), Some(PathBuf::from("/a/auth")));
        assert_eq!(authority_path(Some(""), Some("/home/u")), Some(PathBuf::from("/home/u/.Xauthority")));
        assert_eq!(authority_path(None, Some("/home/u")), Some(PathBuf::from("/home/u/.Xauthority")));
        assert_eq!(authority_path(None, None), None);
    }
}
