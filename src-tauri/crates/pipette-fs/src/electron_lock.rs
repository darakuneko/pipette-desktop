// SPDX-License-Identifier: GPL-2.0-or-later
//! Whether a running Electron build holds the userData directory, so this
//! build does not start on top of it (both would write the config, run sync
//! and append to the same analytics files, and neither's single-instance
//! check sees the other).
//!
//! Chromium's process singleton on Linux and macOS keeps `SingletonLock` in
//! the userData directory: a symbolic link whose target is
//! `<host name>-<pid>`. The link stays behind after a crash, so it counts
//! as held only when it names this host and a process that is alive. Windows
//! has no such link; there the check never finds a holder.
//!
//! On Windows Chromium keeps `lockfile` in the userData directory open,
//! sharing it for reading only, while it runs. [`hold_lockfile`] opens the
//! same file sharing nothing and keeps it open: it fails while Electron
//! holds the file, and while this build holds it, an Electron build started
//! later cannot open it and gives up its single-instance lock. On Linux and
//! macOS the check is one way: an Electron build started later is not
//! stopped.

use std::path::Path;

/// The name of Chromium's lock link in the userData directory.
pub const ELECTRON_LOCK_FILE: &str = "SingletonLock";

/// What the lock link names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockHolder {
    pub host: String,
    pub pid: u32,
}

/// The holder the lock link in `user_data` names, `None` when there is no
/// link or its target is not `<host>-<pid>`.
pub fn read_lock_holder(user_data: &Path) -> Option<LockHolder> {
    let target = std::fs::read_link(user_data.join(ELECTRON_LOCK_FILE)).ok()?;
    // The host name can contain dashes; the pid cannot.
    let (host, pid) = target.to_str()?.rsplit_once('-')?;
    if !pid.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let pid = pid.parse::<u32>().ok().filter(|&pid| pid > 0)?;
    Some(LockHolder { host: host.to_owned(), pid })
}

/// The live process on this host that holds `user_data`, if any.
pub fn electron_lock_holder(user_data: &Path) -> Option<LockHolder> {
    let holder = read_lock_holder(user_data)?;
    let host = host_name()?;
    holds(&holder, &host, std::process::id(), is_alive).then_some(holder)
}

/// Whether `holder` is a live process on `this_host` other than
/// `this_pid` (a link left by a crash can name a pid this process now has).
fn holds(holder: &LockHolder, this_host: &str, this_pid: u32, is_alive: impl Fn(u32) -> bool) -> bool {
    holder.host == this_host && holder.pid != this_pid && is_alive(holder.pid)
}

#[cfg(unix)]
fn host_name() -> Option<String> {
    rustix::system::uname().nodename().to_str().ok().map(str::to_owned)
}

#[cfg(not(unix))]
fn host_name() -> Option<String> {
    None
}

/// A signal-0 probe: the process exists when it could be signalled, or when
/// it exists but belongs to another user.
#[cfg(unix)]
fn is_alive(pid: u32) -> bool {
    use rustix::io::Errno;
    use rustix::process::{Pid, test_kill_process};
    let Some(pid) = i32::try_from(pid).ok().and_then(Pid::from_raw) else {
        return false;
    };
    match test_kill_process(pid) {
        Ok(()) => true,
        Err(err) => err == Errno::PERM,
    }
}

#[cfg(not(unix))]
fn is_alive(_pid: u32) -> bool {
    false
}

/// The name of the file Chromium keeps open in the userData directory on
/// Windows while it runs.
pub const ELECTRON_LOCKFILE: &str = "lockfile";

