// SPDX-License-Identifier: GPL-2.0-or-later
//! The language packs: `sync/i18n`, the store of
//! src/main/i18n-pack-store-{internal,crud}.ts, on the shared pack layer
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
    EPOCH_ISO, Entry, EntryGroup, EntryStore, OverwriteOptions, builtin_entry, clock_ms, mark_deleted,
    overwrite_entry, touch_clock,
};
use pipette_js_json::{JsString, Object, Value};
use pipette_keyboard_stores::StoreContext;
use pipette_time::iso_8601_millis;

use crate::js_text::{trim, utf16_len};
use crate::pack_store::{Field, PackIndex, PackStore, find_active_by_name};
use crate::result::{ErrorCode, PackError, PackResult};

/// The id of the built-in English entry (`BUILTIN_ENGLISH_PACK_ID`).
pub const BUILTIN_ENGLISH_PACK_ID: &str = "builtin-english";

/// The language pack store.
pub const I18N_PACKS: PackStore =
    PackStore { entry_store: EntryStore::I18nPacks, dir: "i18n", local_only_ids: &[BUILTIN_ENGLISH_PACK_ID] };

const NOT_FOUND: &str = "Language pack not found";
const DUPLICATE_NAME: &str = "A language pack with the same name already exists";
/// The longest name a rename gives (UTF-16 units).
const MAX_NAME_LENGTH: usize = 64;

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

/// Makes sure the index has the built-in English entry
/// (`ensureBuiltinEnglishEntry`): created first in the index, reported as
/// an index change; when the entry is there, only its body is recreated if
/// missing.
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

/// The live metas, in the index's order (`listMetas`).
pub fn list_metas(ctx: &StoreContext) -> PackResult<Vec<Entry>> {
    Ok(list_all_metas(ctx)?.into_iter().filter(|meta| !meta.is_deleted()).collect())
}

/// Every meta, tombstones included (`listAllMetas`). The built-in English
/// entry is made sure of under the lock; the index is then read without it.
pub fn list_all_metas(ctx: &StoreContext) -> PackResult<Vec<Entry>> {
    ensure_builtin_english(ctx)?;
    Ok(I18N_PACKS.read_index(ctx)?.metas)
}

/// `{meta, pack}` of the live pack `id` (`getPack`): the body parsed, with
/// the meta's name over its own when it is a plain object.
pub fn get_pack(ctx: &StoreContext, id: &JsString) -> PackResult<Object> {
    if I18N_PACKS.pack_path(ctx, id).is_none() {
        return Err(PackError::not_found("Invalid pack id"));
    }
    let index = I18N_PACKS.read_index(ctx)?;
    let meta =
        index.find(id).filter(|meta| !meta.is_deleted()).ok_or_else(|| PackError::not_found(NOT_FOUND))?;
    let text = I18N_PACKS.read_body(ctx, id)?;
    let parsed = pipette_js_json::parse(&text).map_err(|err| PackError::io(format!("SyntaxError: {err}")))?;
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
    record.insert("meta", meta.clone().into());
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
        Some(Value::String(s)) => Some(trim(s)).filter(|s| !s.is_empty()),
        _ => None,
    };
    Some((text("name")?, text("version")?))
}

/// An empty or blank string clears the field, as `''` does for the Hub's
/// time and uploader.
fn blank_clears(field: Field<JsString>) -> Field<JsString> {
    match field {
        Field::Set(s) => {
            let trimmed = trim(&s);
            if trimmed.is_empty() { Field::Clear } else { Field::Set(trimmed) }
        }
        other => other,
    }
}

