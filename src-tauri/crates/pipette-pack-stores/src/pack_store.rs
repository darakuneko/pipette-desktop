// SPDX-License-Identifier: GPL-2.0-or-later
//! The layer the language packs (`sync/i18n`) and the theme packs
//! (`sync/themes`) share: where a store keeps its files, its index, its
//! write lock and its sync units, and the operations both stores do the
//! same way.
//!
//! A pack store is `index.json` (`{metas: [...]}` and any other fields,
//! written as `JSON.stringify(index, null, 2)`) and one body per pack,
//! `packs/{id}.json`. Each has its own sync unit: `{dir}/index` for the
//! index and `{dir}/packs/{id}` for a body, so changing one pack never
//! resends the others. The writes of a store run one at a time under the
//! write lock named after its index unit, the key the sync merge of the
//! index takes too.

use std::fs;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use pipette_entry_store::{Entry, EntryGroup, EntryStore, is_safe_pack_id, normalize_entries, set_clock};
use pipette_js_json::{JsString, Object, Value};
use pipette_keyboard_stores::StoreContext;
use pipette_time::iso_8601_millis;

use crate::js_text::folded_name;
use crate::result::{PackError, PackResult};

/// A pack store: the directory under `sync/` that holds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PackStore {
    pub entry_store: EntryStore,
    /// The directory under `sync/`, also the prefix of the sync units.
    pub dir: &'static str,
    /// Ids whose body never syncs and that a save never takes by name
    /// (the built-in English pack).
    pub local_only_ids: &'static [&'static str],
    /// The error of an id the store does not have.
    pub not_found: &'static str,
    /// The error of a name another live pack has.
    pub duplicate_name: &'static str,
    /// The longest name a rename gives (UTF-16 units).
    pub max_name_length: usize,
}

/// An index as read: the file's top-level object, whose `metas` holds the
/// place of [`Self::metas`] (the metas as v2 entries) for a write.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PackIndex {
    root: Object,
    pub metas: Vec<Entry>,
}

impl PackIndex {
    /// An index of `metas` alone, as `{metas}`.
    pub fn of_metas(metas: Vec<Entry>) -> Self {
        Self { root: Object::new(), metas }
    }

    /// The position of the first meta with the id `id`.
    pub fn position(&self, id: &JsString) -> Option<usize> {
        self.metas.iter().position(|meta| meta.id() == Some(id))
    }

    /// The position of the first live meta with the id `id`.
    pub fn live_position(&self, id: &JsString) -> Option<usize> {
        self.metas.iter().position(|meta| meta.id() == Some(id) && !meta.is_deleted())
    }

    /// The first meta with the id `id`.
    pub fn find(&self, id: &JsString) -> Option<&Entry> {
        self.position(id).map(|at| &self.metas[at])
    }

    /// The meta at `at` replaced, or appended when `at` is `None`.
    pub fn put(&mut self, at: Option<usize>, meta: Entry) {
        match at {
            Some(at) => self.metas[at] = meta,
            None => self.metas.push(meta),
        }
    }
}

impl PackStore {
    pub fn store_dir(&self, ctx: &StoreContext) -> PathBuf {
        ctx.sync_dir().join(self.dir)
    }

    pub fn packs_dir(&self, ctx: &StoreContext) -> PathBuf {
        self.store_dir(ctx).join("packs")
    }

    pub fn index_path(&self, ctx: &StoreContext) -> PathBuf {
        self.store_dir(ctx).join("index.json")
    }

    /// The body file of the pack `id`, `None` for an id that is not a safe
    /// pack id.
    pub fn pack_path(&self, ctx: &StoreContext, id: &JsString) -> Option<PathBuf> {
        let id = id.as_str().filter(|id| is_safe_pack_id(id))?;
        Some(self.packs_dir(ctx).join(format!("{id}.json")))
    }

    /// The meta's `filename` for the pack `id`, relative to the store.
    pub fn filename_of(&self, id: &JsString) -> JsString {
        let mut units: Vec<u16> = "packs/".encode_utf16().collect();
        units.extend(id.utf16_units());
        units.extend(".json".encode_utf16());
        JsString::from_utf16(units)
    }

    /// The sync unit of the index, also the store's write-lock key.
    pub fn index_unit(&self) -> String {
        format!("{}/index", self.dir)
    }

    pub(crate) fn is_local_only(&self, id: &JsString) -> bool {
        self.local_only_ids.iter().any(|&local| id.as_str() == Some(local))
    }

