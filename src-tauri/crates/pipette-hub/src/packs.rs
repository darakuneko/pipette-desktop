// SPDX-License-Identifier: GPL-2.0-or-later
//! The language and theme pack handlers of `src/main/hub/hub-ipc-packs.ts`,
//! with the requests of `hub-i18n.ts` and `hub-theme.ts`: the list (its
//! fields from snake_case to camelCase), the download (a language pack
//! checked by [`validate_i18n_export`], a theme pack by
//! `validate_theme_pack`), the upload, update and delete with the local
//! pack's Hub link, and the freshness timestamps.
//!
//! The handlers take their arguments as the renderer sent them, as
//! JavaScript values, and answer the TS's `{ success, … }` objects with the
//! Hub's values in the order the Hub sent them. Where the TS reads a
//! property of a value that is not there, the answer carries the
//! `TypeError` message V8 gives.
//!
//! After an upload, the uploader and the Hub time come from the list of
//! the pack's name; after an update, the Hub time comes from the
//! timestamps; either lookup failing leaves the cached values alone. The
//! Hub requests run without the store's write lock, which the link takes
//! for its own write.

use std::collections::{HashMap, HashSet};

use futures_util::future::try_join_all;
use pipette_js_json::{JsString, Object, Value, js_string, stringify};
use pipette_keyboard_stores::StoreContext;
use pipette_pack_stores::i18n_validate::validate_pack;
use pipette_pack_stores::theme_validate::validate_theme_pack;
use pipette_pack_stores::{Cached, i18n, theme};

use crate::endpoint::{Endpoint, ListQuery};
use crate::http::{HubError, HubHttp, RequestBody};
use crate::multipart::{UploadFile, i18n_boundary, pack_body, theme_boundary};
use crate::sources::BoxFuture;
use crate::token::HubToken;
use crate::validate::is_valid_post_id;

/// `HUB_I18N_PACK_TIMESTAMPS_BATCH_LIMIT` and
/// `HUB_THEME_PACK_TIMESTAMPS_BATCH_LIMIT`: the most ids one timestamps
/// request may carry (the Hub answers more with a 400).
pub const TIMESTAMPS_BATCH_LIMIT: usize = 100;

/// What `Buffer.from(JSON.stringify(undefined))` throws for a theme pack
/// upload without a pack.
const NO_THEME_PACK: &str = "The first argument must be of type string or an instance of Buffer, \
                             ArrayBuffer, or Array or an Array-like Object. Received undefined";

/// Which pack store and Hub endpoints a handler works on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackKind {
    I18n,
    Theme,
}

impl PackKind {
    fn list(self, query: ListQuery<'_>) -> Endpoint<'_> {
        match self {
            PackKind::I18n => Endpoint::I18nList(query),
            PackKind::Theme => Endpoint::ThemeList(query),
        }
    }

    fn timestamps(self) -> Endpoint<'static> {
        match self {
            PackKind::I18n => Endpoint::I18nTimestamps,
            PackKind::Theme => Endpoint::ThemeTimestamps,
        }
    }

    fn download(self, post_id: &str) -> Endpoint<'_> {
        match self {
            PackKind::I18n => Endpoint::I18nDownload { post_id },
            PackKind::Theme => Endpoint::ThemeDownload { post_id },
        }
    }

    fn submit(self, post_id: Option<&str>) -> Endpoint<'_> {
        match (self, post_id) {
            (PackKind::I18n, None) => Endpoint::I18nUpload,
            (PackKind::I18n, Some(post_id)) => Endpoint::I18nUpdate { post_id },
            (PackKind::Theme, None) => Endpoint::ThemeUpload,
            (PackKind::Theme, Some(post_id)) => Endpoint::ThemeUpdate { post_id },
        }
    }

    fn delete(self, post_id: &str) -> Endpoint<'_> {
        match self {
            PackKind::I18n => Endpoint::I18nDelete { post_id },
            PackKind::Theme => Endpoint::ThemeDelete { post_id },
        }
    }

    fn boundary(self, now_ms: i64) -> String {
        match self {
            PackKind::I18n => i18n_boundary(now_ms),
            PackKind::Theme => theme_boundary(now_ms),
        }
    }
}

