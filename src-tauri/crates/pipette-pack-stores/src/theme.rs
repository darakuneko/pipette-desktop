// SPDX-License-Identifier: GPL-2.0-or-later
//! The theme packs: `sync/themes`, the store of
//! src/main/theme-pack-store.ts, on the shared pack layer
//! ([`crate::PackStore`]).
//!
//! A pack body is the pack JSON as the page imported it (`{name, version,
//! colorScheme, colors}`), opaque here: the page checks it with
//! `validateThemePack` (src/shared/theme/validate.ts) before saving, and the
//! store reads only `name` and `version`. A meta's name is the pack's name;
//! a rename changes the meta only. Unlike the language packs, there is no
//! built-in pack and no enabled state.

use pipette_entry_store::{Entry, EntryStore, OverwriteOptions, overwrite_entry};
use pipette_js_json::{JsString, Object, Value};
use pipette_keyboard_stores::StoreContext;
use pipette_time::iso_8601_millis;

pub use crate::pack_meta::Cached;
use crate::pack_meta::{blank_clears, pack_header};
use crate::pack_store::{Field, PackStore};
use crate::result::{ErrorCode, PackError, PackResult};

/// The theme pack store.
pub const THEME_PACKS: PackStore = PackStore {
    entry_store: EntryStore::ThemePacks,
    dir: "themes",
    local_only_ids: &[],
    not_found: "Theme pack not found",
    duplicate_name: "A theme pack with the same name already exists",
};

/// The live metas, in the index's order (`listMetas`).
pub fn list_metas(ctx: &StoreContext) -> PackResult<Vec<Entry>> {
    Ok(list_all_metas(ctx)?.into_iter().filter(|meta| !meta.is_deleted()).collect())
}

/// Every meta, tombstones included (`listAllMetas`), read without the lock.
pub fn list_all_metas(ctx: &StoreContext) -> PackResult<Vec<Entry>> {
    Ok(THEME_PACKS.read_index(ctx)?.metas)
}

/// The own enumerable properties `{...value}` copies: an object's, an
/// array's elements and a string's UTF-16 code units under their indexes,
/// none of any other value.
fn spread(value: Value) -> Object {
    let indexed =
        |values: Vec<Value>| values.into_iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect();
    match value {
        Value::Object(object) => object,
        Value::Array(items) => indexed(items),
        Value::String(text) => indexed(
            text.utf16_units()
                .into_iter()
                .map(|unit| Value::String(JsString::from_utf16(vec![unit])))
                .collect(),
        ),
        Value::Null | Value::Bool(_) | Value::Number(_) => Object::new(),
    }
}

/// `{...parsed, name: meta.name}`: the body spread into an object with
/// the meta's name over its own. A meta without a name leaves the key
/// undefined, which JSON leaves out.
fn named_pack(meta: &Entry, parsed: Value) -> Object {
    let mut pack = spread(parsed);
    match meta.get("name") {
        Some(name) => pack.insert("name", name.clone()),
        None => pack.remove("name"),
    };
    pack
}

/// `{meta, pack}` of the live pack `id` (`getPack`).
pub fn get_pack(ctx: &StoreContext, id: &JsString) -> PackResult<Object> {
    let (meta, parsed) = THEME_PACKS.read_live_pack(ctx, id)?;
    let pack = named_pack(&meta, parsed);
    let mut record = Object::new();
    record.insert("meta", meta.into());
    record.insert("pack", Value::Object(pack));
    Ok(record)
}

/// The text an export writes for the live pack `id`, the pack of
/// [`get_pack`] as `JSON.stringify(pack, null, 2)`, and the meta's name
/// (`None` when it has none).
pub fn export_text(ctx: &StoreContext, id: &JsString) -> PackResult<(Option<Value>, String)> {
    let (meta, parsed) = THEME_PACKS.read_live_pack(ctx, id)?;
    let pack = named_pack(&meta, parsed);
    Ok((meta.get("name").cloned(), pipette_js_json::stringify_with_gap(&Value::Object(pack), "  ")))
}

/// A save of a pack (`savePack`'s input).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SaveThemeInput {
    /// The pack to save over; a new one (or the live one of the same name)
    /// when `None`.
    pub id: Option<JsString>,
    /// The pack JSON the page checked; `None` is `undefined`.
    pub pack: Option<Value>,
    pub hub_post_id: Field<JsString>,
    pub hub_updated_at: Field<JsString>,
    pub uploader_name: Field<JsString>,
}

