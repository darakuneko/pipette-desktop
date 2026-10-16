// SPDX-License-Identifier: GPL-2.0-or-later
//! The key labels: `sync/key-labels`, the store of
//! src/main/key-label-store.ts, synced as the unit `key-labels`.
//!
//! `index.json` is `{entries}` written as `JSON.stringify(index, null, 2)`;
//! each body (`{id}_{ts}.json`) is `{name, map, compositeLabels?,
//! keymapApplicable?}` with two-space indentation. The built-in QWERTY
//! entry (id `qwerty`, every clock at the epoch) is created by the first
//! list, first in the index; its order is the user's afterwards, and it
//! cannot be deleted. An index that cannot be read, is not an object or
//! has no `entries` list reads as empty and is replaced by the next write;
//! one nested too deeply to parse here (`JSON.parse` reads it) fails every
//! operation instead and is left as it is. Fields this build does not know,
//! of the entries and their order, survive every write; the other
//! top-level fields of the index survive the writes that change entries in
//! place (rename, delete, Hub link, the QWERTY entry) and are dropped by a
//! save and a reorder, which write `{entries}`, as the Electron build does.
//!
//! The writes run under the store's write lock (`key-labels`, the name of
//! its sync unit) and move legacy body names to id-carrying ones on their
//! read of the index; so does a list that has to create or complete the
//! QWERTY entry. The other reads (list, get, the name check, an import's
//! lookup of an existing name) read the index as it is. A reorder is per
//! device: it moves no clock and reports no change.
//!
//! Every operation answers like its handler: failures are values
//! ([`KeyLabelError`], with the handler's error code and `String(err)`),
//! turned into the `{success, data?, errorCode?, error?}` response by
//! [`key_label_response`].

mod label_file;
mod transfer;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use pipette_entry_store::{
    EPOCH_ISO, Entry, EntryError, EntryGroup, EntryList, EntryStore, OverwriteOptions, builtin_entry,
    id_body_filename, mark_deleted, migrate_body_filenames, normalize_entries, overwrite_entry, set_clock,
    touch_clock, trim_js_whitespace, ts_for_filename,
};
use pipette_js_json::{JsString, Object, Value};
use pipette_time::iso_8601_millis;

pub use label_file::MAX_NAME_LENGTH;
pub use transfer::{KeyLabelExport, export_key_label, import_key_label_files};

use crate::StoreContext;
use crate::entry_files::{BodyPathError, body_path, body_path_of, entry_error_text, read_text};
use label_file::{is_label_map, name_key, normalize_file, validate_name};

const STORE: EntryStore = EntryStore::KeyLabels;

/// The store's sync unit, which is also its write-lock key.
pub const KEY_LABEL_SYNC_UNIT: &str = "key-labels";

/// The id of the built-in QWERTY entry, the same on every device.
pub const QWERTY_ENTRY_ID: &str = "qwerty";

/// The error codes the renderer branches on (`KeyLabelStoreErrorCode` in
/// src/shared/types/key-label-store.ts).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyLabelErrorCode {
    InvalidName,
    DuplicateName,
    NotFound,
    InvalidFile,
    IoError,
}

impl KeyLabelErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyLabelErrorCode::InvalidName => "INVALID_NAME",
            KeyLabelErrorCode::DuplicateName => "DUPLICATE_NAME",
            KeyLabelErrorCode::NotFound => "NOT_FOUND",
            KeyLabelErrorCode::InvalidFile => "INVALID_FILE",
            KeyLabelErrorCode::IoError => "IO_ERROR",
        }
    }
}

