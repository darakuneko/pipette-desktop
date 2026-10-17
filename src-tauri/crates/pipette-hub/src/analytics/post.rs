// SPDX-License-Identifier: GPL-2.0-or-later
//! The Analyze post handlers of src/main/hub/hub-ipc-analytics.ts (upload,
//! update, preview) and the private analytics upload of hub-ipc-private.ts,
//! on the export of [`super::prepare`].
//!
//! Each step runs in the TS's order: the update's post id first, then the
//! preparation (its failures answer before the title's), the title, the
//! file names, the thumbnail, the request with the token retry and, after a
//! public upload or update, the post id linked to the saved filter. That
//! link may fail without undoing the post: its answer is ignored, as the
//! TS ignores the `success: false` of `setAnalyzeFilterHubPostId`. The
//! upload and the update send the export without
//! `validateAnalyticsExport`; only the preview reports the validation.
//!
//! The parameters are the JavaScript value the renderer sent; the answers
//! are the handlers' `{ success, … }` objects, without the properties that
//! are `undefined`.

use pipette_js_json::{Object, Value, js_string};
use pipette_keyboard_stores::{StoreContext, set_analyze_filter_hub_post_id};

use super::export::AnalyticsExport;
use super::prepare::{PrepareError, Prepared, prepare_analytics_export, preview};
use crate::base64::node_base64_decode;
use crate::endpoint::Endpoint;
use crate::http::RequestBody;
use crate::js::js_number_string;
use crate::multipart::{UploadFile, analytics_post_body, post_boundary};
use crate::sources::AnalyticsSource;
use crate::token::{HubFailure, HubToken};
use crate::validate::{sanitize_filename_base, validate_post_id, validate_title};

/// What the Analyze post handlers work with: the Hub token and its client,
/// the stores holding the saved filters (and the userData of the keymap
/// snapshots), and the typing analytics the export reads.
pub struct AnalyticsPosts<'a> {
    pub token: &'a HubToken,
    pub store: &'a StoreContext,
    pub source: &'a dyn AnalyticsSource,
}

/// The files of an analytics post: `{base}.json` (the export) and
/// `{base}.jpg` (the thumbnail).
struct PostFiles {
    json: UploadFile,
    thumbnail: UploadFile,
}

/// The property `key` of `value`, as JavaScript reads it from a JSON value.
fn prop<'v>(value: &'v Value, key: &str) -> Option<&'v Value> {
    value.as_object().and_then(|object| object.get(key))
}

/// `{ success: false, error }`.
fn failure(message: String) -> Value {
    let mut answer = Object::new();
    answer.insert("success", Value::Bool(false));
    answer.insert("error", Value::from(message));
    answer.into()
}

/// `{ success: true, …fields }`, leaving out the fields that are
/// `undefined`.
fn success(fields: &[(&str, Option<Value>)]) -> Value {
    let mut answer = Object::new();
    answer.insert("success", Value::Bool(true));
    for (key, value) in fields {
        if let Some(value) = value {
            answer.insert(*key, value.clone());
        }
    }
    answer.into()
}

/// `value.<key>` of what the Hub answered: the TypeError of reading a
/// property of `undefined` or `null`, and `undefined` for a property a
/// value does not have.
fn read_property(value: Option<&Value>, key: &str) -> Result<Option<Value>, HubFailure> {
    match value {
        None => Err(HubFailure::plain(format!("Cannot read properties of undefined (reading '{key}')"))),
        Some(Value::Null) => {
            Err(HubFailure::plain(format!("Cannot read properties of null (reading '{key}')")))
        }
        Some(value) => Ok(prop(value, key).cloned()),
    }
}

/// `params.title` for `validateTitle`: anything that is not a string is
/// rejected as an empty title. A lone surrogate is read as U+FFFD, which
/// is what Node writes for it in the UTF-8 of the body.
fn title(params: &Value) -> Result<String, HubFailure> {
    let title = match prop(params, "title") {
        Some(Value::String(text)) => Some(text.to_string_lossy().into_owned()),
        _ => None,
    };
    Ok(validate_title(title.as_deref())?)
}

