// SPDX-License-Identifier: GPL-2.0-or-later
//! The language packs: the store of `sync/i18n`, on the shared pack layer
//! ([`crate::PackStore`]).
//!
//! A pack body is the pack JSON as the page imported it (`{name, version,
//! …translations}`), opaque here: the page checks it and measures its
//! coverage before saving, and the store reads only `name` and `version`.
//! A meta's name is the pack's name; a rename changes the meta only.
//!
//! The index always has the built-in English entry (`builtin-english`,
//! every clock at the epoch so every device creates the same one). The
//! lists make sure of it under the lock, and recreate its placeholder body
//! when the index has the entry but the file is missing; its body never
//! syncs. It can be renamed and reordered but not deleted or overwritten.

use pipette_entry_store::{
    EPOCH_ISO, Entry, EntryGroup, EntryStore, builtin_entry, clock_ms, js_trim, touch_clock,
};
use pipette_js_json::{JsString, Object, Value};
use pipette_keyboard_stores::StoreContext;

pub use crate::pack_meta::Cached;
use crate::pack_meta::{SaveHub, insert_save_tail};
use crate::pack_store::{Field, PackStore};
use crate::result::{ErrorCode, PackError, PackResult};

/// The id of the built-in English entry (`BUILTIN_ENGLISH_PACK_ID`).
pub const BUILTIN_ENGLISH_PACK_ID: &str = "builtin-english";

/// The language pack store.
pub const I18N_PACKS: PackStore = PackStore {
    entry_store: EntryStore::I18nPacks,
    dir: "i18n",
    local_only_ids: &[BUILTIN_ENGLISH_PACK_ID],
    not_found: "Language pack not found",
    duplicate_name: "A language pack with the same name already exists",
    max_name_length: 64,
};

fn is_english(id: &JsString) -> bool {
    id.as_str() == Some(BUILTIN_ENGLISH_PACK_ID)
}

fn english_id() -> JsString {
    JsString::from(BUILTIN_ENGLISH_PACK_ID)
}

/// The placeholder body of the built-in English entry.
fn english_body() -> String {
    let mut body = Object::new();
    body.insert("name", "English".into());
    body.insert("version", "0.0.0".into());
    pipette_js_json::stringify_with_gap(&Value::Object(body), "  ")
}

/// Writes the English placeholder body when no file is at its path.
fn write_english_body_if_missing(ctx: &StoreContext) -> PackResult<()> {
    let id = english_id();
    let exists = I18N_PACKS.pack_path(ctx, &id).is_some_and(|path| std::fs::metadata(path).is_ok());
    if exists { Ok(()) } else { I18N_PACKS.write_body(ctx, &id, &english_body()) }
}

/// Makes sure the index has the built-in English entry: created first in
/// the index, reported as an index change; when the entry is there, only
/// its body is recreated if missing.
fn ensure_builtin_english(ctx: &StoreContext) -> PackResult<()> {
    I18N_PACKS.with_lock(ctx, || {
        let mut index = I18N_PACKS.read_index(ctx)?;
        if index.find(&english_id()).is_some() {
            return write_english_body_if_missing(ctx);
        }
        let mut fields = Object::new();
        fields.insert("id", BUILTIN_ENGLISH_PACK_ID.into());
        fields.insert("filename", Value::String(I18N_PACKS.filename_of(&english_id())));
        fields.insert("name", "English".into());
        fields.insert("version", "0.0.0".into());
        fields.insert("enabled", true.into());
        fields.insert("uploaderName", "pipette".into());
        fields.insert("savedAt", EPOCH_ISO.into());
        let meta = builtin_entry(EntryStore::I18nPacks, fields);
        write_english_body_if_missing(ctx)?;
        index.metas.insert(0, meta);
        I18N_PACKS.write_index(ctx, &index)?;
        I18N_PACKS.notify_index_change(ctx);
        Ok(())
    })
}