/// Why a key label operation failed. The text is what the handler answers
/// as `error`: its own messages as they are, a thrown error as
/// `String(err)`. The texts of a file-system error and of a JSON syntax
/// error are this build's, not Node's and V8's.
#[derive(Debug, thiserror::Error)]
pub enum KeyLabelError {
    /// A failure the store answers with its own code and message.
    #[error("{1}")]
    Refused(KeyLabelErrorCode, String),
    #[error("Error: Invalid filename")]
    InvalidFilename,
    /// An entry whose `filename` is a truthy value that is not a string,
    /// which Node's `path.join` refuses.
    #[error("TypeError: The \"path\" argument must be of type string")]
    FilenameNotString,
    /// The TypeError of a string method called on a value that is not a
    /// string (a name of another type in the index).
    #[error("TypeError: {0}")]
    Type(String),
    #[error("SyntaxError: {0}")]
    Syntax(String),
    #[error("Error: {0}")]
    Io(#[from] io::Error),
    #[error("{}", entry_error_text(.0))]
    Entry(#[from] EntryError),
    #[error("Error: {}: nested too deeply to read", .0.display())]
    TooDeep(PathBuf),
}

impl KeyLabelError {
    fn refused(code: KeyLabelErrorCode, message: &str) -> Self {
        KeyLabelError::Refused(code, message.to_owned())
    }

    pub(crate) fn invalid_name(message: &str) -> Self {
        Self::refused(KeyLabelErrorCode::InvalidName, message)
    }

    fn duplicate_name() -> Self {
        Self::refused(KeyLabelErrorCode::DuplicateName, "A label with the same name already exists")
    }

    fn not_found() -> Self {
        Self::refused(KeyLabelErrorCode::NotFound, "Key label not found")
    }

    pub(crate) fn invalid_file(message: &str) -> Self {
        Self::refused(KeyLabelErrorCode::InvalidFile, message)
    }

    /// The answer of a handler whose argument has the wrong type.
    pub fn invalid_argument(code: KeyLabelErrorCode, message: &str) -> Self {
        Self::refused(code, message)
    }

    /// The `cancelled` answer of a dialog the user closed.
    pub fn cancelled() -> Self {
        Self::refused(KeyLabelErrorCode::IoError, "cancelled")
    }

    /// The handler's `errorCode`: a thrown error is `IO_ERROR`.
    pub fn code(&self) -> &'static str {
        match self {
            KeyLabelError::Refused(code, _) => code.as_str(),
            _ => KeyLabelErrorCode::IoError.as_str(),
        }
    }
}

impl From<BodyPathError> for KeyLabelError {
    fn from(err: BodyPathError) -> Self {
        match err {
            BodyPathError::Invalid => KeyLabelError::InvalidFilename,
            BodyPathError::NotString => KeyLabelError::FilenameNotString,
        }
    }
}

/// The handler's answer as JSON text: `{"success":true}` with `data` when
/// there is one, or `{"success":false,"errorCode":…,"error":…}`.
pub fn key_label_response(result: Result<Option<Value>, KeyLabelError>) -> String {
    let mut response = Object::new();
    match result {
        Ok(data) => {
            response.insert("success", true.into());
            if let Some(data) = data {
                response.insert("data", data);
            }
        }
        Err(err) => {
            response.insert("success", false.into());
            response.insert("errorCode", err.code().into());
            response.insert("error", err.to_string().into());
        }
    }
    pipette_js_json::stringify(&Value::Object(response))
}

/// The index file: its top-level object, whose `entries` holds the place of
/// [`Self::entries`] (the entries as v2 entries) for a write.
struct KeyLabelIndex {
    root: Object,
    entries: Vec<Entry>,
}

impl KeyLabelIndex {
    /// An index of `entries` alone, `{entries}`.
    fn bare(entries: Vec<Entry>) -> Self {
        Self { root: std::iter::once(("entries", Value::Array(Vec::new()))).collect(), entries }
    }
}

impl EntryList for KeyLabelIndex {
    fn entries(&self) -> &[Entry] {
        &self.entries
    }

    fn entries_mut(&mut self) -> &mut [Entry] {
        &mut self.entries
    }
}

fn store_dir(ctx: &StoreContext) -> PathBuf {
    ctx.sync_dir().join("key-labels")
}

/// The index in `dir` (`readIndex`): empty when the file is missing,
/// unreadable, not JSON, or not an object with an `entries` list.
fn read_index(dir: &Path) -> Result<KeyLabelIndex, KeyLabelError> {
    let path = dir.join("index.json");
    let Ok(text) = read_text(&path) else { return Ok(KeyLabelIndex::bare(Vec::new())) };
    let mut root = match pipette_js_json::parse(&text) {
        Ok(Value::Object(root)) if matches!(root.get("entries"), Some(Value::Array(_))) => root,
        Err(err) if err.is_nesting_too_deep() => return Err(KeyLabelError::TooDeep(path)),
        _ => return Ok(KeyLabelIndex::bare(Vec::new())),
    };
    let entries = normalize_entries(STORE, root.get("entries"));
    // Holds the place of the entries, which a write puts back.
    root.insert("entries", Value::Array(Vec::new()));
    Ok(KeyLabelIndex { root, entries })
}

fn write_index(dir: &Path, index: &KeyLabelIndex) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let mut root = index.root.clone();
    root.insert("entries", Value::Array(index.entries.iter().cloned().map(Value::from).collect()));
    let text = pipette_js_json::stringify_with_gap(&Value::Object(root), "  ");
    pipette_fs::write_file_atomic(&dir.join("index.json"), text.as_bytes())
}