/// A change of a local pack's Hub link (`setHubPostId`): the pack `id` of
/// `kind` linked to `post` (unlinked for `None`), with its cached uploader
/// and Hub time.
#[derive(Clone, Debug, PartialEq)]
pub struct LinkChange {
    pub kind: PackKind,
    pub id: JsString,
    pub post: Option<JsString>,
    pub uploader: Cached,
    pub updated: Cached,
}

impl LinkChange {
    /// Writes the change through the pack store. A failure is left
    /// unreported, as the TS ignores the store's answer.
    pub fn apply(self, stores: &StoreContext) {
        let Self { kind, id, post, uploader, updated } = self;
        let _ = match kind {
            PackKind::I18n => i18n::set_hub_post_id(stores, &id, post.as_ref(), uploader, updated),
            PackKind::Theme => theme::set_hub_post_id(stores, &id, post.as_ref(), uploader, updated),
        };
    }
}

/// Where the handlers write a local pack's Hub link. The app writes it off
/// the async runtime, as every store write; a [`StoreContext`] writes it
/// in place, for the tests.
pub trait PackLinks: Send + Sync {
    /// Resolves once the change is written (or has failed).
    fn link(&self, change: LinkChange) -> BoxFuture<'_, ()>;
}

impl PackLinks for StoreContext {
    fn link(&self, change: LinkChange) -> BoxFuture<'_, ()> {
        change.apply(self);
        Box::pin(std::future::ready(()))
    }
}

/// `{ success: false, error }`.
fn failure(error: impl Into<JsString>) -> Value {
    let mut answer = Object::new();
    answer.insert("success", Value::Bool(false));
    answer.insert("error", Value::String(error.into()));
    Value::Object(answer)
}

/// `{ success: true }`.
fn succeeded() -> Value {
    let mut answer = Object::new();
    answer.insert("success", Value::Bool(true));
    Value::Object(answer)
}

/// `{ success: true, <key>: value }`, without the key for `undefined`.
fn success(key: &str, value: Option<Value>) -> Value {
    let mut answer = succeeded();
    if let (Value::Object(object), Some(value)) = (&mut answer, value) {
        object.insert(key, value);
    }
    answer
}

fn answer(result: Result<Value, JsString>) -> Value {
    result.unwrap_or_else(failure)
}

/// `value.<key>` (`None` for `undefined`), or the `TypeError` of reading it
/// off `undefined` or `null`.
fn property<'a>(value: Option<&'a Value>, key: &str) -> Result<Option<&'a Value>, JsString> {
    match value {
        None => Err(format!("Cannot read properties of undefined (reading '{key}')").into()),
        Some(Value::Null) => Err(format!("Cannot read properties of null (reading '{key}')").into()),
        Some(Value::Object(object)) => Ok(object.get(key)),
        // A primitive or an array has none of the properties read here.
        Some(_) => Ok(None),
    }
}

/// `a === b` for JSON values (`None` is `undefined`); two objects or arrays
/// are never the same here.
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

/// `value ?? null`.
fn or_null(value: Option<&Value>) -> Value {
    value.cloned().unwrap_or(Value::Null)
}

/// A property of the handler's `params`, which may be an array.
fn param<'a>(params: &'a Value, key: &str) -> Option<&'a Value> {
    params.as_object().and_then(|object| object.get(key))
}

/// `!params || typeof params !== 'object'`.
fn is_params(params: Option<&Value>) -> bool {
    matches!(params, Some(Value::Object(_) | Value::Array(_)))
}