/// The live metas, in the index's order.
pub fn list_metas(ctx: &StoreContext) -> PackResult<Vec<Entry>> {
    Ok(list_all_metas(ctx)?.into_iter().filter(|meta| !meta.is_deleted()).collect())
}

/// Every meta, tombstones included. The built-in English entry is made sure
/// of under the lock; the index is then read without it.
pub fn list_all_metas(ctx: &StoreContext) -> PackResult<Vec<Entry>> {
    ensure_builtin_english(ctx)?;
    Ok(I18N_PACKS.read_index(ctx)?.metas)
}

/// `{meta, pack}` of the live pack `id`: the body parsed, with the meta's
/// name over its own when it is a plain object.
pub fn get_pack(ctx: &StoreContext, id: &JsString) -> PackResult<Object> {
    let (meta, parsed) = I18N_PACKS.read_live_pack(ctx, id)?;
    let pack = match parsed {
        // `{...parsed, name: meta.name}`: a meta without a name leaves the
        // key undefined, which JSON leaves out.
        Value::Object(mut pack) => {
            match meta.get("name") {
                Some(name) => pack.insert("name", name.clone()),
                None => pack.remove("name"),
            };
            Value::Object(pack)
        }
        other => other,
    };
    let mut record = Object::new();
    record.insert("meta", meta.into());
    record.insert("pack", pack);
    Ok(record)
}

/// The text an export writes for the live pack `id`, the pack of
/// [`get_pack`] as `JSON.stringify(pack, null, 2)`, and the meta's name
/// (`None` when it has none).
pub fn export_text(ctx: &StoreContext, id: &JsString) -> PackResult<(Option<Value>, String)> {
    let mut record = get_pack(ctx, id)?;
    let pack = record.remove("pack").unwrap_or(Value::Null);
    let name = match record.get("meta") {
        Some(Value::Object(meta)) => meta.get("name").cloned(),
        _ => None,
    };
    Ok((name, pipette_js_json::stringify_with_gap(&pack, "  ")))
}

/// A save of a pack (`SavePackInput`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SavePackInput {
    /// The pack to save over; a new one (or the live one of the same name)
    /// when `None`.
    pub id: Option<JsString>,
    /// The pack JSON; `None` is `undefined`.
    pub pack: Option<Value>,
    pub enabled: Option<bool>,
    pub hub_post_id: Field<JsString>,
    pub hub_updated_at: Field<JsString>,
    pub uploader_name: Field<JsString>,
    pub app_version_at_import: Option<JsString>,
    pub matched_base_version: Field<JsString>,
    /// `{totalKeys, coveredKeys}`.
    pub coverage: Field<Object>,
    pub dangerous_key_count: Field<f64>,
    /// The Hub's update without the user asking: it saves only over a
    /// live pack still linked to `hub_post_id`, never brings a deleted one
    /// back, and keeps the enabled clock.
    pub unattended: bool,
}

/// `name` and `version` of a pack JSON, both trimmed and not empty.
fn pack_header(pack: Option<&Value>) -> Option<(JsString, JsString)> {
    let Some(Value::Object(pack)) = pack else { return None };
    let text = |key: &str| match pack.get(key) {
        Some(Value::String(s)) => Some(js_trim(s)).filter(|s| !s.is_empty()),
        _ => None,
    };
    Some((text("name")?, text("version")?))
}