/// The index for a writer holding the store's lock, with the legacy body
/// names moved to id-carrying ones (written back when any moved).
fn read_index_locked(dir: &Path) -> Result<KeyLabelIndex, KeyLabelError> {
    let mut index = read_index(dir)?;
    migrate_body_filenames(STORE, dir, &mut index, |index| write_index(dir, index))?;
    Ok(index)
}

fn has_id(entry: &Entry, id: &JsString) -> bool {
    entry.id() == Some(id)
}

fn position_of(entries: &[Entry], id: &JsString) -> Option<usize> {
    entries.iter().position(|entry| has_id(entry, id))
}

/// The first live entry other than `exclude_id` whose name is `name`,
/// ignoring case and surrounding whitespace (`findActiveByName`). Fails as
/// JavaScript does on a name that is not a string: `name` read as
/// `name_receiver`, or a checked entry's.
fn find_active_by_name<'a>(
    entries: &'a [Entry],
    name: Option<&Value>,
    name_receiver: &str,
    exclude_id: Option<&JsString>,
) -> Result<Option<&'a Entry>, KeyLabelError> {
    let target = name_key(name, name_receiver)?;
    for entry in entries {
        if entry.is_deleted() || exclude_id.is_some_and(|id| has_id(entry, id)) {
            continue;
        }
        if name_key(entry.get("name"), "e.name")? == target {
            return Ok(Some(entry));
        }
    }
    Ok(None)
}

/// Writes the body of an entry whose filename this store made.
fn write_body(dir: &Path, filename: &JsString, body: &Object) -> Result<(), KeyLabelError> {
    fs::create_dir_all(dir)?;
    let path = body_path_of(dir, &filename.to_string_lossy()).ok_or(KeyLabelError::InvalidFilename)?;
    let text = pipette_js_json::stringify_with_gap(&Value::Object(body.clone()), "  ");
    Ok(pipette_fs::write_file_atomic(&path, text.as_bytes())?)
}

/// The QWERTY body file, the same on every device.
fn qwerty_filename() -> JsString {
    id_body_filename(STORE, &QWERTY_ENTRY_ID.into(), &"builtin.json".into())
}

/// Creates the QWERTY entry, first in the index, or gives one without an
/// author the author `pipette` at the epoch hub clock, so every device
/// writes the same entry. Under the store's lock.
fn ensure_qwerty_locked(ctx: &StoreContext, dir: &Path) -> Result<(), KeyLabelError> {
    let mut index = read_index_locked(dir)?;
    let qwerty = JsString::from(QWERTY_ENTRY_ID);
    if let Some(at) = position_of(&index.entries, &qwerty) {
        let entry = &mut index.entries[at];
        if !entry.get("uploaderName").is_some_and(Value::is_truthy) {
            entry.set("uploaderName", "pipette");
            set_clock(entry, EntryGroup::Hub, EPOCH_ISO);
            write_index(dir, &index)?;
            ctx.notify(KEY_LABEL_SYNC_UNIT);
        }
        return Ok(());
    }
    let filename = qwerty_filename();
    let fields: Object = [
        ("id", Value::from(QWERTY_ENTRY_ID)),
        ("name", "QWERTY".into()),
        ("uploaderName", "pipette".into()),
        ("filename", Value::String(filename.clone())),
        ("savedAt", EPOCH_ISO.into()),
    ]
    .into_iter()
    .collect();
    let body: Object =
        [("name", Value::from("QWERTY")), ("map", Value::Object(Object::new()))].into_iter().collect();
    write_body(dir, &filename, &body)?;
    index.entries.insert(0, builtin_entry(STORE, fields));
    write_index(dir, &index)?;
    ctx.notify(KEY_LABEL_SYNC_UNIT);
    Ok(())
}

