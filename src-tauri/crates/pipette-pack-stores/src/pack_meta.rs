// SPDX-License-Identifier: GPL-2.0-or-later
//! The operations on a pack's meta that the language and theme packs do
//! the same way: reading a live pack, choosing the id and
//! the name a save takes, renaming, linking to the Hub and deleting. Each
//! write runs under the store's write lock and reports its sync units.

use pipette_entry_store::{
    Entry, EntryGroup, OverwriteOptions, js_trim, mark_deleted, overwrite_entry, touch_clock, utf16_len,
};
use pipette_js_json::{JsString, Object, Value};
use pipette_keyboard_stores::StoreContext;
use pipette_time::iso_8601_millis;

use crate::pack_store::{Field, PackIndex, PackStore, find_active_by_name};
use crate::result::{ErrorCode, PackError, PackResult};

/// An empty or blank string clears the field, as `''` does for the Hub's
/// time and uploader.
fn blank_clears(field: Field<JsString>) -> Field<JsString> {
    match field {
        Field::Set(s) => {
            let trimmed = js_trim(&s);
            if trimmed.is_empty() { Field::Clear } else { Field::Set(trimmed) }
        }
        other => other,
    }
}

/// The Hub fields of a save, each set, cleared or inherited.
pub(crate) struct SaveHub<'a> {
    pub hub_post_id: &'a Field<JsString>,
    pub hub_updated_at: &'a Field<JsString>,
    pub uploader_name: &'a Field<JsString>,
    /// Whether an empty post id is left out (the theme packs) rather than
    /// written (the language packs).
    pub drop_empty_post: bool,
}

/// Adds the fields every save ends its meta with, in this order: the Hub
/// fields that have a value over `existing` (the Hub time and uploader
/// trimmed, a blank one clearing it) and `savedAt`, kept from `existing` or
/// `now`.
pub(crate) fn insert_save_tail(fields: &mut Object, hub: SaveHub<'_>, existing: Option<&Entry>, now: i64) {
    let old = |key: &str| existing.and_then(|meta| meta.get(key));
    let truthy = |value: Option<Value>| value.filter(Value::is_truthy);
    let post = hub.hub_post_id.clone().resolve(old("hubPostId"), Value::String);
    let post = if hub.drop_empty_post { truthy(post) } else { post };
    let updated =
        truthy(blank_clears(hub.hub_updated_at.clone()).resolve(old("hubUpdatedAt"), Value::String));
    let uploader =
        truthy(blank_clears(hub.uploader_name.clone()).resolve(old("uploaderName"), Value::String));
    for (key, value) in [("hubPostId", post), ("hubUpdatedAt", updated), ("uploaderName", uploader)] {
        if let Some(value) = value {
            fields.insert(key, value);
        }
    }
    let saved_at =
        old("savedAt").filter(|v| **v != Value::Null).cloned().unwrap_or_else(|| iso_8601_millis(now).into());
    fields.insert("savedAt", saved_at);
}

/// How a Hub link change treats an optional cached field: left alone, or
/// set to a value (blank once trimmed clears it).
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Cached {
    #[default]
    Keep,
    Set(Option<JsString>),
}

impl PackStore {
    /// The live meta `id` and its body as `JSON.parse` reads it.
    pub(crate) fn read_live_pack(&self, ctx: &StoreContext, id: &JsString) -> PackResult<(Entry, Value)> {
        if self.pack_path(ctx, id).is_none() {
            return Err(PackError::not_found("Invalid pack id"));
        }
        let index = self.read_index(ctx)?;
        let meta = index
            .find(id)
            .filter(|meta| !meta.is_deleted())
            .ok_or_else(|| PackError::not_found(self.not_found))?
            .clone();
        let text = self.read_body(ctx, id)?;
        let parsed =
            pipette_js_json::parse(&text).map_err(|err| PackError::io(format!("SyntaxError: {err}")))?;
        Ok((meta, parsed))
    }

    /// The id and the name a save of a pack named `header_name` takes: the
    /// id given, else the live pack of the same name (unless it is
    /// local-only), else a new id. A live pack saved over keeps its
    /// (possibly renamed) name; a new or revived one takes `header_name`.
    /// Fails when another live pack has that name, or for an id that is not
    /// a safe pack id.
    pub(crate) fn save_target(
        &self,
        ctx: &StoreContext,
        index: &PackIndex,
        id: Option<&JsString>,
        header_name: &JsString,
    ) -> PackResult<(JsString, Value)> {
        // `if (!resolvedId)`: an empty id also looks the name up, and stays
        // when no pack has the name.
        let mut resolved = id.cloned();
        if resolved.as_ref().is_none_or(JsString::is_empty) {
            let by_name = find_active_by_name(&index.metas, &Value::String(header_name.clone()), None)?;
            if let Some(id) = by_name.and_then(Entry::id).filter(|id| !self.is_local_only(id)) {
                resolved = Some(id.clone());
            }
        }
        let kept_name = resolved
            .as_ref()
            .and_then(|id| index.metas.iter().find(|meta| meta.id() == Some(id) && !meta.is_deleted()))
            .and_then(|meta| meta.get("name"))
            .filter(|name| **name != Value::Null)
            .cloned();
        let name = kept_name.unwrap_or_else(|| Value::String(header_name.clone()));
        if find_active_by_name(&index.metas, &name, resolved.as_ref())?.is_some() {
            return Err(PackError::new(ErrorCode::DuplicateName, self.duplicate_name));
        }
        let id = resolved.unwrap_or_else(|| JsString::from(ctx.new_id()));
        if self.pack_path(ctx, &id).is_none() {
            return Err(PackError::new(ErrorCode::InvalidFile, "Generated pack id is unsafe"));
        }
        Ok((id, name))
    }