/// The text of a post id that passes `validatePostId`, which coerces any
/// value that is not falsy to a string.
fn valid_post_id(post_id: Option<&Value>) -> Option<String> {
    let post_id = post_id.filter(|value| value.is_truthy())?;
    let text = js_string(Some(post_id));
    // A lone surrogate becomes U+FFFD, which fails the pattern as it would.
    is_valid_post_id(&text).then_some(text)
}

/// The post id of a handler that first checks `typeof postId === 'string'`.
fn string_post_id(post_id: Option<&Value>) -> Option<&str> {
    match post_id {
        Some(Value::String(id)) => id.as_str().filter(|id| is_valid_post_id(id)),
        _ => None,
    }
}

/// `new Date(ms).toISOString()` for a time from year 0 to 9999.
fn iso_string(ms: f64) -> String {
    let ms = ms as i64;
    let (days, ms_of_day) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    let (hour, minute) = (ms_of_day / 3_600_000, ms_of_day / 60_000 % 60);
    let (second, milli) = (ms_of_day / 1000 % 60, ms_of_day % 1000);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milli:03}Z")
}

/// The `i18n-export-v1.json` file of a language pack upload:
/// `JSON.stringify({ version: 1, kind: 'i18n', exportedAt, pack })`, with
/// `exportedAt` the ISO string of `now_ms` (`buildI18nExport`). The pack is
/// left out where it is `undefined`.
pub fn i18n_export_file(pack: Option<&Value>, now_ms: f64) -> UploadFile {
    let mut export = Object::new();
    export.insert("version", Value::Number(1.0));
    export.insert("kind", Value::from("i18n"));
    export.insert("exportedAt", Value::from(iso_string(now_ms)));
    if let Some(pack) = pack {
        export.insert("pack", pack.clone());
    }
    UploadFile {
        name: "i18n-export-v1.json".to_owned(),
        data: stringify(&Value::Object(export)).into_bytes(),
    }
}

/// The `theme-pack.json` file of a theme pack upload: `JSON.stringify(pack)`.
pub fn theme_pack_file(pack: &Value) -> UploadFile {
    UploadFile { name: "theme-pack.json".to_owned(), data: stringify(pack).into_bytes() }
}

/// What `validateI18nExport` found: `reason` is the first problem.
#[derive(Clone, Debug, PartialEq)]
pub struct I18nExportCheck {
    pub reason: Option<JsString>,
    pub warnings: Vec<JsString>,
}

impl I18nExportCheck {
    pub fn ok(&self) -> bool {
        self.reason.is_none()
    }

    fn failed(reason: impl Into<JsString>) -> Self {
        Self { reason: Some(reason.into()), warnings: Vec::new() }
    }
}

/// `validateI18nExport`: the `{ version: 1, kind: 'i18n', exportedAt, pack }`
/// envelope of a downloaded language pack, and the pack in it
/// (`validatePack`). `None` is `undefined`.
pub fn validate_i18n_export(export: Option<&Value>) -> I18nExportCheck {
    let export = match export {
        Some(value @ (Value::Object(_) | Value::Array(_))) => value,
        _ => return I18nExportCheck::failed("export must be an object"),
    };
    let version = param(export, "version");
    if version != Some(&Value::Number(1.0)) {
        return I18nExportCheck::failed(format!("unsupported version: {}", js_string(version)));
    }
    let kind = param(export, "kind");
    if !matches!(kind, Some(Value::String(kind)) if *kind == *"i18n") {
        return I18nExportCheck::failed(format!("unexpected kind: {}", js_string(kind)));
    }
    if !matches!(param(export, "exportedAt"), Some(Value::String(_))) {
        return I18nExportCheck::failed("exportedAt must be an ISO 8601 string");
    }
    let check = validate_pack(param(export, "pack"));
    let reason = (!check.ok())
        .then(|| check.errors.first().cloned().unwrap_or_else(|| JsString::from("invalid pack body")));
    I18nExportCheck { reason, warnings: check.warnings }
}

