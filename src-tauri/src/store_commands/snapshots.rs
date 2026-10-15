// SPDX-License-Identifier: GPL-2.0-or-later
//! The snapshot commands of the shim's `snapshotStore*` members
//! (src/tauri-shim/api/snapshots.ts), on the snapshot store of
//! crates/pipette-keyboard-stores (managed by store_commands/keyboard_data.rs).
//!
//! Each answers the handler's `{success, …}` object as JSON text written by
//! `pipette_js_json`, so the entries' fields this build does not know reach
//! the renderer as `JSON.stringify` writes them. A failure of the store is
//! such an answer too; a command fails only when its task cannot run.

use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::{SnapshotError, StoreContext, done, field};
use tauri::State;
use tauri::ipc::Response;

use super::answer;
use crate::command_error::CommandError;

/// What a store operation answers besides `success`.
type Answer = Result<Object, SnapshotError>;

#[tauri::command]
pub async fn snapshot_store_list(
    stores: State<'_, StoreContext>,
    uid: String,
) -> Result<Response, CommandError> {
    answer(&stores, move |stores| -> Answer {
        let entries = pipette_keyboard_stores::list_snapshots(stores, &uid)?;
        Ok(field("entries", Value::Array(entries.into_iter().map(Value::from).collect())))
    })
    .await
}

/// `vil_version` null or missing stores no `vilVersion`.
#[tauri::command]
pub async fn snapshot_store_save(
    stores: State<'_, StoreContext>,
    uid: String,
    json: String,
    device_name: String,
    label: String,
    vil_version: Option<f64>,
) -> Result<Response, CommandError> {
    answer(&stores, move |stores| -> Answer {
        let entry =
            pipette_keyboard_stores::save_snapshot(stores, &uid, &json, &device_name, &label, vil_version)?;
        Ok(field("entry", entry))
    })
    .await
}

#[tauri::command]
pub async fn snapshot_store_load(
    stores: State<'_, StoreContext>,
    uid: String,
    entry_id: String,
) -> Result<Response, CommandError> {
    answer(&stores, move |stores| -> Answer {
        let data = pipette_keyboard_stores::load_snapshot(stores, &uid, &entry_id)?;
        Ok(field("data", data))
    })
    .await
}

/// `options` is the renderer's `SnapshotUpdateOptions`: like the handler,
/// only a string `migrateFrom` in it counts.
#[tauri::command]
pub async fn snapshot_store_update(
    stores: State<'_, StoreContext>,
    uid: String,
    entry_id: String,
    json: String,
    vil_version: Option<f64>,
    options: Option<serde_json::Value>,
) -> Result<Response, CommandError> {
    let migrate_from = match options {
        Some(serde_json::Value::Object(mut options)) => match options.remove("migrateFrom") {
            Some(serde_json::Value::String(from)) => Some(from),
            _ => None,
        },
        _ => None,
    };
    answer(&stores, move |stores| {
        done(pipette_keyboard_stores::update_snapshot(
            stores,
            &uid,
            &entry_id,
            &json,
            vil_version,
            migrate_from.as_deref(),
        ))
    })
    .await
}

#[tauri::command]
pub async fn snapshot_store_rename(
    stores: State<'_, StoreContext>,
    uid: String,
    entry_id: String,
    new_label: String,
) -> Result<Response, CommandError> {
    answer(&stores, move |stores| {
        done(pipette_keyboard_stores::rename_snapshot(stores, &uid, &entry_id, &new_label))
    })
    .await
}

#[tauri::command]
pub async fn snapshot_store_delete(
    stores: State<'_, StoreContext>,
    uid: String,
    entry_id: String,
) -> Result<Response, CommandError> {
    answer(&stores, move |stores| done(pipette_keyboard_stores::delete_snapshot(stores, &uid, &entry_id)))
        .await
}

