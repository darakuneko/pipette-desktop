// SPDX-License-Identifier: GPL-2.0-or-later
//! The favorite post handlers of `src/main/hub/hub-ipc-favorite.ts` and the
//! private favorite upload of `hub-ipc-private.ts`, split at the export JSON.
//! Its keycodes are named by the page's worker
//! (src/tauri-shim/workers/favorite-transfer-requests.ts), so the page runs
//! the checks of `prepareFavoritePost` in their order, reads the entry here
//! ([`read_entry`]), builds the JSON and hands it to [`upload`], [`update`]
//! or [`upload_private`]. These run the same checks again before they send
//! the post, so a post the page checked passes them.
//!
//! The answers and messages are the TS handlers': the Hub errors as
//! hub-client.ts words them, a 403 or a 429 as its sentinel, and the
//! `TypeError` texts of a Hub answer or a favorite file that is not shaped
//! as the TS expects. The text of a file-system error other than a missing
//! file, and of a file that is not JSON, is not Node's.

use std::io;
use std::path::Path;

use pipette_js_json::{Object, Value, js_string};

use crate::endpoint::Endpoint;
use crate::http::RequestBody;
use crate::multipart::{MultipartBody, MultipartBuilder, post_boundary};
use crate::token::{HubFailure, HubToken};
use crate::validate::{is_valid_post_id, validate_title};

#[cfg(test)]
mod tests;

/// `FAV_TYPE_TO_EXPORT_KEY` of src/shared/favorite-data.ts: each favorite
/// type and the `post_type` (and export category) of its posts.
pub const FAVORITE_TYPES: [(&str, &str); 5] = [
    ("macro", "macro"),
    ("tapDance", "td"),
    ("combo", "combo"),
    ("keyOverride", "ko"),
    ("altRepeatKey", "ark"),
];

/// The export key of the favorite type `value` (`isValidFavoriteType`), or
/// `None` when it is not a type's name.
fn export_key(value: Option<&Value>) -> Option<(&'static str, &'static str)> {
    let name = value?.as_str()?;
    FAVORITE_TYPES.into_iter().find(|(ty, _)| *ty == name)
}

/// `isValidHubVialProtocol`: a number that is a non-negative integer;
/// `None` is `undefined`.
pub fn is_valid_hub_vial_protocol(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Number(n)) if n.is_finite() && n.fract() == 0.0 && *n >= 0.0)
}

/// `value.<key>` of a JavaScript value: a `TypeError` for `undefined`
/// (`None`) and `null`, `undefined` for a property a value does not have.
fn property<'a>(value: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>, String> {
    match value {
        None => Err(format!("Cannot read properties of undefined (reading '{key}')")),
        Some(Value::Null) => Err(format!("Cannot read properties of null (reading '{key}')")),
        Some(Value::Object(object)) => Ok(object.get(key)),
        Some(_) => Ok(None),
    }
}

/// A favorite post that passed the checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FavoritePost {
    /// The trimmed title.
    pub title: String,
    /// The `post_type` of the type, also the name of the JSON file.
    pub post_type: &'static str,
}

/// The checks of `prepareFavoritePost` in their order: the type, the Vial
/// protocol and the title. `params` is the handler's argument (`None`:
/// `undefined`).
pub fn check_post(params: Option<&Value>) -> Result<FavoritePost, HubFailure> {
    let read = |key: &str| property(params, key).map_err(HubFailure::plain);
    let (_, post_type) =
        export_key(read("type")?).ok_or_else(|| HubFailure::plain("Invalid favorite type"))?;
    if !is_valid_hub_vial_protocol(read("vialProtocol")?) {
        return Err(HubFailure::plain("Invalid vialProtocol"));
    }
    // A lone surrogate is written as U+FFFD by `Buffer.from` too, and has
    // its length and whitespace.
    let title = match read("title")? {
        Some(Value::String(title)) => Some(title.to_string_lossy().into_owned()),
        _ => None,
    };
    let title = validate_title(title.as_deref())?;
    Ok(FavoritePost { title, post_type })
}

/// `validatePostId(params.postId)`: the post id as the path takes it
/// (`String(postId)`).
pub fn check_post_id(params: Option<&Value>) -> Result<String, HubFailure> {
    match property(params, "postId").map_err(HubFailure::plain)? {
        Some(post_id) if post_id.is_truthy() => {
            let post_id = js_string(Some(post_id));
            if is_valid_post_id(&post_id) { Ok(post_id) } else { Err(HubFailure::plain("Invalid post ID")) }
        }
        _ => Err(HubFailure::plain("Invalid post ID")),
    }
}

/// `isSafeExportFilename`: its test of `String(filename)`.
fn is_safe_export_filename(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
        && name != "."
        && name != ".."
}

