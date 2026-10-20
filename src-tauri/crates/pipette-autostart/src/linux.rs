// SPDX-License-Identifier: GPL-2.0-or-later
//! The XDG autostart desktop entry: the file name and the bytes of the 0.4
//! build's entry, so the entry the 0.4 build wrote is the one this build
//! writes.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::path::Path;

pub(crate) use crate::dev_dir::Checked;

/// The entry's file name in the autostart directory.
pub(crate) const FILE_NAME: &str = "pipette.desktop";

/// The start of every message about a failed write or removal.
pub(crate) const FAILURE: &str = "auto-launch: failed to update Linux autostart entry: ";

/// The entry that starts `exec`: quoted, not escaped, as the 0.4 build
/// wrote it, and the path's bytes as they are.
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

/// [`apply`] for a development directory `checked` resolved: the directory
/// is opened once without following a link and taken only when it is still
/// the checked one (its path and, when it existed at the check, its device
/// and inode), and every entry operation is made relative to that open
/// directory, so swapping it or a parent for a link afterwards cannot move
/// the write or the removal. The entry is replaced or removed only when it
/// is a regular file with no other link (a symbolic or hard link could reach
/// another entry), and written through a temporary file renamed over it.
pub(crate) fn apply_guarded(
    checked: &Checked,
    enabled: bool,
    exec: impl FnOnce() -> Result<OsString, String>,
) {
    if let Err(err) = guarded::apply(checked, enabled, exec) {
        log::error!("{FAILURE}{err}");
    }
}

#[cfg(target_os = "linux")]
mod guarded {
    use std::ffi::OsString;
    use std::fs::{self, File};
    use std::io::{self, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::MetadataExt;

    use rustix::fs::{AtFlags, FileType, Mode, OFlags};
    use rustix::io::Errno;

    use super::{Checked, FILE_NAME, desktop_entry};

    pub(super) fn apply(
        checked: &Checked,
        enabled: bool,
        exec: impl FnOnce() -> Result<OsString, String>,
    ) -> io::Result<()> {
        if enabled {
            fs::create_dir_all(&checked.dir)?;
            let dir = open(checked)?;
            own_regular_file(&dir)?;
            let exec = exec().map_err(io::Error::other)?;
            write(&dir, &desktop_entry(&exec))
        } else {
            let dir = match open(checked) {
                Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
                other => other?,
            };
            if own_regular_file(&dir)? {
                rustix::fs::unlinkat(&dir, FILE_NAME, AtFlags::empty())?;
            }
            Ok(())
        }
    }

    /// The checked directory, open, when it still is the checked one.
    fn open(checked: &Checked) -> io::Result<File> {
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let dir = File::from(rustix::fs::open(&checked.dir, flags, Mode::empty())?);
        let at = fs::read_link(format!("/proc/self/fd/{}", dir.as_raw_fd()))?;
        let meta = dir.metadata()?;
        if at != checked.dir || checked.id.is_some_and(|id| id != (meta.dev(), meta.ino())) {
            return Err(io::Error::other(format!("{} changed after it was checked", checked.dir.display())));
        }
        Ok(dir)
    }

    /// Whether the entry exists in `dir`; an error when it is there but is
    /// not a regular file or has another hard link.
    fn own_regular_file(dir: &File) -> io::Result<bool> {
        match rustix::fs::statat(dir, FILE_NAME, AtFlags::SYMLINK_NOFOLLOW) {
            Err(Errno::NOENT) => Ok(false),
            Err(err) => Err(err.into()),
            Ok(stat) if FileType::from_raw_mode(stat.st_mode).is_file() && stat.st_nlink == 1 => Ok(true),
            Ok(_) => Err(io::Error::other(format!("{FILE_NAME} is not a regular file of its own"))),
        }
    }

    fn write(dir: &File, entry: &[u8]) -> io::Result<()> {
        let temp = format!(".{FILE_NAME}.{}.tmp", std::process::id());
        // A temporary file a crash left behind; removing a link removes only the link.
        let _ = rustix::fs::unlinkat(dir, temp.as_str(), AtFlags::empty());
        let flags = OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let mode = Mode::RUSR | Mode::WUSR | Mode::RGRP | Mode::WGRP | Mode::ROTH | Mode::WOTH;
        let written = rustix::fs::openat(dir, temp.as_str(), flags, mode)
            .map_err(io::Error::from)
            .and_then(|fd| File::from(fd).write_all(entry))
            .and_then(|()| Ok(rustix::fs::renameat(dir, temp.as_str(), dir, FILE_NAME)?));
        if written.is_err() {
            let _ = rustix::fs::unlinkat(dir, temp.as_str(), AtFlags::empty());
        }
        written
    }
}

/// Development directories are read on Linux only (`crate::target`).
#[cfg(not(target_os = "linux"))]
mod guarded {
    use std::ffi::OsString;
    use std::io;

    use super::Checked;

    pub(super) fn apply(
        _checked: &Checked,
        _enabled: bool,
        _exec: impl FnOnce() -> Result<OsString, String>,
    ) -> io::Result<()> {
        Err(io::Error::other("a development directory is used on Linux only"))
    }
}