#[tauri::command]
pub async fn snapshot_store_set_hub_post_id(
    stores: State<'_, StoreContext>,
    uid: String,
    entry_id: String,
    hub_post_id: Option<String>,
) -> Result<Response, CommandError> {
    answer(&stores, move |stores| {
        done(pipette_keyboard_stores::set_snapshot_hub_post_id(
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
pub async fn snapshot_store_set_hub_private(
    stores: State<'_, StoreContext>,
    uid: String,
    entry_id: String,
    link: Option<String>,
) -> Result<Response, CommandError> {
    let link = link.as_deref().map(pipette_js_json::parse).transpose()?.filter(|link| *link != Value::Null);
    answer(&stores, move |stores| {
        done(pipette_keyboard_stores::set_snapshot_hub_private(stores, &uid, &entry_id, link))
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use pipette_entry_store::{SequenceIds, SystemClock, WriteLocks};
    use pipette_keyboard_stores::snapshots_sync_unit;
    use pipette_sync_pending::PendingStore;
    use serde_json::json;
    use tauri::Manager;
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn a_snapshot_save_marks_its_unit_and_the_keyboard_names_as_pending() {
        let user_data = TempDir::new().unwrap();
        let app = tauri::test::mock_app();
        crate::store_commands::sync_pending::manage_without_delayed_writes(app.handle(), user_data.path());
        crate::store_commands::keyboard_data::manage(app.handle(), user_data.path());
        let stores = app.state::<StoreContext>();

        pipette_keyboard_stores::save_snapshot(&stores, "0xA1", "{}", "Board", "", None).unwrap();

        let pending = app.state::<PendingStore>();
        assert_ne!(pending.pending_generation_of(&snapshots_sync_unit("0xA1")), 0);
        assert_ne!(pending.pending_generation_of(pipette_keyboard_stores::KEYBOARD_META_SYNC_UNIT), 0);
    }

    #[test]
    fn options_and_links_are_read_as_the_handlers_read_them() {
        let user_data = TempDir::new().unwrap();
        let app = tauri::test::mock_app();
        let ctx = StoreContext::new(
            user_data.path(),
            Arc::new(SystemClock),
            Arc::new(WriteLocks::new()),
            Arc::new(|_: &str| {}),
        )
        .with_ids(Arc::new(SequenceIds::new(["id-1"])));
        pipette_keyboard_stores::save_snapshot(&ctx, "0xA1", "old", "Board", "", None).unwrap();
        app.manage(ctx);
        let stores = app.state::<StoreContext>();
        use tauri::async_runtime::block_on;
        // A migrateFrom that is not a string is no migration.
        let update = |options| {
            block_on(snapshot_store_update(
                stores.clone(),
                "0xA1".into(),
                "id-1".into(),
                "new".into(),
                None,
                options,
            ))
        };
        assert!(update(Some(json!({ "migrateFrom": 5 }))).is_ok());
        assert!(update(Some(json!("migrateFrom"))).is_ok());
        let loaded = pipette_keyboard_stores::load_snapshot(&stores, "0xA1", "id-1").unwrap();
        assert_eq!(loaded, "new");

        let link = r#"{"url":"/u","id":"p","expiresAt":null}"#;
        block_on(snapshot_store_set_hub_private(
            stores.clone(),
            "0xA1".into(),
            "id-1".into(),
            Some(link.into()),
        ))
        .unwrap();
        let listed = pipette_keyboard_stores::list_snapshots(&stores, "0xA1").unwrap();
        let written = pipette_js_json::stringify(listed[0].get("hubPrivate").unwrap());
        assert_eq!(written, link);
        block_on(snapshot_store_set_hub_private(
            stores.clone(),
            "0xA1".into(),
            "id-1".into(),
            Some("null".into()),
        ))
        .unwrap();
        let listed = pipette_keyboard_stores::list_snapshots(&stores, "0xA1").unwrap();
        assert!(listed[0].get("hubPrivate").is_none());
    }
}