/// Saves a pack, over the pack `input.id`, over the live pack of the same
/// name (never the built-in English one), or as a new pack. Answers its
/// meta.
pub fn save_pack(ctx: &StoreContext, input: SavePackInput) -> PackResult<Entry> {
    let Some((header_name, header_version)) = pack_header(input.pack.as_ref()) else {
        return Err(PackError::new(ErrorCode::InvalidFile, "Pack JSON missing required name/version fields"));
    };
    if input.id.as_ref().is_some_and(is_english) {
        return Err(PackError::new(
            ErrorCode::InvalidName,
            "The built-in English pack cannot be overwritten",
        ));
    }
    I18N_PACKS.with_lock(ctx, || {
        let mut index = I18N_PACKS.read_index(ctx)?;
        if input.unattended {
            let linked = input.id.as_ref().and_then(|id| index.find(id)).is_some_and(|target| {
                let post = input_hub_post_id(&input.hub_post_id);
                !target.is_deleted()
                    && post.is_some_and(|post| target.get("hubPostId") == Some(&Value::String(post)))
            });
            if !linked {
                return Err(PackError::not_found("Language pack is no longer linked to this Hub post"));
            }
        }
        let (id, name) = I18N_PACKS.save_target(ctx, &index, input.id.as_ref(), &header_name)?;
        let pack = input.pack.as_ref().unwrap_or(&Value::Null);
        I18N_PACKS.write_body(ctx, &id, &pipette_js_json::stringify_with_gap(pack, "  "))?;

        let now = ctx.now_ms();
        let existing = index.find(&id);
        let live = existing.is_some_and(|meta| !meta.is_deleted());
        let fields = save_fields(&input, &id, name, header_version, existing, now);
        let (at, mut meta) = I18N_PACKS.saved_meta(&index, &id, fields, now, !input.unattended)?;
        // A save that keeps the pack alive over a delete must not come back
        // disabled: the delete disabled it at its own time.
        if !input.unattended && live {
            touch_clock(&mut meta, EntryGroup::Enabled, now)?;
        }
        I18N_PACKS.put_saved(ctx, &mut index, at, &id, meta)
    })
}

/// The post id an unattended save names: `!input.hubPostId` refuses an
/// empty one.
fn input_hub_post_id(field: &Field<JsString>) -> Option<JsString> {
    match field {
        Field::Set(post) if !post.is_empty() => Some(post.clone()),
        _ => None,
    }
}

/// The meta fields of a save over `existing`, in the order [`save_pack`]
/// writes them.
fn save_fields(
    input: &SavePackInput,
    id: &JsString,
    name: Value,
    version: JsString,
    existing: Option<&Entry>,
    now: i64,
) -> Object {
    let old = |key: &str| existing.and_then(|meta| meta.get(key));
    let live = existing.filter(|meta| !meta.is_deleted());
    let truthy = |value: Option<Value>| value.filter(Value::is_truthy);
    let matched_base_version =
        truthy(input.matched_base_version.clone().resolve(old("matchedBaseVersion"), Value::String));
    let coverage = truthy(input.coverage.clone().resolve(old("coverage"), Value::Object));
    let dangerous_key_count = input
        .dangerous_key_count
        .clone()
        .resolve(old("dangerousKeyCount"), Value::from)
        .filter(|v| matches!(v, Value::Number(_)));
    let enabled = input
        .enabled
        .map(Value::from)
        .or_else(|| live.and_then(|meta| meta.get("enabled")).filter(|v| **v != Value::Null).cloned())
        .unwrap_or(Value::Bool(true));

    let mut fields = Object::new();
    fields.insert("id", Value::String(id.clone()));
    fields.insert("filename", Value::String(I18N_PACKS.filename_of(id)));
    fields.insert("name", name);
    fields.insert("version", Value::String(version));
    fields.insert("enabled", enabled);
    let hub = SaveHub {
        hub_post_id: &input.hub_post_id,
        hub_updated_at: &input.hub_updated_at,
        uploader_name: &input.uploader_name,
        drop_empty_post: false,
    };
    insert_save_tail(&mut fields, hub, existing, now);
    let app_version = input.app_version_at_import.clone().filter(|v| !v.is_empty()).map(Value::String);
    let derived = [
        ("appVersionAtImport", app_version),
        ("matchedBaseVersion", matched_base_version),
        ("coverage", coverage),
        ("dangerousKeyCount", dangerous_key_count),
    ];
    for (key, value) in derived {
        if let Some(value) = value {
            fields.insert(key, value);
        }
    }
    fields
}

