// SPDX-License-Identifier: GPL-2.0-or-later
//! The key label handlers of `src/main/hub/hub-ipc-key-labels.ts`, with the
//! requests of `hub-key-labels.ts`: the search, the detail, the freshness
//! timestamps, the download into the local store, and the upload, update,
//! sync and delete of a local label linked to its Hub post.
//!
//! The handlers take their arguments as the renderer sent them, as
//! JavaScript values, and answer the TS's `{ success, data?, errorCode?,
//! error? }` as JSON text, with the Hub's values in the order the Hub sent
//! them. A bad argument is `NOT_FOUND`, a failed Hub request `IO_ERROR` with
//! the request's message; the store's own failures keep their codes. A 404
//! of these endpoints is a plain failure (`<label>: 404 <body>`), not the
//! typed one of the posts.
//!
//! The Hub requests run without the store's write lock; the store takes it
//! for its own read and write after them, on the blocking pool.

use std::collections::{HashMap, HashSet};

use futures_util::future::join_all;
use pipette_js_json::{JsString, Object, Value, js_string, stringify};
use pipette_keyboard_stores::{
    KeyLabelError, KeyLabelErrorCode, KeyLabelSave, StoreContext, get_key_label, key_label_response,
    save_key_label, set_key_label_hub_post_id,
};

use crate::endpoint::{Endpoint, ListQuery};
use crate::http::{HubError, HubHttp, RequestBody, StatusKind};
use crate::retry_after::js_number;
use crate::token::{HubFailure, HubToken};
use crate::validate::{clamp_int, is_valid_post_id};

/// `HUB_KEY_LABEL_TIMESTAMPS_BATCH_LIMIT`: the most ids one timestamps
/// request may carry (the Hub answers more with a 400).
pub const TIMESTAMPS_BATCH_LIMIT: usize = 100;

/// `HUB_ERROR_KEY_LABEL_DUPLICATE`: the error of an upload or update the Hub
/// refuses with a 409 (a label of the same name).
pub const HUB_ERROR_KEY_LABEL_DUPLICATE: &str = "KEY_LABEL_DUPLICATE";

/// The list's page size when the renderer gives none.
const DEFAULT_PER_PAGE: f64 = 20.0;
/// The largest page size the list asks for.
const MAX_PER_PAGE: f64 = 100.0;

/// `HubKeyLabelInput`: the body of an upload or update. `None` leaves a
/// field out, as `JSON.stringify` leaves out `undefined`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct KeyLabelInput {
    pub name: Option<Value>,
    pub map: Option<Value>,
    /// Sent only when given; `Some(Value::Null)` is sent as `null`.
    pub composite_labels: Option<Value>,
    pub keymap_applicable: bool,
}

/// `buildBody`: `{ name, map, composite_labels?, keymap_applicable }`.
/// `keymap_applicable` is always sent, `false` included, so a re-upload can
/// clear a flag set before.
pub fn build_body(input: &KeyLabelInput) -> String {
    let mut body = Object::new();
    if let Some(name) = &input.name {
        body.insert("name", name.clone());
    }
    if let Some(map) = &input.map {
        body.insert("map", map.clone());
    }
    if let Some(labels) = &input.composite_labels {
        body.insert("composite_labels", labels.clone());
    }
    body.insert("keymap_applicable", Value::Bool(input.keymap_applicable));
    stringify(&Value::Object(body))
}

type Answer = Result<Option<Value>, KeyLabelError>;

fn refused(code: KeyLabelErrorCode, message: &str) -> KeyLabelError {
    KeyLabelError::invalid_argument(code, message)
}

fn not_found(message: &str) -> KeyLabelError {
    refused(KeyLabelErrorCode::NotFound, message)
}

/// A failed Hub request, or a TypeError the TS throws while reading its
/// answer: `IO_ERROR` with the message (`extractError`).
fn io_error(message: impl AsRef<str>) -> KeyLabelError {
    refused(KeyLabelErrorCode::IoError, message.as_ref())
}

fn respond(answer: Answer) -> String {
    key_label_response(answer)
}

