// SPDX-License-Identifier: GPL-2.0-or-later
//! The autostart directory a development tools' build is given in
//! `PIPETTE_DEV_AUTOSTART_DIR` in place of `$HOME/.config/autostart`, so the
//! e2e runs can turn `autoLaunch` on and off in a directory of their own.
//! The same rules as `assertAutostartDir` of e2e-tauri/helpers/driver.ts,
//! which checks the value before it starts the app, with the app's userData
//! directory as the session directory there (driver.ts makes the session's
//! userData directory that session directory).

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::linux::FILE_NAME;

/// The variable that names the directory.
pub const VARIABLE: &str = "PIPETTE_DEV_AUTOSTART_DIR";

/// `dir` resolved, when an entry may be written into it, else why not: an
/// absolute path without `.` or `..` components (`<link>/..` resolves
/// against the link's target and could leave the place the path names)
/// that, with its symbolic links resolved, is strictly inside `user_data`
/// (resolved too), is not inside any of `real_dirs`, and whose entry is not
/// a link that resolves into one of them either. Checked at every use, so a
/// link swapped in later is caught at the next change; the caller works on
/// the returned path, not on `dir`.
pub(crate) fn check(dir: &OsStr, real_dirs: &[PathBuf], user_data: &Path) -> Result<PathBuf, String> {
    let path = Path::new(dir);
    if !path.is_absolute() {
        return Err(format!("{VARIABLE} must be an absolute path, not {}", path.display()));
    }
    if dir
        .as_encoded_bytes()
        .split(|byte| matches!(byte, b'/' | b'\\'))
        .any(|part| part == b"." || part == b"..")
    {
        return Err(format!("{VARIABLE} must not contain . or .. components, not {}", path.display()));
    }
    let cannot_resolve =
        |err: io::Error| format!("{VARIABLE} cannot be resolved, not {}: {err}", path.display());
    let resolved = resolve_existing(path).map_err(cannot_resolve)?;
    let entry = resolve_existing(&path.join(FILE_NAME)).map_err(cannot_resolve)?;
    let user_data = fs::canonicalize(user_data).map_err(|err| {
        format!(
            "{VARIABLE} cannot be checked: the userData directory {} cannot be resolved: {err}",
            user_data.display()
        )
    })?;
    if resolved == user_data || !resolved.starts_with(&user_data) {
        return Err(format!(
            "{VARIABLE} must be inside the userData directory {}, not {} ({})",
            user_data.display(),
            path.display(),
            resolved.display()
        ));
    }
    for real in real_dirs {
        // A part of it that cannot be resolved (a dangling link): compared
        // as written.
        let target = resolve_existing(real).unwrap_or_else(|_| real.clone());
        if resolved.starts_with(&target) || entry.starts_with(&target) {
            return Err(format!("{VARIABLE} resolves to the real autostart directory {}", target.display()));
        }
    }
    Ok(resolved)
}

/// `path` with every symbolic link resolved, the part that does not exist
/// yet appended as it is (the entry's directory is created on the first
/// write). Fails when an existing part cannot be resolved, a dangling link
/// among them.
fn resolve_existing(path: &Path) -> io::Result<PathBuf> {
    let mut missing = Vec::new();
    let mut existing = path;
    while fs::symlink_metadata(existing).is_err() {
        let (Some(parent), Some(name)) = (existing.parent(), existing.file_name()) else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!("no part of {} exists", path.display()),
            ));
        };
        missing.push(name);
        existing = parent;
    }
    let mut resolved = fs::canonicalize(existing)?;
    resolved.extend(missing.iter().rev());
    Ok(resolved)
}
