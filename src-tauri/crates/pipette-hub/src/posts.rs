// SPDX-License-Identifier: GPL-2.0-or-later
//! The keymap post handlers of `src/main/hub/hub-ipc-posts.ts`: upload,
//! update, rename and delete a keymap post, and the account's own posts
//! (all of them by page, or those of one keyboard). The answers are the
//! TS's `{ success, postId? | posts?, pagination?, error? }`, with what the
//! Hub sent as it sent it; a value the Hub left out is left out of the
//! answer.
//!
//! The checks run before any request and in the TS's order: the post id
//! (update, rename, delete), the title, then the files (`buildFiles`: the
//! names from the keyboard name with each unsafe UTF-16 unit as `_`, the
//! size limits thumbnail → vil → pipette → keymap C → PDF). The keyboard
//! name itself goes into the `keyboard_name` field as the page sent it,
//! untrimmed and unchecked.
//!
//! The page always sends strings and numbers. Where it does not, Electron
//! fails on JavaScript's coercions with messages of the engine; here a text
//! input that is not a string fails with the handler's own message
//! (`Upload failed` …) once the checks before it pass, and a post id that
//! is not a string is an invalid post id.

use pipette_js_json::{Object, Value};

use crate::endpoint::Endpoint;
use crate::http::{HubError, RequestBody};
use crate::multipart::{KeymapFiles, MultipartBody, keymap_post_body, post_boundary};
use crate::token::{HubFailure, HubToken, Jwt};
use crate::validate::{
    KeymapPostInput, build_files, clamp_int, compute_total_pages, validate_keyboard_name, validate_post_id,
    validate_title,
};

/// `HubUploadPostParams` as the page sent them; `None` stands for a value
/// that is not a string.
#[derive(Debug, Clone, Copy, Default)]
pub struct KeymapPostParams<'a> {
    pub title: Option<&'a str>,
    pub keyboard_name: Option<&'a str>,
    pub vil_json: Option<&'a str>,
    pub pipette_json: Option<&'a str>,
    pub keymap_c: Option<&'a str>,
    pub pdf_base64: Option<&'a str>,
    pub thumbnail_base64: Option<&'a str>,
}

/// The checked title and files of a keymap post (`validateTitle`, then
/// `buildFiles`), with the keyboard name as the page sent it.
pub(crate) struct CheckedKeymapPost<'a> {
    pub title: String,
    pub keyboard_name: &'a str,
    pub files: KeymapFiles,
}

impl<'a> KeymapPostParams<'a> {
    /// `validateTitle(params.title)` then `buildFiles(params)`; `fallback`
    /// is the handler's message for a file input that is not a string.
    pub(crate) fn check(&self, fallback: &str) -> Result<CheckedKeymapPost<'a>, HubFailure> {
        let title = validate_title(self.title)?;
        let (
            Some(keyboard_name),
            Some(vil_json),
            Some(pipette_json),
            Some(keymap_c),
            Some(pdf_base64),
            Some(thumbnail_base64),
        ) = (
            self.keyboard_name,
            self.vil_json,
            self.pipette_json,
            self.keymap_c,
            self.pdf_base64,
            self.thumbnail_base64,
        )
        else {
            return Err(HubFailure::plain(fallback));
        };
        let files = build_files(KeymapPostInput {
            keyboard_name,
            vil_json,
            pipette_json,
            keymap_c,
            pdf_base64,
            thumbnail_base64,
        })?;
        Ok(CheckedKeymapPost { title, keyboard_name, files })
    }
}

/// The multipart body of a keymap post, with the boundary of this moment:
/// the TS builds the body anew for each send, the retry after a 401 too.
pub(crate) fn keymap_body(
    token: &HubToken,
    post: &CheckedKeymapPost<'_>,
    expires_in_days: Option<f64>,
) -> MultipartBody {
    let boundary = post_boundary(token.http().timing().now_ms() as i64);
    keymap_post_body(boundary, &post.title, post.keyboard_name, &post.files, expires_in_days)
}

/// Sends `endpoint` with the JWT and `body`.
pub(crate) async fn send(
    token: &HubToken,
    endpoint: &Endpoint<'_>,
    jwt: Jwt,
    body: RequestBody,
) -> Result<Option<Value>, HubError> {
    token.http().send(endpoint, Some(jwt.as_str()), body).await
}

/// `result.<key>` of the envelope's `data`: a TypeError where `data` is
/// `undefined` or `null`, nothing where it is not an object or has no such
/// property.
pub(crate) fn property(data: Option<&Value>, key: &str) -> Result<Option<Value>, HubFailure> {
    match data {
        None => Err(HubFailure::plain(format!("Cannot read properties of undefined (reading '{key}')"))),
        Some(Value::Null) => {
            Err(HubFailure::plain(format!("Cannot read properties of null (reading '{key}')")))
        }
        Some(Value::Object(object)) => Ok(object.get(key).cloned()),
        // A primitive or an array has no such property.
        Some(_) => Ok(None),
    }
}

/// `{ success: true, <fields> }` without the fields that are absent, or
/// `{ success: false, error }`.
pub(crate) fn answer(result: Result<Vec<(&str, Option<Value>)>, HubFailure>) -> Value {
    let mut answer = Object::new();
    match result {
        Ok(fields) => {
            answer.insert("success", Value::Bool(true));
            for (key, value) in fields {
                if let Some(value) = value {
                    answer.insert(key, value);
                }
            }
        }
        Err(err) => {
            // `extractError(err, fallback)`: every failure here is an Error,
            // so its message, never the fallback.
            answer.insert("success", Value::Bool(false));
            answer.insert("error", Value::from(err.message));
        }
    }
    Value::Object(answer)
}

