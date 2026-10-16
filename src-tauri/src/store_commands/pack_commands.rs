// SPDX-License-Identifier: GPL-2.0-or-later
//! What the language and theme pack commands (i18n_packs.rs,
//! theme_packs.rs) share: reading their arguments as JavaScript values, and
//! answering the handlers' `{success, data | errorCode, error}` objects as
//! JSON text written by `pipette_js_json`, so the metas' fields this build
//! does not know reach the renderer as `JSON.stringify` writes them.

use std::convert::Infallible;
use std::path::PathBuf;

use pipette_js_json::Value;
use pipette_keyboard_stores::StoreContext;
use pipette_pack_stores::handlers::Answer;
use pipette_pack_stores::response_json;
use tauri::State;
use tauri::ipc::Response;

use super::blocking;
use super::pack_import::json_filters;
use crate::command_error::CommandError;
use crate::dialog::{DialogKind, DialogRequest, Dialogs};

/// An argument as the handler gets it: `None` for `undefined`.
pub(crate) type Arg = Option<serde_json::Value>;

/// `arg` as a JavaScript value.
pub(crate) fn js(arg: Arg) -> Result<Option<Value>, CommandError> {
    arg.map(|value| Ok(pipette_js_json::parse(&serde_json::to_string(&value)?)?)).transpose()
}

/// The value of the JSON text `text`, as `JSON.parse` reads it.
pub(crate) fn js_text(text: Option<String>) -> Result<Option<Value>, CommandError> {
    Ok(text.as_deref().map(pipette_js_json::parse).transpose()?)
}

/// Runs `io` on a blocking-task thread and answers its result.
pub(crate) async fn answer(
    stores: &State<'_, StoreContext>,
    io: impl FnOnce(&StoreContext) -> Answer + Send + 'static,
) -> Result<Response, CommandError> {
    let answer = blocking(stores, move |stores| Ok::<_, Infallible>(io(stores))).await?;
    Ok(Response::new(response_json(answer)))
}

/// Runs an export handler on a blocking-task thread, its save dialog titled
/// `title` (JSON files, or all files), and answers its result; an error
/// the handler throws rejects the call.
pub(crate) async fn export_through_dialog(
    stores: &State<'_, StoreContext>,
    dialogs: &State<'_, Dialogs>,
    title: &'static str,
    export: impl FnOnce(&StoreContext, &mut dyn FnMut(&str) -> Option<PathBuf>) -> Result<Answer, String>
    + Send
    + 'static,
) -> Result<Response, CommandError> {
    let (stores, dialogs) = (stores.inner().clone(), dialogs.inner().clone());
    let exported = tauri::async_runtime::spawn_blocking(move || {
        export(&stores, &mut |default_name| {
            dialogs.show(DialogRequest {
                kind: DialogKind::SaveFile { default_name: default_name.to_owned() },
                title: title.to_owned(),
                filters: json_filters(),
            })
        })
    })
    .await?;
    match exported {
        Ok(answer) => Ok(Response::new(response_json(answer))),
        Err(thrown) => Err(Thrown(thrown).into()),
    }
}

/// An error the handler throws.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
struct Thrown(String);

#[cfg(test)]
pub(crate) mod test_app;
