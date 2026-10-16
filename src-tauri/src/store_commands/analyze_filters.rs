// SPDX-License-Identifier: GPL-2.0-or-later
//! The Analyze filter commands of the shim's `analyzeFilterStore*` members
//! (src/tauri-shim/api/analyze-filters.ts), on the Analyze filter store of
//! crates/pipette-keyboard-stores (managed by store_commands/keyboard_data.rs).
//! The two Hub members only record a link on an entry.
//!
//! Each answers the handler's `{success, …}` object as JSON text written by
//! `pipette_js_json`, so the entries' fields this build does not know reach
//! the renderer as `JSON.stringify` writes them. A failure of the store is
//! such an answer too; a command fails only when its task cannot run.

use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::{AnalyzeFilterError, StoreContext, done, field};
use tauri::State;
use tauri::ipc::Response;

use super::answer;
use crate::command_error::CommandError;

/// What a store operation answers besides `success`.
type Answer = Result<Object, AnalyzeFilterError>;

#[tauri::command]
pub async fn analyze_filter_store_list(
    stores: State<'_, StoreContext>,
    uid: String,
) -> Result<Response, CommandError> {
    answer(&stores, move |stores| -> Answer {
        let entries = pipette_keyboard_stores::list_analyze_filters(stores, &uid)?;
        Ok(field("entries", Value::Array(entries.into_iter().map(Value::from).collect())))
    })
    .await
}

/// `summary` null, missing or empty stores no `summary`.
#[tauri::command]
pub async fn analyze_filter_store_save(
    stores: State<'_, StoreContext>,
    uid: String,
    json: String,
    label: String,
    summary: Option<String>,
) -> Result<Response, CommandError> {
    answer(&stores, move |stores| -> Answer {
        let entry =
            pipette_keyboard_stores::save_analyze_filter(stores, &uid, &json, &label, summary.as_deref())?;
        Ok(field("entry", entry))
    })
    .await
}

#[tauri::command]
pub async fn analyze_filter_store_load(
    stores: State<'_, StoreContext>,
    uid: String,
    entry_id: String,
) -> Result<Response, CommandError> {
    answer(&stores, move |stores| -> Answer {
        let data = pipette_keyboard_stores::load_analyze_filter(stores, &uid, &entry_id)?;
        Ok(field("data", data))
    })
    .await
}

#[tauri::command]
pub async fn analyze_filter_store_update(
    stores: State<'_, StoreContext>,
    uid: String,
    entry_id: String,
    json: String,
) -> Result<Response, CommandError> {
    answer(&stores, move |stores| {
        done(pipette_keyboard_stores::update_analyze_filter(stores, &uid, &entry_id, &json))
    })
    .await
}

#[tauri::command]
pub async fn analyze_filter_store_rename(
    stores: State<'_, StoreContext>,
    uid: String,
    entry_id: String,
    new_label: String,
) -> Result<Response, CommandError> {
    answer(&stores, move |stores| {
        done(pipette_keyboard_stores::rename_analyze_filter(stores, &uid, &entry_id, &new_label))
    })
    .await
}

#[tauri::command]
pub async fn analyze_filter_store_delete(
    stores: State<'_, StoreContext>,
    uid: String,
    entry_id: String,
) -> Result<Response, CommandError> {
    answer(&stores, move |stores| {
        done(pipette_keyboard_stores::delete_analyze_filter(stores, &uid, &entry_id))
    })
    .await
}

#[tauri::command]
pub async fn analyze_filter_store_set_hub_post_id(
    stores: State<'_, StoreContext>,
    uid: String,
    entry_id: String,
    hub_post_id: Option<String>,
) -> Result<Response, CommandError> {
    answer(&stores, move |stores| {
        done(pipette_keyboard_stores::set_analyze_filter_hub_post_id(
            stores,
            &uid,
            &entry_id,
            hub_post_id.as_deref(),
        ))
    })
    .await
}

/// `link` is the text of `JSON.stringify(link)`, read as `JSON.parse` would
/// so the link keeps its key order; `null` (or no text) clears the link.
#[tauri::command]
pub async fn analyze_filter_store_set_hub_private(
    stores: State<'_, StoreContext>,
    uid: String,
    entry_id: String,
    link: Option<String>,
) -> Result<Response, CommandError> {
    let link = link.as_deref().map(pipette_js_json::parse).transpose()?.filter(|link| *link != Value::Null);
    answer(&stores, move |stores| {
        done(pipette_keyboard_stores::set_analyze_filter_hub_private(stores, &uid, &entry_id, link))
    })
    .await
}

#[cfg(test)]
mod tests {
    use pipette_keyboard_stores::analyze_filters_sync_unit;
    use pipette_sync_pending::PendingStore;
    use tauri::Manager;
    use tempfile::TempDir;

    #[test]
    fn a_save_marks_its_unit_as_pending() {
        let user_data = TempDir::new().unwrap();
        let app = tauri::test::mock_app();
        crate::store_commands::sync_pending::manage_without_delayed_writes(app.handle(), user_data.path());
        crate::store_commands::keyboard_data::manage(app.handle(), user_data.path());
        let stores = app.state::<pipette_keyboard_stores::StoreContext>();

        pipette_keyboard_stores::save_analyze_filter(&stores, "0xA1", "{}", "Filter", None).unwrap();

        let pending = app.state::<PendingStore>();
        assert_ne!(pending.pending_generation_of(&analyze_filters_sync_unit("0xA1")), 0);
    }
}