/// Gives the live pack `id` the name `new_name`, trimmed.
pub fn rename_pack(ctx: &StoreContext, id: &JsString, new_name: &JsString) -> PackResult<Entry> {
    I18N_PACKS.rename_pack(ctx, id, new_name)
}

/// Enables or disables the live pack `id`; a pack already so is answered as
/// it is, nothing written.
pub fn set_enabled(ctx: &StoreContext, id: &JsString, enabled: bool) -> PackResult<Entry> {
    I18N_PACKS.change_live_meta(ctx, id, |_, meta| {
        if meta.get("enabled") == Some(&Value::Bool(enabled)) {
            return Ok(false);
        }
        meta.set("enabled", enabled);
        touch_clock(meta, EntryGroup::Enabled, ctx.now_ms())?;
        Ok(true)
    })
}

/// A coverage the page measured from a pack's body.
#[derive(Clone, Debug, PartialEq)]
pub struct CoverageValues {
    pub matched_base_version: JsString,
    pub total_keys: f64,
    pub covered_keys: f64,
    /// The body clock of the meta the body was read with.
    pub measured_body_clock: JsString,
}

/// Stores a coverage measured again on the live pack `id`. Every device
/// computes the same values from the same body, so no clock moves and
/// nothing is reported for sync. When the body changed after it was
/// measured, nothing is written.
pub fn refresh_coverage(ctx: &StoreContext, id: &JsString, values: CoverageValues) -> PackResult<Entry> {
    I18N_PACKS.with_lock(ctx, || {
        let mut index = I18N_PACKS.read_index(ctx)?;
        let at = index.live_position(id).ok_or_else(|| PackError::not_found(I18N_PACKS.not_found))?;
        let meta = &mut index.metas[at];
        let measured = Value::String(values.measured_body_clock);
        if clock_ms(meta.clock(EntryGroup::Body)) != clock_ms(Some(&measured)) {
            return Err(PackError::not_found("Language pack body changed"));
        }
        let mut coverage = Object::new();
        coverage.insert("totalKeys", values.total_keys.into());
        coverage.insert("coveredKeys", values.covered_keys.into());
        meta.set("matchedBaseVersion", Value::String(values.matched_base_version));
        meta.set("coverage", coverage);
        let meta = meta.clone();
        I18N_PACKS.write_index(ctx, &index)?;
        Ok(meta)
    })
}

/// Deletes the pack `id`: disabled and tombstoned, its body kept for sync.
/// The built-in English entry cannot be deleted.
pub fn delete_pack(ctx: &StoreContext, id: &JsString) -> PackResult<()> {
    if is_english(id) {
        return Err(PackError::new(ErrorCode::InvalidName, "English cannot be deleted"));
    }
    I18N_PACKS.tombstone(ctx, id, |meta, now| {
        meta.set("enabled", false);
        touch_clock(meta, EntryGroup::Enabled, now)?;
        Ok(())
    })
}

/// Links the pack `id` (live or not) to the Hub post `hub_post_id`, or
/// unlinks it when that is `None` or blank once trimmed, which also drops
/// the cached Hub time. The uploader name and Hub time are left alone, set,
/// or cleared by a blank value.
pub fn set_hub_post_id(
    ctx: &StoreContext,
    id: &JsString,
    hub_post_id: Option<&JsString>,
    uploader_name: Cached,
    hub_updated_at: Cached,
) -> PackResult<Entry> {
    I18N_PACKS.set_hub_post_id(ctx, id, hub_post_id, uploader_name, hub_updated_at)
}

/// Whether a live pack other than `exclude` has the name `name`.
pub fn has_active_name(ctx: &StoreContext, name: &JsString, exclude: Option<&JsString>) -> PackResult<bool> {
    I18N_PACKS.has_active_name(ctx, name, exclude)
}

/// Puts the live packs of `ordered_ids` first.
pub fn reorder_active(ctx: &StoreContext, ordered_ids: &[JsString]) -> PackResult<()> {
    I18N_PACKS.reorder_active(ctx, ordered_ids)
}