/// Node's `path.join` refusing a file name that is not a string.
fn path_not_a_string(value: Option<&Value>) -> String {
    let received = match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(b)) => format!("type boolean ({b})"),
        Some(Value::Number(_)) => format!("type number ({})", js_string(value)),
        Some(Value::Array(_)) => "an instance of Array".to_owned(),
        Some(_) => "an instance of Object".to_owned(),
    };
    format!("The \"path\" argument must be of type string. Received {received}")
}

/// `readFile(path, 'utf-8')`: each invalid sequence as U+FFFD. A missing
/// file has Node's message; any other failure the OS's.
fn read_text(path: &Path) -> Result<String, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {
            Err(format!("ENOENT: no such file or directory, open '{}'", path.display()))
        }
        Err(err) => Err(err.to_string()),
    }
}

fn parse(text: &str) -> Result<Value, String> {
    pipette_js_json::parse(text).map_err(|err| err.to_string())
}

/// `===` of two JSON values: objects and arrays are never equal.
fn strictly_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a == b,
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        _ => false,
    }
}

/// `index.entries.find((e) => e.id === entryId && !e.deletedAt)` on the
/// index as `JSON.parse` read it.
fn find_entry<'a>(index: &'a Value, entry_id: Option<&Value>) -> Result<Option<&'a Value>, String> {
    let entries = match index {
        Value::Null => return Err("Cannot read properties of null (reading 'entries')".to_owned()),
        Value::Object(object) => object.get("entries"),
        // `Array.prototype.entries` is a function, which has no `find`.
        Value::Array(_) => return Err("index.entries.find is not a function".to_owned()),
        _ => None,
    };
    let entries = match entries {
        None => return Err("Cannot read properties of undefined (reading 'find')".to_owned()),
        Some(Value::Null) => return Err("Cannot read properties of null (reading 'find')".to_owned()),
        Some(Value::Array(entries)) => entries,
        Some(_) => return Err("index.entries.find is not a function".to_owned()),
    };
    for entry in entries {
        let id = property(Some(entry), "id")?;
        let deleted = property(Some(entry), "deletedAt")?.is_some_and(Value::is_truthy);
        if strictly_equal(id, entry_id) && !deleted {
            return Ok(Some(entry));
        }
    }
    Ok(None)
}

/// The favorite entry a post is built from, as `buildFavoriteExportJson`
/// reads it from `{sync_dir}/favorites/{type}`: the index as it is on
/// disk (no entry is normalized and no body is renamed), the first entry
/// with the id that is not deleted, then its body, which must have `data`
/// and name the type. The result is `{label?, savedAt?, body}`: the entry's
/// label and save time as they are, and the text of its body, which the
/// page's worker parses again. `favorite_type` and `entry_id` are the
/// handler's (`None`: `undefined`).
pub fn read_entry(
    sync_dir: &Path,
    favorite_type: Option<&Value>,
    entry_id: Option<&Value>,
) -> Result<Value, String> {
    let (ty, _) = export_key(favorite_type).ok_or("Invalid favorite type")?;
    let dir = sync_dir.join("favorites").join(ty);
    let index = parse(&read_text(&dir.join("index.json"))?)?;
    let entry = find_entry(&index, entry_id)?.ok_or("Entry not found")?;

    let filename = property(Some(entry), "filename")?;
    if !is_safe_export_filename(&js_string(filename)) {
        return Err("Invalid filename".to_owned());
    }
    let filename = match filename {
        Some(Value::String(name)) => name.to_string_lossy().into_owned(),
        other => return Err(path_not_a_string(other)),
    };
    let body = read_text(&dir.join(filename))?;
    let parsed = parse(&body)?;
    if matches!(property(Some(&parsed), "data")?, None | Some(Value::Null)) {
        return Err("Entry data is empty".to_owned());
    }
    if !strictly_equal(property(Some(&parsed), "type")?, Some(&Value::from(ty))) {
        return Err("Entry type mismatch".to_owned());
    }

    let mut out = Object::new();
    for key in ["label", "savedAt"] {
        if let Some(value) = property(Some(entry), key)? {
            out.insert(key, value.clone());
        }
    }
    out.insert("body", Value::from(body));
    Ok(Value::Object(out))
}

/// `HUB_FAVORITE_ENTRY`'s answer: `{success: true, entry}` or
/// `{success: false, error}`.
pub fn entry_answer(entry: Result<Value, String>) -> Value {
    match entry {
        Ok(entry) => answer([("success", Value::Bool(true)), ("entry", entry)]),
        Err(error) => failure(HubFailure::plain(error)),
    }
}

