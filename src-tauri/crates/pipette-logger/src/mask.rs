// SPDX-License-Identifier: GPL-2.0-or-later
//! The home folder in log lines, replaced with `~` (best effort).
//!
//! A home given as a Windows path (a drive letter or a backslash) matches
//! ASCII letters in any case, with `\`, `/` or the `\\` of a `{:?}` string
//! between its parts; a Unix home matches exactly, with `/` only. A match
//! counts only as a whole path start: the character before it must not be
//! part of a path (start of line, whitespace, a quote, an opening bracket,
//! `=`, `:`, `;`, `,`; for a Windows home also the verbatim prefixes `\\?\`
//! and `\\?\UNC\`), and the one after it must end the home (end of line,
//! a separator, whitespace, a quote, a closing bracket, `:`, `;`, `,`). So
//! `/mnt/home/alice` and `/home/alice2` stay as they are. A symlinked home
//! and its canonical path are not told apart: only the given form matches.

use std::borrow::Cow;
use std::path::Path;

/// What matches the home in a line. Empty: nothing is replaced.
#[derive(Debug, Default)]
pub struct HomeMask {
    /// The home's parts, without separators.
    parts: Vec<String>,
    /// A Windows home: case-insensitive, `\` and `/` both separate.
    windows: bool,
}

impl HomeMask {
    /// The mask for `home`. A home that is missing, not UTF-8, the root, or a
    /// single part (a container's `HOME=/` or `/root`) masks nothing.
    pub fn new(home: Option<&Path>) -> Self {
        let Some(home) = home.and_then(Path::to_str) else {
            return Self::default();
        };
        let windows = home.contains('\\') || home.as_bytes().get(1) == Some(&b':');
        let is_separator = |c: char| c == '/' || (windows && c == '\\');
        let parts: Vec<String> =
            home.split(is_separator).filter(|part| !part.is_empty()).map(str::to_owned).collect();
        // A Unix home starts at `/`, a Windows one at its drive.
        let rooted = home.starts_with('/') || windows;
        if parts.len() < 2 || !rooted {
            return Self::default();
        }
        Self { parts, windows }
    }

    /// `line` with each whole-path occurrence of the home replaced with `~`.
    /// Borrows `line` when there is none.
    pub fn apply<'a>(&self, line: &'a str) -> Cow<'a, str> {
        if self.parts.is_empty() {
            return Cow::Borrowed(line);
        }
        let bytes = line.as_bytes();
        let mut out: Option<String> = None;
        // The end of the text already copied to `out`.
        let mut copied = 0;
        let mut at = 0;
        while at < bytes.len() {
            if (at == 0 || starts_after(bytes[at - 1]) || self.after_verbatim_prefix(&bytes[..at]))
                && let Some(end) = self.match_at(bytes, at)
                && bytes.get(end).is_none_or(|&next| ends_before(next))
            {
                let masked = out.get_or_insert_with(|| String::with_capacity(line.len()));
                // `at` follows an ASCII byte (or starts the line) and `end`
                // ends the home's last part, so both are char boundaries.
                masked.push_str(&line[copied..at]);
                masked.push('~');
                copied = end;
                at = end;
                continue;
            }
            at += 1;
        }
        match out {
            Some(mut masked) => {
                masked.push_str(&line[copied..]);
                Cow::Owned(masked)
            }
            None => Cow::Borrowed(line),
        }
    }

    /// Whether `before` ends with a verbatim prefix that starts the path (at
    /// the line's start or after a boundary). Windows homes only.
    fn after_verbatim_prefix(&self, before: &[u8]) -> bool {
        self.windows
            && VERBATIM_PREFIXES.iter().any(|prefix| {
                before.ends_with(prefix) && {
                    let start = before.len() - prefix.len();
                    start == 0 || starts_after(before[start - 1])
                }
            })
    }

    /// The end of the home when it starts at `at`.
    fn match_at(&self, bytes: &[u8], mut at: usize) -> Option<usize> {
        if !self.windows {
            // A Unix home starts with its root `/`.
            if bytes.get(at) != Some(&b'/') {
                return None;
            }
            at += 1;
        }
        for (index, part) in self.parts.iter().enumerate() {
            if index > 0 {
                at = self.skip_separator(bytes, at)?;
            }
            let end = at + part.len();
            let text = bytes.get(at..end)?;
            let same = if self.windows {
                text.eq_ignore_ascii_case(part.as_bytes())
            } else {
                text == part.as_bytes()
            };
            if !same {
                return None;
            }
            at = end;
        }
        Some(at)
    }

    /// The position after the separator at `at`: `/`, or on Windows also
    /// `\` or the escaped `\\`.
    fn skip_separator(&self, bytes: &[u8], at: usize) -> Option<usize> {
        match bytes.get(at)? {
            b'/' => Some(at + 1),
            b'\\' if self.windows => Some(if bytes.get(at + 1) == Some(&b'\\') { at + 2 } else { at + 1 }),
            _ => None,
        }
    }
}

/// Whether a home may start right after `byte`. Not after `/` or `\`, so a
/// home inside another path (`/mnt/home/…`, `\\other\server\share`) stays.
fn starts_after(byte: u8) -> bool {
    byte.is_ascii_whitespace()
        || matches!(byte, b'"' | b'\'' | b'`' | b'(' | b'[' | b'{' | b'<' | b'=' | b':' | b';' | b',')
}