/// `value.<key>` (`None` for `undefined`), or the `TypeError` of reading it
/// off `undefined` or `null`.
fn property<'a>(value: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>, String> {
    match value {
        None => Err(format!("Cannot read properties of undefined (reading '{key}')")),
        Some(Value::Null) => Err(format!("Cannot read properties of null (reading '{key}')")),
        Some(Value::Object(object)) => Ok(object.get(key)),
        // A primitive or an array has none of the properties read here.
        Some(_) => Ok(None),
    }
}

/// `a ?? b`.
fn nullish(a: Option<&Value>, b: Option<Value>) -> Option<Value> {
    match a {
        None | Some(Value::Null) => b,
        Some(value) => Some(value.clone()),
    }
}

/// The text of `typeof id === 'string' && POST_ID_RE.test(id)`.
fn hub_post_id(id: Option<&Value>) -> Option<&str> {
    match id {
        Some(Value::String(id)) => id.as_str().filter(|id| is_valid_post_id(id)),
        _ => None,
    }
}

/// The local id argument: a string, or `Invalid id`.
fn local_id(id: Option<&Value>) -> Result<JsString, KeyLabelError> {
    match id {
        Some(Value::String(id)) => Ok(id.clone()),
        _ => Err(not_found("Invalid id")),
    }
}

/// Runs a store operation on the blocking pool.
async fn in_store<T, F>(stores: &StoreContext, job: F) -> Result<T, KeyLabelError>
where
    T: Send + 'static,
    F: FnOnce(&StoreContext) -> Result<T, KeyLabelError> + Send + 'static,
{
    let stores = stores.clone();
    match tokio::task::spawn_blocking(move || job(&stores)).await {
        Ok(result) => result,
        Err(err) => Err(io_error(err.to_string())),
    }
}

/// `getRecord`: the live label `id` as `{ meta, data }`.
async fn record(stores: &StoreContext, id: &JsString) -> Result<Object, KeyLabelError> {
    let id = id.clone();
    in_store(stores, move |stores| get_key_label(stores, &id)).await
}

fn meta_of(record: &Object) -> Option<&Value> {
    record.get("meta")
}

/// The record's `meta.hubPostId` when truthy, as the text its request and
/// link use; else `Entry has no hub post`.
fn linked_post_id(record: &Object) -> Result<String, KeyLabelError> {
    let post_id = property(meta_of(record), "hubPostId").ok().flatten();
    match post_id.filter(|value| value.is_truthy()) {
        Some(post_id) => Ok(js_string(Some(post_id))),
        None => Err(not_found("Entry has no hub post")),
    }
}

/// `buildHubKeyLabelInput`: the label's name (the meta's, which a rename
/// changes), map and composite labels (when truthy), and its keymap mark.
fn input_of(record: &Object) -> KeyLabelInput {
    let data = record.get("data");
    let read = |value: Option<&Value>, key: &str| property(value, key).ok().flatten().cloned();
    KeyLabelInput {
        name: read(meta_of(record), "name"),
        map: read(data, "map"),
        composite_labels: read(data, "compositeLabels").filter(Value::is_truthy),
        keymap_applicable: read(data, "keymapApplicable").is_some_and(|value| value.is_truthy()),
    }
}

/// `HUB_KEY_LABEL_LIST`: the page (1 when not given) and the page size (20
/// when not given, within 1 to 100) the renderer asks for.
pub async fn list(http: &HubHttp, params: Option<&Value>) -> String {
    let param = |key: &str| params.and_then(Value::as_object).and_then(|object| object.get(key));
    let page = clamp_int(number_param(param("page")), 1.0, 9_007_199_254_740_991.0).unwrap_or(1.0);
    let per_page = clamp_int(number_param(param("perPage")), 1.0, MAX_PER_PAGE).unwrap_or(DEFAULT_PER_PAGE);
    // `query.q && query.q.trim()`.
    let q = match param("q") {
        Some(Value::String(q)) => Some(q.to_string_lossy().into_owned()),
        Some(q) if q.is_truthy() => return respond(Err(io_error("query.q.trim is not a function"))),
        _ => None,
    };
    let query = ListQuery { q: q.as_deref(), name: None, page: Some(page), per_page: Some(per_page) };
    let data = http.send(&Endpoint::KeyLabelList(query), None, RequestBody::None).await;
    respond(data.map_err(|err| io_error(err.to_string())))
}

