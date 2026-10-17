// SPDX-License-Identifier: GPL-2.0-or-later
//! The language-pack, theme-pack and key-label routes of the in-memory Hub,
//! as scripts/fake-hub/hub-routes-packs.ts has them: list, detail,
//! download, timestamps and the authenticated create / update / delete.

use pipette_js_json::{Value, stringify_with_gap};

use super::http::{
    Answer, Request, authenticate, fail, form_file, ok, ok_with, page_of, pagination, read_form,
    read_json_body,
};
use super::object;
use super::state::{KeyLabel, Pack, PackKind, SYSTEM_USER_ID, State, User, by_updated_desc};
use super::validate::{
    I18N_MAX_BYTES, NameVersion, THEME_MAX_BYTES, parse_i18n_export, parse_theme_pack,
    validate_key_label_payload,
};
use crate::js::js_trim;

const TIMESTAMPS_MAX_IDS: usize = 100;
const TIMESTAMPS_MAX_BODY_BYTES: usize = 16 * 1024;
const TIMESTAMPS_MAX_ID_LENGTH: usize = 64;
const KEY_LABEL_MAX_BODY_BYTES: usize = 64 * 1024;
const QUERY_MAX_LENGTH: usize = 200;
const KEY_LABEL_NOT_FOUND: &str = "Key label not found";

macro_rules! check {
    ($result:expr) => {
        match $result {
            Ok(value) => value,
            Err(answer) => return answer,
        }
    };
}

fn not_found(kind: PackKind) -> &'static str {
    match kind {
        PackKind::I18n => "i18n pack not found",
        PackKind::Theme => "theme pack not found",
    }
}

/// The query `key`, cut to 200 UTF-16 units and trimmed.
fn query_text(request: &Request<'_>, key: &str) -> String {
    let units: Vec<u16> = request.query(key).unwrap_or("").encode_utf16().take(QUERY_MAX_LENGTH).collect();
    js_trim(&String::from_utf16_lossy(&units))
}

/// A download: the JSON pretty-printed with two spaces, not wrapped.
fn download(value: &Value) -> Answer {
    Answer {
        status: 200,
        body: stringify_with_gap(value, "  "),
        retry_after: None,
        content_type: "application/json; charset=utf-8",
    }
}

/// `{ids}` to `{items}`: the `{id, updated_at}` of each id that exists,
/// once, in the order asked.
fn timestamps<'a>(
    request: &Request<'_>,
    records: impl Iterator<Item = (&'a str, &'a str)> + Clone,
) -> Answer {
    if request.body.len() > TIMESTAMPS_MAX_BODY_BYTES {
        return fail(413, "Request body too large");
    }
    let parsed = check!(read_json_body(request));
    let Some(Value::Array(ids)) = parsed.as_object().and_then(|object| object.get("ids")) else {
        return fail(400, "ids must be an array");
    };
    if ids.len() > TIMESTAMPS_MAX_IDS {
        return fail(400, &format!("Too many ids (max {TIMESTAMPS_MAX_IDS})"));
    }
    let ids: Option<Vec<&str>> = ids
        .iter()
        .map(|id| id.as_str().filter(|id| id.encode_utf16().count() <= TIMESTAMPS_MAX_ID_LENGTH))
        .collect();
    let Some(ids) = ids else {
        return fail(400, &format!("ids must be strings (max {TIMESTAMPS_MAX_ID_LENGTH} chars)"));
    };
    let mut seen: Vec<&str> = Vec::new();
    let mut items = Vec::new();
    for id in ids {
        if seen.contains(&id) {
            continue;
        }
        seen.push(id);
        if let Some((id, updated_at)) = records.clone().find(|(candidate, _)| *candidate == id) {
            items.push(object([("id", Value::from(id)), ("updated_at", Value::from(updated_at))]));
        }
    }
    ok(object([("items", Value::Array(items))]))
}

// --- /api/i18n-packs and /api/theme-packs ----------------------------------------

/// The `json` file of a pack upload: its name, version and text.
fn pack_upload(kind: PackKind, request: &Request<'_>) -> Result<(NameVersion, String), Answer> {
    let form = read_form(request);
    let max = if kind == PackKind::I18n { I18N_MAX_BYTES } else { THEME_MAX_BYTES };
    let Some(json) = form_file(&form, "json") else { return Err(fail(400, "JSON file is required")) };
    if json.bytes.len() > max {
        return Err(fail(400, &format!("JSON file exceeds {max} bytes")));
    }
    if !json.filename.to_lowercase().ends_with(".json") {
        return Err(fail(400, "JSON file must have .json extension"));
    }
    let text = String::from_utf8_lossy(&json.bytes).into_owned();
    let parsed = if kind == PackKind::I18n { parse_i18n_export(&text) } else { parse_theme_pack(&text) };
    parsed.map(|name_version| (name_version, text)).map_err(|err| fail(400, &err))
}

