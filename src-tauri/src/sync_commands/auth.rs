// SPDX-License-Identifier: GPL-2.0-or-later
//! The Google sign-in of the sync: its status, the sign-in through the
//! browser and the sign-out. A sign-in or sign-out keeps the pending units
//! with the account they were changed under (`pipette_sync::account`).

use std::sync::Arc;

use pipette_google_auth::{AuthError, GoogleAuth};
use pipette_sync::account::{AccountSwitchError, AccountSwitcher};
use pipette_sync_pending::PendingStore;
use pipette_typing_analytics::SyncRuntime;
use serde::Serialize;
use tauri::State;
use ts_rs::TS;

use super::SyncSecrets;
use super::result::SyncOperationResult;
use super::triggers::SyncTriggers;
use crate::command_error::CommandError;
use crate::shell::AuthBrowser;

/// `SyncAuthStatus` of src/shared/types/sync.ts, without the optional
/// `email`, which is never set.
#[derive(Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct SyncAuthStatus {
    authenticated: bool,
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
/// when the build has no usable Google endpoints. Once signed in, the
/// pending changes are scheduled and polling starts when auto sync is on.
#[tauri::command]
pub async fn sync_auth_start(
    sync: State<'_, SyncSecrets>,
    browser: State<'_, AuthBrowser>,
    runtime: State<'_, SyncRuntime>,
    pending: State<'_, PendingStore>,
    triggers: State<'_, Arc<SyncTriggers>>,
) -> Result<SyncOperationResult, CommandError> {
    let switcher = switcher(&sync, &runtime, &pending);
    let result = sync.auth.sign_in(browser.inner(), &switcher).await;
    if result.is_ok() {
        triggers.credentials_ready();
    }
    Ok(result.into())
}

/// Signs out. This account's unsent changes are held for its next
/// sign-in; its caches are forgotten once the tokens are gone, and polling
/// stops. Refused while the sync password is being changed; a refused
/// sign-out keeps the account signed in, so polling keeps running.
#[tauri::command]
pub async fn sync_auth_sign_out(
    sync: State<'_, SyncSecrets>,
    runtime: State<'_, SyncRuntime>,
    pending: State<'_, PendingStore>,
    triggers: State<'_, Arc<SyncTriggers>>,
) -> Result<SyncOperationResult, CommandError> {
    let result = switcher(&sync, &runtime, &pending).sign_out_keeping_pending().await;
    if result.is_ok() {
        triggers.signed_out();
    }
    Ok(result.into())
}

#[cfg(test)]
mod tests {
    use pipette_sync::account::{ACCOUNT_SWITCH_BUSY_MESSAGE, SIGN_OUT_PASSWORD_CHANGING};
    use pipette_sync::preflight::Preflight;
    use pipette_sync_runtime::ValidatedPasswordCheck;
    use tauri::Manager;

    use super::*;

    /// A sign-out forgets the preflight's caches through the sign-in's
    /// account listener, bumping the sign-out generation once.
    #[tokio::test]
    async fn a_sign_out_forgets_the_preflight_caches_once() {
        let user_data = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        crate::store_commands::sync_pending::manage_without_delayed_writes(app.handle(), user_data.path());
        super::super::manage_for_tests(app.handle(), user_data.path());
        app.manage(SyncRuntime::new());
        super::super::preflight::manage_for_tests(app.handle());
        let runtime = app.state::<SyncRuntime>().inner().clone();
        let preflight = Arc::clone(app.state::<Arc<Preflight>>().inner());
        runtime.credentials().set_validated_password_check(ValidatedPasswordCheck {
            id: "check".to_owned(),
            modified_time: "2026-10-01T00:00:00.000Z".to_owned(),
            password_fingerprint: [0; 32],
        });
        let generation = preflight.sync_format_generation();

        let sync = app.state::<SyncSecrets>();
        let pending = app.state::<PendingStore>();
        switcher(&sync, &runtime, &pending).sign_out_keeping_pending().await.unwrap();

        assert!(runtime.credentials().validated_password_check().is_none());
        assert_eq!(preflight.sync_format_generation(), generation + 1);
    }

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
