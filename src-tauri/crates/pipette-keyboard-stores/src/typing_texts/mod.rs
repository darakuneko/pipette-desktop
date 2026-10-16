// SPDX-License-Identifier: GPL-2.0-or-later
//! The typing test texts: `sync/typing-test-texts`, the store of
//! src/main/typing-test-text-store.ts, synced as the unit
//! `typing-test-texts`.
//!
//! `index.json` is `{entries}` written as `JSON.stringify(index, null, 2)`;
//! each body (`{id}_{ts}.json`) is `{name, text}` with two-space
//! indentation, the text normalized and capped at
//! [`pipette_typing_text::MAX_WORDS`] words when it is saved. An index that
//! cannot be read, is not an object or has no `entries` list reads as empty
//! and is replaced by the next write; one nested too deeply to parse here
//! (`JSON.parse` reads it) fails every operation instead and is left as it
//! is. Every read of the index keeps an entry's `source` only when its
//! `provider` and `workId` are strings (as `{provider, workId}`), and every
//! write writes `{entries}` alone; the entries' other fields and their
//! order survive.
//!
//! The writes run under the store's write lock (`typing-test-texts`, the
//! name of its sync unit) and move legacy body names to id-carrying ones on
//! their read of the index. The reads (list, get, an import's lookup of an
//! existing name) read the index as it is.
//!
//! A [`TypingTextStore`] holds what the Electron build keeps in its main
//! process: whether each text is pure kana (`romajiCapable`, computed from
//! the body and never written), cached by the entry's id and body filename,
//! and the import held for the user's confirmation (import.rs).
//!
//! Every operation answers like its handler: failures are values
//! ([`TypingTextError`], with the handler's error code and `String(err)`),
//! turned into the `{success, data?, errorCode?, error?}` response by
//! [`typing_text_response`].

mod error;
mod import;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use pipette_entry_store::{
    Entry, EntryGroup, EntryStore, OverwriteOptions, id_body_filename, mark_deleted, overwrite_entry,
    touch_clock, ts_for_filename,
};
use pipette_js_json::{JsString, Object, Value};
use pipette_time::iso_8601_millis;
use pipette_typing_text::{MAX_WORDS, is_kana_only_text, normalize_file_import_text};

pub use error::{TypingTextError, TypingTextErrorCode, typing_text_response};
pub use import::TYPING_TEXT_MAX_FILE_BYTES;

use crate::StoreContext;
use crate::entry_files::body_path;
use crate::entry_index::{
    EntryIndex, IndexSpec, find_active_by_name, has_id, read_index, read_index_locked, read_json,
    validate_name, write_body, write_index,
};
use error::{duplicate_name, not_found};
use import::PendingImport;

const STORE: EntryStore = EntryStore::TypingTestTexts;

/// The store's sync unit, which is also its write-lock key.
pub const TYPING_TEXT_SYNC_UNIT: &str = "typing-test-texts";

/// Every read keeps a `source` only in its `{provider, workId}` form, and
/// every write writes `{entries}` alone.
const INDEX: IndexSpec = IndexSpec { store: STORE, keeps_other_fields: false, on_read: sanitize_source };

/// The catalog a text was imported from (`source` of the meta).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TypingTextSource {
    pub provider: JsString,
    /// The catalog entry's `name` path, which finds a work imported before.
    pub work_id: JsString,
}

/// What a save writes (`SaveTextInput`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TypingTextSave {
    /// The entry to write over or create; a new UUID when `None`.
    pub id: Option<JsString>,
    pub name: JsString,
    /// The raw text, normalized and capped by the save.
    pub text: JsString,
    /// Set by a catalog import (the Aozora Bunko one), never by a file
    /// import.
    pub source: Option<TypingTextSource>,
    /// Keep the name the live entry `id` has when the save runs (under the
    /// lock) instead of `name`: the confirmed overwrite of a same-named
    /// import, so a rename made while the prompt was open stays.
    pub keep_current_name: bool,
}

