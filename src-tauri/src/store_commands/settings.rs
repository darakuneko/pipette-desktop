// SPDX-License-Identifier: GPL-2.0-or-later
//! The pipette settings commands of the shim's `pipetteSettings*` members
//! (src/tauri-shim/api/settings.ts), on the settings storage of
//! crates/pipette-keyboard-stores (managed by store_commands/keyboard_data.rs).
//!
//! The commands store text: the shim reads a file with its etag, applies
//! the content rules of src/shared/pipette-settings-normalize.ts, and writes
//! the result back naming that etag. A write the file has moved past answers
//! `conflict`, and the shim reads again.

use pipette_keyboard_stores::{SettingsFile, SettingsWrite, StoreContext};
use serde::Serialize;
use tauri::State;
use tauri::ipc::Response;

use crate::command_error::CommandError;
use crate::store_commands::blocking;

/// A settings file as read: `content` is null when there is none.
#[derive(Debug, Serialize)]
pub struct SettingsFileDto {
    content: Option<String>,
    etag: String,
}

impl From<SettingsFile> for SettingsFileDto {
    fn from(file: SettingsFile) -> Self {
        Self { content: file.content, etag: file.etag }
    }
}

/// What a write did: `"written"`, or `"conflict"` when the file no longer
/// has the etag the write named.
#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SettingsWriteDto {
    Written,
    Conflict,
}

#[tauri::command]
pub async fn pipette_settings_read(
    stores: State<'_, StoreContext>,
    uid: String,
) -> Result<SettingsFileDto, CommandError> {
    let file =
        blocking(&stores, move |stores| pipette_keyboard_stores::read_pipette_settings(stores, &uid)).await?;
    Ok(file.into())
}

#[tauri::command]
pub async fn pipette_settings_write(
    stores: State<'_, StoreContext>,
    uid: String,
    content: String,
    etag: String,
) -> Result<SettingsWriteDto, CommandError> {
    let written = blocking(&stores, move |stores| {
        pipette_keyboard_stores::write_pipette_settings(stores, &uid, &content, &etag)
    })
    .await?;
    Ok(match written {
        SettingsWrite::Written => SettingsWriteDto::Written,
        SettingsWrite::Conflict => SettingsWriteDto::Conflict,
    })
}

#[tauri::command]
pub async fn pipette_settings_ensure_dir(
    stores: State<'_, StoreContext>,
    uid: String,
) -> Result<(), CommandError> {
    blocking(&stores, move |stores| pipette_keyboard_stores::ensure_pipette_settings_dir(stores, &uid)).await
}

/// `[{uid, name, content}, …]` as JSON text: a name read from the keyboard
/// names is sent as it is there, which `pipette_js_json` writes as
/// `JSON.stringify` does.
#[tauri::command]
pub async fn pipette_settings_read_all(stores: State<'_, StoreContext>) -> Result<Response, CommandError> {
    let files = blocking(&stores, pipette_keyboard_stores::read_all_pipette_settings).await?;
    Ok(Response::new(pipette_keyboard_stores::keyboard_settings_files_json(&files)))
}

#[cfg(test)]
mod tests {
    use pipette_keyboard_stores::settings_sync_unit;
    use pipette_sync_pending::PendingStore;
    use tauri::Manager;
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn a_settings_write_marks_its_unit_as_pending() {
        let user_data = TempDir::new().unwrap();
        let app = tauri::test::mock_app();
        crate::store_commands::sync_pending::manage_without_delayed_writes(app.handle(), user_data.path());
        crate::store_commands::keyboard_data::manage(app.handle(), user_data.path());
        let stores = app.state::<StoreContext>();

        let etag = pipette_keyboard_stores::read_pipette_settings(&stores, "0xA1").unwrap().etag;
        pipette_keyboard_stores::write_pipette_settings(&stores, "0xA1", "{}", &etag).unwrap();

        let pending = app.state::<PendingStore>();
        assert_ne!(pending.pending_generation_of(&settings_sync_unit("0xA1")), 0);
    }
}
