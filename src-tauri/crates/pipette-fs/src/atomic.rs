// SPDX-License-Identifier: GPL-2.0-or-later
//! Temp-file-then-rename writes, so a reader never sees a torn file and a
//! crash leaves either the old content or the new one.
//!
//! The temp file is `<path>.<pid>.<12 hex digits>.tmp` in the target's
//! directory, the name src/main/utils/write-file-atomic.ts uses, so the
//! orphan sweep of src/main/utils/sweep-orphan-pack-bodies.ts recognises
//! temp files left by either build. Keep the two formats in step;
//! tests/ts_temp_names.rs checks them against names the TypeScript writer
//! built. A target name long enough to push the temp name past 255 bytes is
//! cut short in the temp name, as there.
//!
//! The temp file is synced before the rename. On a failure it is removed
//! on a best-effort basis and the original error is returned. The parent
//! directory is not created.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Name limit of the common file systems, in bytes.
pub const MAX_NAME_BYTES: usize = 255;

/// Writes `content` to `path` through a synced temp file and a rename.
pub fn write_file_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
    write_through_temp(path, content, |_| {})
}

/// [`write_file_atomic`] that also tries to give the new file the owner of
/// the one it replaces, as the `atomically` package does for electron-store:
/// when an existing `path` belongs to another user or group than this
/// process, the temp file is handed to them before the rename. A failure to
/// do so (only a privileged process may give a file away) is ignored.
pub fn write_file_atomic_keeping_owner(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let owner = foreign_owner(path);
    write_through_temp(path, content, |tmp| {
        #[cfg(unix)]
        if let Some((uid, gid)) = owner {
            let _ = std::os::unix::fs::chown(tmp, Some(uid), Some(gid));
        }
        #[cfg(not(unix))]
        let _ = (tmp, owner);
    })
}

/// The owner of `path` when it exists and differs from this process's user
/// or group.
#[cfg(unix)]
fn foreign_owner(path: &Path) -> Option<(u32, u32)> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(path).ok()?;
    let ours = (rustix::process::getuid().as_raw(), rustix::process::getgid().as_raw());
    let theirs = (meta.uid(), meta.gid());
    (theirs != ours).then_some(theirs)
}

#[cfg(not(unix))]
fn foreign_owner(_path: &Path) -> Option<(u32, u32)> {
    None
}

/// Writes the synced temp file, calls `before_rename` with its path, and
/// renames it over `path`.
fn write_through_temp(path: &Path, content: &[u8], before_rename: impl FnOnce(&Path)) -> std::io::Result<()> {
    let tmp = temp_path_for(path);
    let result = write_synced(&tmp, content).and_then(|()| {
        before_rename(&tmp);
        std::fs::rename(&tmp, path)
    });
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn write_synced(path: &Path, content: &[u8]) -> std::io::Result<()> {
    let mut file = std::fs::File::create(path)?;
    file.write_all(content)?;
    file.sync_all()
}

fn temp_path_for(path: &Path) -> PathBuf {
    // The keys of a new `RandomState` are random per process and per instance.
    let random = RandomState::new().build_hasher().finish();
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    path.with_file_name(temp_file_name(&name, std::process::id(), random))
}

/// The temp file name for a target named `name`:
/// `<name>.<pid>.<12 hex digits>.tmp`, the hex digits being the low 48 bits
/// of `random` (the 6 random bytes of the TypeScript writer), with `name`
/// cut short when the whole would pass [`MAX_NAME_BYTES`].
pub fn temp_file_name(name: &str, pid: u32, random: u64) -> String {
    let suffix = format!(".{pid}.{:012x}.tmp", random & 0xffff_ffff_ffff);
    let mut temp_name = truncate_utf8(name, MAX_NAME_BYTES - suffix.len()).to_owned();
    temp_name.push_str(&suffix);
    temp_name
}

/// The longest prefix of `s` that fits in `max` bytes without splitting a
/// character.
fn truncate_utf8(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn writes_the_content_and_leaves_no_temp_file() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        let target = dir.join("a.json");
        write_file_atomic(&target, b"one").unwrap();
        write_file_atomic(&target, b"two").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"two");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn a_failed_write_removes_the_temp_file() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        // Renaming a file onto a non-empty directory fails.
        let target = dir.join("busy");
        std::fs::create_dir_all(target.join("inside")).unwrap();
        assert!(write_file_atomic(&target, b"x").is_err());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    }

    #[test]
    fn the_temp_name_matches_the_typescript_writer() {
        let tmp = temp_path_for(Path::new("/d/quit-pending.json"));
        let name = tmp.file_name().unwrap().to_str().unwrap();
        let rest = name.strip_prefix("quit-pending.json.").unwrap().strip_suffix(".tmp").unwrap();
        let (pid, hex) = rest.split_once('.').unwrap();
        assert_eq!(pid, std::process::id().to_string());
        assert_eq!(hex.len(), 12);
        assert!(hex.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        assert_eq!(tmp.parent(), Some(Path::new("/d")));
    }

    #[test]
    fn two_temp_names_for_one_path_differ() {
        let path = Path::new("/d/a.json");
        assert_ne!(temp_path_for(path), temp_path_for(path));
    }

    #[test]
    fn a_long_name_is_cut_to_fit_the_name_limit() {
        let long = "é".repeat(200);
        let tmp = temp_path_for(&Path::new("/d").join(&long));
        let name = tmp.file_name().unwrap().to_str().unwrap();
        assert!(name.len() <= MAX_NAME_BYTES);
        assert!(name.starts_with("éé"));
        assert!(name.ends_with(".tmp"));
    }
}