impl TypingTextSave {
    /// A new text named `name`: no id, no catalog source, the name given
    /// kept. Set the other fields on the result to write over an entry or
    /// record a catalog.
    pub fn new(name: impl Into<JsString>, text: impl Into<JsString>) -> Self {
        Self { id: None, name: name.into(), text: text.into(), source: None, keep_current_name: false }
    }
}

/// The cached `romajiCapable` of an entry, with the body filename it was
/// computed from: every save that changes the text writes a new filename,
/// and nothing else changes the text.
type RomajiCache = HashMap<JsString, (Option<Value>, bool)>;

#[derive(Default)]
struct State {
    romaji: Mutex<RomajiCache>,
    pending: Mutex<Option<PendingImport>>,
}

impl State {
    /// Holds `import` for the confirmation, replacing any held one; `None`
    /// drops it.
    fn set_pending(&self, import: Option<PendingImport>) {
        *self.pending.lock().unwrap_or_else(PoisonError::into_inner) = import;
    }

    /// The held import, which is no longer held.
    fn take_pending(&self) -> Option<PendingImport> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner).take()
    }
}

/// The store's in-process state; the files live under the context's
/// userData directory. Cheap to clone; the clones share the state. One per
/// process, as the Electron build's module state is.
#[derive(Clone, Default)]
pub struct TypingTextStore {
    state: Arc<State>,
}

fn store_dir(ctx: &StoreContext) -> PathBuf {
    ctx.sync_dir().join(TYPING_TEXT_SYNC_UNIT)
}

/// `source` as the store reads it (`sanitizeSource`): `{provider, workId}`
/// when both are strings, otherwise no `source` at all.
fn sanitize_source(entry: &mut Entry) {
    let Some(source) = entry.get("source") else { return };
    let kept = source.as_object().and_then(|source| match (source.get("provider"), source.get("workId")) {
        (Some(provider @ Value::String(_)), Some(work_id @ Value::String(_))) => Some(Value::Object(
            [("provider", provider.clone()), ("workId", work_id.clone())].into_iter().collect(),
        )),
        _ => None,
    });
    match kept {
        Some(kept) => entry.set("source", kept),
        None => {
            entry.remove("source");
        }
    }
}

/// The text of a body file (`normalizeFile`): `None` unless the file is an
/// object with a string `name` and a string `text`.
fn body_text(parsed: &Value) -> Option<&JsString> {
    let file = parsed.as_object()?;
    match (file.get("name"), file.get("text")) {
        (Some(Value::String(_)), Some(Value::String(text))) => Some(text),
        _ => None,
    }
}

/// The text of the body of `entry`, `None` when it cannot be read or is
/// malformed.
fn stored_text(dir: &Path, entry: &Entry) -> Option<JsString> {
    let parsed = read_json::<TypingTextErrorCode>(&body_path(dir, entry).ok()?).ok()?;
    body_text(&parsed).cloned()
}

fn is_kana_only(text: &JsString) -> bool {
    is_kana_only_text(&text.utf16_units())
}

impl TypingTextStore {
    fn cached_romaji(&self, entry: &Entry) -> Option<bool> {
        let id = entry.id()?;
        let cache = self.state.romaji.lock().unwrap_or_else(PoisonError::into_inner);
        cache
            .get(id)
            .and_then(|(filename, capable)| (filename.as_ref() == entry.get("filename")).then_some(*capable))
    }

    fn cache_romaji(&self, entry: &Entry, capable: bool) {
        let Some(id) = entry.id() else { return };
        let mut cache = self.state.romaji.lock().unwrap_or_else(PoisonError::into_inner);
        cache.insert(id.clone(), (entry.get("filename").cloned(), capable));
    }

    /// Whether the text of `meta` is pure kana (`romajiCapable`): the
    /// answer cached for its body filename, or `text()` checked and cached.
    /// No text (a body that cannot be read or is malformed, also one nested
    /// too deeply to parse here) is not.
    fn romaji_capable_of(&self, meta: &Entry, text: impl FnOnce() -> Option<JsString>) -> bool {
        if let Some(capable) = self.cached_romaji(meta) {
            return capable;
        }
        let capable = text().is_some_and(|text| is_kana_only(&text));
        self.cache_romaji(meta, capable);
        capable
    }