/// Why [`hold_lockfile`] could not take the file.
#[derive(Debug, thiserror::Error)]
pub enum LockfileError {
    /// Another process has the file open: a running Electron build.
    #[error("the file is in use")]
    InUse,
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

/// `ERROR_SHARING_VIOLATION`: the file is open in a way this open does not
/// share.
#[cfg(any(windows, test))]
const SHARING_VIOLATION: i32 = 32;

/// The error of an open of the lock file that failed with `err`.
#[cfg(any(windows, test))]
fn classify(err: std::io::Error) -> LockfileError {
    if err.raw_os_error() == Some(SHARING_VIOLATION) { LockfileError::InUse } else { LockfileError::Io(err) }
}

/// Opens `lockfile` in `user_data` (creating both when missing, an existing
/// file is neither truncated nor deleted) sharing nothing, and returns it to
/// be kept open as long as the app runs.
#[cfg(windows)]
pub fn hold_lockfile(user_data: &Path) -> Result<std::fs::File, LockfileError> {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::create_dir_all(user_data)?;
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(user_data.join(ELECTRON_LOCKFILE))
        .map_err(classify)
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use std::os::unix::fs::symlink;
    use std::path::PathBuf;

    use super::*;

    fn user_data(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pipette-lock-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn lock(dir: &Path, target: &str) {
        symlink(target, dir.join(ELECTRON_LOCK_FILE)).unwrap();
    }

    #[test]
    fn the_link_names_host_and_pid() {
        let dir = user_data("parse");
        lock(&dir, "my-host-name-4242");
        assert_eq!(read_lock_holder(&dir), Some(LockHolder { host: "my-host-name".into(), pid: 4242 }));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn no_link_or_a_malformed_one_has_no_holder() {
        let dir = user_data("malformed");
        assert_eq!(read_lock_holder(&dir), None);
        for target in ["nopid", "host-", "host-abc", "host-0", "host-+1", "host-99999999999"] {
            let _ = std::fs::remove_file(dir.join(ELECTRON_LOCK_FILE));
            lock(&dir, target);
            assert_eq!(read_lock_holder(&dir), None, "{target}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_regular_file_is_not_a_lock() {
        let dir = user_data("file");
        std::fs::write(dir.join(ELECTRON_LOCK_FILE), "host-4242").unwrap();
        assert_eq!(read_lock_holder(&dir), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_a_live_process_on_this_host_other_than_this_one_holds_it() {
        let holder = LockHolder { host: "here".into(), pid: 4242 };
        assert!(holds(&holder, "here", 1, |_| true));
        assert!(!holds(&holder, "elsewhere", 1, |_| true));
        assert!(!holds(&holder, "here", 1, |_| false));
        assert!(!holds(&holder, "here", 4242, |_| true));
    }

    #[test]
    fn a_running_process_holds_the_lock_until_it_ends() {
        let dir = user_data("live");
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        lock(&dir, &format!("{}-{}", host_name().unwrap(), child.id()));
        assert_eq!(electron_lock_holder(&dir).map(|h| h.pid), Some(child.id()));
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(electron_lock_holder(&dir), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_lock_from_another_host_is_ignored() {
        let dir = user_data("host");
        lock(&dir, &format!("not-{}-{}", host_name().unwrap(), std::os::unix::process::parent_id()));
        assert_eq!(electron_lock_holder(&dir), None);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod lockfile_tests {
    use super::*;

    #[test]
    fn only_a_sharing_violation_means_the_file_is_in_use() {
        assert!(matches!(classify(std::io::Error::from_raw_os_error(32)), LockfileError::InUse));
        // ERROR_ACCESS_DENIED and a plain error stay what they are.
        assert!(matches!(classify(std::io::Error::from_raw_os_error(5)), LockfileError::Io(_)));
        assert!(matches!(classify(std::io::Error::other("x")), LockfileError::Io(_)));
    }

    /// Chromium's open of the file: write access, shared for reading only.
    #[cfg(windows)]
    fn open_as_chromium(dir: &Path) -> std::io::Result<std::fs::File> {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 1;
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .share_mode(FILE_SHARE_READ)
            .open(dir.join(ELECTRON_LOCKFILE))
    }

    #[cfg(windows)]
    #[test]
    fn a_held_file_keeps_chromium_out_until_it_is_closed() {
        let dir = tempfile::tempdir().unwrap();
        let user_data = dir.path().join("pipette-desktop");
        let held = hold_lockfile(&user_data).unwrap();
        let refused = open_as_chromium(&user_data).unwrap_err();
        assert_eq!(refused.raw_os_error(), Some(SHARING_VIOLATION));
        drop(held);
        open_as_chromium(&user_data).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn a_file_chromium_holds_is_in_use() {
        let dir = tempfile::tempdir().unwrap();
        let chromium = open_as_chromium(dir.path()).unwrap();
        assert!(matches!(hold_lockfile(dir.path()), Err(LockfileError::InUse)));
        drop(chromium);
        hold_lockfile(dir.path()).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn an_existing_file_keeps_its_content() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(ELECTRON_LOCKFILE), b"left behind").unwrap();
        drop(hold_lockfile(dir.path()).unwrap());
        assert_eq!(std::fs::read(dir.path().join(ELECTRON_LOCKFILE)).unwrap(), b"left behind");
    }
}