/// The fallbacks of `extractError` in the upload and update handlers,
/// which are also the messages of a file input that is not a string.
pub(crate) const UPLOAD_FAILED: &str = "Upload failed";
const UPDATE_FAILED: &str = "Update failed";

/// `HUB_UPLOAD_POST`: `{ success, postId }`.
pub async fn upload_post(token: &HubToken, params: KeymapPostParams<'_>) -> Value {
    answer(submit(token, params, None).await)
}

/// `HUB_UPDATE_POST`: the post id is checked first. `None` stands for a
/// post id that is not a string.
pub async fn update_post(token: &HubToken, post_id: Option<&str>, params: KeymapPostParams<'_>) -> Value {
    let result = match validate_post_id(post_id.unwrap_or_default()) {
        Ok(()) => submit(token, params, post_id).await,
        Err(err) => Err(err.into()),
    };
    answer(result)
}

/// The upload (`post_id` `None`) or the update of a keymap post.
async fn submit(
    token: &HubToken,
    params: KeymapPostParams<'_>,
    post_id: Option<&str>,
) -> Result<Vec<(&'static str, Option<Value>)>, HubFailure> {
    let post = params.check(if post_id.is_some() { UPDATE_FAILED } else { UPLOAD_FAILED })?;
    let endpoint = match post_id {
        Some(post_id) => Endpoint::UpdatePost { post_id },
        None => Endpoint::UploadPost,
    };
    let data = token
        .with_token_retry(|jwt| {
            let body = RequestBody::Multipart(keymap_body(token, &post, None));
            send(token, &endpoint, jwt, body)
        })
        .await?;
    Ok(vec![("postId", property(data.as_ref(), "id")?)])
}

/// `HUB_PATCH_POST`: renames a post (`{ title }`). `None` stands for a
/// value that is not a string.
pub async fn patch_post(token: &HubToken, post_id: Option<&str>, title: Option<&str>) -> Value {
    let result = async {
        let post_id = post_id.unwrap_or_default();
        validate_post_id(post_id)?;
        let title = validate_title(title)?;
        let mut fields = Object::new();
        fields.insert("title", Value::from(title));
        let body = pipette_js_json::stringify(&Value::Object(fields));
        let endpoint = Endpoint::PatchPost { post_id };
        token.with_token_retry(|jwt| send(token, &endpoint, jwt, RequestBody::Json(body.clone()))).await?;
        Ok(Vec::new())
    }
    .await;
    answer(result)
}

/// `HUB_DELETE_POST`. `None` stands for a post id that is not a string.
pub async fn delete_post(token: &HubToken, post_id: Option<&str>) -> Value {
    let result = async {
        let post_id = post_id.unwrap_or_default();
        validate_post_id(post_id)?;
        let endpoint = Endpoint::DeletePost { post_id };
        token.with_token_retry(|jwt| send(token, &endpoint, jwt, RequestBody::None)).await?;
        Ok(Vec::new())
    }
    .await;
    answer(result)
}

/// `HubFetchMyPostsParams`: `None` for an absent `page` / `per_page` (and
/// for one that is not a number).
#[derive(Debug, Clone, Copy, Default)]
pub struct MyPostsParams {
    pub page: Option<f64>,
    pub per_page: Option<f64>,
}

/// `HUB_FETCH_MY_POSTS`: the page within `1..`, the page size within
/// `1..=100`, and `total_pages` counted from what the Hub answered.
pub async fn fetch_my_posts(token: &HubToken, params: MyPostsParams) -> Value {
    let page = clamp_int(params.page, 1.0, MAX_SAFE_INTEGER);
    let per_page = clamp_int(params.per_page, 1.0, 100.0);
    let result = async {
        let endpoint = Endpoint::MyPosts { page, per_page };
        let data = token.with_token_retry(|jwt| send(token, &endpoint, jwt, RequestBody::None)).await?;
        let data = data.as_ref();
        // The TS reads `result.total` first.
        let total = property(data, "total")?;
        let per_page = property(data, "per_page")?;
        let total_pages =
            compute_total_pages(number_or_nan(total.as_ref()), number_or_nan(per_page.as_ref()));
        let mut pagination = Object::new();
        for (key, value) in [("total", total), ("page", property(data, "page")?), ("per_page", per_page)] {
            if let Some(value) = value {
                pagination.insert(key, value);
            }
        }
        pagination.insert("total_pages", Value::Number(total_pages));
        Ok(vec![("posts", property(data, "items")?), ("pagination", Some(Value::Object(pagination)))])
    }
    .await;
    answer(result)
}

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A number as it is; anything else fails `Number.isFinite` as NaN does.
fn number_or_nan(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(n)) => *n,
        _ => f64::NAN,
    }
}

/// `HUB_FETCH_MY_KEYBOARD_POSTS`: the posts of the trimmed keyboard name.
/// `None` stands for a value that is not a string.
pub async fn fetch_my_keyboard_posts(token: &HubToken, keyboard_name: Option<&str>) -> Value {
    let result = async {
        let keyboard_name = validate_keyboard_name(keyboard_name)?;
        let endpoint = Endpoint::MyKeyboardPosts { keyboard_name: &keyboard_name };
        let posts = token.with_token_retry(|jwt| send(token, &endpoint, jwt, RequestBody::None)).await?;
        Ok(vec![("posts", posts)])
    }
    .await;
    answer(result)
}

#[cfg(test)]
mod tests;
