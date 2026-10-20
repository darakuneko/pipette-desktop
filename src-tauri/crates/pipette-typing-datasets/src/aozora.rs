// SPDX-License-Identifier: GPL-2.0-or-later
//! The Aozora Bunko import and its handler: one work of the aozora catalog,
//! named by its manifest `name` (the work id, a zip path under the dataset's
//! `downloadUrlBase`), downloaded, unzipped, decoded from Shift_JIS, cleaned
//! and saved as a typing test text with the catalog as its `source`.
//!
//! Only a work the effective catalog lists is fetched: the id is looked up
//! before any URL is built, so the import never fetches a URL of the
//! caller's choosing.

use pipette_js_json::{JsString, Object, Value};
use pipette_keyboard_stores::{StoreContext, TypingTextSave, TypingTextSource, TypingTextStore};
use pipette_typing_text::{AozoraTextError, aozora_text_from_zip};

use crate::dataset::{Dataset, Model, file_size};
use crate::download::{FetchFailure, fetch_verified_bytes, number_text};
use crate::store::{DatasetError, LanguageStore, run_blocking};

const AOZORA_PROVIDER: &str = "aozora";

const NOT_IN_CATALOG: &str = "NOT_IN_CATALOG";

/// Why an import fails instead of answering, as `importAozoraWork` throws
/// (the IPC call rejects with the message).
#[derive(Debug, thiserror::Error)]
pub enum AozoraImportError {
    /// The overrides could not be read, or a blocking task did not finish.
    #[error(transparent)]
    Dataset(#[from] DatasetError),
    /// A gaiji note naming a code point past U+10FFFF, which
    /// `String.fromCodePoint` throws on.
    #[error(transparent)]
    Text(AozoraTextError),
}

/// Where an import stopped: a failure answer (`errorCode`, `error`), or an
/// error it throws.
enum Stop {
    Answer(&'static str, String),
    Throw(AozoraImportError),
}

impl From<AozoraImportError> for Stop {
    fn from(err: AozoraImportError) -> Self {
        Stop::Throw(err)
    }
}

impl From<DatasetError> for Stop {
    fn from(err: DatasetError) -> Self {
        Stop::Throw(err.into())
    }
}

/// The catalog entry of a work as the import uses it.
struct Work {
    url: String,
    /// The manifest's `fileSize`.
    size: f64,
    /// The name the text is saved under.
    name: JsString,
}

/// `{title}（{author}）` for an entry with a non-empty title, else the
/// work id.
fn text_name(entry: &Object, work_id: &str) -> JsString {
    let units = |key| match entry.get(key) {
        Some(Value::String(text)) => text.utf16_units(),
        _ => Vec::new(),
    };
    let title = units("title");
    if title.is_empty() {
        return work_id.into();
    }
    let mut name = title;
    name.extend("（".encode_utf16());
    name.extend(units("author"));
    name.extend("）".encode_utf16());
    JsString::from_utf16(name)
}

/// The catalog entry `work_id` of `dataset`, or the answer for a dataset
/// that is not a catalog or does not list it.
fn find_work(dataset: Dataset<'_>, work_id: &str) -> Result<Work, Stop> {
    if dataset.model != Some(Model::Catalog) {
        let model = match dataset.model {
            Some(Model::Pack) => "pack",
            Some(Model::Catalog) | None => "undefined",
        };
        let error = format!("Aozora dataset is not catalog-shaped (model: {model})");
        return Err(Stop::Answer(NOT_IN_CATALOG, error));
    }
    let entry = dataset
        .entry(work_id)
        .ok_or_else(|| Stop::Answer(NOT_IN_CATALOG, format!("Aozora work not in catalog: {work_id}")))?;
    Ok(Work {
        url: dataset.download_url(work_id, ""),
        size: file_size(entry),
        name: text_name(entry, work_id),
    })
}

fn download_failure(work_id: &str, failure: FetchFailure) -> Stop {
    let detail = match failure {
        FetchFailure::SizeMismatch { expected, actual } => {
            let detail = format!("expected {} bytes, got {actual}", number_text(expected));
            log::warn!("Aozora work {work_id}: size mismatch ({detail})");
            return Stop::Answer("SIZE_MISMATCH", detail);
        }
        FetchFailure::Http(status) => format!("HTTP {status}"),
        FetchFailure::Network(err) => err.to_string(),
    };
    log::warn!("Aozora download failed for {work_id}: {detail}");
    Stop::Answer("DOWNLOAD_FAILED", detail)
}

async fn import(
    languages: &LanguageStore,
    ctx: &StoreContext,
    texts: &TypingTextStore,
    work_id: &str,
) -> Result<Value, Stop> {
    let id = work_id.to_owned();
    let work = languages.read_dataset(AOZORA_PROVIDER, move |dataset| find_work(dataset, &id)).await??;
    let bytes = fetch_verified_bytes(languages.http(), &work.url, work.size)
        .await
        .map_err(|failure| download_failure(work_id, failure))?;
    let text =
        run_blocking(move || aozora_text_from_zip(&bytes)).await?.map_err(|err| match err.error_code() {
            Some(code) => Stop::Answer(code, err.to_string()),
            None => AozoraImportError::Text(err).into(),
        })?;

    let input = TypingTextSave {
        source: Some(TypingTextSource { provider: AOZORA_PROVIDER.into(), work_id: work_id.into() }),
        ..TypingTextSave::new(work.name, JsString::from_utf16(text))
    };
    let (ctx, texts) = (ctx.clone(), texts.clone());
    let meta = run_blocking(move || texts.save(&ctx, &input))
        .await?
        .map_err(|err| Stop::Answer(err.code(), err.to_string()))?;
    let id = meta.id().map(JsString::to_string_lossy).unwrap_or_default();
    log::info!("Imported Aozora work: {work_id} -> {id}");
    Ok(meta.into())
}

/// `AOZORA_IMPORT`: imports the catalog work `work_id` (a non-empty string,
/// else the handler's `Invalid work id`) and answers the handler's
/// `{success: true, meta}` or `{success: false, errorCode, error}` as JSON
/// text.
pub async fn import_aozora_work(
    languages: &LanguageStore,
    ctx: &StoreContext,
    texts: &TypingTextStore,
    work_id: Option<&str>,
) -> Result<String, AozoraImportError> {
    let result = match work_id.filter(|id| !id.is_empty()) {
        Some(work_id) => import(languages, ctx, texts, work_id).await,
        None => Err(Stop::Answer(NOT_IN_CATALOG, "Invalid work id".to_owned())),
    };
    let mut response = Object::new();
    match result {
        Ok(meta) => {
            response.insert("success", true.into());
            response.insert("meta", meta);
        }
        Err(Stop::Answer(code, error)) => {
            response.insert("success", false.into());
            response.insert("errorCode", code.into());
            response.insert("error", error.into());
        }
        Err(Stop::Throw(err)) => return Err(err),
    }
    Ok(pipette_js_json::stringify(&Value::Object(response)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(json: &str) -> Object {
        pipette_js_json::parse(json).unwrap().as_object().unwrap().clone()
    }

    #[test]
    fn a_work_is_named_by_its_title_and_author_or_its_id() {
        let name = |json| text_name(&entry(json), "w/1.zip").to_string_lossy().into_owned();
        assert_eq!(name(r#"{"title":"T","author":"A"}"#), "T（A）");
        assert_eq!(name(r#"{"title":"T"}"#), "T（）");
        assert_eq!(name(r#"{"title":"","author":"A"}"#), "w/1.zip");
        assert_eq!(name(r#"{"author":"A"}"#), "w/1.zip");
        // Lone surrogates stay as they are.
        assert_eq!(text_name(&entry(r#"{"title":"\ud800"}"#), "x").utf16_units(), [0xd800, 0xff08, 0xff09]);
    }
}