/// The entries of a list (`KEY_LABEL_STORE_LIST` / `…_LIST_ALL`), in the
/// index's order, tombstones included when `include_deleted`. Makes sure of
/// the QWERTY entry first, taking the lock only when it has to be written.
pub fn list_key_labels(ctx: &StoreContext, include_deleted: bool) -> Result<Vec<Entry>, KeyLabelError> {
    let dir = store_dir(ctx);
    let qwerty = JsString::from(QWERTY_ENTRY_ID);
    let mut entries = read_index(&dir)?.entries;
    let complete = entries
        .iter()
        .find(|entry| has_id(entry, &qwerty))
        .is_some_and(|entry| entry.get("uploaderName").is_some_and(Value::is_truthy));
    if !complete {
        ctx.locks.with_write_lock(KEY_LABEL_SYNC_UNIT, || ensure_qwerty_locked(ctx, &dir))?;
        entries = read_index(&dir)?.entries;
    }
    Ok(entries.into_iter().filter(|entry| include_deleted || !entry.is_deleted()).collect())
}

/// The JSON of a body or an imported file, as `JSON.parse(readFile(…))`
/// reads it.
fn read_json(path: &Path) -> Result<Value, KeyLabelError> {
    pipette_js_json::parse(&read_text(path)?).map_err(|err| {
        if err.is_nesting_too_deep() {
            KeyLabelError::TooDeep(path.to_path_buf())
        } else {
            KeyLabelError::Syntax(err.to_string())
        }
    })
}

/// The live entry `id` and its body (`KEY_LABEL_STORE_GET`): `{meta,
/// data}`, the body as [`normalize_file`] reads it with the entry's name,
/// which a rename changes in the index only.
pub fn get_key_label(ctx: &StoreContext, id: &JsString) -> Result<Object, KeyLabelError> {
    let dir = store_dir(ctx);
    let index = read_index(&dir)?;
    let meta = index.entries.into_iter().find(|entry| has_id(entry, id));
    let meta = meta.filter(|meta| !meta.is_deleted()).ok_or_else(KeyLabelError::not_found)?;
    let path = body_path(&dir, &meta)?;
    let mut data = normalize_file(&read_json(&path)?)
        .ok_or_else(|| KeyLabelError::invalid_file("Stored file is malformed"))?;
    match meta.get("name") {
        // `{...parsed, name: undefined}`, which JSON leaves out.
        None => {
            data.remove("name");
        }
        Some(name) => {
            data.insert("name", name.clone());
        }
    }
    Ok([("meta", Value::from(meta)), ("data", Value::Object(data))].into_iter().collect())
}

/// What a save writes (`SaveRecordInput`). The optional Hub fields are
/// kept when truthy, as the handler does.
#[derive(Clone, Debug, PartialEq)]
pub struct KeyLabelSave {
    /// The entry to write over or create; a new UUID when `None`.
    pub id: Option<JsString>,
    pub name: JsString,
    pub uploader_name: Option<Value>,
    pub map: Value,
    pub composite_labels: Option<Value>,
    /// The author's mark that the map is a pure QWERTY permutation.
    pub keymap_applicable: bool,
    pub hub_post_id: Option<Value>,
    pub hub_updated_at: Option<Value>,
    /// Keep the name the live entry `id` has when the save runs instead of
    /// `name` (a Hub refresh that is not a rename).
    pub keep_current_name: bool,
}

fn truthy(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| value.is_truthy())
}

/// Saves a label (`saveRecord`): a new entry last in the index, or the
/// entry `input.id` written over in its place, brought back if deleted
/// (every save is a user action). The previous body file is removed. Returns
/// the entry.
pub fn save_key_label(ctx: &StoreContext, input: &KeyLabelSave) -> Result<Entry, KeyLabelError> {
    ctx.locks.with_write_lock(KEY_LABEL_SYNC_UNIT, || save_locked(ctx, input))
}