/// The number `clampInt` floors: `Math.floor` turns a string or a boolean
/// into a number; `null` and `undefined` are none.
fn number_param(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Null => None,
        Value::Number(n) => Some(*n),
        Value::String(text) => Some(js_number(&text.to_string_lossy())),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Array(_) | Value::Object(_) => Some(f64::NAN),
    }
}

/// `HUB_KEY_LABEL_DETAIL`.
pub async fn detail(http: &HubHttp, hub_post_id: Option<&Value>) -> String {
    let Some(post_id) = self::hub_post_id(hub_post_id) else {
        return respond(Err(not_found("Invalid hub post id")));
    };
    let data = http.send(&Endpoint::KeyLabelDetail { post_id }, None, RequestBody::None).await;
    respond(data.map_err(|err| io_error(err.to_string())))
}

/// `HUB_KEY_LABEL_TIMESTAMPS`: the ids without repeats, sent 100 to a
/// request, all at once; the answer lists the ids the Hub knows in the
/// order they were given.
pub async fn timestamps(http: &HubHttp, ids: Option<&Value>) -> String {
    const INVALID: &str = "ids must be an array of valid hub post ids";
    let Some(Value::Array(items)) = ids else { return respond(Err(not_found(INVALID))) };
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for item in items {
        let Some(id) = hub_post_id(Some(item)) else { return respond(Err(not_found(INVALID))) };
        if seen.insert(id) {
            unique.push(id);
        }
    }
    let requests = unique.chunks(TIMESTAMPS_BATCH_LIMIT).map(|chunk| {
        let ids = chunk.iter().map(|id| Value::from(*id)).collect();
        let body: Object = [("ids", Value::Array(ids))].into_iter().collect();
        http.send(&Endpoint::KeyLabelTimestamps, None, RequestBody::Json(stringify(&Value::Object(body))))
    });
    let mut responses = Vec::new();
    for response in join_all(requests).await {
        match response {
            Ok(response) => responses.push(response),
            Err(err) => return respond(Err(io_error(err.to_string()))),
        }
    }
    let mut by_id: HashMap<&str, &Value> = HashMap::new();
    for response in &responses {
        let listed = match property(response.as_ref(), "items") {
            Ok(Some(Value::Array(listed))) => listed,
            // A string's characters have no `id`.
            Ok(Some(Value::String(_))) => continue,
            Ok(_) => return respond(Err(io_error("r.items is not iterable"))),
            Err(err) => return respond(Err(io_error(err))),
        };
        for item in listed {
            match property(Some(item), "id") {
                Ok(Some(Value::String(id))) => {
                    if let Some(id) = id.as_str() {
                        by_id.insert(id, item);
                    }
                }
                Ok(_) => {}
                Err(err) => return respond(Err(io_error(err))),
            }
        }
    }
    let found = unique.iter().filter_map(|id| by_id.get(id).map(|item| (*item).clone())).collect();
    let data: Object = [("items", Value::Array(found))].into_iter().collect();
    respond(Ok(Some(Value::Object(data))))
}

/// The download's body with the uploader and the Hub time of the post's
/// detail (`fetchHubKeyLabelPayload`). The detail is best effort: when it
/// fails, the given fallbacks stay.
struct Payload {
    body: Option<Value>,
    uploader_name: Option<Value>,
    hub_updated_at: Option<Value>,
}

async fn payload(
    http: &HubHttp,
    post_id: &str,
    fallback_uploader: Option<Value>,
    fallback_updated_at: Option<Value>,
) -> Result<Payload, HubError> {
    let body = http.send(&Endpoint::KeyLabelDownload { post_id }, None, RequestBody::None).await?;
    let (mut uploader_name, mut hub_updated_at) = (fallback_uploader, fallback_updated_at);
    if let Ok(detail) = http.send(&Endpoint::KeyLabelDetail { post_id }, None, RequestBody::None).await
        && let Ok(uploader) = property(detail.as_ref(), "uploader_name")
    {
        uploader_name = nullish(uploader, uploader_name);
        let updated = property(detail.as_ref(), "updated_at").ok().flatten();
        hub_updated_at = nullish(updated, hub_updated_at);
    }
    Ok(Payload { body, uploader_name, hub_updated_at })
}

