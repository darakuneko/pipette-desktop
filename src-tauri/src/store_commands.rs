// SPDX-License-Identifier: GPL-2.0-or-later
//! The commands of the stores under the userData directory, one module per
//! store.

use std::fmt::Display;

use pipette_js_json::Object;
use pipette_keyboard_stores::{StoreContext, response_json};
use tauri::State;
use tauri::ipc::Response;

use crate::command_error::CommandError;

pub mod favorites;
pub mod keyboard_data;
pub mod snapshots;
pub mod sync_pending;

/// Runs `io` on a blocking-task thread (a store waits for its write lock
/// and syncs its writes to disk) and answers its result as the handler's
/// `{success, …}` object (`response_json`). A failure of the store is such
/// an answer too; the command fails only when its task cannot run.
pub(crate) async fn answer<E, F>(stores: &State<'_, StoreContext>, io: F) -> Result<Response, CommandError>
where
    E: Display + Send + 'static,
    F: FnOnce(&StoreContext) -> Result<Object, E> + Send + 'static,
{
    let stores = stores.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || io(&stores)).await?;
    Ok(Response::new(response_json(result)))
}
