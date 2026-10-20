// SPDX-License-Identifier: GPL-2.0-or-later
//! The favorites of each type (tap dance, macro, combo, key override,
//! alt repeat key): `sync/favorites/{type}`, synced as the unit
//! `favorites/{type}`.
//!
//! `index.json` is `{type, entries}` written as `JSON.stringify(index,
//! null, 2)`; each body (`{type}_{ts}_{id}.json`) is `{type, data}` as the
//! renderer or the import wrote it. An index that cannot be read, is not an
//! object, or names another type reads as empty and is replaced by the
//! next write; one nested too deeply to parse here (`JSON.parse` reads it)
//! fails every operation instead and is left as it is. Fields this build
//! does not know, of the index and of its entries, and their order survive
//! a write.
//!
//! The writes run under the type's write lock (`favorites/{type}`, the
//! name of its sync unit) and move legacy body names to id-carrying ones on
//! their read of the index. The list, the load and the read for an export
//! read the index as it is.
//!
//! The export and the import convert keycodes, which the renderer's side
//! does (src/shared/favorite-transfer.ts): an export reads the stored
//! favorites here ([`read_favorites_for_export`]) and the file is written
//! where the user chooses; an import hands over the converted favorites of
//! one type ([`import_favorites`]).
//!
//! Every operation answers like its handler: failures are values
//! ([`FavoriteError`], whose text is the handler's `String(err)`), turned
//! into the `{success, …}` response by [`crate::response_json`].

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use pipette_entry_store::{
    Entry, EntryError, EntryList, EntryMutation, EntryStore, MetaGroup, apply_entry_mutation, create_entry,
    id_body_filename, migrate_body_filenames, normalize_entries, trim_js_whitespace, ts_for_filename,
};
use pipette_js_json::{JsString, Object, Value};
use pipette_time::iso_8601_millis;

use crate::StoreContext;
use crate::entry_files::{BodyPathError, body_path, body_path_of, entry_error_text, read_text};

const STORE: EntryStore = EntryStore::Favorites;

/// A favorite type, the directory and the sync unit of its store.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FavoriteType {
    TapDance,
    Macro,
    Combo,
    KeyOverride,
    AltRepeatKey,
}

impl FavoriteType {
    pub const ALL: [FavoriteType; 5] = [
        FavoriteType::TapDance,
        FavoriteType::Macro,
        FavoriteType::Combo,
        FavoriteType::KeyOverride,
        FavoriteType::AltRepeatKey,
    ];

    /// The type's name (`FavoriteType` in src/shared/types/favorite-store.ts).
    pub fn name(self) -> &'static str {
        match self {
            FavoriteType::TapDance => "tapDance",
            FavoriteType::Macro => "macro",
            FavoriteType::Combo => "combo",
            FavoriteType::KeyOverride => "keyOverride",
            FavoriteType::AltRepeatKey => "altRepeatKey",
        }
    }

    /// The type named `name`.
    pub fn parse(name: &str) -> Result<Self, FavoriteError> {
        Self::ALL.into_iter().find(|t| t.name() == name).ok_or(FavoriteError::InvalidType)
    }

    /// The sync unit of the type's store, which is also its write-lock key.
    pub fn sync_unit(self) -> String {
        format!("favorites/{}", self.name())
    }
}