/// `prefix` followed by `text`, keeping a lone surrogate of `text`.
fn prefixed(prefix: &str, text: &JsString) -> JsString {
    let mut units: Vec<u16> = prefix.encode_utf16().collect();
    units.extend(text.utf16_units());
    JsString::from_utf16(units)
}

/// The list's answer (`fetchI18nPostList` / `fetchThemePostList`): each
/// item's fields renamed to camelCase, the uploader's id and name `null`
/// where the Hub sent none.
fn list_answer(raw: Option<Value>) -> Result<Value, JsString> {
    let items = match property(raw.as_ref(), "items")? {
        Some(Value::Array(items)) => items,
        None => return Err("Cannot read properties of undefined (reading 'map')".into()),
        Some(Value::Null) => return Err("Cannot read properties of null (reading 'map')".into()),
        Some(_) => return Err("raw.items.map is not a function".into()),
    };
    let mut mapped = Vec::with_capacity(items.len());
    for item in items {
        let field = |key: &str| property(Some(item), key);
        let mut out = Object::new();
        for (to, from) in [("id", "id"), ("name", "name"), ("version", "version")] {
            if let Some(value) = field(from)? {
                out.insert(to, value.clone());
            }
        }
        out.insert("uploadedBy", or_null(field("uploaded_by")?));
        out.insert("uploaderName", or_null(field("uploader_name")?));
        for (to, from) in [("createdAt", "created_at"), ("updatedAt", "updated_at")] {
            if let Some(value) = field(from)? {
                out.insert(to, value.clone());
            }
        }
        mapped.push(Value::Object(out));
    }
    let mut list = Object::new();
    list.insert("items", Value::Array(mapped));
    for (to, from) in [("total", "total"), ("page", "page"), ("perPage", "per_page")] {
        if let Some(value) = property(raw.as_ref(), from)? {
            list.insert(to, value.clone());
        }
    }
    Ok(Value::Object(list))
}

/// The list of `query` (`fetchI18nPostList` / `fetchThemePostList`).
async fn fetch_list(http: &HubHttp, kind: PackKind, query: ListQuery<'_>) -> Result<Value, JsString> {
    let raw = http.send(&kind.list(query), None, RequestBody::None).await.map_err(|err| err.to_string())?;
    list_answer(raw)
}

/// `HUB_LIST_I18N_POSTS` / `HUB_LIST_THEME_POSTS`: `q` and `name` when they
/// are strings, `page` and `perPage` when they are numbers.
pub async fn list(http: &HubHttp, kind: PackKind, params: Option<&Value>) -> Value {
    let params = params.filter(|params| is_params(Some(params)));
    let text = |key: &str| match params.and_then(|params| param(params, key)) {
        Some(Value::String(text)) => Some(text.to_string_lossy().into_owned()),
        _ => None,
    };
    let number = |key: &str| match params.and_then(|params| param(params, key)) {
        Some(Value::Number(n)) => Some(*n),
        _ => None,
    };
    let (q, name) = (text("q"), text("name"));
    let query = ListQuery {
        q: q.as_deref(),
        name: name.as_deref(),
        page: number("page"),
        per_page: number("perPage"),
    };
    answer(fetch_list(http, kind, query).await.map(|data| success("data", Some(data))))
}

/// `HUB_DOWNLOAD_I18N_POST` / `HUB_DOWNLOAD_THEME_POST`: the pack, once it
/// passes its check.
pub async fn download(http: &HubHttp, kind: PackKind, post_id: Option<&Value>) -> Value {
    let Some(post_id) = string_post_id(post_id) else { return failure("Invalid post ID") };
    let body = match http.send(&kind.download(post_id), None, RequestBody::None).await {
        Ok(body) => body,
        Err(err) => return failure(err.to_string()),
    };
    let reason = match kind {
        PackKind::I18n => validate_i18n_export(body.as_ref())
            .reason
            .map(|reason| prefixed("Hub returned an invalid pack: ", &reason)),
        PackKind::Theme => {
            let check = validate_theme_pack(body.as_ref());
            (!check.ok()).then(|| {
                let first = check.errors.first().cloned().unwrap_or_else(|| JsString::from("unknown reason"));
                prefixed("Hub returned an invalid theme pack: ", &first)
            })
        }
    };
    match reason {
        Some(reason) => failure(reason),
        None => success("data", body),
    }
}

