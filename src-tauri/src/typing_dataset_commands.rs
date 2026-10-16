// SPDX-License-Identifier: GPL-2.0-or-later
//! The commands of the shim's word list and dataset members
//! (`lang{List,Get,Download,Delete}`, `checkTypingDatasetUpdate`,
//! `updateTypingDataset`; src/tauri-shim/api/typing-datasets.ts), on the
//! language store of crates/pipette-typing-datasets. Its requests go
//! through the app's HTTP client (dev_commands.rs).
//!
//! The arguments are taken as any JSON value: like the handlers, a name
//! that is not a string is not a valid name, and a provider that is not a
//! string is no provider (the default one).

use std::path::Path;

use pipette_js_json::Value as JsValue;
use pipette_net::Http;
use pipette_typing_datasets::LanguageStore;
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, Runtime, State};
use ts_rs::TS;

use crate::command_error::CommandError;

/// What a word list download or delete answers.
#[derive(Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct LanguageActionResult {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    error: Option<String>,
}

impl From<Result<(), String>> for LanguageActionResult {
    fn from(result: Result<(), String>) -> Self {
        Self { success: result.is_ok(), error: result.err() }
    }
}

/// What a dataset check answers.
#[derive(Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TypingDatasetCheckResult {
    provider: String,
    update_available: bool,
}

/// Manages the language store of `user_data` on the app's HTTP client,
/// which must be managed already, and starts the move of the legacy
/// downloads, which the word list commands wait for.
pub fn manage<R: Runtime>(app: &AppHandle<R>, user_data: &Path) {
    let http = app.state::<Http>().inner().clone();
    // Electron reads the Hub URL override in its development runs; this
    // build in its builds with the development tools.
    let store =
        LanguageStore::new(user_data, http, || pipette_net::hub_api_base(cfg!(feature = "dev-tools")));
    app.manage(store.clone());
    tauri::async_runtime::spawn(async move { store.migrated().await });
}

fn text(value: Option<Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => Some(text),
        _ => None,
    }
}

/// The entries with their status as JSON text: the manifest's entries are
/// sent with their fields in the order the dataset has them.
#[tauri::command]
pub async fn lang_list(
    store: State<'_, LanguageStore>,
    provider: Option<Value>,
) -> Result<Response, CommandError> {
    let entries = store.list(text(provider).as_deref()).await?;
    Ok(Response::new(pipette_js_json::stringify(&JsValue::Array(entries))))
}

/// The word list file's JSON text, or `null`.
#[tauri::command]
pub async fn lang_get(
    store: State<'_, LanguageStore>,
    name: Option<Value>,
    provider: Option<Value>,
) -> Result<Response, CommandError> {
    let name = text(name).unwrap_or_default();
    let data = store.get(&name, text(provider).as_deref()).await?;
    Ok(Response::new(data.unwrap_or_else(|| "null".to_owned())))
}

#[tauri::command]
pub async fn lang_download(
    store: State<'_, LanguageStore>,
    name: Option<Value>,
    provider: Option<Value>,
) -> Result<LanguageActionResult, CommandError> {
    let name = text(name).unwrap_or_default();
    Ok(store.download(&name, text(provider).as_deref()).await.into())
}

#[tauri::command]
pub async fn lang_delete(
    store: State<'_, LanguageStore>,
    name: Option<Value>,
    provider: Option<Value>,
) -> Result<LanguageActionResult, CommandError> {
    let name = text(name).unwrap_or_default();
    Ok(store.delete(&name, text(provider).as_deref()).await.into())
}

/// Fails, as the handler rejects, for a provider with neither a bundled
/// dataset nor an override.
#[tauri::command]
pub async fn typing_dataset_check(
    store: State<'_, LanguageStore>,
    provider: Option<Value>,
) -> Result<TypingDatasetCheckResult, CommandError> {
    let check = store.check(text(provider).as_deref()).await?;
    Ok(TypingDatasetCheckResult { provider: check.provider, update_available: check.update_available })
}

/// `{provider, changed, fromVersion, toVersion?}` as JSON text: the
/// versions are the datasets' strings as `JSON.stringify` writes them.
#[tauri::command]
pub async fn typing_dataset_update(
    store: State<'_, LanguageStore>,
    provider: Option<Value>,
) -> Result<Response, CommandError> {
    let update = store.update(text(provider).as_deref()).await?;
    Ok(Response::new(update.to_json()))
}
