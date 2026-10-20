// SPDX-License-Identifier: GPL-2.0-or-later
//! The pipette settings of a keyboard: `sync/keyboards/{uid}/pipette_settings.json`,
//! synced as the unit `keyboards/{uid}/settings`.
//!
//! This is storage only. What a valid file is, which fields a read keeps, how
//! a patch merges and the text a write stores are the rules of
//! src/shared/pipette-settings-normalize.ts, which the caller applies: it
//! reads the file with its etag, builds the new text, and writes it back
//! with that etag. The write happens only while the file still has that
//! etag, checked under the uid's write lock (the lock of the keyboard's
//! snapshots too); otherwise the caller reads again and rebuilds the text.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use pipette_entry_store::is_safe_path_segment;
use pipette_js_json::{Object, Value};
use sha2::{Digest, Sha256};

use crate::keyboard_meta::read_active_names;
use crate::stored_keyboards::{keyboard_dirs, snapshot_device_name};
use crate::{StoreContext, StoreError};

/// The etag of a settings file that cannot be read, a missing one included.
pub const SETTINGS_ETAG_ABSENT: &str = "absent";

const SETTINGS_FILE: &str = "pipette_settings.json";

/// The sync unit of `uid`'s settings.
pub fn settings_sync_unit(uid: &str) -> String {
    format!("keyboards/{uid}/settings")
}

/// Why a settings operation failed. The text of a file-system error is
/// this OS's, not Node's.
#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("Invalid uid")]
    InvalidUid,
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// A settings file as read: its text (`None` when it cannot be read) and
/// the etag a write of a text built from it must name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettingsFile {
    pub content: Option<String>,
    pub etag: String,
}

/// What a write did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsWrite {
    Written,
    /// The file no longer had the etag the write named; nothing was written.
    Conflict,
}

fn keyboard_dir(ctx: &StoreContext, uid: &str) -> Result<PathBuf, SettingsError> {
    if !is_safe_path_segment(uid) {
        return Err(SettingsError::InvalidUid);
    }
    Ok(ctx.sync_dir().join("keyboards").join(uid))
}

/// The file at `path` as text, as `readFile(…, 'utf-8')` reads it (each
/// invalid sequence as U+FFFD); `None` when it cannot be read.
fn read_text(path: &Path) -> Option<String> {
    fs::read(path).ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// The file at `path` as [`read_text`] reads it, with its etag: the
/// SHA-256 of its bytes in lowercase hex, or [`SETTINGS_ETAG_ABSENT`] when
/// it cannot be read.
fn read_file(path: &Path) -> SettingsFile {
    match fs::read(path) {
        Ok(bytes) => SettingsFile {
            etag: format!("{:x}", Sha256::digest(&bytes)),
            content: Some(String::from_utf8_lossy(&bytes).into_owned()),
        },
        Err(_) => SettingsFile { content: None, etag: SETTINGS_ETAG_ABSENT.to_owned() },
    }
}

/// `uid`'s settings file as it is now. Reads without waiting for the lock,
/// as the handler does; the etag tells a later write whether it changed.
pub fn read_pipette_settings(ctx: &StoreContext, uid: &str) -> Result<SettingsFile, SettingsError> {
    Ok(read_file(&keyboard_dir(ctx, uid)?.join(SETTINGS_FILE)))
}

/// Writes `content` as `uid`'s settings file when the file still has
/// `etag`, creating the keyboard's directory, and reports the settings
/// unit. Under the uid's write lock.
pub fn write_pipette_settings(
    ctx: &StoreContext,
    uid: &str,
    content: &str,
    etag: &str,
) -> Result<SettingsWrite, SettingsError> {
    let dir = keyboard_dir(ctx, uid)?;
    ctx.locks.with_write_lock(uid, || {
        let path = dir.join(SETTINGS_FILE);
        if read_file(&path).etag != etag {
            return Ok(SettingsWrite::Conflict);
        }
        fs::create_dir_all(&dir)?;
        pipette_fs::write_file_atomic(&path, content.as_bytes())?;
        ctx.notify(&settings_sync_unit(uid));
        Ok(SettingsWrite::Written)
    })
}

/// Creates `uid`'s keyboard directory without a settings file: the
/// directory alone marks the keyboard as stored here.
pub fn ensure_pipette_settings_dir(ctx: &StoreContext, uid: &str) -> Result<(), SettingsError> {
    fs::create_dir_all(keyboard_dir(ctx, uid)?)?;
    Ok(())
}

/// A stored keyboard's settings file, for the pool of every keyboard's
/// typing test results.
#[derive(Clone, Debug, PartialEq)]
pub struct KeyboardSettingsFile {
    pub uid: String,
    /// The keyboard's display name: its active name in the keyboard names
    /// unless that is its uid; failing that, the device name of its first
    /// live snapshot; failing that, `null`, which the caller names from the
    /// typing analytics or by the uid. Nothing is recorded.
    pub name: Value,
    pub content: String,
}

/// The settings file of every keyboard directory whose name is one path
/// segment, in byte order of the names (Node's `readdir` order on Linux
/// and macOS); keyboards without a readable file are left out.
///
/// Fails only when the keyboard names file has a `null` entry, as the
/// handler throws then.
pub fn read_all_pipette_settings(ctx: &StoreContext) -> Result<Vec<KeyboardSettingsFile>, StoreError> {
    let names = read_active_names(ctx)?;
    let keyboards_dir = ctx.sync_dir().join("keyboards");
    let mut files = Vec::new();
    for uid in keyboard_dirs(&keyboards_dir, is_safe_path_segment) {
        let dir = keyboards_dir.join(&uid);
        let Some(content) = read_text(&dir.join(SETTINGS_FILE)) else { continue };
        let uid_value = Value::from(uid.as_str());
        let name = match names.get(&uid) {
            Some(name) if *name != uid_value => name.clone(),
            _ => snapshot_device_name(&dir).map_or(Value::Null, Value::String),
        };
        files.push(KeyboardSettingsFile { uid, name, content });
    }
    Ok(files)
}

/// The files as JSON text: `[{uid, name, content}, …]`, with a name read
/// from the keyboard names written as `JSON.stringify` writes it.
pub fn keyboard_settings_files_json(files: &[KeyboardSettingsFile]) -> String {
    let items = files
        .iter()
        .map(|file| {
            let mut item = Object::new();
            item.insert("uid", file.uid.as_str().into());
            item.insert("name", file.name.clone());
            item.insert("content", file.content.as_str().into());
            Value::Object(item)
        })
        .collect();
    pipette_js_json::stringify(&Value::Array(items))
}
