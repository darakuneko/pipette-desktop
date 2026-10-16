// SPDX-License-Identifier: GPL-2.0-or-later
//! The commands of the stores under the userData directory, one module per
//! store.

use std::convert::Infallible;
use std::fmt::Display;

use pipette_js_json::Object;
use pipette_keyboard_stores::{StoreContext, response_json};
use tauri::State;
use tauri::ipc::Response;

use crate::command_error::CommandError;

pub mod favorites;
pub mod i18n_packs;
pub mod key_labels;
pub mod keyboard_data;
mod pack_commands;
mod pack_import;
pub mod settings;
pub mod snapshots;
pub mod sync_pending;

/// Runs `io` on a blocking-task thread (a store waits for its write lock
/// and syncs its writes to disk) and answers what it returns.
pub(crate) async fn blocking<T, E, F>(stores: &State<'_, StoreContext>, io: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    E: std::error::Error + Send + 'static,
    F: FnOnce(&StoreContext) -> Result<T, E> + Send + 'static,
{
    let stores = stores.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || io(&stores)).await??)
}

/// Runs `io` as [`blocking`] does and answers its result as the handler's
/// `{success, …}` object (`response_json`). A failure of the store is such
/// an answer too; the command fails only when its task cannot run.
pub(crate) async fn answer<E, F>(stores: &State<'_, StoreContext>, io: F) -> Result<Response, CommandError>
where
    E: Display + Send + 'static,
    F: FnOnce(&StoreContext) -> Result<Object, E> + Send + 'static,
{
    let result = blocking(stores, move |stores| Ok::<_, Infallible>(io(stores))).await?;
    Ok(Response::new(response_json(result)))
}