/// `buildFeatureMultipartBody`, with the boundary of now: the title, the
/// post type, the JSON file `{postType}.json` and, for a private upload
/// with an expiry, `String(expiresInDays)`.
fn feature_body(
    now_ms: f64,
    post: &FavoritePost,
    json: &str,
    expires_in_days: Option<&str>,
) -> MultipartBody {
    let mut builder = MultipartBuilder::new(post_boundary(now_ms as i64));
    builder.field("title", &post.title);
    builder.field("post_type", post.post_type);
    builder.file("json", &format!("{}.json", post.post_type), json.as_bytes(), "application/json");
    if let Some(days) = expires_in_days {
        builder.field("expires_in_days", days);
    }
    builder.build()
}

/// `submitFeaturePost` (or the private upload) through `withTokenRetry`:
/// each run builds its body, so a run after a new token has the boundary
/// of its own time, as the TS's.
async fn send(
    token: &HubToken,
    endpoint: &Endpoint<'_>,
    post: &FavoritePost,
    json: &str,
    expires_in_days: Option<&str>,
) -> Result<Option<Value>, HubFailure> {
    token
        .with_token_retry(|jwt| {
            let body = feature_body(token.http().timing().now_ms(), post, json, expires_in_days);
            async move { token.http().send(endpoint, Some(jwt.as_str()), RequestBody::Multipart(body)).await }
        })
        .await
}

fn answer<const N: usize>(fields: [(&str, Value); N]) -> Value {
    let mut object = Object::new();
    for (key, value) in fields {
        object.insert(key, value);
    }
    Value::Object(object)
}

fn failure(err: HubFailure) -> Value {
    answer([("success", Value::Bool(false)), ("error", Value::from(err.message))])
}

/// `{ success: true, postId: result.id }`, without `postId` where the
/// result has no `id`.
fn post_id_answer(result: Result<Option<Value>, HubFailure>) -> Value {
    let read = result.and_then(|data| {
        property(data.as_ref(), "id").map(Option::<&Value>::cloned).map_err(HubFailure::plain)
    });
    match read {
        Ok(id) => {
            let mut object = Object::new();
            object.insert("success", Value::Bool(true));
            if let Some(id) = id {
                object.insert("postId", id);
            }
            Value::Object(object)
        }
        Err(err) => failure(err),
    }
}

/// `toPrivateResult`: `{ success: true, id, url, expiresAt }`, each left
/// out where the result does not have it.
fn private_answer(result: Result<Option<Value>, HubFailure>) -> Value {
    let read = result.and_then(|data| {
        let mut object = Object::new();
        object.insert("success", Value::Bool(true));
        for (key, from) in [("id", "id"), ("url", "url"), ("expiresAt", "expires_at")] {
            if let Some(value) = property(data.as_ref(), from).map_err(HubFailure::plain)? {
                object.insert(key, value.clone());
            }
        }
        Ok(Value::Object(object))
    });
    read.unwrap_or_else(failure)
}

/// `HUB_UPLOAD_FAVORITE_POST`: the post of `params` with the export `json`
/// the page built for it.
pub async fn upload(token: &HubToken, params: Option<&Value>, json: &str) -> Value {
    let post = match check_post(params) {
        Ok(post) => post,
        Err(err) => return failure(err),
    };
    post_id_answer(send(token, &Endpoint::UploadFeaturePost, &post, json, None).await)
}

/// `HUB_UPDATE_FAVORITE_POST`: the post id is checked first.
pub async fn update(token: &HubToken, params: Option<&Value>, json: &str) -> Value {
    let checked = check_post_id(params).and_then(|post_id| check_post(params).map(|post| (post_id, post)));
    let (post_id, post) = match checked {
        Ok(checked) => checked,
        Err(err) => return failure(err),
    };
    let endpoint = Endpoint::UpdateFeaturePost { post_id: &post_id };
    post_id_answer(send(token, &endpoint, &post, json, None).await)
}

/// `HUB_UPLOAD_PRIVATE_FAVORITE_POST`: `expiresInDays` is sent as
/// `String(expiresInDays)` unless it is `null` or `undefined`.
pub async fn upload_private(token: &HubToken, params: Option<&Value>, json: &str) -> Value {
    let post = match check_post(params) {
        Ok(post) => post,
        Err(err) => return failure(err),
    };
    // `params` is an object here: its checks read its properties.
    let expires_in_days = match property(params, "expiresInDays") {
        Ok(None | Some(Value::Null)) | Err(_) => None,
        Ok(days) => Some(js_string(days)),
    };
    let result =
        send(token, &Endpoint::UploadPrivateFeaturePost, &post, json, expires_in_days.as_deref()).await;
    private_answer(result)
}