/// Why a favorite operation failed. The text is what the handler answers
/// as `error`: its own messages as they are, a thrown `Error` as
/// `Error: …`. The text of a file-system error is this OS's, not Node's.
#[derive(Debug, thiserror::Error)]
pub enum FavoriteError {
    #[error("Error: Invalid favorite type")]
    InvalidType,
    #[error("Error: Invalid filename")]
    InvalidFilename,
    /// An entry whose `filename` is a truthy value that is not a string,
    /// which Node's `path.join` refuses.
    #[error("TypeError: The \"path\" argument must be of type string")]
    FilenameNotString,
    #[error("Entry not found")]
    NotFound,
    #[error("Entry has been deleted")]
    Deleted,
    #[error("Error: {0}")]
    Io(#[from] io::Error),
    #[error("{}", entry_error_text(.0))]
    Entry(#[from] EntryError),
    #[error("Error: {}: nested too deeply to read", .0.display())]
    TooDeep(PathBuf),
}

impl From<BodyPathError> for FavoriteError {
    fn from(err: BodyPathError) -> Self {
        match err {
            BodyPathError::Invalid => FavoriteError::InvalidFilename,
            BodyPathError::NotString => FavoriteError::FilenameNotString,
        }
    }
}

/// The index file: its top-level object, whose `entries` holds the place
/// of [`Self::entries`] (the entries as v2 entries) for a write.
struct FavoriteIndex {
    root: Object,
    entries: Vec<Entry>,
}

impl EntryList for FavoriteIndex {
    fn entries(&self) -> &[Entry] {
        &self.entries
    }

    fn entries_mut(&mut self) -> &mut [Entry] {
        &mut self.entries
    }
}

fn favorite_dir(ctx: &StoreContext, ty: FavoriteType) -> PathBuf {
    ctx.sync_dir().join("favorites").join(ty.name())
}

/// The index of `ty` in `dir`: empty when the file is missing, unreadable,
/// not JSON, not an object naming `ty`, or without an `entries` list.
fn read_index(dir: &Path, ty: FavoriteType) -> Result<FavoriteIndex, FavoriteError> {
    let empty = || {
        let mut root = Object::new();
        root.insert("type", ty.name().into());
        root.insert("entries", Value::Array(Vec::new()));
        FavoriteIndex { root, entries: Vec::new() }
    };
    let path = dir.join("index.json");
    let Ok(bytes) = fs::read(&path) else { return Ok(empty()) };
    // readFile(…, 'utf-8') reads each invalid sequence as U+FFFD.
    let mut root = match pipette_js_json::parse(&String::from_utf8_lossy(&bytes)) {
        Ok(Value::Object(root)) => root,
        Ok(_) => return Ok(empty()),
        Err(err) if err.is_nesting_too_deep() => return Err(FavoriteError::TooDeep(path)),
        Err(_) => return Ok(empty()),
    };
    let names_type = matches!(root.get("type"), Some(Value::String(s)) if s.as_str() == Some(ty.name()));
    if !names_type || !matches!(root.get("entries"), Some(Value::Array(_))) {
        return Ok(empty());
    }
    let entries = normalize_entries(STORE, root.get("entries"));
    // Holds the place of the entries, which a write puts back.
    root.insert("entries", Value::Array(Vec::new()));
    Ok(FavoriteIndex { root, entries })
}

fn write_index(dir: &Path, index: &FavoriteIndex) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let mut root = index.root.clone();
    root.insert("entries", Value::Array(index.entries.iter().cloned().map(Value::from).collect()));
    let text = pipette_js_json::stringify_with_gap(&Value::Object(root), "  ");
    pipette_fs::write_file_atomic(&dir.join("index.json"), text.as_bytes())
}

/// The index for a writer holding the type's lock, with the legacy body
/// names moved to id-carrying ones (written back when any moved).
fn read_index_locked(dir: &Path, ty: FavoriteType) -> Result<FavoriteIndex, FavoriteError> {
    let mut index = read_index(dir, ty)?;
    migrate_body_filenames(STORE, dir, &mut index, |index| write_index(dir, index))?;
    Ok(index)
}

/// Writes a new body under `dir` and returns its new entry, saved at
/// `saved_at` (now when `None`), with every clock at now.
fn write_new_favorite(
    ctx: &StoreContext,
    ty: FavoriteType,
    dir: &Path,
    body: &[u8],
    label: Value,
    saved_at: Option<Value>,
) -> Result<Entry, FavoriteError> {
    let now = ctx.now_ms();
    let id = JsString::from(ctx.new_id());
    let legacy = JsString::from(format!("{}_{}.json", ty.name(), ts_for_filename(now)));
    let filename = id_body_filename(STORE, &id, &legacy);
    pipette_fs::write_file_atomic(
        &body_path_of(dir, &filename.to_string_lossy()).ok_or(FavoriteError::InvalidFilename)?,
        body,
    )?;

    let mut fields = Object::new();
    fields.insert("id", Value::String(id));
    fields.insert("label", label);
    fields.insert("filename", Value::String(filename));
    fields.insert("savedAt", saved_at.unwrap_or_else(|| iso_8601_millis(now).into()));
    Ok(create_entry(STORE, fields, now))
}

/// The live favorites of `ty` (the `favorite_store_list` command), newest first.
pub fn list_favorites(ctx: &StoreContext, ty: FavoriteType) -> Result<Vec<Entry>, FavoriteError> {
    let index = read_index(&favorite_dir(ctx, ty), ty)?;
    Ok(index.entries.into_iter().filter(|entry| !entry.is_deleted()).collect())
}

/// Saves `json` as a new favorite of `ty` labelled `label`
/// (the `favorite_store_save` command), first in the index. Returns the new entry.
pub fn save_favorite(
    ctx: &StoreContext,
    ty: FavoriteType,
    json: &str,
    label: &str,
) -> Result<Entry, FavoriteError> {
    ctx.locks.with_write_lock(&ty.sync_unit(), || {
        let dir = favorite_dir(ctx, ty);
        fs::create_dir_all(&dir)?;
        // The body is written before the index is read, as the handler does.
        let entry = write_new_favorite(ctx, ty, &dir, json.as_bytes(), label.into(), None)?;
        let mut index = read_index_locked(&dir, ty)?;
        index.entries.insert(0, entry.clone());
        write_index(&dir, &index)?;
        ctx.notify(&ty.sync_unit());
        Ok(entry)
    })
}

fn find_entry<'a>(entries: &'a [Entry], id: &str) -> Option<&'a Entry> {
    entries.iter().find(|entry| entry.id().is_some_and(|own| own.as_str() == Some(id)))
}