/// `sanitizeFilenameBase(params.keyboard.productName, params.uid)`; the
/// preparation has checked that `keyboard` is there and `uid` is a
/// non-empty string. A product name that is a truthy non-string fails as
/// `.replace` does on it.
fn filename_base(params: &Value, uid: &str) -> Result<String, HubFailure> {
    let product_name = prop(params, "keyboard").and_then(|keyboard| prop(keyboard, "productName"));
    match product_name {
        Some(Value::String(name)) => Ok(sanitize_filename_base(&name.to_string_lossy(), uid)),
        Some(value) if value.is_truthy() => {
            Err(HubFailure::plain("(productName || fallback || \"analytics\").replace is not a function"))
        }
        _ => Ok(sanitize_filename_base("", uid)),
    }
}

/// How Node's `inspect` writes a number in an error message: `String(n)`,
/// with `-0` kept.
fn inspected_number(n: f64) -> String {
    if n == 0.0 && n.is_sign_negative() { "-0".to_owned() } else { js_number_string(n) }
}

/// `Buffer.from(value, 'base64')`: a string is decoded as Node decodes
/// base64, a list is its items as bytes, anything else is Node's TypeError.
fn thumbnail_bytes(value: Option<&Value>) -> Result<Vec<u8>, HubFailure> {
    const MESSAGE: &str = "The first argument must be of type string or an instance of Buffer, ArrayBuffer, or \
                           Array or an Array-like Object. Received";
    let received = match value {
        Some(Value::String(text)) => return Ok(node_base64_decode(&text.to_string_lossy())),
        Some(Value::Array(items)) => return Ok(items.iter().map(array_byte).collect()),
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Number(n)) => format!("type number ({})", inspected_number(*n)),
        Some(Value::Bool(b)) => format!("type boolean ({b})"),
        Some(Value::Object(_)) => "an instance of Object".to_owned(),
    };
    Err(HubFailure::plain(format!("{MESSAGE} {received}")))
}

/// A list item as a byte of `Buffer.from(list)`: a number modulo 256,
/// `true` as 1, anything else as 0.
fn array_byte(item: &Value) -> u8 {
    match item {
        Value::Number(n) if n.is_finite() => (n.trunc().rem_euclid(256.0)) as u8,
        Value::Bool(true) => 1,
        _ => 0,
    }
}

/// The text of `params.postId` once `validatePostId` accepts it: a falsy
/// value is rejected, any other is tested (and sent) as `String(value)`.
fn post_id(params: &Value) -> Result<String, HubFailure> {
    let value = prop(params, "postId").filter(|value| value.is_truthy());
    let text = value.map(|value| js_string(Some(value))).unwrap_or_default();
    validate_post_id(&text)?;
    Ok(text)
}

/// `params.expiresInDays` of a private upload: a number is written as the
/// last field, `null` / `undefined` send no expiry. The renderer sends
/// nothing else (`HubExpiresInDays`); any other value sends no expiry.
fn expires_in_days(params: &Value) -> Option<f64> {
    match prop(params, "expiresInDays") {
        Some(Value::Number(days)) => Some(*days),
        _ => None,
    }
}