/// Why a timestamps lookup failed.
pub(crate) enum TimestampsError {
    /// A request failed.
    Request(HubError),
    /// An answer is not shaped as read: the message of the `TypeError`.
    Read(JsString),
}

/// The timestamps items of the distinct `ids`, by their `id`. The batches of
/// [`TIMESTAMPS_BATCH_LIMIT`] go out at once (`Promise.all`: the first
/// request to fail ends the lookup, before any answer is read).
pub(crate) async fn fetch_timestamp_items(
    http: &HubHttp,
    endpoint: &Endpoint<'_>,
    ids: &[&JsString],
) -> Result<HashMap<JsString, Value>, TimestampsError> {
    let requests = ids.chunks(TIMESTAMPS_BATCH_LIMIT).map(|chunk| {
        let ids = chunk.iter().map(|id| Value::String((*id).clone())).collect();
        let body: Object = [("ids", Value::Array(ids))].into_iter().collect();
        http.send(endpoint, None, RequestBody::Json(stringify(&Value::Object(body))))
    });
    let responses = try_join_all(requests).await.map_err(TimestampsError::Request)?;
    let mut by_id: HashMap<JsString, Value> = HashMap::new();
    for response in &responses {
        let listed = match property(response.as_ref(), "items").map_err(TimestampsError::Read)? {
            Some(Value::Array(listed)) => listed,
            // A string's characters have no `id`.
            Some(Value::String(_)) => continue,
            _ => return Err(TimestampsError::Read("r.items is not iterable".into())),
        };
        for item in listed {
            if let Some(Value::String(id)) = property(Some(item), "id").map_err(TimestampsError::Read)? {
                by_id.insert(id.clone(), item.clone());
            }
        }
    }
    Ok(by_id)
}

/// `HUB_I18N_PACK_TIMESTAMPS` / `HUB_THEME_PACK_TIMESTAMPS`: the distinct
/// ids asked for in batches of [`TIMESTAMPS_BATCH_LIMIT`], sent at once;
/// the Hub's items come back in the order of the ids, without the ids it
/// did not answer.
pub async fn timestamps(http: &HubHttp, kind: PackKind, ids: Option<&Value>) -> Value {
    let Some(Value::Array(items)) = ids else { return failure("ids must be an array of strings") };
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for item in items {
        let Value::String(id) = item else { return failure("ids must be an array of strings") };
        if seen.insert(id) {
            unique.push(id);
        }
    }
    let by_id = match fetch_timestamp_items(http, &kind.timestamps(), &unique).await {
        Ok(by_id) => by_id,
        Err(TimestampsError::Request(err)) => return failure(err.to_string()),
        Err(TimestampsError::Read(message)) => return failure(message),
    };
    let found = unique.iter().filter_map(|id| by_id.get(*id).cloned()).collect();
    let data: Object = [("items", Value::Array(found))].into_iter().collect();
    success("data", Some(Value::Object(data)))
}

/// What a lookup after an upload or update found: `None` for `undefined`.
#[derive(Default)]
struct Enriched {
    uploader_name: Option<Value>,
    hub_updated_at: Option<Value>,
}

