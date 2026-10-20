// SPDX-License-Identifier: GPL-2.0-or-later
//! Who recorded the typing data: the installation id
//! (`local/installation-id`), the machine hash built from it, and the OS
//! part of the fingerprint, with the strings Node's `os.platform()`,
//! `os.release()` and `os.arch()` give.
//!
//! The machine hash names this device's data directories and the scope of
//! every record, and the OS strings go into the scope key as they are, so
//! each must be the value the 0.4 build computes on the same machine:
//! anything else shows the same PC as another device.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use pipette_entry_store::{IdGen, is_js_whitespace};
use pipette_sync_format::{MachineIdError, machine_hash};

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("installation id: {0}")]
    InstallationId(#[from] std::io::Error),
    #[error(transparent)]
    MachineId(#[from] MachineIdError),
}

/// `local/installation-id` under the userData directory.
pub fn installation_id_path(user_data: &Path) -> PathBuf {
    user_data.join("local").join("installation-id")
}

/// `INSTALLATION_ID_PATTERN`: a lowercase hyphenated UUID.
fn is_installation_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_digit() || (b'a'..=b'f').contains(b),
        })
}

/// The installation id in `user_data`, written as `{id}\n` with a new id
/// from `ids` when the file is missing or does not hold an id (after
/// JavaScript's `trim`). Any other read error is returned and the file is
/// left alone: replacing the id after any read error would turn a passing
/// I/O failure into a new device.
pub fn load_or_create_installation_id(user_data: &Path, ids: &dyn IdGen) -> std::io::Result<String> {
    let path = installation_id_path(user_data);
    match std::fs::read(&path) {
        Ok(bytes) => {
            // readFile(…, 'utf-8') reads each invalid sequence as U+FFFD,
            // which no id has.
            let text = String::from_utf8_lossy(&bytes);
            let trimmed =
                text.trim_matches(|c: char| u16::try_from(u32::from(c)).is_ok_and(is_js_whitespace));
            if is_installation_id(trimmed) {
                return Ok(trimmed.to_owned());
            }
        }
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    let fresh = ids.new_id();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    pipette_fs::write_file_atomic(&path, format!("{fresh}\n").as_bytes())?;
    Ok(fresh)
}

/// The raw machine id (`machineId(true)` of node-machine-id).
pub type MachineIdSource = Box<dyn Fn() -> Result<String, MachineIdError> + Send + Sync>;

/// The machine hash of this device, worked out once: the first success is
/// kept for the life of the process, and a failure is tried again on the
/// next call. The installation id is kept on its own the same way, so a
/// failing machine id does not read or
/// create the file again.
pub struct MachineIdentity {
    user_data: PathBuf,
    ids: Arc<dyn IdGen>,
    machine_id: MachineIdSource,
    cached: Mutex<Cached>,
}

#[derive(Default)]
struct Cached {
    installation_id: Option<String>,
    machine_hash: Option<String>,
}

impl MachineIdentity {
    /// The identity of this machine: node-machine-id's id and random UUIDs.
    pub fn system(user_data: &Path, ids: Arc<dyn IdGen>) -> Self {
        Self::new(user_data, ids, Box::new(pipette_sync_format::machine_id_original))
    }

    pub fn new(user_data: &Path, ids: Arc<dyn IdGen>, machine_id: MachineIdSource) -> Self {
        Self { user_data: user_data.to_path_buf(), ids, machine_id, cached: Mutex::new(Cached::default()) }
    }

    /// `getMachineHash`: the SHA-256 of the machine id followed by the
    /// installation id. Blocks on file I/O and, on Windows and macOS, on
    /// the command that reads the machine id. Concurrent callers wait for
    /// one another, so the file is read or created once.
    pub fn machine_hash(&self) -> Result<String, IdentityError> {
        let mut cached = self.cached.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(hash) = &cached.machine_hash {
            return Ok(hash.clone());
        }
        let installation_id = match &cached.installation_id {
            Some(id) => id.clone(),
            None => {
                let id = load_or_create_installation_id(&self.user_data, self.ids.as_ref())?;
                cached.installation_id = Some(id.clone());
                id
            }
        };
        let hash = machine_hash(&(self.machine_id)()?, &installation_id);
        cached.machine_hash = Some(hash.clone());
        Ok(hash)
    }
}

/// `os.platform()`: `process.platform` of Node for this build's target.
pub fn os_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        "solaris" | "illumos" => "sunos",
        other => other,
    }
}