    /// Reports a change of the body of `id`, unless its body never syncs.
    pub fn notify_pack_change(&self, ctx: &StoreContext, id: &JsString) {
        if !self.is_local_only(id) {
            ctx.notify(&format!("{}/packs/{}", self.dir, id.to_string_lossy()));
        }
    }

    pub fn notify_index_change(&self, ctx: &StoreContext) {
        ctx.notify(&self.index_unit());
    }

    /// Runs `task` holding the store's write lock.
    pub fn with_lock<T>(&self, ctx: &StoreContext, task: impl FnOnce() -> T) -> T {
        ctx.locks().with_write_lock(&self.index_unit(), task)
    }

    /// The index with every meta read as a v2 entry (`readIndex`): `{metas:
    /// []}` when the file is missing, unreadable, not JSON, or not an
    /// object with a `metas` list; other fields of the file are kept. An
    /// index nested deeper than pipette-js-json reads (`JSON.parse` reads
    /// it) fails instead, so a write never replaces it.
    pub fn read_index(&self, ctx: &StoreContext) -> PackResult<PackIndex> {
        let path = self.index_path(ctx);
        let Ok(bytes) = fs::read(&path) else { return Ok(PackIndex::default()) };
        // readFile(…, 'utf-8') reads each invalid sequence as U+FFFD.
        let root = match pipette_js_json::parse(&String::from_utf8_lossy(&bytes)) {
            Ok(Value::Object(root)) => root,
            Err(err) if err.is_nesting_too_deep() => {
                return Err(PackError::io(format!("Error: {}: nested too deeply to read", path.display())));
            }
            _ => return Ok(PackIndex::default()),
        };
        if !matches!(root.get("metas"), Some(Value::Array(_))) {
            return Ok(PackIndex::default());
        }
        let metas = self.read_pack_metas(ctx, root.get("metas"));
        Ok(PackIndex { root, metas })
    }