/// Saves a pack (`savePack`), over the pack `input.id`, over the live pack
/// of the same name (never the built-in English one), or as a new pack.
/// Answers its meta.
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
        // `if (!resolvedId)`: an empty id also looks the name up, and stays
        // when no pack has the name.
        let mut resolved = input.id.clone();
        if resolved.as_ref().is_none_or(JsString::is_empty) {
            let by_name = find_active_by_name(&index.metas, &Value::String(header_name.clone()), None)?;
            if let Some(id) = by_name.and_then(Entry::id).filter(|id| !is_english(id)) {
                resolved = Some(id.clone());
            }
        }
        // A live pack saved over keeps its (possibly renamed) name.
        let kept_name = resolved
            .as_ref()
            .and_then(|id| index.metas.iter().find(|meta| meta.id() == Some(id) && !meta.is_deleted()))
            .and_then(|meta| meta.get("name"))
            .filter(|name| **name != Value::Null)
            .cloned();
        let name = kept_name.unwrap_or_else(|| Value::String(header_name.clone()));
        if find_active_by_name(&index.metas, &name, resolved.as_ref())?.is_some() {
            return Err(PackError::new(ErrorCode::DuplicateName, DUPLICATE_NAME));
        }
        let id = resolved.unwrap_or_else(|| JsString::from(ctx.new_id()));
        if I18N_PACKS.pack_path(ctx, &id).is_none() {
            return Err(PackError::new(ErrorCode::InvalidFile, "Generated pack id is unsafe"));
        }
        let pack = input.pack.as_ref().unwrap_or(&Value::Null);
        I18N_PACKS.write_body(ctx, &id, &pipette_js_json::stringify_with_gap(pack, "  "))?;

        let now = ctx.now_ms();
        let at = index.position(&id);
        let existing = at.map(|at| &index.metas[at]);
        let live = existing.filter(|meta| !meta.is_deleted());
        let fields = save_fields(&I18N_PACKS, &input, &id, name, header_version, existing, live, now);
        let options = OverwriteOptions { body: true, explicit: !input.unattended };
        let mut meta = overwrite_entry(EntryStore::I18nPacks, existing, fields, now, options)?;
        // A save that keeps the pack alive over a delete must not come back
        // disabled: the delete disabled it at its own time.
        if !input.unattended && live.is_some() {
            touch_clock(&mut meta, EntryGroup::Enabled, now)?;
        }
        index.put(at, meta.clone());
        I18N_PACKS.write_index(ctx, &index)?;
        I18N_PACKS.notify_pack_change(ctx, &id);
        I18N_PACKS.notify_index_change(ctx);
        Ok(meta)
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