    /// The entries of a list (`TYPING_TEST_TEXT_LIST`; `listAllMetas` with
    /// `include_deleted`), in the index's order, each with its
    /// `romajiCapable`.
    pub fn list(&self, ctx: &StoreContext, include_deleted: bool) -> Result<Vec<Entry>, TypingTextError> {
        let dir = store_dir(ctx);
        let entries = read_index(&INDEX, &dir)?
            .entries
            .into_iter()
            .filter(|entry| include_deleted || !entry.is_deleted());
        Ok(entries
            .map(|mut entry| {
                let capable = self.romaji_capable_of(&entry, || stored_text(&dir, &entry));
                entry.set("romajiCapable", capable);
                entry
            })
            .collect())
    }

    /// The live entry `id` and its body (`TYPING_TEST_TEXT_GET`): `{meta,
    /// data}`, the meta with its `romajiCapable` and the body with the
    /// entry's name, which a rename changes in the index only.
    pub fn get(&self, ctx: &StoreContext, id: &JsString) -> Result<Object, TypingTextError> {
        let dir = store_dir(ctx);
        let meta = read_index(&INDEX, &dir)?.entries.into_iter().find(|entry| has_id(entry, id));
        let mut meta = meta.filter(|meta| !meta.is_deleted()).ok_or_else(not_found)?;
        let parsed = read_json(&body_path(&dir, &meta)?)?;
        let text = body_text(&parsed)
            .ok_or_else(|| TypingTextError::invalid_file("Stored file is malformed"))?
            .clone();
        let capable = self.romaji_capable_of(&meta, || Some(text.clone()));
        let mut data = Object::new();
        // `{...parsed, name: meta.name}`: an undefined name is left out.
        if let Some(name) = meta.get("name") {
            data.insert("name", name.clone());
        }
        data.insert("text", Value::String(text));
        meta.set("romajiCapable", capable);
        Ok([("meta", Value::from(meta)), ("data", Value::Object(data))].into_iter().collect())
    }