/// The body of the favorite `id` of `ty` (the `favorite_store_load` command).
pub fn load_favorite(ctx: &StoreContext, ty: FavoriteType, id: &str) -> Result<String, FavoriteError> {
    let dir = favorite_dir(ctx, ty);
    let index = read_index(&dir, ty)?;
    let entry = find_entry(&index.entries, id).ok_or(FavoriteError::NotFound)?;
    if entry.is_deleted() {
        return Err(FavoriteError::Deleted);
    }
    Ok(read_text(&body_path(&dir, entry)?)?)
}

/// A meta-only change of the favorite `id` of `ty`: `mutate` edits the
/// entry, then `mutation` moves its clock or tombstones it.
fn change_entry(
    ctx: &StoreContext,
    ty: FavoriteType,
    id: &str,
    mutation: EntryMutation,
    mutate: impl FnOnce(&mut Entry),
) -> Result<(), FavoriteError> {
    ctx.locks.with_write_lock(&ty.sync_unit(), || {
        let dir = favorite_dir(ctx, ty);
        let mut index = read_index_locked(&dir, ty)?;
        let id = JsString::from(id);
        if apply_entry_mutation(&mut index.entries, &id, mutation, ctx.now_ms(), mutate)?.is_none() {
            return Err(FavoriteError::NotFound);
        }
        write_index(&dir, &index)?;
        ctx.notify(&ty.sync_unit());
        Ok(())
    })
}

/// Gives the favorite `id` of `ty` the label `label`
/// (the `favorite_store_rename` command).
pub fn rename_favorite(
    ctx: &StoreContext,
    ty: FavoriteType,
    id: &str,
    label: &str,
) -> Result<(), FavoriteError> {
    change_entry(ctx, ty, id, EntryMutation::Meta(MetaGroup::Name), |entry| entry.set("label", label))
}

/// Tombstones the favorite `id` of `ty` (the `favorite_store_delete` command); its
/// body stays for sync.
pub fn delete_favorite(ctx: &StoreContext, ty: FavoriteType, id: &str) -> Result<(), FavoriteError> {
    change_entry(ctx, ty, id, EntryMutation::Delete, |_| {})
}

/// Links the favorite `id` of `ty` to a public Hub post
/// (the `favorite_store_set_hub_post_id` command), dropping any private link: the two
/// are exclusive. A post id that is `None` or blank once trimmed clears the
/// link instead.
pub fn set_favorite_hub_post_id(
    ctx: &StoreContext,
    ty: FavoriteType,
    id: &str,
    hub_post_id: Option<&str>,
) -> Result<(), FavoriteError> {
    let trimmed = hub_post_id
        .map(|post_id| {
            JsString::from_utf16(trim_js_whitespace(&JsString::from(post_id).utf16_units()).to_vec())
        })
        .filter(|post_id| !post_id.is_empty());
    change_entry(ctx, ty, id, EntryMutation::Meta(MetaGroup::Hub), |entry| match trimmed {
        None => {
            entry.remove("hubPostId");
        }
        Some(post_id) => {
            entry.set("hubPostId", Value::String(post_id));
            entry.remove("hubPrivate");
        }
    })
}

