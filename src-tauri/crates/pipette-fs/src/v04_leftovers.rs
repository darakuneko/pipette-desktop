// SPDX-License-Identifier: GPL-2.0-or-later
//! Removes what the 0.4 build and the builds before it left in the userData
//! directory this build takes over: the Chromium profile, the 0.4 build's
//! encrypted sign-in and sync password (`local/auth/*.enc`), and files no
//! build reads any more.
//!
//! Only the names listed here are touched. Chromium's lock files
//! (`SingletonLock`, `SingletonSocket`, `SingletonCookie`, `lockfile`) stay:
//! they are how this build finds a running 0.4 build and, on Windows, how it
//! keeps one out. Symbolic links are never followed: a listed entry that is
//! a link loses the link only, and when `local` or `local/auth` is not a
//! directory of its own (a link, a Windows junction or a file) nothing under
//! it is touched.
//!
//! Errors are logged and the rest goes on; nothing here stops the app.

use std::io::ErrorKind;
use std::path::Path;

use crate::v04_lock_holder;

/// The Chromium profile the 0.4 build kept directly in the userData
/// directory. Its renderer used none of the web storage in it.
const CHROMIUM_PROFILE: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "Cookies",
    "Cookies-journal",
    "Crashpad",
    "DIPS",
    "DIPS-journal",
    "DevToolsActivePort",
    "Dictionaries",
    "Local State",
    "Local Storage",
    "Network Persistent State",
    "Preferences",
    "Session Storage",
    "Shared Dictionary",
    "SharedStorage",
    "TransportSecurity",
    "Trust Tokens",
    "Trust Tokens-journal",
    "WebStorage",
    "blob_storage",
    "IndexedDB",
    "Service Worker",
    "databases",
    "declarative_performance_observer.db",
    "declarative_performance_observer.db-journal",
];

/// The start of the names of Chromium's temporary files in the userData
/// directory.
const CHROMIUM_TEMP_PREFIX: &str = ".org.chromium.Chromium.";

/// What the builds before 0.4 kept directly in the userData directory.
const PRE_V04_TOP_LEVEL: &[&str] = &["window-state.json", "languages"];

/// The directory of the app's local state, and in it the one of the
/// secrets.
const LOCAL_DIR: &str = "local";
const AUTH_DIR: &str = "auth";

/// What the builds before 0.4 kept in `local/`.
const PRE_V04_LOCAL_CONFIG: &str = "config.json";

/// The extension of the 0.4 build's secret files in `local/auth/`. This
/// build's own are `tauri-*.bin`.
const V04_SECRET_EXTENSION: &str = ".enc";

/// Removes the 0.4 build's leftovers from `user_data` and returns how many
/// entries went (a directory counts once). Removes nothing when a running
/// 0.4 build holds `user_data` as it starts: on Linux and macOS nothing
/// stops one from starting after this build, and one that starts during
/// the removal is not seen. A missing `user_data` or entry counts as
/// nothing to remove.
pub fn remove_v04_leftovers(user_data: &Path) -> usize {
    if v04_lock_holder(user_data).is_some() {
        log::warn!("the 0.4 build is running; its leftovers stay");
        return 0;
    }
    // Every listed name is UTF-8, so a name that is not cannot match.
    let mut removed = read_entries(user_data)
        .filter(|entry| {
            entry.file_name().to_str().is_some_and(is_top_level_leftover) && remove(&entry.path())
        })
        .count();
    let local = user_data.join(LOCAL_DIR);
    if !is_real_dir(&local) {
        return removed;
    }
    removed += usize::from(remove(&local.join(PRE_V04_LOCAL_CONFIG)));
    let auth = local.join(AUTH_DIR);
    if is_real_dir(&auth) {
        removed += remove_v04_secrets(&auth);
    }
    removed
}

fn is_top_level_leftover(name: &str) -> bool {
    CHROMIUM_PROFILE.contains(&name)
        || PRE_V04_TOP_LEVEL.contains(&name)
        || name.starts_with(CHROMIUM_TEMP_PREFIX)
}

/// The entries of `dir`; none when it cannot be read.
fn read_entries(dir: &Path) -> impl Iterator<Item = std::fs::DirEntry> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => Some(entries),
        Err(err) if err.kind() == ErrorKind::NotFound => None,
        Err(err) => {
            log::warn!("cannot list {}: {err}", dir.display());
            None
        }
    };
    entries.into_iter().flatten().filter_map(move |entry| {
        entry.inspect_err(|err| log::warn!("cannot list an entry of {}: {err}", dir.display())).ok()
    })
}

/// Whether `path` is a directory and not a link or junction to one.
fn is_real_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

/// Removes the regular `*.enc` files directly in `auth`; a link or a
/// directory with such a name stays.
fn remove_v04_secrets(auth: &Path) -> usize {
    read_entries(auth)
        .filter(|entry| {
            // `DirEntry::file_type` does not follow links.
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry.file_name().to_str().is_some_and(|name| name.ends_with(V04_SECRET_EXTENSION))
                && removed_or_logged(&entry.path(), std::fs::remove_file(entry.path()))
        })
        .count()
}

