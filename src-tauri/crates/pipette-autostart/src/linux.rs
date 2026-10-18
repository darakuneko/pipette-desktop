// SPDX-License-Identifier: GPL-2.0-or-later
//! The XDG autostart desktop entry, `applyLinuxAutostart` of
//! src/main/app-behavior.ts: the same file name and the same bytes, so the
//! entry either build writes starts the app the same way.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Write};
use std::path::Path;

/// The entry's file name in the autostart directory.
pub(crate) const FILE_NAME: &str = "pipette.desktop";

/// The start of every message about a failed write or removal.
pub(crate) const FAILURE: &str = "auto-launch: failed to update Linux autostart entry: ";

/// The entry that starts `exec`: quoted, not escaped, as the Electron build
/// writes it, and the path's bytes as they are.
pub(crate) fn desktop_entry(exec: &OsStr) -> Vec<u8> {
    let mut entry = b"[Desktop Entry]\nType=Application\nName=Pipette\nComment=Vial-compatible keyboard configurator\nExec=\""
        .to_vec();
    entry.extend_from_slice(exec.as_encoded_bytes());
    entry.extend_from_slice(b"\"\nX-GNOME-Autostart-enabled=true\n");
    entry
}

/// Writes the entry into `dir` (creating the directory) when `enabled`,
/// else removes it; an entry that is not there is already removed. Other
/// files in `dir` stay. A failure is logged as an error.
pub(crate) fn apply(dir: &Path, enabled: bool, exec: impl FnOnce() -> Result<OsString, String>) {
    let path = dir.join(FILE_NAME);
    let result = if enabled {
        fs::create_dir_all(dir).and_then(|()| {
            let exec = exec().map_err(io::Error::other)?;
            fs::write(&path, desktop_entry(&exec))
        })
    } else {
        match fs::remove_file(&path) {
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    };
    if let Err(err) = result {
        log::error!("{FAILURE}{err}");
    }
}

/// [`apply`] for a development directory `dir`, already resolved: only
/// while `dir` still resolves to itself, only over or removing a regular
/// file with no other link (a symbolic or hard link could reach another
/// entry), and writing through a temporary file in `dir` renamed over the
/// entry, which replaces a link put there meanwhile instead of following it.
pub(crate) fn apply_guarded(dir: &Path, enabled: bool, exec: impl FnOnce() -> Result<OsString, String>) {
    let result = if enabled { write_guarded(dir, exec) } else { remove_guarded(dir) };
    if let Err(err) = result {
        log::error!("{FAILURE}{err}");
    }
}

fn write_guarded(dir: &Path, exec: impl FnOnce() -> Result<OsString, String>) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    still_resolved(dir)?;
    let path = dir.join(FILE_NAME);
    own_regular_file(&path)?;
    let exec = exec().map_err(io::Error::other)?;
    let temp = dir.join(format!(".{FILE_NAME}.{}.tmp", std::process::id()));
    // A temporary file a crash left behind; removing a link removes only the link.
    let _ = fs::remove_file(&temp);
    let written = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .and_then(|mut file| file.write_all(&desktop_entry(&exec)))
        .and_then(|()| fs::rename(&temp, &path));
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

fn remove_guarded(dir: &Path) -> io::Result<()> {
    match fs::canonicalize(dir) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
        Ok(_) => still_resolved(dir)?,
    }
    let path = dir.join(FILE_NAME);
    if own_regular_file(&path)? { fs::remove_file(&path) } else { Ok(()) }
}

/// An error unless `dir` resolves to itself: a part of it replaced by a link
/// after the check.
fn still_resolved(dir: &Path) -> io::Result<()> {
    if fs::canonicalize(dir)? == dir {
        Ok(())
    } else {
        Err(io::Error::other(format!("{} changed after it was checked", dir.display())))
    }
}

/// Whether the entry `path` exists; an error when it is there but is not a
/// regular file or has another hard link.
fn own_regular_file(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
        Ok(meta) if meta.file_type().is_file() && link_count(&meta) == 1 => Ok(true),
        Ok(_) => Err(io::Error::other(format!("{} is not a regular file of its own", path.display()))),
    }
}

#[cfg(unix)]
fn link_count(meta: &fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.nlink()
}

/// Development directories are read on Linux only (`crate::target`).
#[cfg(not(unix))]
fn link_count(_meta: &fs::Metadata) -> u64 {
    1
}