fn save_locked(ctx: &StoreContext, input: &KeyLabelSave) -> Result<Entry, KeyLabelError> {
    let validated = validate_name(&input.name)?;
    if !is_label_map(&input.map) {
        return Err(KeyLabelError::invalid_file("map must be an object of strings"));
    }
    if truthy(input.composite_labels.as_ref()).is_some_and(|labels| !is_label_map(labels)) {
        return Err(KeyLabelError::invalid_file("compositeLabels must be an object of strings"));
    }

    let dir = store_dir(ctx);
    let index = read_index_locked(&dir)?;
    let current = match (&input.id, input.keep_current_name) {
        (Some(id), true) => index.entries.iter().find(|entry| has_id(entry, id) && !entry.is_deleted()),
        _ => None,
    };
    // `current?.name ?? validated`
    let name = match current.and_then(|entry| entry.get("name")) {
        None | Some(Value::Null) => Value::String(validated),
        Some(name) => name.clone(),
    };
    if find_active_by_name(&index.entries, Some(&name), "name", input.id.as_ref())?.is_some() {
        return Err(KeyLabelError::duplicate_name());
    }

    let now = ctx.now_ms();
    let id = input.id.clone().unwrap_or_else(|| ctx.new_id().into());
    let filename = id_body_filename(STORE, &id, &JsString::from(format!("{}.json", ts_for_filename(now))));
    let mut body = Object::new();
    body.insert("name", name.clone());
    body.insert("map", input.map.clone());
    if let Some(labels) = truthy(input.composite_labels.as_ref()) {
        body.insert("compositeLabels", labels.clone());
    }
    if input.keymap_applicable {
        body.insert("keymapApplicable", true.into());
    }

    let at = position_of(&index.entries, &id);
    let previous = at.map(|at| &index.entries[at]);
    let mut fields = Object::new();
    fields.insert("id", Value::String(id.clone()));
    fields.insert("name", name);
    fields.insert("filename", Value::String(filename.clone()));
    fields.insert("savedAt", iso_8601_millis(now).into());
    for (key, value) in [
        ("uploaderName", &input.uploader_name),
        ("hubPostId", &input.hub_post_id),
        ("hubUpdatedAt", &input.hub_updated_at),
    ] {
        if let Some(value) = truthy(value.as_ref()) {
            fields.insert(key, value.clone());
        }
    }
    let meta =
        overwrite_entry(STORE, previous, fields, now, OverwriteOptions { body: true, explicit: true })?;

    write_body(&dir, &filename, &body)?;
    // Best effort: a missing or unsafe previous body never fails the save.
    if let Some(previous) = previous
        && previous.get("filename") != Some(&Value::String(filename))
        && let Ok(path) = body_path(&dir, previous)
    {
        let _ = fs::remove_file(path);
    }

    let mut entries = index.entries;
    match at {
        Some(at) => entries[at] = meta.clone(),
        None => entries.push(meta.clone()),
    }
    write_index(&dir, &KeyLabelIndex::bare(entries))?;
    ctx.notify(KEY_LABEL_SYNC_UNIT);
    Ok(meta)
}

/// Renames the live entry `id` (`renameRecord`): the index only, the body
/// file keeps the name it was saved with. Returns the entry.
pub fn rename_key_label(ctx: &StoreContext, id: &JsString, name: &JsString) -> Result<Entry, KeyLabelError> {
    let name = validate_name(name)?;
    ctx.locks.with_write_lock(KEY_LABEL_SYNC_UNIT, || {
        let dir = store_dir(ctx);
        let mut index = read_index_locked(&dir)?;
        let at = index
            .entries
            .iter()
            .position(|entry| has_id(entry, id) && !entry.is_deleted())
            .ok_or_else(KeyLabelError::not_found)?;
        let name = Value::String(name);
        if find_active_by_name(&index.entries, Some(&name), "name", Some(id))?.is_some() {
            return Err(KeyLabelError::duplicate_name());
        }
        let mut meta = index.entries[at].clone();
        meta.set("name", name);
        touch_clock(&mut meta, EntryGroup::Name, ctx.now_ms())?;
        index.entries[at] = meta.clone();
        write_index(&dir, &index)?;
        ctx.notify(KEY_LABEL_SYNC_UNIT);
        Ok(meta)
    })
}

/// Tombstones the entry `id` (`deleteRecord`), again when it already is;
/// its body stays for sync. The QWERTY entry is refused.
pub fn delete_key_label(ctx: &StoreContext, id: &JsString) -> Result<(), KeyLabelError> {
    if *id == *QWERTY_ENTRY_ID {
        return Err(KeyLabelError::invalid_name("QWERTY cannot be deleted"));
    }
    ctx.locks.with_write_lock(KEY_LABEL_SYNC_UNIT, || {
        let dir = store_dir(ctx);
        let mut index = read_index_locked(&dir)?;
        let at = position_of(&index.entries, id).ok_or_else(KeyLabelError::not_found)?;
        mark_deleted(&mut index.entries[at], ctx.now_ms());
        write_index(&dir, &index)?;
        ctx.notify(KEY_LABEL_SYNC_UNIT);
        Ok(())
    })
}