/// Removes `path` without following it: a directory with its content (the
/// standard library's `remove_dir_all` does not follow the links in it), a
/// link as a link. Returns whether it was removed.
fn remove(path: &Path) -> bool {
    let result = std::fs::symlink_metadata(path).and_then(|meta| {
        if meta.is_dir() { std::fs::remove_dir_all(path) } else { remove_entry(path, meta.file_type()) }
    });
    removed_or_logged(path, result)
}

/// Removes a file or a link. A link to a directory or a junction is a
/// directory entry on Windows, removed as one (which leaves its target).
#[cfg(windows)]
fn remove_entry(path: &Path, kind: std::fs::FileType) -> std::io::Result<()> {
    use std::os::windows::fs::FileTypeExt;
    if kind.is_symlink_dir() { std::fs::remove_dir(path) } else { std::fs::remove_file(path) }
}

#[cfg(not(windows))]
fn remove_entry(path: &Path, _kind: std::fs::FileType) -> std::io::Result<()> {
    std::fs::remove_file(path)
}

fn removed_or_logged(path: &Path, result: std::io::Result<()>) -> bool {
    match result {
        Ok(()) => true,
        Err(err) if err.kind() == ErrorKind::NotFound => false,
        Err(err) => {
            log::warn!("cannot remove {}: {err}", path.display());
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    /// What this build keeps in the userData directory, next to the
    /// leftovers.
    const KEPT_FILES: &[&str] = &[
        "config.json",
        "quit-pending.json",
        "SingletonCookie",
        "lockfile",
        "logs/pipette.log",
        "sync/favorites/index.json",
        "typing-analytics/keymaps/x.json",
        "local/installation-id",
        "local/sync-pending.json",
        "local/auth/tauri-oauth-tokens.bin",
        "local/auth/sync-password-change.json",
    ];

    fn user_data() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn file(root: &Path, path: &str) {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"x").unwrap();
    }

    fn dir_with_content(root: &Path, path: &str) {
        file(root, &format!("{path}/inner/data"));
    }

    fn exists(root: &Path, path: &str) -> bool {
        std::fs::symlink_metadata(root.join(path)).is_ok()
    }

    fn entries(root: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if std::fs::symlink_metadata(&path).unwrap().is_dir() {
                    stack.push(path.clone());
                }
                found.push(path.strip_prefix(root).unwrap().to_path_buf());
            }
        }
        found.sort();
        found
    }

    #[test]
    fn the_leftovers_go_and_what_this_build_uses_stays() {
        let dir = user_data();
        let root = dir.path();
        for path in KEPT_FILES {
            file(root, path);
        }
        let kept = entries(root);
        for name in ["Cache", "Code Cache", "GPUCache", "Local Storage", "IndexedDB", "Crashpad"] {
            dir_with_content(root, name);
        }
        for name in ["Cookies", "Preferences", "Local State", "DevToolsActivePort", "window-state.json"] {
            file(root, name);
        }
        dir_with_content(root, "languages");
        file(root, "local/config.json");
        file(root, "local/auth/oauth-tokens.enc");
        file(root, "local/auth/sync-password.enc");
        file(root, "local/auth/sync-password-change-keys.enc");

        assert_eq!(remove_v04_leftovers(root), 16);
        assert_eq!(entries(root), kept);
    }

    #[test]
    fn every_listed_name_goes() {
        let dir = user_data();
        let root = dir.path();
        for name in CHROMIUM_PROFILE.iter().chain(PRE_V04_TOP_LEVEL) {
            file(root, name);
        }
        let listed = CHROMIUM_PROFILE.len() + PRE_V04_TOP_LEVEL.len();
        assert_eq!(remove_v04_leftovers(root), listed);
        assert_eq!(entries(root), Vec::<PathBuf>::new());
    }

    #[test]
    fn a_listed_name_of_the_other_kind_still_goes() {
        let dir = user_data();
        let root = dir.path();
        // Files where Chromium keeps directories, and the other way round.
        file(root, "Cache");
        file(root, "languages");
        dir_with_content(root, "Cookies");
        dir_with_content(root, "window-state.json");
        dir_with_content(root, "local/config.json");
        assert_eq!(remove_v04_leftovers(root), 5);
        assert_eq!(entries(root), vec![PathBuf::from("local")]);
    }

    #[test]
    fn chromium_temporary_files_and_directories_go() {
        let dir = user_data();
        let root = dir.path();
        file(root, ".org.chromium.Chromium.abc123");
        dir_with_content(root, ".org.chromium.Chromium.def456");
        file(root, ".org.chromium.Other");
        assert_eq!(remove_v04_leftovers(root), 2);
        assert_eq!(entries(root), vec![PathBuf::from(".org.chromium.Other")]);
    }

    #[test]
    fn only_regular_enc_files_directly_in_auth_go() {
        let dir = user_data();
        let root = dir.path();
        file(root, "local/auth/oauth-tokens.enc");
        dir_with_content(root, "local/auth/folder.enc");
        file(root, "local/auth/nested/deeper.enc");
        file(root, "local/other.enc");
        file(root, "other.enc");
        assert_eq!(remove_v04_leftovers(root), 1);
        assert!(!exists(root, "local/auth/oauth-tokens.enc"));
        for path in [
            "local/auth/folder.enc/inner/data",
            "local/auth/nested/deeper.enc",
            "local/other.enc",
            "other.enc",
        ] {
            assert!(exists(root, path), "{path}");
        }
    }

    #[test]
    fn a_second_run_finds_nothing() {
        let dir = user_data();
        let root = dir.path();
        dir_with_content(root, "Cache");
        file(root, "local/auth/sync-password.enc");
        assert_eq!(remove_v04_leftovers(root), 2);
        assert_eq!(remove_v04_leftovers(root), 0);
    }

    #[test]
    fn a_missing_or_empty_user_data_has_nothing() {
        let dir = user_data();
        assert_eq!(remove_v04_leftovers(&dir.path().join("missing")), 0);
        assert_eq!(remove_v04_leftovers(dir.path()), 0);
    }

    #[test]
    fn a_file_named_local_or_auth_is_left_alone() {
        for path in ["local", "local/auth"] {
            let dir = user_data();
            file(dir.path(), path);
            assert_eq!(remove_v04_leftovers(dir.path()), 0);
            assert!(exists(dir.path(), path), "{path}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn the_cleanup_runs_while_this_build_holds_the_lockfile() {
        let dir = user_data();
        let root = dir.path();
        let held = crate::hold_lockfile(root).unwrap();
        dir_with_content(root, "Cache");
        file(root, "local/auth/oauth-tokens.enc");
        assert_eq!(remove_v04_leftovers(root), 2);
        assert!(exists(root, crate::V04_LOCKFILE));
        drop(held);
    }

    #[cfg(unix)]
    mod links {
        use std::os::unix::fs::symlink;

        use super::*;

        #[test]
        fn dangling_singleton_links_stay() {
            let dir = user_data();
            let root = dir.path();
            // Names another host, so the lock check finds no holder.
            symlink("another-host.invalid-12345", root.join("SingletonLock")).unwrap();
            symlink("/nonexistent/socket", root.join("SingletonSocket")).unwrap();
            symlink("/nonexistent/cookie", root.join("SingletonCookie")).unwrap();
            dir_with_content(root, "Cache");
            assert_eq!(remove_v04_leftovers(root), 1);
            for name in ["SingletonLock", "SingletonSocket", "SingletonCookie"] {
                assert!(exists(root, name), "{name}");
            }
        }

        #[test]
        fn a_listed_link_goes_and_its_target_stays() {
            let dir = user_data();
            let outside = user_data();
            file(outside.path(), "keep/data");
            file(outside.path(), "keep.json");
            symlink(outside.path().join("keep"), dir.path().join("Cache")).unwrap();
            symlink(outside.path().join("keep.json"), dir.path().join("window-state.json")).unwrap();
            symlink(outside.path().join("keep.json"), dir.path().join(".org.chromium.Chromium.x")).unwrap();
            assert_eq!(remove_v04_leftovers(dir.path()), 3);
            assert_eq!(entries(dir.path()), Vec::<PathBuf>::new());
            assert!(exists(outside.path(), "keep/data"));
            assert!(exists(outside.path(), "keep.json"));
        }

        #[test]
        fn a_link_inside_a_listed_directory_is_not_followed() {
            let dir = user_data();
            let outside = user_data();
            file(outside.path(), "data");
            std::fs::create_dir(dir.path().join("Cache")).unwrap();
            symlink(outside.path(), dir.path().join("Cache/link")).unwrap();
            assert_eq!(remove_v04_leftovers(dir.path()), 1);
            assert!(exists(outside.path(), "data"));
        }

        #[test]
        fn nothing_under_a_linked_local_or_auth_is_touched() {
            let outside = user_data();
            file(outside.path(), "auth/oauth-tokens.enc");
            file(outside.path(), "config.json");

            for (link, target) in
                [("local", outside.path().to_path_buf()), ("local/auth", outside.path().join("auth"))]
            {
                let dir = user_data();
                std::fs::create_dir_all(dir.path().join(link).parent().unwrap()).unwrap();
                symlink(target, dir.path().join(link)).unwrap();
                assert_eq!(remove_v04_leftovers(dir.path()), 0, "{link}");
            }

            assert!(exists(outside.path(), "auth/oauth-tokens.enc"));
            assert!(exists(outside.path(), "config.json"));
        }

        #[test]
        fn a_linked_enc_in_auth_stays() {
            let dir = user_data();
            let outside = user_data();
            file(outside.path(), "real.enc");
            std::fs::create_dir_all(dir.path().join("local/auth")).unwrap();
            symlink(outside.path().join("real.enc"), dir.path().join("local/auth/oauth-tokens.enc")).unwrap();
            assert_eq!(remove_v04_leftovers(dir.path()), 0);
            assert!(exists(dir.path(), "local/auth/oauth-tokens.enc"));
            assert!(exists(outside.path(), "real.enc"));
        }
    }
}