/// The save of a downloaded or synced label (`hubBodyToSaveRecordFields`
/// with the caller's id, name and post id): the Hub body's map, composite
/// labels and keymap mark, and the uploader and Hub time when truthy.
fn save_of(
    id: JsString,
    name: Option<&Value>,
    hub_post_id: &str,
    keep_current_name: bool,
    payload: Payload,
) -> Result<KeyLabelSave, KeyLabelError> {
    // `validateName` of the save, which comes before any other check.
    let Some(Value::String(name)) = name else {
        return Err(refused(KeyLabelErrorCode::InvalidName, "name must be a string"));
    };
    let body = payload.body.as_ref();
    let read = |key: &str| property(body, key).ok().flatten();
    Ok(KeyLabelSave {
        id: Some(id),
        name: name.clone(),
        uploader_name: payload.uploader_name,
        map: read("map").cloned().unwrap_or(Value::Null),
        composite_labels: read("composite_labels").cloned(),
        keymap_applicable: read("keymap_applicable").is_some_and(Value::is_truthy),
        hub_post_id: Some(Value::from(hub_post_id)),
        hub_updated_at: payload.hub_updated_at,
        keep_current_name,
    })
}

async fn save(stores: &StoreContext, save: KeyLabelSave) -> Answer {
    let meta = in_store(stores, move |stores| save_key_label(stores, &save)).await?;
    Ok(Some(meta.into()))
}

/// `HUB_KEY_LABEL_DOWNLOAD`: saves the post as the label whose id is the
/// post id, so a keyboard's layout that names it can still be matched with
/// the Hub once the label is gone locally.
pub async fn download(http: &HubHttp, stores: &StoreContext, hub_post_id: Option<&Value>) -> String {
    let Some(post_id) = self::hub_post_id(hub_post_id) else {
        return respond(Err(not_found("Invalid hub post id")));
    };
    let answer = async {
        let payload = payload(http, post_id, None, None).await.map_err(|err| io_error(err.to_string()))?;
        // `body.name`, read before the save.
        let name = property(payload.body.as_ref(), "name").map_err(io_error)?.cloned();
        let save_input = save_of(post_id.into(), name.as_ref(), post_id, false, payload)?;
        save(stores, save_input).await
    };
    respond(answer.await)
}

/// What an upload or update failed with: a 409 is the duplicate name, any
/// other failure its message.
fn submit_failure(err: HubFailure) -> KeyLabelError {
    if err.is(StatusKind::Conflict) {
        refused(KeyLabelErrorCode::DuplicateName, HUB_ERROR_KEY_LABEL_DUPLICATE)
    } else {
        io_error(err.message)
    }
}

/// A value the Hub answered for a field `setHubPostId` takes: `None` for
/// `undefined` (left as it is), `Some(None)` for a value that is not a
/// string (removed).
fn cached(value: Option<&Value>) -> Option<Option<JsString>> {
    value.map(|value| match value {
        Value::String(text) => Some(text.clone()),
        _ => None,
    })
}

/// Links the local label `id` to `post_id` (`None` unlinks), with the
/// uploader and the Hub time when given.
async fn link(
    stores: &StoreContext,
    id: JsString,
    post_id: Option<JsString>,
    uploader_name: Option<Option<JsString>>,
    hub_updated_at: Option<Option<JsString>>,
) -> Result<Value, KeyLabelError> {
    let meta = in_store(stores, move |stores| {
        set_key_label_hub_post_id(
            stores,
            &id,
            post_id.as_ref(),
            uploader_name.as_ref().map(Option::as_ref),
            hub_updated_at.as_ref().map(Option::as_ref),
        )
    })
    .await?;
    Ok(meta.into())
}

