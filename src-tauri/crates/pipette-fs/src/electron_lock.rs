// SPDX-License-Identifier: GPL-2.0-or-later
//! Whether a running Electron build holds the userData directory, so this
//! build does not start on top of it (both would write the config, run sync
//! and append to the same analytics files, and neither's single-instance
//! check sees the other).
//!
//! Chromium's process singleton on Linux and macOS keeps two symbolic links
//! in the userData directory: `SingletonLock`, whose target is
//! `<host name>-<pid>`, and `SingletonSocket`, which leads to the socket the
//! running browser listens on. Both stay behind after a crash, and after a
//! reboot the pid can belong to any process. The directory counts as held
//! when the socket accepts a connection (whatever host the lock names: the
//! host may have been renamed while Electron runs), or else when the lock
//! names this host and a live process that is the Electron build (its
//! executable is `pipette-desktop` or Electron's own; a process whose name
//! cannot be read counts as the Electron build). Windows has no such links;
//! there the check never finds a holder.
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

/// The name of Chromium's link to its singleton socket.
const ELECTRON_SOCKET_LINK: &str = "SingletonSocket";

/// The executable names of the Electron build: electron-builder names the
/// Linux executable after the package (`pipette-desktop`) and the macOS one
/// after the product (`Pipette`); a development run is Electron's own
/// (`electron`, `Electron`).
const ELECTRON_EXECUTABLES: &[&str] = &["pipette-desktop", "Pipette", "electron", "Electron"];

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

/// The running Electron build that holds `user_data`, if any.
pub fn electron_lock_holder(user_data: &Path) -> Option<LockHolder> {
    let holder = read_lock_holder(user_data)?;
    let probe = Probe {
        this_host: host_name(),
        this_pid: std::process::id(),
        socket_answers: socket_answers(user_data),
        is_alive: &is_alive,
        executable: &executable_name,
    };
    probe.holds(&holder).then_some(holder)
}

/// What the decision reads from the system.
struct Probe<'a> {
    this_host: Option<String>,
    this_pid: u32,
    /// Whether the socket `SingletonSocket` leads to accepts a connection.
    socket_answers: bool,
    is_alive: &'a dyn Fn(u32) -> bool,
    /// The executable name of a process, `None` when it cannot be read.
    executable: &'a dyn Fn(u32) -> Option<String>,
}

impl Probe<'_> {
    /// Whether `holder` holds the directory: the socket answers, or the
    /// lock names a live Electron build on this host other than this
    /// process (a link left by a crash can name a pid this process now has).
    fn holds(&self, holder: &LockHolder) -> bool {
        if self.socket_answers {
            return true;
        }
        self.this_host.as_deref() == Some(holder.host.as_str())
            && holder.pid != self.this_pid
            && (self.is_alive)(holder.pid)
            && (self.executable)(holder.pid).is_none_or(|name| is_electron_executable(&name))
    }
}

/// Whether `name` (an executable's file name) is the Electron build's.
fn is_electron_executable(name: &str) -> bool {
    ELECTRON_EXECUTABLES.contains(&name)
}

/// Whether the socket the `SingletonSocket` link in `user_data` leads to
/// accepts a connection. The connection is closed at once without a
/// message, which Chromium discards.
#[cfg(unix)]
fn socket_answers(user_data: &Path) -> bool {
    std::fs::read_link(user_data.join(ELECTRON_SOCKET_LINK))
        .is_ok_and(|target| std::os::unix::net::UnixStream::connect(user_data.join(target)).is_ok())
}