fn name_version_taken(packs: &[Pack], name: &str, version: &str, except: Option<&str>) -> bool {
    packs.iter().any(|pack| {
        Some(pack.id.as_str()) != except
            && pack.name.to_lowercase() == name.to_lowercase()
            && pack.version == version
    })
}

/// The index of the record `id` of the request's account.
fn owned(
    owners: impl Iterator<Item = (String, String)>,
    id: &str,
    user: &User,
    missing: &str,
) -> Result<usize, Answer> {
    let (index, owner) = owners
        .enumerate()
        .find_map(|(index, (candidate, owner))| (candidate == id).then_some((index, owner)))
        .ok_or_else(|| fail(404, missing))?;
    if owner != user.id {
        return Err(fail(403, "Forbidden"));
    }
    Ok(index)
}

fn pack_owners(state: &State, kind: PackKind) -> impl Iterator<Item = (String, String)> + '_ {
    state.packs(kind).iter().map(|pack| (pack.id.clone(), pack.uploaded_by.clone()))
}

pub fn pack_route(
    state: &mut State,
    request: &Request<'_>,
    kind: PackKind,
    op: &str,
    id: Option<&str>,
) -> Answer {
    let id = id.unwrap_or("");
    match op {
        "list" => {
            let (page, per_page) = pagination(request);
            let query = query_text(request, "q").to_lowercase();
            let name = query_text(request, "name").to_lowercase();
            let matching = by_updated_desc(
                state
                    .packs(kind)
                    .iter()
                    .filter(|pack| {
                        (query.is_empty() || pack.name.to_lowercase().contains(&query))
                            && (name.is_empty() || pack.name.to_lowercase() == name)
                    })
                    .collect(),
                |pack| &pack.updated_at,
            );
            let items = page_of(&matching, page, per_page)
                .into_iter()
                .map(|pack| state.pack_summary(kind, pack))
                .collect();
            ok(object([
                ("items", Value::Array(items)),
                ("total", Value::Number(matching.len() as f64)),
                ("page", Value::Number(page)),
                ("per_page", Value::Number(per_page)),
            ]))
        }
        "timestamps" => timestamps(
            request,
            state.packs(kind).iter().map(|pack| (pack.id.as_str(), pack.updated_at.as_str())),
        ),
        "get" => match state.packs(kind).iter().find(|pack| pack.id == id) {
            Some(pack) => ok(state.pack_detail(kind, pack)),
            None => fail(404, not_found(kind)),
        },
        "download" => match state.packs(kind).iter().find(|pack| pack.id == id) {
            Some(pack) => download(&pipette_js_json::parse(&pack.pack_json).unwrap_or(Value::Null)),
            None => fail(404, not_found(kind)),
        },
        "create" => {
            let user = check!(authenticate(state, request));
            if user.display_name.as_deref().is_none_or(str::is_empty) {
                return fail(400, "Display name is required to upload");
            }
            let ((name, version), pack_json) = check!(pack_upload(kind, request));
            if name_version_taken(state.packs(kind), &name, &version, None) {
                return fail(409, "name and version already exist");
            }
            let now = state.stamp(None);
            let pack = Pack {
                id: state.new_id(),
                name,
                version,
                pack_json,
                uploaded_by: user.id,
                created_at: now.clone(),
                updated_at: now,
            };
            let answer = state.pack_detail(kind, &pack);
            state.packs_mut(kind).push(pack);
            ok_with(201, answer)
        }
        "update" => {
            let user = check!(authenticate(state, request));
            let index = check!(owned(pack_owners(state, kind), id, &user, not_found(kind)));
            let ((name, version), pack_json) = check!(pack_upload(kind, request));
            if name_version_taken(state.packs(kind), &name, &version, Some(id)) {
                return fail(409, "name and version already exist");
            }
            let stamp = state.stamp(None);
            let pack = &mut state.packs_mut(kind)[index];
            pack.name = name;
            pack.version = version;
            pack.pack_json = pack_json;
            pack.updated_at = stamp;
            ok(state.pack_detail(kind, &state.packs(kind)[index]))
        }
        _ => {
            let user = check!(authenticate(state, request));
            let index = check!(owned(pack_owners(state, kind), id, &user, not_found(kind)));
            state.packs_mut(kind).remove(index);
            ok(object([("id", Value::from(id))]))
        }
    }
}

// --- /api/key-labels -------------------------------------------------------------