/// The meta fields of a save, in the order `savePack` writes them.
#[allow(clippy::too_many_arguments)]
fn save_fields(
    store: &PackStore,
    input: &SavePackInput,
    id: &JsString,
    name: Value,
    version: JsString,
    existing: Option<&Entry>,
    live: Option<&Entry>,
    now: i64,
) -> Object {
    let old = |key: &str| existing.and_then(|meta| meta.get(key));
    let truthy = |value: Option<Value>| value.filter(Value::is_truthy);
    let hub_post_id = input.hub_post_id.clone().resolve(old("hubPostId"), Value::String);
    let hub_updated_at =
        truthy(blank_clears(input.hub_updated_at.clone()).resolve(old("hubUpdatedAt"), Value::String));
    let uploader_name =
        truthy(blank_clears(input.uploader_name.clone()).resolve(old("uploaderName"), Value::String));
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
    let saved_at =
        old("savedAt").filter(|v| **v != Value::Null).cloned().unwrap_or_else(|| iso_8601_millis(now).into());

    let mut fields = Object::new();
    fields.insert("id", Value::String(id.clone()));
    fields.insert("filename", Value::String(store.filename_of(id)));
    fields.insert("name", name);
    fields.insert("version", Value::String(version));
    fields.insert("enabled", enabled);
    let optional =
        [("hubPostId", hub_post_id), ("hubUpdatedAt", hub_updated_at), ("uploaderName", uploader_name)];
    for (key, value) in optional {
        if let Some(value) = value {
            fields.insert(key, value);
        }
    }
    fields.insert("savedAt", saved_at);
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

/// The live meta `id` under the lock, changed by `change`: written and
/// reported as an index change when `change` answers true, answered as it
/// is otherwise.
fn change_live_meta(
    ctx: &StoreContext,
    id: &JsString,
    change: impl FnOnce(&PackIndex, &mut Entry) -> PackResult<bool>,
) -> PackResult<Entry> {
    I18N_PACKS.with_lock(ctx, || {
        let mut index = I18N_PACKS.read_index(ctx)?;
        let at = index.live_position(id).ok_or_else(|| PackError::not_found(NOT_FOUND))?;
        let mut meta = index.metas[at].clone();
        if change(&index, &mut meta)? {
            index.metas[at] = meta.clone();
            I18N_PACKS.write_index(ctx, &index)?;
            I18N_PACKS.notify_index_change(ctx);
        }
        Ok(meta)
    })
}

/// Gives the live pack `id` the name `new_name`, trimmed (`renamePack`).
/// Only the meta changes: the body and its sync unit stay as they are.
pub fn rename_pack(ctx: &StoreContext, id: &JsString, new_name: &JsString) -> PackResult<Entry> {
    let name = trim(new_name);
    if name.is_empty() {
        return Err(PackError::new(ErrorCode::InvalidName, "Name must not be empty"));
    }
    if utf16_len(&name) > MAX_NAME_LENGTH {
        let message = format!("Name must be at most {MAX_NAME_LENGTH} characters");
        return Err(PackError::new(ErrorCode::InvalidName, message));
    }
    change_live_meta(ctx, id, |index, meta| {
        let named = Value::String(name);
        if find_active_by_name(&index.metas, &named, Some(id))?.is_some() {
            return Err(PackError::new(ErrorCode::DuplicateName, DUPLICATE_NAME));
        }
        meta.set("name", named);
        touch_clock(meta, EntryGroup::Name, ctx.now_ms())?;
        Ok(true)
    })
}

/// Enables or disables the live pack `id` (`setEnabled`); a pack already so
/// is answered as it is, nothing written.
pub fn set_enabled(ctx: &StoreContext, id: &JsString, enabled: bool) -> PackResult<Entry> {
    change_live_meta(ctx, id, |_, meta| {
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

/// Stores a coverage measured again on the live pack `id`
/// (`refreshCoverage`). Every device computes the same values from the same
/// body, so no clock moves and nothing is reported for sync. When the body
/// changed after it was measured, nothing is written.
pub fn refresh_coverage(ctx: &StoreContext, id: &JsString, values: CoverageValues) -> PackResult<Entry> {
    I18N_PACKS.with_lock(ctx, || {
        let mut index = I18N_PACKS.read_index(ctx)?;
        let at = index.live_position(id).ok_or_else(|| PackError::not_found(NOT_FOUND))?;
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

/// Deletes the pack `id` (`deletePack`): disabled and tombstoned, its body
/// kept for sync. The built-in English entry cannot be deleted.
pub fn delete_pack(ctx: &StoreContext, id: &JsString) -> PackResult<()> {
    if is_english(id) {
        return Err(PackError::new(ErrorCode::InvalidName, "English cannot be deleted"));
    }
    I18N_PACKS.with_lock(ctx, || {
        let mut index = I18N_PACKS.read_index(ctx)?;
        let at = index.position(id).ok_or_else(|| PackError::not_found(NOT_FOUND))?;
        let now = ctx.now_ms();
        let meta = &mut index.metas[at];
        meta.set("enabled", false);
        touch_clock(meta, EntryGroup::Enabled, now)?;
        mark_deleted(meta, now);
        I18N_PACKS.write_index(ctx, &index)?;
        I18N_PACKS.notify_pack_change(ctx, id);
        I18N_PACKS.notify_index_change(ctx);
        Ok(())
    })
}

/// How a Hub link change treats an optional cached field: left alone, or
/// set to a value (blank once trimmed clears it).
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Cached {
    #[default]
    Keep,
    Set(Option<JsString>),
}

/// Links the pack `id` (live or not) to the Hub post `hub_post_id`, or
/// unlinks it when that is `None` or blank once trimmed, which also drops
/// the cached Hub time (`setHubPostId`). The uploader name and Hub time
/// are left alone, set, or cleared by a blank value.
pub fn set_hub_post_id(
    ctx: &StoreContext,
    id: &JsString,
    hub_post_id: Option<&JsString>,
    uploader_name: Cached,
    hub_updated_at: Cached,
) -> PackResult<Entry> {
    I18N_PACKS.with_lock(ctx, || {
        let mut index = I18N_PACKS.read_index(ctx)?;
        let at = index.position(id).ok_or_else(|| PackError::not_found(NOT_FOUND))?;
        let meta = &mut index.metas[at];
        match hub_post_id.map(trim).filter(|post| !post.is_empty()) {
            None => {
                meta.remove("hubPostId");
                meta.remove("hubUpdatedAt");
            }
            Some(post) => meta.set("hubPostId", Value::String(post)),
        }
        for (key, cached) in [("uploaderName", uploader_name), ("hubUpdatedAt", hub_updated_at)] {
            let Cached::Set(value) = cached else { continue };
            match value.as_ref().map(trim).filter(|v| !v.is_empty()) {
                Some(value) => meta.set(key, Value::String(value)),
                None => {
                    meta.remove(key);
                }
            }
        }
        touch_clock(meta, EntryGroup::Hub, ctx.now_ms())?;
        let meta = meta.clone();
        I18N_PACKS.write_index(ctx, &index)?;
        I18N_PACKS.notify_index_change(ctx);
        Ok(meta)
    })
}

/// Whether a live pack other than `exclude` has the name `name`
/// (`hasActiveName`).
pub fn has_active_name(ctx: &StoreContext, name: &JsString, exclude: Option<&JsString>) -> PackResult<bool> {
    I18N_PACKS.has_active_name(ctx, name, exclude)
}

/// Puts the live packs of `ordered_ids` first (`reorderActive`).
pub fn reorder_active(ctx: &StoreContext, ordered_ids: &[JsString]) -> PackResult<()> {
    I18N_PACKS.reorder_active(ctx, ordered_ids)
}
