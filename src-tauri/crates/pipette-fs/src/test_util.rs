// SPDX-License-Identifier: GPL-2.0-or-later
//! Whether the host's file system can hold a tree the golden tests recorded
//! on Linux. Windows refuses some names (its reserved device names, a name
//! that ends in `.` or a space, the characters `<>:"|?*` and control
//! characters), Windows and macOS compare names without regard to case by
//! default, and only Unix makes symbolic links without privileges, so a
//! scenario that needs one of these is left out there rather than compared.

use std::collections::HashMap;
use std::path::Path;

/// Why the tree of `paths` (relative, `/`-separated, a directory possibly
/// ending in `/`) cannot be built under `root` as it was recorded, or
/// `None` when it can. `symlinks` is whether the tree has symbolic links.
/// `root` must exist; a probe file is made in it and removed.
pub fn unsupported_tree<'a>(
    root: &Path,
    paths: impl IntoIterator<Item = &'a str>,
    symlinks: bool,
) -> Option<String> {
    if symlinks && !cfg!(unix) {
        return Some("the tree has symbolic links".to_owned());
    }
    let paths: Vec<&str> = paths.into_iter().map(|path| path.trim_end_matches('/')).collect();
    if let Some(name) = paths.iter().flat_map(|path| path.split('/')).find(|name| !host_holds_name(name)) {
        return Some(format!("the file system cannot hold the name {name:?}"));
    }
    if ignores_case(root) {
        let mut seen: HashMap<String, &str> = HashMap::new();
        for path in &paths {
            // Every leading part, so two directories that differ in case
            // count as well.
            for (end, _) in path.match_indices('/').chain([(path.len(), "")]) {
                let part = &path[..end];
                match seen.insert(part.to_lowercase(), part) {
                    Some(other) if other != part => {
                        return Some(format!("{other:?} and {part:?} differ only in case"));
                    }
                    _ => {}
                }
            }
        }
    }
    None
}

/// Whether the host's file system can hold a file named `name`.
pub fn host_holds_name(name: &str) -> bool {
    !cfg!(windows) || windows_holds_name(name)
}

fn windows_holds_name(name: &str) -> bool {
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = name.split('.').next().unwrap_or(name).trim_end_matches(' ');
    !name.is_empty()
        && !name.ends_with(['.', ' '])
        && !name.chars().any(|c| c < ' ' || "<>:\"|?*\\".contains(c))
        && !RESERVED.iter().any(|reserved| stem.eq_ignore_ascii_case(reserved))
}

/// Whether the file system under `root` takes a name in another case for
/// the same file.
fn ignores_case(root: &Path) -> bool {
    let probe = root.join(".pipette-case-probe");
    if std::fs::write(&probe, b"").is_err() {
        return false;
    }
    let ignores = root.join(".PIPETTE-CASE-PROBE").exists();
    let _ = std::fs::remove_file(&probe);
    ignores
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_names() {
        for name in ["a.json", "ctl name", ".hidden", "nullable.json", "COM10", "a b#c"] {
            assert!(windows_holds_name(name), "{name}");
        }
        for name in ["dot.", "trailing ", "a?b", "a:b", "ctl\u{1}", "nul.json", "Con", "lpt1.txt", ""] {
            assert!(!windows_holds_name(name), "{name}");
        }
    }

    #[test]
    fn a_tree_this_host_holds_has_no_reason() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(unsupported_tree(dir.path(), ["a/", "a/b.json", "c"], false), None);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn names_that_differ_only_in_case_collide_where_case_is_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let reason = unsupported_tree(dir.path(), ["in/doc.txt", "IN/other.txt"], false);
        assert_eq!(reason.is_some(), ignores_case(dir.path()));
    }

    #[test]
    fn symbolic_links_need_unix() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(unsupported_tree(dir.path(), ["link"], true).is_some(), !cfg!(unix));
    }
}