/// `os.arch()`: `process.arch` of Node for this build's target.
pub fn os_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "x86" => "ia32",
        "aarch64" => "arm64",
        "loongarch64" => "loong64",
        "powerpc" => "ppc",
        "powerpc64" => "ppc64",
        "mips" if cfg!(target_endian = "little") => "mipsel",
        "mips64" if cfg!(target_endian = "little") => "mips64el",
        other => other,
    }
}

/// `os.release()`: the release libuv's `uv_os_uname` reports, the
/// `release` of `uname(2)` on Linux and macOS and
/// `major.minor.build` of `RtlGetVersion` on Windows; empty when the
/// system does not tell (Node throws then).
pub fn os_release() -> String {
    #[cfg(unix)]
    {
        rustix::system::uname().release().to_string_lossy().into_owned()
    }
    #[cfg(windows)]
    {
        let version = windows_version::OsVersion::current();
        format!("{}.{}.{}", version.major, version.minor, version.build)
    }
    #[cfg(not(any(unix, windows)))]
    {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use pipette_entry_store::SequenceIds;

    use super::*;

    const ID_A: &str = "0f1e2d3c-4b5a-4697-8877-665544332211";
    const ID_B: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    fn ids(list: &[&str]) -> Arc<dyn IdGen> {
        Arc::new(SequenceIds::new(list.iter().copied()))
    }

    #[test]
    fn creates_the_file_once_and_reads_it_back() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_or_create_installation_id(dir.path(), ids(&[ID_A]).as_ref()).unwrap(), ID_A);
        assert_eq!(std::fs::read(installation_id_path(dir.path())).unwrap(), format!("{ID_A}\n").as_bytes());
        assert_eq!(load_or_create_installation_id(dir.path(), ids(&[]).as_ref()).unwrap(), ID_A);
    }

    #[test]
    fn replaces_text_that_is_not_an_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = installation_id_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, ID_A.to_uppercase()).unwrap();
        assert_eq!(load_or_create_installation_id(dir.path(), ids(&[ID_B]).as_ref()).unwrap(), ID_B);
        // JavaScript's trim also removes U+FEFF and U+3000.
        std::fs::write(&path, format!("\u{feff} {ID_A}\u{3000}\r\n")).unwrap();
        assert_eq!(load_or_create_installation_id(dir.path(), ids(&[]).as_ref()).unwrap(), ID_A);
    }

    #[cfg(unix)]
    #[test]
    fn another_read_error_fails_and_leaves_the_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = installation_id_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, format!("{ID_A}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::read(&path).is_ok() {
            // Root reads any file, so there is no read error to test.
            eprintln!(
                "SKIPPED another_read_error_fails_and_leaves_the_file: the unreadable file was read (root)"
            );
            return;
        }
        let err = load_or_create_installation_id(dir.path(), ids(&[ID_B]).as_ref()).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::PermissionDenied);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), format!("{ID_A}\n"));
    }

    #[test]
    fn a_directory_in_the_way_fails() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(installation_id_path(dir.path())).unwrap();
        assert!(load_or_create_installation_id(dir.path(), ids(&[ID_B]).as_ref()).is_err());
    }

    #[test]
    fn keeps_the_hash_and_retries_a_failed_machine_id() {
        let dir = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let identity = MachineIdentity::new(
            dir.path(),
            ids(&[ID_A]),
            Box::new(move || match counted.fetch_add(1, Ordering::SeqCst) {
                0 => Err(MachineIdError::NotFound),
                _ => Ok("machine".to_owned()),
            }),
        );
        assert!(matches!(identity.machine_hash(), Err(IdentityError::MachineId(MachineIdError::NotFound))));
        // The installation id made by the failed call is kept: the
        // sequence has no second id to give.
        let hash = identity.machine_hash().unwrap();
        assert_eq!(hash, machine_hash("machine", ID_A));
        assert_eq!(identity.machine_hash().unwrap(), hash);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn os_strings_have_the_node_names() {
        assert!(
            ["linux", "win32", "darwin", "freebsd", "openbsd", "netbsd", "android", "sunos", "aix"]
                .contains(&os_platform())
        );
        assert!(["x64", "arm64", "ia32", "arm", "riscv64", "ppc64", "s390x", "loong64"].contains(&os_arch()));
        assert!(!os_release().is_empty());
    }
}