/// Links the favorite `id` of `ty` to a private Hub post
/// (the `favorite_store_set_hub_private` command), dropping any public post id, or
/// clears the private link when `link` is `None`.
pub fn set_favorite_hub_private(
    ctx: &StoreContext,
    ty: FavoriteType,
    id: &str,
    link: Option<Value>,
) -> Result<(), FavoriteError> {
    change_entry(ctx, ty, id, EntryMutation::Meta(MetaGroup::Hub), |entry| match link {
        None => {
            entry.remove("hubPrivate");
        }
        Some(link) => {
            entry.set("hubPrivate", link);
            entry.remove("hubPostId");
        }
    })
}

/// The live favorites of `ty` an export reads (the
/// `favorite_store_read_for_export` command):
/// all of them, or those with the id `id`, as `{label, savedAt, body}`
/// with the entry's label and save time as they are and the text of its
/// body. A favorite whose body cannot be read is left out. Fails with
/// [`FavoriteError::NotFound`] when `id` names no live favorite.
pub fn read_favorites_for_export(
    ctx: &StoreContext,
    ty: FavoriteType,
    id: Option<&str>,
) -> Result<Vec<Value>, FavoriteError> {
    let dir = favorite_dir(ctx, ty);
    let index = read_index(&dir, ty)?;
    let targets: Vec<&Entry> = index
        .entries
        .iter()
        .filter(|entry| !entry.is_deleted())
        .filter(|entry| id.is_none_or(|id| entry.id().is_some_and(|own| own.as_str() == Some(id))))
        .collect();
    if id.is_some() && targets.is_empty() {
        return Err(FavoriteError::NotFound);
    }
    let mut bodies = Vec::with_capacity(targets.len());
    for entry in targets {
        let Some(body) = body_path(&dir, entry).ok().and_then(|path| read_text(&path).ok()) else { continue };
        let mut out = Object::new();
        for key in ["label", "savedAt"] {
            if let Some(value) = entry.get(key) {
                out.insert(key, value.clone());
            }
        }
        out.insert("body", body.into());
        bodies.push(Value::Object(out));
    }
    Ok(bodies)
}

/// A favorite to import: its label and save time from the export file, and
/// the text of its body with the keycodes converted.
#[derive(Clone, Debug, PartialEq)]
pub struct FavoriteImport {
    pub label: JsString,
    pub saved_at: JsString,
    pub body: JsString,
}

/// What an import of one type did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ImportCounts {
    pub imported: usize,
    pub skipped: usize,
}

/// Imports `favorites` into the store of `ty` (the
/// `favorite_store_import_batch` command), each first in the index in turn. A favorite
/// with the label and save time of a live one (one imported earlier in the
/// same call included) is skipped; the others keep the exported save time
/// and get every clock at now. The index is read and migrated, and the
/// directory made, even when nothing is imported.
pub fn import_favorites(
    ctx: &StoreContext,
    ty: FavoriteType,
    favorites: &[FavoriteImport],
) -> Result<ImportCounts, FavoriteError> {
    ctx.locks.with_write_lock(&ty.sync_unit(), || {
        let dir = favorite_dir(ctx, ty);
        let mut index = read_index_locked(&dir, ty)?;
        fs::create_dir_all(&dir)?;
        let mut counts = ImportCounts::default();
        for favorite in favorites {
            let label = Value::String(favorite.label.clone());
            let saved_at = Value::String(favorite.saved_at.clone());
            let duplicate = index.entries.iter().any(|existing| {
                !existing.is_deleted()
                    && existing.get("label") == Some(&label)
                    && existing.get("savedAt") == Some(&saved_at)
            });
            if duplicate {
                counts.skipped += 1;
                continue;
            }
            let body = favorite.body.to_string_lossy();
            let entry = write_new_favorite(ctx, ty, &dir, body.as_bytes(), label, Some(saved_at))?;
            index.entries.insert(0, entry);
            counts.imported += 1;
        }
        if counts.imported > 0 {
            write_index(&dir, &index)?;
            ctx.notify(&ty.sync_unit());
        }
        Ok(counts)
    })
}