/// `enrichHubPackMeta`: the uploader and the Hub time of `post_id`, from the
/// list of the pack's name (the whole list when the name is empty or not
/// there). Any failure finds nothing.
async fn enrich_from_list(
    http: &HubHttp,
    kind: PackKind,
    name: Option<&Value>,
    post_id: Option<&Value>,
) -> Enriched {
    let name = match name.filter(|name| name.is_truthy()) {
        None => None,
        Some(Value::String(name)) => Some(name.to_string_lossy().into_owned()),
        // `name.trim` is not a function.
        Some(_) => return Enriched::default(),
    };
    let query = ListQuery { name: name.as_deref(), ..ListQuery::default() };
    let Ok(list) = fetch_list(http, kind, query).await else { return Enriched::default() };
    let item = match param(&list, "items") {
        Some(Value::Array(items)) => items.iter().find(|item| strictly_equal(param(item, "id"), post_id)),
        _ => None,
    };
    // `?? undefined`: a null uploader or time leaves the cached one alone.
    let defined =
        |key: &str| item.and_then(|item| param(item, key)).filter(|value| **value != Value::Null).cloned();
    Enriched { uploader_name: defined("uploaderName"), hub_updated_at: defined("updatedAt") }
}

/// `enrichHubUpdatedAt`: the Hub time of `post_id` from the timestamps. Any
/// failure finds nothing.
async fn enrich_from_timestamps(http: &HubHttp, kind: PackKind, post_id: Option<&Value>) -> Enriched {
    // `JSON.stringify({ ids: [postId] })` writes `undefined` as `null`.
    let body: Object = [("ids", Value::Array(vec![or_null(post_id)]))].into_iter().collect();
    let Ok(response) =
        http.send(&kind.timestamps(), None, RequestBody::Json(stringify(&Value::Object(body)))).await
    else {
        return Enriched::default();
    };
    let Ok(Some(Value::Array(items))) = property(response.as_ref(), "items") else {
        return Enriched::default();
    };
    let mut found = None;
    for item in items {
        match property(Some(item), "id") {
            Ok(id) if strictly_equal(id, post_id) => {
                found = Some(item);
                break;
            }
            Ok(_) => {}
            Err(_) => return Enriched::default(),
        }
    }
    Enriched {
        uploader_name: None,
        hub_updated_at: found.and_then(|item| param(item, "updated_at")).cloned(),
    }
}

/// How `setHubPostId` takes an optional cached field: `undefined` leaves it
/// alone, `null` or a string sets it; `None` for any other value, on which
/// the store fails before writing.
fn cached(value: Option<&Value>) -> Option<Cached> {
    match value {
        None => Some(Cached::Keep),
        Some(Value::Null) => Some(Cached::Set(None)),
        Some(Value::String(text)) => Some(Cached::Set(Some(text.clone()))),
        Some(_) => None,
    }
}

/// `setHubPostId(entryId, postId, uploaderName, hubUpdatedAt)` with the
/// values the handler has: a local pack id that is not a string matches no
/// pack, and a post id that is neither a string nor nullish fails the
/// store's `trim`.
async fn link_pack(
    links: &dyn PackLinks,
    kind: PackKind,
    entry_id: Option<&Value>,
    post_id: Option<&Value>,
    enriched: &Enriched,
) {
    let Some(Value::String(entry_id)) = entry_id else { return };
    let post = match post_id {
        None | Some(Value::Null) => None,
        Some(Value::String(post)) => Some(post),
        Some(_) => return,
    };
    let (Some(uploader), Some(updated)) =
        (cached(enriched.uploader_name.as_ref()), cached(enriched.hub_updated_at.as_ref()))
    else {
        return;
    };
    let change = LinkChange { kind, id: entry_id.clone(), post: post.cloned(), uploader, updated };
    links.link(change).await;
}

