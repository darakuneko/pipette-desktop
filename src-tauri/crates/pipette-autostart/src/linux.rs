// SPDX-License-Identifier: GPL-2.0-or-later
//! The XDG autostart desktop entry, `applyLinuxAutostart` of
//! src/main/app-behavior.ts: the same file name and the same bytes, so the
//! entry either build writes starts the app the same way.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
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