    /// The meta of a save of the pack `id`: `fields` over the meta `index` has
    /// for `id` ([`overwrite_entry`], the body clock moved; `explicit` when the
    /// user asked for it), and that meta's position.
    pub(crate) fn saved_meta(
        &self,
        index: &PackIndex,
        id: &JsString,
        fields: Object,
        now: i64,
        explicit: bool,
    ) -> PackResult<(Option<usize>, Entry)> {
        let at = index.position(id);
        let existing = at.map(|at| &index.metas[at]);
        let options = OverwriteOptions { body: true, explicit };
        Ok((at, overwrite_entry(self.entry_store, existing, fields, now, options)?))
    }

    /// Writes the saved `meta` of the pack `id` at `at` (appended when
    /// `None`), and reports the body and the index.
    pub(crate) fn put_saved(
        &self,
        ctx: &StoreContext,
        index: &mut PackIndex,
        at: Option<usize>,
        id: &JsString,
        meta: Entry,
    ) -> PackResult<Entry> {
        index.put(at, meta.clone());
        self.write_index(ctx, index)?;
        self.notify_pack_change(ctx, id);
        self.notify_index_change(ctx);
        Ok(meta)
    }

    /// The live meta `id` under the lock, changed by `change`: written and
    /// reported as an index change when `change` answers true, answered as
    /// it is otherwise.
    pub(crate) fn change_live_meta(
        &self,
        ctx: &StoreContext,
        id: &JsString,
        change: impl FnOnce(&PackIndex, &mut Entry) -> PackResult<bool>,
    ) -> PackResult<Entry> {
        self.with_lock(ctx, || {
            let mut index = self.read_index(ctx)?;
            let at = index.live_position(id).ok_or_else(|| PackError::not_found(self.not_found))?;
            let mut meta = index.metas[at].clone();
            if change(&index, &mut meta)? {
                index.metas[at] = meta.clone();
                self.write_index(ctx, &index)?;
                self.notify_index_change(ctx);
            }
            Ok(meta)
        })
    }

    /// Gives the live pack `id` the name `new_name`, trimmed.
    /// Only the meta changes: the body and its sync unit stay as they are,
    /// and a read of the pack shows the meta's name.
    pub fn rename_pack(&self, ctx: &StoreContext, id: &JsString, new_name: &JsString) -> PackResult<Entry> {
        let name = js_trim(new_name);
        if name.is_empty() {
            return Err(PackError::new(ErrorCode::InvalidName, "Name must not be empty"));
        }
        if utf16_len(&name) > self.max_name_length {
            let message = format!("Name must be at most {} characters", self.max_name_length);
            return Err(PackError::new(ErrorCode::InvalidName, message));
        }
        self.change_live_meta(ctx, id, |index, meta| {
            let named = Value::String(name);
            if find_active_by_name(&index.metas, &named, Some(id))?.is_some() {
                return Err(PackError::new(ErrorCode::DuplicateName, self.duplicate_name));
            }
            meta.set("name", named);
            touch_clock(meta, EntryGroup::Name, ctx.now_ms())?;
            Ok(true)
        })
    }

    /// Links the pack `id` (live or not) to the Hub post `hub_post_id`, or
    /// unlinks it when that is `None` or blank once trimmed, which also
    /// drops the cached Hub time. The uploader name and Hub time are left
    /// alone, set, or cleared by a blank value.
    pub fn set_hub_post_id(
        &self,
        ctx: &StoreContext,
        id: &JsString,
        hub_post_id: Option<&JsString>,
        uploader_name: Cached,
        hub_updated_at: Cached,
    ) -> PackResult<Entry> {
        self.with_lock(ctx, || {
            let mut index = self.read_index(ctx)?;
            let at = index.position(id).ok_or_else(|| PackError::not_found(self.not_found))?;
            let meta = &mut index.metas[at];
            meta.set_trimmed("hubPostId", hub_post_id);
            if meta.get("hubPostId").is_none() {
                meta.remove("hubUpdatedAt");
            }
            for (key, cached) in [("uploaderName", uploader_name), ("hubUpdatedAt", hub_updated_at)] {
                if let Cached::Set(value) = cached {
                    meta.set_trimmed(key, value.as_ref());
                }
            }
            touch_clock(meta, EntryGroup::Hub, ctx.now_ms())?;
            let meta = meta.clone();
            self.write_index(ctx, &index)?;
            self.notify_index_change(ctx);
            Ok(meta)
        })
    }

    /// Deletes the pack `id` (live or not): `prepare` changes its meta at
    /// the time of the delete, then the meta is tombstoned, its body kept
    /// for sync. Reports the body and the index.
    pub(crate) fn tombstone(
        &self,
        ctx: &StoreContext,
        id: &JsString,
        prepare: impl FnOnce(&mut Entry, i64) -> PackResult<()>,
    ) -> PackResult<()> {
        self.with_lock(ctx, || {
            let mut index = self.read_index(ctx)?;
            let at = index.position(id).ok_or_else(|| PackError::not_found(self.not_found))?;
            let now = ctx.now_ms();
            let meta = &mut index.metas[at];
            prepare(meta, now)?;
            mark_deleted(meta, now);
            self.write_index(ctx, &index)?;
            self.notify_pack_change(ctx, id);
            self.notify_index_change(ctx);
            Ok(())
        })
    }
}