/// The Windows verbatim prefixes a home may follow (`\\?\C:\Users\…`,
/// `\\?\UNC\server\share\…`).
const VERBATIM_PREFIXES: [&[u8]; 2] = [br"\\?\", br"\\?\UNC\"];

/// Whether `byte` may follow a whole home.
fn ends_before(byte: u8) -> bool {
    byte.is_ascii_whitespace()
        || matches!(byte, b'/' | b'\\' | b'"' | b'\'' | b'`' | b')' | b']' | b'}' | b'>' | b':' | b';' | b',')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mask(home: &str, line: &str) -> String {
        HomeMask::new(Some(Path::new(home))).apply(line).into_owned()
    }

    #[test]
    fn a_unix_home_becomes_a_tilde() {
        assert_eq!(mask("/home/alice", "/home/alice/.config/x"), "~/.config/x");
        assert_eq!(mask("/home/alice/", "open /home/alice/a and /home/alice/b"), "open ~/a and ~/b");
        assert_eq!(mask("/Users/alice", "dir=/Users/alice"), "dir=~");
        assert_eq!(mask("/home/alice", "(/home/alice/x) [/home/alice]"), "(~/x) [~]");
        assert_eq!(mask("/home/alice", "\"/home/alice/x\": gone"), "\"~/x\": gone");
    }

    #[test]
    fn a_unix_home_matches_case_sensitively() {
        assert_eq!(mask("/home/alice", "/HOME/ALICE/x"), "/HOME/ALICE/x");
    }

    #[test]
    fn only_a_whole_path_start_matches() {
        assert_eq!(mask("/home/al", "/mnt/home/al/x"), "/mnt/home/al/x");
        assert_eq!(mask("/home/al", "/home/alice/x"), "/home/alice/x");
        assert_eq!(mask("/home/al", "/home/al.bak"), "/home/al.bak");
        assert_eq!(mask("/home/al", "x/home/al"), "x/home/al");
    }

    #[test]
    fn a_path_with_spaces_keeps_what_follows_the_home() {
        assert_eq!(mask("/home/alice", "/home/alice/My Files/a b.txt"), "~/My Files/a b.txt");
        assert_eq!(mask(r"C:\Users\John Smith", r"C:\Users\John Smith\Documents"), r"~\Documents");
        assert_eq!(mask(r"C:\Users\John Smith", r"C:\Users\John Smithers"), r"C:\Users\John Smithers");
    }

    #[test]
    fn a_windows_home_matches_any_separator_and_case() {
        let home = r"C:\Users\Alice";
        assert_eq!(mask(home, r"C:\Users\Alice\AppData"), r"~\AppData");
        assert_eq!(mask(home, "c:/users/alice/AppData"), "~/AppData");
        assert_eq!(mask(home, r#"path: "C:\\Users\\Alice\\AppData""#), r#"path: "~\\AppData""#);
        assert_eq!(mask(home, r"C:\Users/alice\x"), r"~\x");
        assert_eq!(mask(home, r"D:\Users\Alice\x"), r"D:\Users\Alice\x");
    }

    #[test]
    fn a_windows_verbatim_path_keeps_its_prefix() {
        assert_eq!(mask(r"C:\Users\Alice", r"open \\?\C:\Users\Alice\AppData"), r"open \\?\~\AppData");
        assert_eq!(mask(r"\\server\share", r"\\?\UNC\server\share\x"), r"\\?\UNC\~\x");
    }

    #[test]
    fn a_home_after_a_backslash_inside_another_path_stays() {
        assert_eq!(mask("/home/alice", r"/mnt/x\/home/alice"), r"/mnt/x\/home/alice");
        assert_eq!(mask(r"\\server\share", r"\\other\server\share"), r"\\other\server\share");
        assert_eq!(mask(r"C:\Users\Alice", r"x\\?\C:\Users\Alice"), r"x\\?\C:\Users\Alice");
    }

    #[test]
    fn a_line_with_both_forms_masks_each() {
        let home = r"C:\Users\Alice\";
        assert_eq!(mask(home, r"from C:\Users\Alice\a to C:/Users/Alice/b"), r"from ~\a to ~/b");
    }

    #[test]
    fn a_short_or_missing_home_masks_nothing() {
        assert_eq!(mask("/", "/x"), "/x");
        assert_eq!(mask("/root", "/root/x"), "/root/x");
        assert_eq!(mask("", "x"), "x");
        assert_eq!(mask(r"C:\", r"C:\x"), r"C:\x");
        assert_eq!(mask("home/alice", "home/alice/x"), "home/alice/x");
        assert_eq!(HomeMask::new(None).apply("/home/alice"), "/home/alice");
    }

    #[test]
    fn a_line_without_the_home_is_borrowed() {
        let mask = HomeMask::new(Some(Path::new("/home/alice")));
        assert!(matches!(mask.apply("nothing here"), Cow::Borrowed(_)));
        assert_eq!(mask.apply("ü /home/alice ü"), "ü ~ ü");
    }
}
