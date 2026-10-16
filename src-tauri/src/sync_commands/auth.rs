// SPDX-License-Identifier: GPL-2.0-or-later
//! The Google sign-in of the sync (src/main/sync/sync-ipc.ts): its status,
//! the sign-in through the browser and the sign-out. A sign-in or sign-out
//! keeps the pending units with the account they were changed under
//! (`pipette_sync::account`).

use std::sync::Arc;

use pipette_google_auth::{AuthError, GoogleAuth};
use pipette_sync::account::{AccountSwitchError, AccountSwitcher};
use pipette_sync_pending::PendingStore;
use pipette_typing_analytics::SyncRuntime;
use serde::Serialize;
use tauri::State;
use ts_rs::TS;

use super::SyncSecrets;
use crate::command_error::CommandError;
use crate::shell::AuthBrowser;

/// `SyncAuthStatus` of src/shared/types/sync.ts; Electron never sets its
/// `email`.
#[derive(Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct SyncAuthStatus {
    authenticated: bool,
}

/// `SyncOperationResult` of src/shared/types/sync.ts as `wrapIpc`
/// (src/main/sync/sync-ipc-wrap.ts) answers it: the failure's message, and
/// the `reason` of a refusal the renderer shows its own message for.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct SyncOperationResult {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

impl SyncOperationResult {
    const SUCCESS: Self = Self { success: true, error: None, reason: None };

    fn failure(error: String, reason: Option<&'static str>) -> Self {
        Self { success: false, error: Some(error), reason }
    }
}

impl From<Result<(), AuthError>> for SyncOperationResult {
    fn from(result: Result<(), AuthError>) -> Self {
        let Err(err) = result else { return Self::SUCCESS };
        let reason = match &err {
            AuthError::Switch(refusal) => {
                refusal.downcast_ref::<AccountSwitchError>().and_then(AccountSwitchError::reason)
            }
            _ => None,
        };
        Self::failure(err.to_string(), reason)
    }
}

impl From<Result<(), AccountSwitchError>> for SyncOperationResult {
    fn from(result: Result<(), AccountSwitchError>) -> Self {
        match result {
            Ok(()) => Self::SUCCESS,
            Err(err) => Self::failure(err.to_string(), err.reason()),
        }
    }
}

fn switcher(
    sync: &SyncSecrets,
    runtime: &SyncRuntime,
    pending: &PendingStore,
) -> AccountSwitcher<GoogleAuth> {
    AccountSwitcher::new(runtime.clone(), pending.clone(), Arc::clone(&sync.auth))
}

/// Whether the sync is signed in: Google tokens are stored and readable,
/// or the Hub test account is set.
#[tauri::command]
pub async fn sync_auth_status(sync: State<'_, SyncSecrets>) -> Result<SyncAuthStatus, CommandError> {
    Ok(SyncAuthStatus { authenticated: sync.auth.is_authenticated().await })
}

/// Signs in through the browser. The new tokens are stored holding the sync
/// lock, once running sync work has ended (refused with `syncBusy` when it
/// has not within the wait), and the previous account's caches are
/// forgotten. Changes kept while signed out, and those this account left
/// unsent, go to it; another account's changes are held. Refused at once
/// when the build has no usable Google endpoints.
#[tauri::command]
pub async fn sync_auth_start(
    sync: State<'_, SyncSecrets>,
    browser: State<'_, AuthBrowser>,
    runtime: State<'_, SyncRuntime>,
    pending: State<'_, PendingStore>,
) -> Result<SyncOperationResult, CommandError> {
    let switcher = switcher(&sync, &runtime, &pending);
    Ok(sync.auth.sign_in(browser.inner(), &switcher).await.into())
}

/// Signs out. This account's unsent changes are held for its next
/// sign-in; its caches are forgotten once the tokens are gone. Refused
/// while the sync password is being changed.
#[tauri::command]
pub async fn sync_auth_sign_out(
    sync: State<'_, SyncSecrets>,
    runtime: State<'_, SyncRuntime>,
    pending: State<'_, PendingStore>,
) -> Result<SyncOperationResult, CommandError> {
    Ok(switcher(&sync, &runtime, &pending).sign_out_keeping_pending().await.into())
}

#[cfg(test)]
mod tests {
    use pipette_sync::account::{ACCOUNT_SWITCH_BUSY_MESSAGE, SIGN_OUT_PASSWORD_CHANGING};

    use super::*;

    #[test]
    fn answers_as_wrap_ipc_does() {
        let json = |result: SyncOperationResult| serde_json::to_value(result).unwrap();
        assert_eq!(json(Ok::<(), AuthError>(()).into()), serde_json::json!({ "success": true }));
        assert_eq!(
            json(Err::<(), _>(AuthError::Switch(Box::new(AccountSwitchError::Busy))).into()),
            serde_json::json!({ "success": false, "error": ACCOUNT_SWITCH_BUSY_MESSAGE, "reason": "syncBusy" })
        );
        assert_eq!(
            json(Err::<(), _>(AuthError::TimedOut).into()),
            serde_json::json!({ "success": false, "error": "OAuth flow timed out" })
        );
        assert_eq!(
            json(Err::<(), _>(AccountSwitchError::PasswordChanging).into()),
            serde_json::json!({ "success": false, "error": SIGN_OUT_PASSWORD_CHANGING })
        );
        assert_eq!(
            json(Err::<(), _>(AccountSwitchError::Busy).into()),
            serde_json::json!({ "success": false, "error": ACCOUNT_SWITCH_BUSY_MESSAGE, "reason": "syncBusy" })
        );
    }
}
