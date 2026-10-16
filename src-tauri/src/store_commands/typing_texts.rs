// SPDX-License-Identifier: GPL-2.0-or-later
//! The typing test text commands of the shim's `typingTestTextStore*`
//! members (src/tauri-shim/api/typing-texts.ts), on the typing test text
//! store of crates/pipette-keyboard-stores (its state managed by
//! store_commands/keyboard_data.rs).
//!
//! Each answers the handler's `{success, data?, errorCode?, error?}` object
//! as JSON text written by `pipette_js_json`, so the entries' fields this
//! build does not know reach the renderer as `JSON.stringify` writes them.
//! The arguments are taken as any JSON value and checked as the handlers of
//! src/main/typing-test-text-ipc.ts check them, answering their `Invalid …`
//! failures. The import dialog has the title and filter of
//! src/main/typing-test-text-store.ts: one file of any name.

use std::convert::Infallible;

use pipette_js_json::{JsString, Value};
use pipette_keyboard_stores::{
    StoreContext, TypingTextError, TypingTextErrorCode, TypingTextStore, typing_text_response,
};
use serde_json::Value as Arg;
use tauri::State;
use tauri::ipc::Response;

use super::blocking;
use crate::command_error::CommandError;
use crate::dialog::{DialogKind, DialogRequest, Dialogs, FileFilter};

/// What a store operation answers besides `success`.
type Answer = Result<Option<Value>, TypingTextError>;

/// Runs `io` on a blocking-task thread and answers its result as the
/// handler's object.
async fn answer<F>(
    stores: &State<'_, StoreContext>,
    texts: &State<'_, TypingTextStore>,
    io: F,
) -> Result<Response, CommandError>
where
    F: FnOnce(&StoreContext, &TypingTextStore) -> Answer + Send + 'static,
{
    let texts = texts.inner().clone();
    let result = blocking(stores, move |stores| Ok::<_, Infallible>(io(stores, &texts))).await?;
    Ok(Response::new(typing_text_response(result)))
}

/// The argument as a string, `None` for any other value or none.
fn string(arg: Option<Arg>) -> Option<JsString> {
    match arg {
        Some(Arg::String(text)) => Some(text.into()),
        _ => None,
    }
}

/// The id argument: a string, or the handler's `Invalid id`.
fn id(arg: Option<Arg>) -> Result<JsString, TypingTextError> {
    string(arg).ok_or_else(|| TypingTextError::invalid_argument(TypingTextErrorCode::NotFound, "Invalid id"))
}

#[tauri::command]
pub async fn typing_test_text_store_list(
    stores: State<'_, StoreContext>,
    texts: State<'_, TypingTextStore>,
) -> Result<Response, CommandError> {
    answer(&stores, &texts, |stores, texts| {
        let list = texts.list(stores, false)?;
        Ok(Some(Value::Array(list.into_iter().map(Value::from).collect())))
    })
    .await
}

#[tauri::command]
pub async fn typing_test_text_store_get(
    stores: State<'_, StoreContext>,
    texts: State<'_, TypingTextStore>,
    id: Option<Arg>,
) -> Result<Response, CommandError> {
    let id = self::id(id);
    answer(&stores, &texts, move |stores, texts| Ok(Some(Value::Object(texts.get(stores, &id?)?)))).await
}

#[tauri::command]
pub async fn typing_test_text_store_rename(
    stores: State<'_, StoreContext>,
    texts: State<'_, TypingTextStore>,
    id: Option<Arg>,
    new_name: Option<Arg>,
) -> Result<Response, CommandError> {
    let (id, name) = (self::id(id), string(new_name));
    answer(&stores, &texts, move |stores, texts| {
        let id = id?;
        let name = name.ok_or_else(|| {
            TypingTextError::invalid_argument(TypingTextErrorCode::InvalidName, "Invalid name")
        })?;
        Ok(Some(texts.rename(stores, &id, &name)?.into()))
    })
    .await
}

#[tauri::command]
pub async fn typing_test_text_store_delete(
    stores: State<'_, StoreContext>,
    texts: State<'_, TypingTextStore>,
    id: Option<Arg>,
) -> Result<Response, CommandError> {
    let id = self::id(id);
    answer(&stores, &texts, move |stores, texts| texts.delete(stores, &id?).map(|()| None)).await
}

/// Asks for a text file and imports it. The dialog waits for the user on
/// the blocking-task thread, outside the store's lock.
#[tauri::command]
pub async fn typing_test_text_store_import(
    stores: State<'_, StoreContext>,
    texts: State<'_, TypingTextStore>,
    dialogs: State<'_, Dialogs>,
) -> Result<Response, CommandError> {
    let dialogs = dialogs.inner().clone();
    answer(&stores, &texts, move |stores, texts| {
        let path = dialogs
            .show(DialogRequest {
                kind: DialogKind::OpenFile,
                title: "Import UTF-8 Text".to_owned(),
                // Any file: the content is checked as UTF-8, not the name.
                filters: vec![FileFilter::new("UTF-8 text", &["*"])],
            })
            .ok_or_else(TypingTextError::cancelled)?;
        Ok(Some(texts.import_file(stores, &path)?.into()))
    })
    .await
}

/// Saves the import held for confirmation over the text it collided with.
#[tauri::command]
pub async fn typing_test_text_store_import_confirm(
    stores: State<'_, StoreContext>,
    texts: State<'_, TypingTextStore>,
) -> Result<Response, CommandError> {
    answer(&stores, &texts, |stores, texts| Ok(Some(texts.confirm_import(stores)?.into()))).await
}

#[cfg(test)]
mod tests;
