// SPDX-License-Identifier: GPL-2.0-or-later
//! The keystroke logs of a keyboard's Typing Test runs:
//! `sync/keyboards/{uid}/runs`, the store of
//! src/main/typing-run-log-store.ts, synced as the unit of the same name.
//!
//! The index is the snapshots' (`{uid, entries}`, see keyboard_index.rs),
//! with one entry per run keyed by its run id; each body
//! (`{ts}_{runId}.json`) is the log as `JSON.stringify` writes it. A save
//! is refused unless the user accepted the recording consent, and checks
//! the log first (validate.rs). It then keeps the
//! [`MAX_RUN_LOGS_PER_KEYBOARD`] runs that started last (the others are
//! tombstoned and their bodies removed) and removes every body the index
//! does not name, so the store stays bounded on disk. There is no delete:
//! the trim is the only way out.
//!
//! The save runs under the uid's write lock, the lock the keyboard's other
//! stores share, and moves legacy body names to id-carrying ones on its
//! read of the index; the list and the get read the index as it is. Every
//! operation answers like its handler: failures are values
//! ([`RunLogError`], whose text is the handler's error text).

mod validate;

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use pipette_entry_store::{
    Entry, EntryError, EntryStore, OverwriteOptions, apply_run_log_retention, id_body_filename,
    is_safe_path_segment, overwrite_entry, ts_for_filename, unlink_unreferenced_body_files,
};
use pipette_js_json::{JsString, Object, Value};
use pipette_time::iso_8601_millis;

use crate::StoreContext;
use crate::entry_files::{BodyPathError, body_path, body_path_of, entry_error_text, read_text};
use crate::keyboard_index::{
    IndexError, KeyboardIndex, find_entry, read_index, read_index_locked, write_index,
};

pub use validate::{MAX_RUN_LOG_BYTES, MAX_RUN_LOG_EVENTS};

/// The runs a keyboard keeps.
pub const MAX_RUN_LOGS_PER_KEYBOARD: usize = 50;

const STORE: EntryStore = EntryStore::RunLogs;

/// The sync unit of `uid`'s run logs.
pub fn run_logs_sync_unit(uid: &str) -> String {
    format!("keyboards/{uid}/runs")
}