    /// The metas of an index file as v2 entries (`readPackMetas` of
    /// src/main/sync/pack-sync.ts). A meta stored without `clocks` was
    /// written by the v1 pack sync, which kept the body file's mtime equal
    /// to Drive's `modifiedTime`: its body clock is that mtime (when after
    /// the epoch; none without a body file). Local-only and unsafe ids keep
    /// the epoch.
    fn read_pack_metas(&self, ctx: &StoreContext, raw: Option<&Value>) -> Vec<Entry> {
        let v1_ids: Vec<&JsString> = match raw {
            Some(Value::Array(list)) => list
                .iter()
                .filter_map(|meta| match meta {
                    // An array is an object to `typeof`, so it counts as clocks.
                    Value::Object(meta)
                        if !matches!(meta.get("clocks"), Some(Value::Object(_) | Value::Array(_))) =>
                    {
                        match meta.get("id") {
                            Some(Value::String(id)) => Some(id),
                            _ => None,
                        }
                    }
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        let mut metas = normalize_entries(self.entry_store, raw);
        if v1_ids.is_empty() {
            return metas;
        }
        for meta in &mut metas {
            let Some(id) = meta.id().filter(|id| v1_ids.contains(id) && !self.is_local_only(id)) else {
                continue;
            };
            let Some(mtime) = self.pack_path(ctx, id).and_then(|path| mtime_ms(&path)) else { continue };
            if mtime > 0 {
                set_clock(meta, EntryGroup::Body, &iso_8601_millis(mtime));
            }
        }
        metas
    }

    /// Writes `index` (`writeIndex`), atomically.
    pub fn write_index(&self, ctx: &StoreContext, index: &PackIndex) -> PackResult<()> {
        let dir = self.store_dir(ctx);
        fs::create_dir_all(&dir)?;
        let mut root = index.root.clone();
        root.insert("metas", Value::Array(index.metas.iter().cloned().map(Value::from).collect()));
        let text = pipette_js_json::stringify_with_gap(&Value::Object(root), "  ");
        pipette_fs::write_file_atomic(&dir.join("index.json"), text.as_bytes())?;
        Ok(())
    }

    /// The text of the body of `id`, read as `readFile(…, 'utf-8')` reads
    /// it.
    pub fn read_body(&self, ctx: &StoreContext, id: &JsString) -> PackResult<String> {
        let path = self.pack_path(ctx, id).ok_or_else(|| invalid_pack_id(id))?;
        Ok(String::from_utf8_lossy(&fs::read(path)?).into_owned())
    }

    /// Writes `text` as the body of `id`, atomically.
    pub fn write_body(&self, ctx: &StoreContext, id: &JsString, text: &str) -> PackResult<()> {
        let path = self.pack_path(ctx, id).ok_or_else(|| invalid_pack_id(id))?;
        fs::create_dir_all(self.packs_dir(ctx))?;
        pipette_fs::write_file_atomic(&path, text.as_bytes())?;
        Ok(())
    }

    /// Whether a live pack other than `exclude` has the name `name`
    /// (`hasActiveName`), read without the lock.
    pub fn has_active_name(
        &self,
        ctx: &StoreContext,
        name: &JsString,
        exclude: Option<&JsString>,
    ) -> PackResult<bool> {
        let index = self.read_index(ctx)?;
        Ok(find_active_by_name(&index.metas, &Value::String(name.clone()), exclude)?.is_some())
    }

    /// Puts the live metas named in `ordered_ids` first, in that order
    /// (`reorderActive`); every other meta follows in its current order. A
    /// meta listed by id is the last one with that id, and every meta with
    /// a listed id leaves the tail. Only the metas are written: the order
    /// is per device, so no clock moves and nothing is reported for sync.
    pub fn reorder_active(&self, ctx: &StoreContext, ordered_ids: &[JsString]) -> PackResult<()> {
        self.with_lock(ctx, || {
            let index = self.read_index(ctx)?;
            let last_by_id = |id: &JsString| index.metas.iter().rev().find(|meta| meta.id() == Some(id));
            let mut seen: Vec<&JsString> = Vec::new();
            let mut reordered = Vec::with_capacity(index.metas.len());
            for id in ordered_ids {
                let Some(meta) = last_by_id(id) else { continue };
                if meta.is_deleted() || seen.contains(&id) {
                    continue;
                }
                reordered.push(meta.clone());
                seen.push(id);
            }
            for meta in &index.metas {
                if meta.id().is_some_and(|id| seen.contains(&id)) {
                    continue;
                }
                reordered.push(meta.clone());
            }
            self.write_index(ctx, &PackIndex::of_metas(reordered))
        })
    }
}

/// The error `getPackPath` throws for an id that is not a safe pack id.
fn invalid_pack_id(id: &JsString) -> PackError {
    PackError::io(format!("Error: Invalid packId: {}", id.to_string_lossy()))
}

/// The first live meta other than `exclude` named `name`, ignoring case and
/// surrounding whitespace (`findActiveByName`). A name that is not a
/// string fails as `trim` does in JavaScript.
pub fn find_active_by_name<'a>(
    metas: &'a [Entry],
    name: &Value,
    exclude: Option<&JsString>,
) -> PackResult<Option<&'a Entry>> {
    let target = folded_name(Some(name), "name").map_err(PackError::io)?;
    for meta in metas {
        if meta.is_deleted() || (exclude.is_some() && meta.id() == exclude) {
            continue;
        }
        if folded_name(meta.get("name"), "m.name").map_err(PackError::io)? == target {
            return Ok(Some(meta));
        }
    }
    Ok(None)
}

/// A file's modification time as `stat().mtime.getTime()`: Node's
/// `sec * 1e3 + nsec / 1e6` as a double, truncated to whole
/// milliseconds. `None` without a file or for a time before the epoch.
fn mtime_ms(path: &std::path::Path) -> Option<i64> {
    let since = fs::metadata(path).ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    let ms = (since.as_secs() as f64 * 1e3 + f64::from(since.subsec_nanos()) / 1e6).trunc() as i64;
    Some(ms)
}

/// The value the three-state fields of a save take (`resolveOptionalField`
/// of src/main/i18n-pack-store-internal.ts): set, cleared with `null`, or
/// inherited from the existing meta when not given.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Field<T> {
    #[default]
    Inherit,
    Clear,
    Set(T),
}

impl<T> Field<T> {
    /// The value after a save over a meta whose value is `existing`, a set
    /// value as `to_value` makes it.
    pub fn resolve(self, existing: Option<&Value>, to_value: impl FnOnce(T) -> Value) -> Option<Value> {
        match self {
            Field::Inherit => existing.cloned(),
            Field::Clear => None,
            Field::Set(value) => Some(to_value(value)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_state_fields_set_clear_or_inherit() {
        let existing = Value::from("old");
        assert_eq!(Field::Set("new").resolve(Some(&existing), Value::from), Some("new".into()));
        assert_eq!(Field::<&str>::Clear.resolve(Some(&existing), Value::from), None);
        assert_eq!(Field::<&str>::Inherit.resolve(Some(&existing), Value::from), Some(existing.clone()));
        assert_eq!(Field::<&str>::Inherit.resolve(None, Value::from), None);
    }
}