/// `HUB_KEY_LABEL_UPLOAD`: posts the local label and links it to the new
/// post, with the post's uploader and Hub time, so the label shows its
/// author and its Hub actions at once.
pub async fn upload(token: &HubToken, stores: &StoreContext, local_id: Option<&Value>) -> String {
    let answer = async {
        let id = self::local_id(local_id)?;
        let record = record(stores, &id).await?;
        let body = build_body(&input_of(&record));
        let result = token
            .with_token_retry(|jwt| {
                let body = body.clone();
                async move {
                    token
                        .http()
                        .send(&Endpoint::KeyLabelUpload, Some(jwt.as_str()), RequestBody::Json(body))
                        .await
                }
            })
            .await
            .map_err(submit_failure)?;
        let read = |key: &str| property(result.as_ref(), key).map_err(io_error);
        // `hubPostId?.trim() || null`: no id unlinks.
        let post_id = match read("id")? {
            Some(Value::String(id)) => Some(id.clone()),
            _ => None,
        };
        let (uploader, updated) = (cached(read("uploader_name")?), cached(read("updated_at")?));
        link(stores, id, post_id, uploader, updated).await.map(Some)
    };
    respond(answer.await)
}

/// `HUB_KEY_LABEL_UPDATE`: posts the local label over its Hub post and
/// keeps the post's new Hub time; the uploader stays as it is.
pub async fn update(token: &HubToken, stores: &StoreContext, local_id: Option<&Value>) -> String {
    let answer = async {
        let id = self::local_id(local_id)?;
        let record = record(stores, &id).await?;
        let post_id = linked_post_id(&record)?;
        let body = build_body(&input_of(&record));
        let result = token
            .with_token_retry(|jwt| {
                let (body, post_id) = (body.clone(), post_id.as_str());
                async move {
                    let endpoint = Endpoint::KeyLabelUpdate { post_id };
                    token.http().send(&endpoint, Some(jwt.as_str()), RequestBody::Json(body)).await
                }
            })
            .await
            .map_err(submit_failure)?;
        let updated = cached(property(result.as_ref(), "updated_at").map_err(io_error)?);
        link(stores, id, Some(post_id.into()), None, updated).await.map(Some)
    };
    respond(answer.await)
}

/// `HUB_KEY_LABEL_SYNC`: takes the post's map, composite labels and keymap
/// mark into the local label, with its uploader and Hub time (the cached
/// ones when the detail fails). The label keeps its id, its post and the
/// name it has when the save runs, so a rename made meanwhile stays.
pub async fn sync(http: &HubHttp, stores: &StoreContext, local_id: Option<&Value>) -> String {
    let answer = async {
        let id = self::local_id(local_id)?;
        let record = record(stores, &id).await?;
        let post_id = linked_post_id(&record)?;
        let meta = meta_of(&record);
        let read = |key: &str| property(meta, key).ok().flatten().cloned();
        let payload = payload(http, &post_id, read("uploaderName"), read("hubUpdatedAt"))
            .await
            .map_err(|err| io_error(err.to_string()))?;
        let name = read("name");
        save(stores, save_of(id, name.as_ref(), &post_id, true, payload)?).await
    };
    respond(answer.await)
}

/// `HUB_KEY_LABEL_DELETE`: deletes the Hub post and unlinks the local
/// label, which stays.
pub async fn delete(token: &HubToken, stores: &StoreContext, local_id: Option<&Value>) -> String {
    let answer = async {
        let id = self::local_id(local_id)?;
        let record = record(stores, &id).await?;
        let post_id = linked_post_id(&record)?;
        token
            .with_token_retry(|jwt| {
                let post_id = post_id.as_str();
                async move {
                    let endpoint = Endpoint::KeyLabelDelete { post_id };
                    token.http().send(&endpoint, Some(jwt.as_str()), RequestBody::None).await
                }
            })
            .await
            .map_err(|err| io_error(err.message))?;
        link(stores, id, None, None, None).await?;
        Ok(None)
    };
    respond(answer.await)
}

#[cfg(test)]
mod tests;