    /// Saves a text (`saveRecord`): a new entry last in the index, or the
    /// entry `input.id` written over in its place, brought back if deleted
    /// (every save is a user action). The previous body file is removed.
    /// Returns the entry, without `romajiCapable`.
    pub fn save(&self, ctx: &StoreContext, input: &TypingTextSave) -> Result<Entry, TypingTextError> {
        let validated = validate_name(&input.name)?;
        let normalized = normalize_file_import_text(&input.text.utf16_units(), MAX_WORDS);
        if normalized.word_count == 0 {
            return Err(TypingTextError::refused(
                TypingTextErrorCode::EmptyText,
                "Text has no typeable words",
            ));
        }
        let text = JsString::from_utf16(normalized.text);
        ctx.locks().with_write_lock(TYPING_TEXT_SYNC_UNIT, || {
            let dir = store_dir(ctx);
            let entries = read_index_locked(&INDEX, &dir)?.entries;
            let current = match (&input.id, input.keep_current_name) {
                (Some(id), true) => entries.iter().find(|entry| has_id(entry, id) && !entry.is_deleted()),
                _ => None,
            };
            // `current?.name ?? validated`
            let name = match current.and_then(|entry| entry.get("name")) {
                None | Some(Value::Null) => Value::String(validated),
                Some(name) => name.clone(),
            };
            if find_active_by_name(&entries, &name, input.id.as_ref())?.is_some() {
                return Err(duplicate_name());
            }

            let now = ctx.now_ms();
            let id = input.id.clone().unwrap_or_else(|| ctx.new_id().into());
            let filename =
                id_body_filename(STORE, &id, &JsString::from(format!("{}.json", ts_for_filename(now))));
            let at = entries.iter().position(|entry| has_id(entry, &id));
            let previous = at.map(|at| &entries[at]);
            let saved_at = iso_8601_millis(now);
            let mut fields = Object::new();
            fields.insert("id", Value::String(id));
            fields.insert("name", name.clone());
            fields.insert("wordCount", count(normalized.word_count));
            fields.insert("lineCount", count(normalized.line_count));
            fields.insert("filename", Value::String(filename.clone()));
            fields.insert("savedAt", saved_at.clone().into());
            // Derived from the clocks by the write; set here for its position.
            fields.insert("updatedAt", saved_at.into());
            if let Some(source) = &input.source {
                let source: Object = [
                    ("provider", Value::String(source.provider.clone())),
                    ("workId", Value::String(source.work_id.clone())),
                ]
                .into_iter()
                .collect();
                fields.insert("source", Value::Object(source));
            }
            let meta = overwrite_entry(
                STORE,
                previous,
                fields,
                now,
                OverwriteOptions { body: true, explicit: true },
            )?;

            let body: Object = [("name", name), ("text", Value::String(text.clone()))].into_iter().collect();
            write_body(&dir, &filename, &body)?;
            self.cache_romaji(&meta, is_kana_only(&text));
            // Best effort: a missing or unsafe previous body never fails the save.
            if let Some(previous) = previous
                && previous.get("filename") != Some(&Value::String(filename))
                && let Ok(path) = body_path(&dir, previous)
            {
                let _ = fs::remove_file(path);
            }

            let mut entries = entries;
            match at {
                Some(at) => entries[at] = meta.clone(),
                None => entries.push(meta.clone()),
            }
            write_index(&dir, &EntryIndex::bare(entries))?;
            ctx.notify(TYPING_TEXT_SYNC_UNIT);
            Ok(meta)
        })
    }

    /// Renames the live entry `id` (`renameRecord`): the index only, the
    /// body file keeps the name it was saved with. Returns the entry.
    pub fn rename(
        &self,
        ctx: &StoreContext,
        id: &JsString,
        name: &JsString,
    ) -> Result<Entry, TypingTextError> {
        let name = Value::String(validate_name(name)?);
        ctx.locks().with_write_lock(TYPING_TEXT_SYNC_UNIT, || {
            let dir = store_dir(ctx);
            let mut entries = read_index_locked(&INDEX, &dir)?.entries;
            let at = entries
                .iter()
                .position(|entry| has_id(entry, id) && !entry.is_deleted())
                .ok_or_else(not_found)?;
            if find_active_by_name(&entries, &name, Some(id))?.is_some() {
                return Err(duplicate_name());
            }
            let meta = &mut entries[at];
            meta.set("name", name);
            touch_clock(meta, EntryGroup::Name, ctx.now_ms())?;
            let meta = meta.clone();
            write_index(&dir, &EntryIndex::bare(entries))?;
            ctx.notify(TYPING_TEXT_SYNC_UNIT);
            Ok(meta)
        })
    }

    /// Tombstones the entry `id` (`deleteRecord`), again when it already
    /// is; its body stays for sync.
    pub fn delete(&self, ctx: &StoreContext, id: &JsString) -> Result<(), TypingTextError> {
        ctx.locks().with_write_lock(TYPING_TEXT_SYNC_UNIT, || {
            let dir = store_dir(ctx);
            let mut entries = read_index_locked(&INDEX, &dir)?.entries;
            let at = entries.iter().position(|entry| has_id(entry, id)).ok_or_else(not_found)?;
            mark_deleted(&mut entries[at], ctx.now_ms());
            write_index(&dir, &EntryIndex::bare(entries))?;
            ctx.notify(TYPING_TEXT_SYNC_UNIT);
            Ok(())
        })
    }
}

/// A count as the JSON number it is written as.
fn count(n: usize) -> Value {
    // Counts are at most MAX_WORDS, far below f64's exact integers.
    Value::Number(f64::from(u32::try_from(n).unwrap_or(u32::MAX)))
}