fn key_label_name_taken(state: &State, name: &str, except: Option<&str>) -> bool {
    state
        .key_labels
        .iter()
        .any(|label| Some(label.id.as_str()) != except && label.name.to_lowercase() == name.to_lowercase())
}

/// The index of the key label `id` of the request's account; the Hub's
/// built-in ones are refused with `system_error`.
fn own_key_label(state: &State, user: &User, id: &str, system_error: &str) -> Result<usize, Answer> {
    let index = state
        .key_labels
        .iter()
        .position(|label| label.id == id)
        .ok_or_else(|| fail(404, KEY_LABEL_NOT_FOUND))?;
    let owner = &state.key_labels[index].uploaded_by;
    if owner == SYSTEM_USER_ID {
        return Err(fail(403, system_error));
    }
    if *owner != user.id {
        return Err(fail(403, "Forbidden"));
    }
    Ok(index)
}

pub fn key_label_route(state: &mut State, request: &Request<'_>, op: &str, id: Option<&str>) -> Answer {
    let id = id.unwrap_or("");
    match op {
        "list" => {
            let (page, per_page) = pagination(request);
            let query = query_text(request, "q").to_lowercase();
            let matching = by_updated_desc(
                state
                    .key_labels
                    .iter()
                    .filter(|label| query.is_empty() || label.name.to_lowercase().contains(&query))
                    .collect(),
                |label| &label.updated_at,
            );
            let items = page_of(&matching, page, per_page)
                .into_iter()
                .map(|label| state.public_key_label(label))
                .collect();
            ok(object([
                ("items", Value::Array(items)),
                ("total", Value::Number(matching.len() as f64)),
                ("page", Value::Number(page)),
                ("per_page", Value::Number(per_page)),
            ]))
        }
        "timestamps" => timestamps(
            request,
            state.key_labels.iter().map(|label| (label.id.as_str(), label.updated_at.as_str())),
        ),
        "get" => match state.key_labels.iter().find(|label| label.id == id) {
            Some(label) => ok(state.public_key_label(label)),
            None => fail(404, KEY_LABEL_NOT_FOUND),
        },
        "download" => match state.key_labels.iter().find(|label| label.id == id) {
            Some(label) => download(&object([
                ("name", Value::from(label.name.as_str())),
                ("map", label.map.clone()),
                ("composite_labels", label.composite_labels.clone().unwrap_or(Value::Null)),
                ("keymap_applicable", Value::Bool(label.keymap_applicable)),
            ])),
            None => fail(404, KEY_LABEL_NOT_FOUND),
        },
        "create" => {
            if request.body.len() > KEY_LABEL_MAX_BODY_BYTES {
                return fail(413, "Request body too large");
            }
            let user = check!(authenticate(state, request));
            if user.display_name.as_deref().is_none_or(str::is_empty) {
                return fail(400, "Display name is required to upload");
            }
            let parsed = check!(read_json_body(request));
            let valid = check!(validate_key_label_payload(&parsed).map_err(|err| fail(400, &err)));
            if key_label_name_taken(state, &valid.name, None) {
                return fail(409, "name is already taken");
            }
            let now = state.stamp(None);
            let label = KeyLabel {
                id: state.new_id(),
                name: valid.name,
                map: valid.map,
                composite_labels: valid.composite_labels,
                keymap_applicable: valid.keymap_applicable.unwrap_or(false),
                uploaded_by: user.id,
                created_at: now.clone(),
                updated_at: now,
            };
            let answer = state.public_key_label(&label);
            state.key_labels.push(label);
            ok_with(201, answer)
        }
        "update" => {
            if request.body.len() > KEY_LABEL_MAX_BODY_BYTES {
                return fail(413, "Request body too large");
            }
            let user = check!(authenticate(state, request));
            let index =
                check!(own_key_label(state, &user, id, "System-seeded key labels cannot be modified"));
            let parsed = check!(read_json_body(request));
            let valid = check!(validate_key_label_payload(&parsed).map_err(|err| fail(400, &err)));
            if key_label_name_taken(state, &valid.name, Some(id)) {
                return fail(409, "name is already taken");
            }
            let stamp = state.stamp(None);
            let label = &mut state.key_labels[index];
            label.name = valid.name;
            label.map = valid.map;
            label.composite_labels = valid.composite_labels;
            // Absent keeps the stored flag.
            label.keymap_applicable = valid.keymap_applicable.unwrap_or(label.keymap_applicable);
            label.updated_at = stamp;
            ok(state.public_key_label(&state.key_labels[index]))
        }
        _ => {
            let user = check!(authenticate(state, request));
            let index = check!(own_key_label(state, &user, id, "System-seeded key labels cannot be deleted"));
            state.key_labels.remove(index);
            ok(object([("id", Value::from(id))]))
        }
    }
}