#[cfg(not(unix))]
fn socket_answers(_user_data: &Path) -> bool {
    false
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

/// The file name of the executable of process `pid`: the target of
/// `/proc/<pid>/exe` (without the ` (deleted)` the kernel appends once the
/// file is gone, as when an AppImage is unmounted), else
/// `/proc/<pid>/comm`, which any user may read.
#[cfg(target_os = "linux")]
fn executable_name(pid: u32) -> Option<String> {
    let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok().and_then(|path| {
        let name = path.file_name()?.to_str()?.to_owned();
        Some(name.strip_suffix(" (deleted)").map(str::to_owned).unwrap_or(name))
    });
    exe.or_else(|| {
        let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
        Some(comm.trim_end_matches('\n').to_owned()).filter(|name| !name.is_empty())
    })
}

/// The file name of the executable of process `pid`, from `ps`.
#[cfg(target_os = "macos")]
fn executable_name(pid: u32) -> Option<String> {
    let output = std::process::Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let path = String::from_utf8(output.stdout).ok()?;
    let name = Path::new(path.trim_end()).file_name()?.to_str()?.to_owned();
    Some(name).filter(|name| !name.is_empty())
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn executable_name(_pid: u32) -> Option<String> {
    None
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
mod decision_tests {
    use super::*;

    fn probe<'a>(
        socket_answers: bool,
        is_alive: &'a dyn Fn(u32) -> bool,
        executable: &'a dyn Fn(u32) -> Option<String>,
    ) -> Probe<'a> {
        Probe { this_host: Some("here".into()), this_pid: 1, socket_answers, is_alive, executable }
    }

    const ELECTRON: &dyn Fn(u32) -> Option<String> = &|_| Some("pipette-desktop".into());
    const OTHER: &dyn Fn(u32) -> Option<String> = &|_| Some("sleep".into());
    const UNREADABLE: &dyn Fn(u32) -> Option<String> = &|_| None;
    const ALIVE: &dyn Fn(u32) -> bool = &|_| true;
    const DEAD: &dyn Fn(u32) -> bool = &|_| false;

    fn holder(host: &str, pid: u32) -> LockHolder {
        LockHolder { host: host.into(), pid }
    }

    #[test]
    fn a_live_electron_build_on_this_host_holds_it() {
        assert!(probe(false, ALIVE, ELECTRON).holds(&holder("here", 4242)));
        // A process whose name cannot be read is taken for the Electron build.
        assert!(probe(false, ALIVE, UNREADABLE).holds(&holder("here", 4242)));
    }

    #[test]
    fn a_pid_reused_by_another_program_a_dead_pid_or_this_process_does_not() {
        assert!(!probe(false, ALIVE, OTHER).holds(&holder("here", 4242)));
        assert!(!probe(false, DEAD, ELECTRON).holds(&holder("here", 4242)));
        assert!(!probe(false, ALIVE, ELECTRON).holds(&holder("here", 1)));
    }

    #[test]
    fn another_host_holds_it_only_while_the_socket_answers() {
        assert!(!probe(false, ALIVE, ELECTRON).holds(&holder("elsewhere", 4242)));
        assert!(probe(true, DEAD, OTHER).holds(&holder("elsewhere", 4242)));
        let unknown_host = Probe { this_host: None, ..probe(false, ALIVE, ELECTRON) };
        assert!(!unknown_host.holds(&holder("here", 4242)));
    }

    #[test]
    fn the_electron_executables() {
        for name in ["pipette-desktop", "Pipette", "electron", "Electron"] {
            assert!(is_electron_executable(name), "{name}");
        }
        // This build's own executable is not one.
        for name in ["pipette", "sleep", "pipette-desktop.AppImage", ""] {
            assert!(!is_electron_executable(name), "{name}");
        }
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use std::os::unix::fs::symlink;
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;
    use std::process::{Child, Command};

    use super::*;

    fn user_data() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn lock(dir: &Path, target: &str) {
        symlink(target, dir.join(ELECTRON_LOCK_FILE)).unwrap();
    }

    /// `sleep` started under the executable name `name`, from a copy in
    /// `dir`.
    fn sleeper(dir: &Path, name: &str) -> Child {
        let exe: PathBuf = dir.join(name);
        let sleep =
            ["/bin/sleep", "/usr/bin/sleep"].into_iter().find(|path| Path::new(path).exists()).unwrap();
        std::fs::copy(sleep, &exe).unwrap();
        // A fork in another test thread can briefly hold the copy open for
        // writing (ETXTBSY).
        for _ in 0..50 {
            match Command::new(&exe).arg("30").spawn() {
                Err(err) if err.raw_os_error() == Some(26) => {
                    std::thread::sleep(std::time::Duration::from_millis(20))
                }
                spawned => return spawned.unwrap(),
            }
        }
        panic!("{} stayed busy", exe.display());
    }

    fn stop(mut child: Child) {
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn the_link_names_host_and_pid() {
        let dir = user_data();
        lock(dir.path(), "my-host-name-4242");
        assert_eq!(read_lock_holder(dir.path()), Some(LockHolder { host: "my-host-name".into(), pid: 4242 }));
    }

    #[test]
    fn no_link_or_a_malformed_one_has_no_holder() {
        let dir = user_data();
        assert_eq!(read_lock_holder(dir.path()), None);
        for target in ["nopid", "host-", "host-abc", "host-0", "host-+1", "host-99999999999"] {
            let _ = std::fs::remove_file(dir.path().join(ELECTRON_LOCK_FILE));
            lock(dir.path(), target);
            assert_eq!(read_lock_holder(dir.path()), None, "{target}");
        }
    }

    #[test]
    fn a_regular_file_is_not_a_lock() {
        let dir = user_data();
        std::fs::write(dir.path().join(ELECTRON_LOCK_FILE), "host-4242").unwrap();
        assert_eq!(read_lock_holder(dir.path()), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_running_electron_build_holds_the_lock_until_it_ends() {
        let dir = user_data();
        let bin = tempfile::tempdir().unwrap();
        let child = sleeper(bin.path(), "pipette-desktop");
        let pid = child.id();
        assert_eq!(executable_name(pid).as_deref(), Some("pipette-desktop"));
        lock(dir.path(), &format!("{}-{pid}", host_name().unwrap()));
        assert_eq!(electron_lock_holder(dir.path()).map(|h| h.pid), Some(pid));
        stop(child);
        assert_eq!(electron_lock_holder(dir.path()), None);
    }

    #[test]
    fn a_stale_lock_whose_pid_another_program_has_is_ignored() {
        let dir = user_data();
        let bin = tempfile::tempdir().unwrap();
        let child = sleeper(bin.path(), "unrelated-program");
        lock(dir.path(), &format!("{}-{}", host_name().unwrap(), child.id()));
        assert_eq!(electron_lock_holder(dir.path()), None);
        stop(child);
    }

    #[test]
    fn a_lock_from_another_host_is_ignored_while_no_socket_answers() {
        let dir = user_data();
        lock(dir.path(), &format!("not-{}-{}", host_name().unwrap(), std::os::unix::process::parent_id()));
        assert_eq!(electron_lock_holder(dir.path()), None);
        // A socket file nobody listens on any more (the browser crashed).
        let sockets = tempfile::tempdir().unwrap();
        let socket = sockets.path().join("SingletonSocket");
        drop(UnixListener::bind(&socket).unwrap());
        symlink(&socket, dir.path().join(ELECTRON_SOCKET_LINK)).unwrap();
        assert_eq!(electron_lock_holder(dir.path()), None);
    }

    #[test]
    fn a_socket_that_answers_holds_the_lock_on_any_host() {
        let dir = user_data();
        let sockets = tempfile::tempdir().unwrap();
        let socket = sockets.path().join("SingletonSocket");
        let listener = UnixListener::bind(&socket).unwrap();
        symlink(&socket, dir.path().join(ELECTRON_SOCKET_LINK)).unwrap();
        // The host was renamed while the browser runs; its pid is gone too.
        lock(dir.path(), "renamed-host-999999");
        assert_eq!(
            electron_lock_holder(dir.path()),
            Some(LockHolder { host: "renamed-host".into(), pid: 999_999 })
        );
        drop(listener);
        assert_eq!(electron_lock_holder(dir.path()), None);
    }

    #[test]
    fn this_process_is_not_the_electron_build() {
        let name = executable_name(std::process::id());
        assert!(name.as_deref().is_some_and(|name| !is_electron_executable(name)), "{name:?}");
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