impl AnalyticsPosts<'_> {
    /// `prepareAnalyticsExport(params)` with the Hub client's clock as the
    /// export's time.
    async fn prepare(&self, params: &Value) -> Result<Prepared, PrepareError> {
        let now_ms = self.token.http().timing().now_ms() as i64;
        prepare_analytics_export(params, self.store, self.source, now_ms).await
    }

    /// The export, or the reason it could not be assembled as the
    /// handler's error.
    async fn export(&self, params: &Value) -> Result<Box<AnalyticsExport>, HubFailure> {
        match self.prepare(params).await {
            Ok(Prepared::Built(export)) => Ok(export),
            Ok(Prepared::Failed { error, .. }) => Err(HubFailure::plain(error)),
            Err(PrepareError(message)) => Err(HubFailure::plain(message)),
        }
    }

    /// The title, the file names and the files of a post, in the TS's
    /// order, once the export is built. The export's JSON and the
    /// thumbnail's bytes, both as large as the post, are made on the
    /// blocking pool, off the async runtime's threads.
    async fn post_input(&self, params: &Value) -> Result<(String, PostFiles), HubFailure> {
        let export = self.export(params).await?;
        let title = title(params)?;
        // The preparation has accepted `uid` as a non-empty string.
        let uid = prop(params, "uid").and_then(Value::as_str).unwrap_or_default();
        let base = filename_base(params, uid)?;
        let thumbnail = prop(params, "thumbnailBase64").cloned();
        let (json, thumbnail) = tokio::task::spawn_blocking(move || {
            let thumbnail = thumbnail_bytes(thumbnail.as_ref())?;
            Ok::<_, HubFailure>((export.to_json().into_bytes(), thumbnail))
        })
        .await
        .map_err(|err| HubFailure::plain(err.to_string()))??;
        let json = UploadFile { name: format!("{base}.json"), data: json };
        let thumbnail = UploadFile { name: format!("{base}.jpg"), data: thumbnail };
        Ok((title, PostFiles { json, thumbnail }))
    }

    /// Sends the post to `endpoint` with the token retry, the multipart
    /// body made anew (with its boundary from the clock) for each attempt.
    async fn send(
        &self,
        endpoint: Endpoint<'_>,
        title: &str,
        files: &PostFiles,
        expires_in_days: Option<f64>,
    ) -> Result<Option<Value>, HubFailure> {
        let token = self.token;
        token
            .with_token_retry(|jwt| async move {
                let boundary = post_boundary(token.http().timing().now_ms() as i64);
                let body =
                    analytics_post_body(boundary, title, &files.json, &files.thumbnail, expires_in_days);
                token.http().send(&endpoint, Some(jwt.as_str()), RequestBody::Multipart(body)).await
            })
            .await
    }

    /// `setAnalyzeFilterHubPostId(params.uid, params.entryId, id)`, whose
    /// answer the handlers ignore. `undefined` and `null` clear the link; a
    /// value that is not a string makes the TS's `trim()` throw inside the
    /// store, which then answers `success: false` and writes nothing, and so
    /// is not written here either.
    async fn link(&self, params: &Value, id: Option<&Value>) {
        let post_id = match id {
            None | Some(Value::Null) => None,
            Some(Value::String(text)) => match text.as_str() {
                Some(text) => Some(text.to_owned()),
                // A lone surrogate, which no Rust string holds.
                None => return,
            },
            Some(_) => return,
        };
        let text = |key: &str| prop(params, key).and_then(Value::as_str).unwrap_or_default().to_owned();
        let (store, uid, entry_id) = (self.store.clone(), text("uid"), text("entryId"));
        let _ignored = tokio::task::spawn_blocking(move || {
            set_analyze_filter_hub_post_id(&store, &uid, &entry_id, post_id.as_deref())
        })
        .await;
    }

    /// A public upload or update: `{ success: true, postId }` with the post
    /// linked to the saved filter.
    async fn publish(&self, params: &Value, post_id: Option<&str>) -> Value {
        let posted = async {
            let (title, files) = self.post_input(params).await?;
            let endpoint = match post_id {
                Some(post_id) => Endpoint::UpdateAnalyticsPost { post_id },
                None => Endpoint::UploadAnalyticsPost,
            };
            let result = self.send(endpoint, &title, &files, None).await?;
            read_property(result.as_ref(), "id")
        }
        .await;
        match posted {
            Ok(id) => {
                self.link(params, id.as_ref()).await;
                success(&[("postId", id)])
            }
            Err(err) => failure(err.message),
        }
    }

    /// `HUB_UPLOAD_ANALYTICS_POST`.
    pub async fn upload(&self, params: &Value) -> Value {
        self.publish(params, None).await
    }

    /// `HUB_UPDATE_ANALYTICS_POST`: the post id is checked before anything
    /// else.
    pub async fn update(&self, params: &Value) -> Value {
        match post_id(params) {
            Ok(post_id) => self.publish(params, Some(&post_id)).await,
            Err(err) => failure(err.message),
        }
    }

    /// `HUB_UPLOAD_PRIVATE_ANALYTICS_POST`: `{ success: true, id, url,
    /// expiresAt }`; nothing is linked to the saved filter (the renderer
    /// stores the private link).
    pub async fn upload_private(&self, params: &Value) -> Value {
        let posted = async {
            let (title, files) = self.post_input(params).await?;
            let result = self
                .send(Endpoint::UploadPrivateAnalyticsPost, &title, &files, expires_in_days(params))
                .await?;
            let data = result.as_ref();
            Ok::<_, HubFailure>([
                ("id", read_property(data, "id")?),
                ("url", read_property(data, "url")?),
                ("expiresAt", read_property(data, "expires_at")?),
            ])
        }
        .await;
        match posted {
            Ok(fields) => success(&fields),
            Err(err) => failure(err.message),
        }
    }

    /// `HUB_PREVIEW_ANALYTICS_POST`: `{ success: true, preview }`, a
    /// preparation that fails being a failed validation; only a thrown
    /// error fails the call.
    pub async fn preview(&self, params: &Value) -> Value {
        match self.prepare(params).await {
            Ok(prepared) => success(&[("preview", Some(preview(&prepared)))]),
            Err(PrepareError(message)) => failure(message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Value {
        pipette_js_json::parse(json).unwrap()
    }

    fn message<T: std::fmt::Debug>(result: Result<T, HubFailure>) -> String {
        result.unwrap_err().message
    }

    #[test]
    fn the_file_base_falls_back_to_the_uid() {
        let base = |json: &str| filename_base(&parse(json), "0xA1:B2").unwrap();
        assert_eq!(base(r#"{"keyboard":{"productName":"Corne v4 (日)"}}"#), "Corne_v4____");
        assert_eq!(base(r#"{"keyboard":{"productName":""}}"#), "0xA1_B2");
        assert_eq!(base(r#"{"keyboard":{"productName":0}}"#), "0xA1_B2");
        assert_eq!(base(r#"{"keyboard":{}}"#), "0xA1_B2");
        assert_eq!(base(r#"{"keyboard":5}"#), "0xA1_B2");
        assert_eq!(
            message(filename_base(&parse(r#"{"keyboard":{"productName":7}}"#), "u")),
            "(productName || fallback || \"analytics\").replace is not a function"
        );
    }

    #[test]
    fn the_thumbnail_is_read_as_buffer_from() {
        assert_eq!(thumbnail_bytes(Some(&Value::from("/9j/4A=="))).unwrap(), [0xff, 0xd8, 0xff, 0xe0]);
        assert_eq!(thumbnail_bytes(Some(&parse("[1,300,-1,true,null,1.5]"))).unwrap(), [1, 44, 255, 1, 0, 1]);
        let prefix = "The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an \
                      Array-like Object. Received ";
        for (value, received) in [
            (None, "undefined"),
            (Some(Value::Null), "null"),
            (Some(Value::Number(5.0)), "type number (5)"),
            (Some(Value::Number(-0.0)), "type number (-0)"),
            (Some(Value::Bool(true)), "type boolean (true)"),
            (Some(parse("{}")), "an instance of Object"),
        ] {
            assert_eq!(message(thumbnail_bytes(value.as_ref())), format!("{prefix}{received}"));
        }
    }

    #[test]
    fn the_post_id_is_tested_as_its_string() {
        let id = |json: &str| post_id(&parse(json));
        assert_eq!(id(r#"{"postId":"p-1_x"}"#).unwrap(), "p-1_x");
        assert_eq!(id(r#"{"postId":123}"#).unwrap(), "123");
        assert_eq!(id(r#"{"postId":["ab"]}"#).unwrap(), "ab");
        for bad in [
            r#"{}"#,
            r#"{"postId":""}"#,
            r#"{"postId":0}"#,
            r#"{"postId":"a b"}"#,
            r#"{"postId":[]}"#,
            "null",
        ] {
            assert_eq!(message(id(bad)), "Invalid post ID", "{bad}");
        }
    }

    #[test]
    fn a_title_that_is_not_text_is_empty() {
        assert_eq!(title(&parse(r#"{"title":"  Stats "}"#)).unwrap(), "Stats");
        assert_eq!(message(title(&parse(r#"{"title":5}"#))), "Title must not be empty");
        assert_eq!(message(title(&parse("{}"))), "Title must not be empty");
    }

    #[test]
    fn the_hub_answer_is_read_as_javascript_does() {
        assert_eq!(read_property(Some(&parse(r#"{"id":"p"}"#)), "id").unwrap(), Some(Value::from("p")));
        assert_eq!(read_property(Some(&Value::from("p")), "id").unwrap(), None);
        assert_eq!(message(read_property(None, "id")), "Cannot read properties of undefined (reading 'id')");
        assert_eq!(
            message(read_property(Some(&Value::Null), "url")),
            "Cannot read properties of null (reading 'url')"
        );
        assert_eq!(expires_in_days(&parse(r#"{"expiresInDays":7}"#)), Some(7.0));
        assert_eq!(expires_in_days(&parse(r#"{"expiresInDays":null}"#)), None);
    }

    #[test]
    fn an_answer_leaves_out_what_is_undefined() {
        let answer =
            success(&[("id", Some(Value::from("p"))), ("url", None), ("expiresAt", Some(Value::Null))]);
        assert_eq!(pipette_js_json::stringify(&answer), r#"{"success":true,"id":"p","expiresAt":null}"#);
        assert_eq!(pipette_js_json::stringify(&failure("x".into())), r#"{"success":false,"error":"x"}"#);
    }
}
