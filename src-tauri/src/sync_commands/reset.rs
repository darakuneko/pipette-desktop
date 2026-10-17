// SPDX-License-Identifier: GPL-2.0-or-later
//! The resets of the Data modal and the settings (the
//! `SYNC_RESET_TARGETS`, `RESET_KEYBOARD_DATA` and `RESET_LOCAL_TARGETS`
//! handlers of src/main/sync/sync-reset-ipc.ts), on crates/pipette-sync's
//! `reset`, with the rest of the app as the resets need it: the sign-out
//! that keeps the pending units, polling, the app config, the key store
//! and the typing analytics. Each answers as `wrapIpc` does; an argument
//! the handler would refuse is refused before the lock is taken.

use std::sync::Arc;

use pipette_keyboard_stores::StoreContext;
use pipette_sync::account::AccountSwitcher;
use pipette_sync::preflight::{BoxFuture, Preflight};
use pipette_sync::reset::targets::{LocalResetTargets, SyncResetTargets, uid_arg};
use pipette_sync::reset::{ResetDeps, ResetHooks, Resets};
use pipette_sync_pending::PendingStore;
use pipette_typing_analytics::{DataOps, DeleteScope, SyncRuntime, TypingAnalytics};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, State};

use super::SyncSecrets;
use super::result::SyncOperationResult;
use super::triggers::{on_auto_sync_changed, triggers};
use crate::app_config::AppConfig;
use crate::command_error::CommandError;

/// The app as the resets see it.
struct AppResetHooks<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> AppResetHooks<R> {
    fn ops(&self) -> Arc<DataOps> {
        Arc::clone(self.app.state::<Arc<DataOps>>().inner())
    }
}

impl<R: Runtime> ResetHooks for AppResetHooks<R> {
    fn sign_out_keeping_pending_locked(&self) -> BoxFuture<'_, Result<(), String>> {
        let switcher = AccountSwitcher::new(
            self.app.state::<SyncRuntime>().inner().clone(),
            self.app.state::<PendingStore>().inner().clone(),
            Arc::clone(&self.app.state::<SyncSecrets>().auth),
        );
        Box::pin(
            async move { switcher.sign_out_keeping_pending_locked().await.map_err(|err| err.to_string()) },
        )
    }

    fn stop_polling(&self) {
        if let Some(triggers) = triggers(&self.app) {
            triggers.poller().stop_polling();
        }
    }

    fn clear_app_config(&self) -> Result<(), String> {
        let config = self.app.state::<AppConfig>();
        config.clear().map_err(|err| err.to_string())?;
        // Clearing the store tells no listener: the sync's copy of autoSync
        // follows the cleared value here.
        let auto_sync = match config.get("autoSync") {
            Ok(value) => value.as_ref().is_some_and(pipette_app_config::Value::is_truthy),
            Err(err) => {
                log::error!("[sync] failed to read autoSync after the reset: {err}");
                false
            }
        };
        on_auto_sync_changed(&self.app, auto_sync);
        Ok(())
    }

    fn forget_secret_key(&self) -> BoxFuture<'_, ()> {
        let secrets = Arc::clone(&self.app.state::<SyncSecrets>().secrets);
        Box::pin(async move {
            if let Err(err) = secrets.master_key().delete().await {
                log::warn!("[sync] the key store entry of the removed secrets stays: {err}");
            }
        })
    }

    fn typing_keyboards(&self) -> BoxFuture<'_, Result<Vec<String>, String>> {
        let analytics = Arc::clone(self.app.state::<Arc<TypingAnalytics>>().inner());
        Box::pin(async move {
            let ready = analytics.ready().await.map_err(|err| err.to_string())?;
            let keyboards = ready
                .db
                .call(|db| db.keyboards_with_typing_data())
                .await
                .map_err(|err| err.to_string())?
                .map_err(|err| err.to_string())?;
            Ok(keyboards.into_iter().map(|keyboard| keyboard.uid).collect())
        })
    }

    fn delete_all_typing_for_keyboard<'a>(&'a self, uid: &'a str) -> BoxFuture<'a, Result<(), String>> {
        let ops = self.ops();
        Box::pin(async move {
            let cutoff = ops.analytics().now_ms();
            ops.delete_all_for_keyboard(uid, cutoff, DeleteScope::All)
                .await
                .map(|_| ())
                .map_err(|err| err.to_string())
        })
    }
}

