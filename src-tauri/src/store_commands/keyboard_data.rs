// SPDX-License-Identifier: GPL-2.0-or-later
//! The keyboard data commands of the shim's `listStoredKeyboards` and
//! `keyboardMetaNameIfMissing` (src/tauri-shim/api/keyboard-data.ts), on
//! the stores of crates/pipette-keyboard-stores. Their changes are recorded
//! as pending sync units (store_commands/sync_pending.rs).

use std::path::Path;
use std::sync::Arc;

use pipette_entry_store::{SystemClock, WriteLocks};
use pipette_keyboard_stores::StoreContext;
use pipette_sync_pending::PendingStore;
use serde_json::Value;
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::command_error::CommandError;
use crate::store_commands::blocking;

/// Manages the stores of `user_data`, reporting their changes to the
/// pending sync units, which must be managed already.
pub fn manage<R: Runtime>(app: &AppHandle<R>, user_data: &Path) {
    let pending = app.state::<PendingStore>().inner().clone();
    app.manage(StoreContext::new(
        user_data,
        Arc::new(SystemClock),
        Arc::new(WriteLocks::new()),
        Arc::new(move |unit: &str| pending.notify_change(unit)),
    ));
}

/// `[{uid, name}, …]` as JSON text: a name read from the keyboard names is
/// sent as it is there, which `pipette_js_json` writes as `JSON.stringify`
/// does.
#[tauri::command]
pub async fn list_stored_keyboards(stores: State<'_, StoreContext>) -> Result<Response, CommandError> {
    let list = blocking(&stores, pipette_keyboard_stores::list_stored_keyboards).await?;
    Ok(Response::new(pipette_keyboard_stores::stored_keyboards_json(&list)))
}

/// Takes the arguments as any JSON value: like the handler, it does
/// nothing for a uid or name that is not a string.
#[tauri::command]
pub async fn keyboard_meta_name_if_missing(
    stores: State<'_, StoreContext>,
    uid: Option<Value>,
    name: Option<Value>,
) -> Result<(), CommandError> {
    let text = |value: Option<Value>| match value {
        Some(Value::String(text)) => Some(text),
        _ => None,
    };
    let (uid, name) = (text(uid), text(name));
    blocking(&stores, move |stores| {
        pipette_keyboard_stores::keyboard_meta_name_if_missing(stores, uid.as_deref(), name.as_deref())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use pipette_keyboard_stores::KEYBOARD_META_SYNC_UNIT;
    use tempfile::TempDir;

    #[test]
    fn a_change_of_the_keyboard_names_is_a_pending_sync_unit() {
        let user_data = TempDir::new().unwrap();
        let app = tauri::test::mock_app();
        crate::store_commands::sync_pending::manage_without_delayed_writes(app.handle(), user_data.path());
        manage(app.handle(), user_data.path());
        let stores = app.state::<StoreContext>();

        pipette_keyboard_stores::keyboard_meta_name_if_missing(&stores, Some("0xA1"), Some("Board")).unwrap();

        let pending = app.state::<PendingStore>();
        assert!(pending.has_pending_changes());
        assert_ne!(pending.pending_generation_of(KEYBOARD_META_SYNC_UNIT), 0);
        assert!(user_data.path().join("sync/meta/keyboard-names.json").is_file());
    }
}
