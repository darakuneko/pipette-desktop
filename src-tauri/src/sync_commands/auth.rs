// SPDX-License-Identifier: GPL-2.0-or-later
//! The sign-in status of the sync (`syncAuthStatus`, src/main/sync/sync-ipc.ts).

use serde::Serialize;
use tauri::State;
use ts_rs::TS;

use super::SyncSecrets;

/// `SyncAuthStatus` of src/shared/types/sync.ts; Electron never sets its
/// `email`.
#[derive(Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct SyncAuthStatus {
    authenticated: bool,
}

/// Whether the sync is signed in: Google tokens are stored and readable,
/// or the Hub test account is set.
#[tauri::command]
pub async fn sync_auth_status(
    sync: State<'_, SyncSecrets>,
) -> Result<SyncAuthStatus, crate::command_error::CommandError> {
    Ok(SyncAuthStatus { authenticated: sync.auth.is_authenticated().await })
}