/// Saves a pack (`savePack`), over the pack `input.id`, over the live pack
/// of the same name, or as a new pack. Every save is the user's (an import
/// or a Hub download), so it brings a deleted pack back. Answers its meta.
///
/// The page has checked the pack; a pack without a name and a version
/// fails here too.
pub fn save_pack(ctx: &StoreContext, input: SaveThemeInput) -> PackResult<Entry> {
    let Some((header_name, version)) = pack_header(input.pack.as_ref()) else {
        return Err(PackError::new(ErrorCode::InvalidFile, "Pack JSON missing required name/version fields"));
    };
    THEME_PACKS.with_lock(ctx, || {
        let mut index = THEME_PACKS.read_index(ctx)?;
        let (id, name) = THEME_PACKS.save_target(ctx, &index, input.id.as_ref(), &header_name)?;
        let pack = input.pack.as_ref().unwrap_or(&Value::Null);
        THEME_PACKS.write_body(ctx, &id, &pipette_js_json::stringify_with_gap(pack, "  "))?;

        let now = ctx.now_ms();
        let at = index.position(&id);
        let existing = at.map(|at| &index.metas[at]);
        let old = |key: &str| existing.and_then(|meta| meta.get(key));
        let truthy = |value: Option<Value>| value.filter(Value::is_truthy);
        let optional = [
            ("hubPostId", truthy(input.hub_post_id.resolve(old("hubPostId"), Value::String))),
            (
                "hubUpdatedAt",
                truthy(blank_clears(input.hub_updated_at).resolve(old("hubUpdatedAt"), Value::String)),
            ),
            (
                "uploaderName",
                truthy(blank_clears(input.uploader_name).resolve(old("uploaderName"), Value::String)),
            ),
        ];
        let saved_at = old("savedAt")
            .filter(|v| **v != Value::Null)
            .cloned()
            .unwrap_or_else(|| iso_8601_millis(now).into());

        let mut fields = Object::new();
        fields.insert("id", Value::String(id.clone()));
        fields.insert("filename", Value::String(THEME_PACKS.filename_of(&id)));
        fields.insert("name", name);
        fields.insert("version", Value::String(version));
        for (key, value) in optional {
            if let Some(value) = value {
                fields.insert(key, value);
            }
        }
        fields.insert("savedAt", saved_at);
        let options = OverwriteOptions { body: true, explicit: true };
        let meta = overwrite_entry(EntryStore::ThemePacks, existing, fields, now, options)?;
        index.put(at, meta.clone());
        THEME_PACKS.write_index(ctx, &index)?;
        THEME_PACKS.notify_pack_change(ctx, &id);
        THEME_PACKS.notify_index_change(ctx);
        Ok(meta)
    })
}

/// Gives the live pack `id` the name `new_name`, trimmed (`renamePack`).
pub fn rename_pack(ctx: &StoreContext, id: &JsString, new_name: &JsString) -> PackResult<Entry> {
    THEME_PACKS.rename_pack(ctx, id, new_name)
}

/// Deletes the pack `id` (`deletePack`): tombstoned, its body kept for
/// sync.
pub fn delete_pack(ctx: &StoreContext, id: &JsString) -> PackResult<()> {
    THEME_PACKS.tombstone(ctx, id, |_, _| Ok(()))
}

/// Links the pack `id` to a Hub post or unlinks it (`setHubPostId`, see
/// [`PackStore::set_hub_post_id`]).
pub fn set_hub_post_id(
    ctx: &StoreContext,
    id: &JsString,
    hub_post_id: Option<&JsString>,
    uploader_name: Cached,
    hub_updated_at: Cached,
) -> PackResult<Entry> {
    THEME_PACKS.set_hub_post_id(ctx, id, hub_post_id, uploader_name, hub_updated_at)
}

/// Whether a live pack other than `exclude` has the name `name`
/// (`hasActiveName`).
pub fn has_active_name(ctx: &StoreContext, name: &JsString, exclude: Option<&JsString>) -> PackResult<bool> {
    THEME_PACKS.has_active_name(ctx, name, exclude)
}

/// Puts the live packs of `ordered_ids` first (`reorderActive`).
pub fn reorder_active(ctx: &StoreContext, ordered_ids: &[JsString]) -> PackResult<()> {
    THEME_PACKS.reorder_active(ctx, ordered_ids)
}
