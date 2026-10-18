// SPDX-License-Identifier: GPL-2.0-or-later
//! A private Xvfb for the X11 tests, started the way the fixture generator
//! starts its own (scripts/resident-fixtures/x11/x-server.ts): on a display
//! number from 90 up that this test reserves through the lock file first,
//! without TCP, with a cookie in an authority file of its own, under
//! `setpriv --pdeathsig TERM` so it stops with the test thread, and always
//! stopped (and its lock file removed) when the guard is dropped. The tests
//! never talk to the X server of the desktop they run on.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::linux::net::SocketAddrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::{SocketAddr, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// FamilyWild, which Xlib matches against any local display.
const FAMILY_WILD: u16 = 65535;

const FIRST_DISPLAY: u16 = 90;
const LAST_DISPLAY: u16 = 199;
const START_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_TIMEOUT: Duration = Duration::from_secs(3);

/// Set (to anything) where the X11 tests must run rather than skip, as in
/// the CI job that installs Xvfb.
pub(crate) const REQUIRE_VAR: &str = "PIPETTE_REQUIRE_XVFB";

pub(crate) struct PrivateXServer {
    pub display: String,
    authority: PathBuf,
    /// The MIT-MAGIC-COOKIE-1 cookie in `authority`.
    pub cookie: [u8; 16],
    child: Option<Child>,
    lock_file: PathBuf,
    _dir: tempfile::TempDir,
}

/// `Xvfb` on PATH.
fn find_xvfb() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join("Xvfb")).find(|candidate| candidate.is_file())
}

/// Whether something already serves display `n` without a lock file.
fn display_in_use(n: u16) -> bool {
    let path = format!("/tmp/.X11-unix/X{n}");
    if std::fs::symlink_metadata(&path).is_ok() {
        return true;
    }
    SocketAddr::from_abstract_name(path.as_bytes())
        .ok()
        .is_some_and(|address| UnixStream::connect_addr(&address).is_ok())
}

/// Reserves the first display number in the private range that nothing
/// holds, by creating its lock file `/tmp/.X<n>-lock` exclusively with this
/// process's pid in the X server's format. A lock file that exists, stale
/// or not, means the number is taken. Only the guard removes the file.
fn reserve_display() -> Result<(u16, PathBuf), String> {
    let desktop = std::env::var("DISPLAY").ok();
    for n in FIRST_DISPLAY..=LAST_DISPLAY {
        if desktop
            .as_deref()
            .is_some_and(|d| d.trim_start_matches(':').split('.').next() == Some(&n.to_string()))
        {
            continue;
        }
        let lock_file = PathBuf::from(format!("/tmp/.X{n}-lock"));
        let mut file = match OpenOptions::new().write(true).create_new(true).mode(0o444).open(&lock_file) {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(format!("cannot create {}: {err}", lock_file.display())),
        };
        let written = file.write_all(format!("{:>10}\n", std::process::id()).as_bytes());
        drop(file);
        if written.is_err() || display_in_use(n) {
            let _ = std::fs::remove_file(&lock_file);
            continue;
        }
        return Ok((n, lock_file));
    }
    Err(format!("no free display between :{FIRST_DISPLAY} and :{LAST_DISPLAY}"))
}

/// One Xauthority entry of family FamilyWild with no display number.
fn authority_entry(cookie: &[u8]) -> Vec<u8> {
    let mut entry = FAMILY_WILD.to_be_bytes().to_vec();
    for field in [&b""[..], b"", b"MIT-MAGIC-COOKIE-1", cookie] {
        entry.extend((field.len() as u16).to_be_bytes());
        entry.extend(field);
    }
    entry
}

fn random_cookie() -> Result<[u8; 16], String> {
    let mut cookie = [0u8; 16];
    File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut cookie))
        .map_err(|err| format!("cannot read /dev/urandom: {err}"))?;
    Ok(cookie)
}

impl PrivateXServer {
    /// Starts the server, or `None` (with a message on stderr) when `Xvfb`
    /// is not on PATH and [`REQUIRE_VAR`] is not set.
    pub fn start() -> Option<Self> {
        let Some(xvfb) = find_xvfb() else {
            assert!(std::env::var_os(REQUIRE_VAR).is_none(), "Xvfb is not on PATH and {REQUIRE_VAR} is set");
            eprintln!("skipping the X11 test: Xvfb is not on PATH");
            return None;
        };
        match Self::start_with(&xvfb) {
            Ok(server) => Some(server),
            Err(err) => panic!("cannot start the private Xvfb: {err}"),
        }
    }

    fn start_with(xvfb: &Path) -> Result<Self, String> {
        let (number, lock_file) = reserve_display()?;
        let mut server = Self {
            display: format!(":{number}"),
            authority: PathBuf::new(),
            cookie: random_cookie()?,
            child: None,
            lock_file,
            _dir: tempfile::tempdir().map_err(|err| err.to_string())?,
        };
        server.authority = server._dir.path().join("Xauthority");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&server.authority)
            .map_err(|err| err.to_string())?;
        file.write_all(&authority_entry(&server.cookie)).map_err(|err| err.to_string())?;
        drop(file);
        // With the display number given, `-displayfd` only reports it (on
        // standard output here) once the server is ready; it also makes the
        // server skip its own lock file, which this test holds.
        let mut child = Command::new("setpriv")
            .args(["--pdeathsig", "TERM", "--"])
            .arg(xvfb)
            .arg(&server.display)
            .args(["-displayfd", "1", "-nolisten", "tcp", "-auth"])
            .arg(&server.authority)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| format!("cannot run setpriv: {err}"))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        server.child = Some(child);
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut line = String::new();
            if let Some(stdout) = stdout {
                let _ = BufReader::new(stdout).read_line(&mut line);
            }
            let _ = sender.send(line);
        });
        let log = thread::spawn(move || {
            let mut log = String::new();
            if let Some(mut stderr) = stderr {
                let _ = stderr.read_to_string(&mut log);
            }
            log
        });
        let reported = receiver.recv_timeout(START_TIMEOUT).unwrap_or_default();
        if reported.trim() != number.to_string() {
            server.stop();
            let log = log.join().unwrap_or_default();
            return Err(format!("the server reported display {:?}, not {number}\n{log}", reported.trim()));
        }
        Ok(server)
    }

    /// SIGTERM, then SIGKILL if it has not exited in time; then the lock
    /// file goes.
    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            if matches!(child.try_wait(), Ok(None)) {
                let _ = Command::new("kill")
                    .args(["-TERM", &child.id().to_string()])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
                let deadline = Instant::now() + STOP_TIMEOUT;
                while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(20));
                }
                let _ = child.kill();
            }
            let _ = child.wait();
        }
        let _ = std::fs::remove_file(&self.lock_file);
    }
}

impl Drop for PrivateXServer {
    fn drop(&mut self) {
        self.stop();
    }
}