/// Why a run log operation failed. The text is what the handler answers as
/// `error`: its own messages as they are, a thrown error as `String(err)`.
/// The text of a file-system error is this OS's, and that of a body that
/// is not JSON this parser's, not Node's.
#[derive(Debug, thiserror::Error)]
pub enum RunLogError {
    #[error("Invalid uid")]
    InvalidUid,
    #[error("Recording consent not accepted")]
    ConsentNotAccepted,
    #[error("Malformed run log")]
    Malformed,
    #[error("Invalid runId")]
    InvalidRunId,
    #[error("uid mismatch")]
    UidMismatch,
    #[error("Invalid startedAt")]
    InvalidStartedAt,
    #[error("Invalid durationMs")]
    InvalidDurationMs,
    #[error("Invalid mode")]
    InvalidMode,
    #[error("Invalid language")]
    InvalidLanguage,
    #[error("Invalid charCorrelationUnavailable")]
    InvalidCharCorrelationUnavailable,
    #[error("Invalid romajiInput")]
    InvalidRomajiInput,
    #[error("Invalid words")]
    InvalidWords,
    #[error("Invalid word entry")]
    InvalidWordEntry,
    #[error("Too many keystrokes")]
    TooManyKeystrokes,
    #[error("Invalid lineBreaks")]
    InvalidLineBreaks,
    #[error("Run log too large")]
    TooLarge,
    #[error("Not found")]
    NotFound,
    #[error("Error: Invalid filename")]
    InvalidFilename,
    /// An entry whose `filename` is a truthy value that is not a string,
    /// which Node's `path.join` refuses.
    #[error("TypeError: The \"path\" argument must be of type string")]
    FilenameNotString,
    /// A body that is not JSON.
    #[error("SyntaxError: {0}")]
    Syntax(pipette_js_json::ParseError),
    #[error("Error: {0}")]
    Io(#[from] io::Error),
    #[error("{}", entry_error_text(.0))]
    Entry(#[from] EntryError),
    #[error("Error: {}: nested too deeply to read", .0.display())]
    TooDeep(PathBuf),
}

impl From<BodyPathError> for RunLogError {
    fn from(err: BodyPathError) -> Self {
        match err {
            BodyPathError::Invalid => RunLogError::InvalidFilename,
            BodyPathError::NotString => RunLogError::FilenameNotString,
        }
    }
}

impl From<IndexError> for RunLogError {
    fn from(err: IndexError) -> Self {
        match err {
            IndexError::TooDeep(path) => RunLogError::TooDeep(path),
            IndexError::Io(err) => RunLogError::Io(err),
        }
    }
}

fn validate_uid(uid: &str) -> Result<(), RunLogError> {
    if is_safe_path_segment(uid) { Ok(()) } else { Err(RunLogError::InvalidUid) }
}

fn run_log_dir(ctx: &StoreContext, uid: &str) -> PathBuf {
    ctx.sync_dir().join("keyboards").join(uid).join("runs")
}

/// Removes the bodies of `entries`, skipping any that cannot be removed (a
/// body already gone is not an error).
fn unlink_bodies<'a>(dir: &Path, entries: impl IntoIterator<Item = &'a Entry>) {
    for entry in entries {
        if let Ok(path) = body_path(dir, entry) {
            let _ = fs::remove_file(path);
        }
    }
}

/// Saves `raw`, the log the renderer sent (`None` when it sent none), as
/// the run log of `uid` (`TYPING_RUN_LOG_SAVE`), replacing a saved run of
/// the same id. `consent_accepted` is the app config's
/// `typingRecordingConsentAccepted`. Returns the run's entry as saved,
/// before the trim.
pub fn save_run_log(
    ctx: &StoreContext,
    uid: &str,
    raw: Option<&Value>,
    consent_accepted: bool,
) -> Result<Entry, RunLogError> {
    validate_uid(uid)?;
    if !consent_accepted {
        return Err(RunLogError::ConsentNotAccepted);
    }
    let log = validate::validate_run_log(raw, uid)?;
    ctx.locks().with_write_lock(uid, || {
        let dir = run_log_dir(ctx, uid);
        fs::create_dir_all(&dir)?;
        let now = ctx.now_ms();
        let filename =
            id_body_filename(STORE, &log.run_id, &JsString::from(format!("{}.json", ts_for_filename(now))));
        let path = body_path_of(&dir, &filename.to_string_lossy()).ok_or(RunLogError::InvalidFilename)?;
        pipette_fs::write_file_atomic(&path, log.serialized.as_bytes())?;

        let mut index = read_index_locked(STORE, &dir, uid)?;
        // A run saved again by id is the recorder's own write: it brings a
        // tombstoned id back like a save of an absent id.
        let existing = find_entry(&index.entries, &log.run_id).map(|at| index.entries[at].clone());
        let mut fields = Object::new();
        fields.insert("id", Value::String(log.run_id.clone()));
        fields.insert("startedAt", Value::String(log.started_at));
        fields.insert("filename", Value::String(filename.clone()));
        fields.insert("savedAt", iso_8601_millis(now).into());
        let options = OverwriteOptions { body: true, explicit: true };
        let meta = overwrite_entry(STORE, existing.as_ref(), fields, now, options)?;

        let mut entries = vec![meta.clone()];
        entries
            .extend(std::mem::take(&mut index.entries).into_iter().filter(|e| e.id() != Some(&log.run_id)));
        let (entries, evicted) = apply_run_log_retention(entries, MAX_RUN_LOGS_PER_KEYBOARD, now);
        let referenced: HashSet<JsString> = entries.iter().filter_map(Entry::filename).cloned().collect();
        index.entries = entries;
        write_index(&dir, index)?;
        unlink_bodies(&dir, &evicted);
        // The body the replaced entry named (its timestamp differs) is out
        // of the index now, so the trim would never remove it.
        if let Some(existing) = existing.filter(|e| e.filename() != Some(&filename)) {
            unlink_bodies(&dir, [&existing]);
        }
        // A body no entry names (a save whose index write failed after its
        // body was written) is never trimmed either.
        unlink_unreferenced_body_files(STORE, &dir, &referenced);

        ctx.notify(&run_logs_sync_unit(uid));
        Ok(meta)
    })
}

fn read_runs(ctx: &StoreContext, uid: &str) -> Result<(PathBuf, KeyboardIndex), RunLogError> {
    validate_uid(uid)?;
    let dir = run_log_dir(ctx, uid);
    let index = read_index(STORE, &dir, uid)?;
    Ok((dir, index))
}

/// The live runs of `uid` (`TYPING_RUN_LOG_LIST`), in the index's order.
pub fn list_run_logs(ctx: &StoreContext, uid: &str) -> Result<Vec<Entry>, RunLogError> {
    let (_, index) = read_runs(ctx, uid)?;
    Ok(index.entries.into_iter().filter(|entry| !entry.is_deleted()).collect())
}

/// The log of `uid`'s run `run_id` (`TYPING_RUN_LOG_GET`), as `JSON.parse`
/// reads its body.
pub fn get_run_log(ctx: &StoreContext, uid: &str, run_id: &str) -> Result<Value, RunLogError> {
    let (dir, index) = read_runs(ctx, uid)?;
    let entry = find_entry(&index.entries, &JsString::from(run_id))
        .map(|at| &index.entries[at])
        .filter(|entry| !entry.is_deleted())
        .ok_or(RunLogError::NotFound)?;
    let text = read_text(&body_path(&dir, entry)?)?;
    pipette_js_json::parse(&text).map_err(RunLogError::Syntax)
}