/// Uploads (no `post_id`) or updates the pack with the JWT, as
/// `submitI18nPack` / `submitThemePack` do; the post the Hub answered.
async fn submit(
    token: &HubToken,
    kind: PackKind,
    post_id: Option<&str>,
    pack: Option<&Value>,
) -> Result<Option<Value>, JsString> {
    let http = token.http();
    let theme_pack = match (kind, pack) {
        // The file is built after the token, and building it throws.
        (PackKind::Theme, None) => {
            let failed = token.get().await.err();
            return Err(failed.map_or_else(|| NO_THEME_PACK.into(), |err| err.message.into()));
        }
        (PackKind::Theme, Some(pack)) => Some(pack),
        (PackKind::I18n, _) => None,
    };
    let endpoint = kind.submit(post_id);
    token
        .with_token_retry(|jwt| async move {
            let now = http.timing().now_ms();
            let file = match theme_pack {
                Some(pack) => theme_pack_file(pack),
                None => i18n_export_file(pack, now),
            };
            let body = pack_body(kind.boundary(now as i64), &file);
            http.send(&endpoint, Some(jwt.as_str()), RequestBody::Multipart(body)).await
        })
        .await
        .map_err(|err| err.message.into())
}

/// `HUB_UPLOAD_I18N_POST` / `HUB_UPLOAD_THEME_POST`: uploads `params.pack`,
/// then links the local pack `params.entryId` to the new post with the
/// uploader and Hub time the list of the pack's name gives.
pub async fn upload(
    token: &HubToken,
    links: &dyn PackLinks,
    kind: PackKind,
    params: Option<&Value>,
) -> Value {
    let Some(params) = params.filter(|params| is_params(Some(params))) else {
        return failure("Invalid params");
    };
    let pack = param(params, "pack");
    answer(
        async {
            let result = submit(token, kind, None, pack).await?;
            let name = property(pack, "name")?;
            let post_id = property(result.as_ref(), "id")?;
            let enriched = enrich_from_list(token.http(), kind, name, post_id).await;
            link_pack(links, kind, param(params, "entryId"), post_id, &enriched).await;
            Ok(success("postId", post_id.cloned()))
        }
        .await,
    )
}

/// `HUB_UPDATE_I18N_POST` / `HUB_UPDATE_THEME_POST`: replaces the post
/// `params.postId` with `params.pack`, then refreshes the local pack's Hub
/// time from the timestamps (its uploader stays).
pub async fn update(
    token: &HubToken,
    links: &dyn PackLinks,
    kind: PackKind,
    params: Option<&Value>,
) -> Value {
    let Some(params) = params.filter(|params| is_params(Some(params))) else {
        return failure("Invalid params");
    };
    let Some(post_id) = valid_post_id(param(params, "postId")) else { return failure("Invalid post ID") };
    answer(
        async {
            let result = submit(token, kind, Some(&post_id), param(params, "pack")).await?;
            let posted = property(result.as_ref(), "id")?;
            let enriched = enrich_from_timestamps(token.http(), kind, posted).await;
            link_pack(links, kind, param(params, "entryId"), posted, &enriched).await;
            Ok(success("postId", posted.cloned()))
        }
        .await,
    )
}

/// `HUB_DELETE_I18N_POST` / `HUB_DELETE_THEME_POST`: deletes the post, then
/// unlinks the local pack `local_pack_id` when it is a non-empty string.
pub async fn delete(
    token: &HubToken,
    links: &dyn PackLinks,
    kind: PackKind,
    post_id: Option<&Value>,
    local_pack_id: Option<&Value>,
) -> Value {
    let Some(post_id) = string_post_id(post_id) else { return failure("Invalid post ID") };
    let endpoint = kind.delete(post_id);
    let deleted = token
        .with_token_retry(|jwt| async move {
            token.http().send(&endpoint, Some(jwt.as_str()), RequestBody::None).await
        })
        .await;
    if let Err(err) = deleted {
        return failure(err.message);
    }
    if let Some(Value::String(local)) = local_pack_id.filter(|id| id.is_truthy()) {
        let change =
            LinkChange { kind, id: local.clone(), post: None, uploader: Cached::Keep, updated: Cached::Keep };
        links.link(change).await;
    }
    succeeded()
}

#[cfg(test)]
mod tests;