/// A string field set to its trimmed value, or removed when that is empty
/// or the value is `None` (null).
fn set_trimmed(entry: &mut Entry, key: &str, value: Option<&JsString>) {
    let trimmed = value.map(|value| trim_js_whitespace(&value.utf16_units()).to_vec()).unwrap_or_default();
    if trimmed.is_empty() {
        entry.remove(key);
    } else {
        entry.set(key, Value::String(JsString::from_utf16(trimmed)));
    }
}

/// Links the entry `id` (live or not) to a Hub post (`setHubPostId`). A
/// post id that is `None` or blank once trimmed clears the link and the
/// cached Hub time. `uploader_name` and `hub_updated_at` change their field
/// only when given (`Some`): trimmed, or removed when `Some(None)` or blank.
/// Returns the entry.
pub fn set_key_label_hub_post_id(
    ctx: &StoreContext,
    id: &JsString,
    hub_post_id: Option<&JsString>,
    uploader_name: Option<Option<&JsString>>,
    hub_updated_at: Option<Option<&JsString>>,
) -> Result<Entry, KeyLabelError> {
    ctx.locks.with_write_lock(KEY_LABEL_SYNC_UNIT, || {
        let dir = store_dir(ctx);
        let mut index = read_index_locked(&dir)?;
        let at = position_of(&index.entries, id).ok_or_else(KeyLabelError::not_found)?;
        let mut meta = index.entries[at].clone();
        set_trimmed(&mut meta, "hubPostId", hub_post_id);
        if meta.get("hubPostId").is_none() {
            meta.remove("hubUpdatedAt");
        }
        if let Some(uploader_name) = uploader_name {
            set_trimmed(&mut meta, "uploaderName", uploader_name);
        }
        if let Some(hub_updated_at) = hub_updated_at {
            set_trimmed(&mut meta, "hubUpdatedAt", hub_updated_at);
        }
        touch_clock(&mut meta, EntryGroup::Hub, ctx.now_ms())?;
        index.entries[at] = meta.clone();
        write_index(&dir, &index)?;
        ctx.notify(KEY_LABEL_SYNC_UNIT);
        Ok(meta)
    })
}

/// Puts the live entries named in `ordered_ids` first, in that order
/// (`reorderActive`); the others follow in their order. An id the index
/// holds more than once is placed once, as its last entry, and its other
/// entries go. No clock moves and no change is reported: the order is this
/// device's own.
pub fn reorder_key_labels(ctx: &StoreContext, ordered_ids: &[JsString]) -> Result<(), KeyLabelError> {
    ctx.locks.with_write_lock(KEY_LABEL_SYNC_UNIT, || {
        let dir = store_dir(ctx);
        let index = read_index_locked(&dir)?;
        // The last entry of each id, as a Map built over the entries keeps.
        let mut last_of: HashMap<&JsString, &Entry> = HashMap::new();
        for entry in &index.entries {
            if let Some(id) = entry.id() {
                last_of.insert(id, entry);
            }
        }
        let mut placed: HashSet<&JsString> = HashSet::new();
        let mut reordered = Vec::with_capacity(index.entries.len());
        for id in ordered_ids {
            let Some(&entry) = last_of.get(id) else { continue };
            if entry.is_deleted() || !placed.insert(id) {
                continue;
            }
            reordered.push(entry.clone());
        }
        let was_placed = |entry: &Entry| entry.id().is_some_and(|id| placed.contains(id));
        reordered.extend(index.entries.iter().filter(|entry| !was_placed(entry)).cloned());
        write_index(&dir, &KeyLabelIndex::bare(reordered))?;
        Ok(())
    })
}

/// Whether a live entry other than `exclude_id` has the name `name`,
/// ignoring case and surrounding whitespace (`hasActiveName`).
pub fn has_key_label_name(
    ctx: &StoreContext,
    name: &JsString,
    exclude_id: Option<&JsString>,
) -> Result<bool, KeyLabelError> {
    let index = read_index(&store_dir(ctx))?;
    let name = Value::String(name.clone());
    Ok(find_active_by_name(&index.entries, Some(&name), "name", exclude_id)?.is_some())
}