/// Manages the resets. Needs the sync's secrets, the preflight, the
/// pending units, the stores, the typing analytics and the triggers
/// ([`super::execute::manage`]) to be managed first.
pub fn manage<R: Runtime>(app: &AppHandle<R>) {
    let resets = Resets::new(ResetDeps {
        preflight: Arc::clone(app.state::<Arc<Preflight>>().inner()),
        pending: app.state::<PendingStore>().inner().clone(),
        ctx: app.state::<StoreContext>().inner().clone(),
        hooks: Arc::new(AppResetHooks { app: app.clone() }),
    });
    app.manage(resets);
}

/// Removes the chosen targets from Drive.
#[tauri::command]
pub async fn sync_reset_targets(
    resets: State<'_, Arc<Resets>>,
    targets: Option<Value>,
) -> Result<SyncOperationResult, CommandError> {
    Ok(match SyncResetTargets::from_json(targets.as_ref()) {
        Ok(targets) => resets.reset_sync_targets(&targets).await.into(),
        Err(err) => SyncOperationResult::failure(err, None),
    })
}

/// Removes one keyboard's data, here and on Drive.
#[tauri::command]
pub async fn reset_keyboard_data(
    resets: State<'_, Arc<Resets>>,
    uid: Option<Value>,
) -> Result<SyncOperationResult, CommandError> {
    Ok(match uid_arg(uid.as_ref()) {
        Ok(uid) => resets.reset_keyboard_data(&uid).await.into(),
        Err(err) => SyncOperationResult::failure(err, None),
    })
}

/// Removes the chosen targets of this machine's data.
#[tauri::command]
pub async fn reset_local_targets(
    resets: State<'_, Arc<Resets>>,
    targets: Option<Value>,
) -> Result<SyncOperationResult, CommandError> {
    Ok(match LocalResetTargets::from_json(targets.as_ref()) {
        Ok(targets) => resets.reset_local_targets(&targets).await.into(),
        Err(err) => SyncOperationResult::failure(err, None),
    })
}

#[cfg(test)]
mod tests {
    use pipette_app_config::AppConfigStore;
    use pipette_secret_store::SecretKind;
    use pipette_sync::reset::targets::LocalResetTargets;
    use tauri::test::{MockRuntime, mock_app};

    use super::*;
    use crate::sync_commands::triggers::SyncTriggers;

    /// An app with the sync, its triggers and the resets on `user_data`,
    /// signed out, with an in-memory key store.
    fn app(user_data: &std::path::Path) -> tauri::App<MockRuntime> {
        let app = mock_app();
        let config: AppConfig = Arc::new(AppConfigStore::open(user_data));
        app.manage(config);
        crate::store_commands::sync_pending::manage_without_delayed_writes(app.handle(), user_data);
        crate::store_commands::keyboard_data::manage(app.handle(), user_data);
        crate::sync_commands::manage_for_tests(app.handle(), user_data);
        crate::analytics_commands::mark_cache_fresh(user_data, "machine");
        crate::analytics_commands::manage_with_machine_id(app.handle(), user_data, "machine");
        crate::sync_commands::preflight::manage_for_tests(app.handle());
        crate::sync_commands::execute::manage(app.handle());
        manage(app.handle());
        app
    }

    /// Reset Local Data of App Settings removes all of `local/auth/` (the
    /// Electron build's files too) and this userData's key store entry,
    /// stops polling and leaves auto sync off with the cleared config.
    #[tokio::test]
    async fn app_settings_remove_every_secret_and_turn_auto_sync_off() {
        let user_data = tempfile::tempdir().unwrap();
        let app = app(user_data.path());
        let secrets = Arc::clone(&app.state::<SyncSecrets>().secrets);
        secrets.store(SecretKind::SyncPassword, b"pw").await.unwrap();
        std::fs::write(user_data.path().join("local/auth/oauth-tokens.enc"), "electron").unwrap();
        app.state::<AppConfig>().set("autoSync", true.into()).unwrap();
        let triggers = Arc::clone(app.state::<Arc<SyncTriggers>>().inner());
        triggers.set_auto_sync(true);
        assert!(triggers.poller().is_polling());

        let targets = LocalResetTargets {
            keyboards: false,
            favorites: false,
            app_settings: true,
            i18n_packs: false,
            theme_packs: false,
        };
        app.state::<Arc<Resets>>().reset_local_targets(&targets).await.unwrap();

        assert!(!user_data.path().join("local/auth").exists());
        assert!(secrets.master_key().read().await.unwrap().is_none());
        assert!(!triggers.poller().is_polling());
        let auto_sync = app.state::<AppConfig>().get("autoSync").unwrap();
        assert!(!auto_sync.as_ref().is_some_and(pipette_app_config::Value::is_truthy));
        // Turning auto sync on again starts polling: the triggers were told
        // it is off, not stopped for good.
        triggers.set_auto_sync(true);
        assert!(triggers.poller().is_polling());
        triggers.set_auto_sync(false);
    }
}
