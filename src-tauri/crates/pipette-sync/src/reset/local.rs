// SPDX-License-Identifier: GPL-2.0-or-later
//! The resets of this machine's data: Reset Keyboard Data of one keyboard and
//! Reset Local Data of chosen targets.
//!
//! Each cancels the pending units of what it removes, then clears the
//! typing analytics of the removed keyboards, then cancels again (the
//! cleanup's flush marks their units pending), and only then removes the
//! files. The first cancel always writes, so a pending file that cannot be
//! written stops the reset before anything is removed.
//!
//! Removing App Settings removes `local/auth/`, which holds the sign-in, the
//! sync password and a password change's state (and the 0.4 build's `*.enc`
//! files): it is refused while this machine has a password change, and it signs
//! out right after the first cancel, before anything is removed. A failed
//! sign-out ends the reset with nothing removed, the sign-in and settings kept,
//! polling still running, and the cancelled units put back pending. It also
//! removes the app's log files (`ResetHooks::clear_logs`).

use pipette_keyboard_stores::{KEYBOARD_META_SYNC_UNIT, TombstoneOutcome};
use pipette_sync_runtime::ResetKeyboards;
use pipette_sync_runtime::runtime::RESET_BUSY_MESSAGE;

use super::targets::LocalResetTargets;
use super::{I18N_SYNC_UNIT_PREFIX, Resets, THEME_SYNC_UNIT_PREFIX, remove_all};
use crate::data_error::DataError;
use crate::password::guard::SyncBlockReason;
use crate::preflight::PreflightError;
use crate::scope::list_local_keyboard_uids;
use pipette_keyboard_stores::{KEY_LABEL_SYNC_UNIT, TYPING_TEXT_SYNC_UNIT};

impl Resets {
    /// The typing-analytics cleanup of every keyboard with a local directory or
    /// cache rows. Removing `sync/keyboards` alone leaves the cache, so Analyze
    /// would keep showing the removed keyboards. Failures are logged and
    /// skipped.
    async fn delete_typing_for_all_keyboards(&self) {
        let user_data = self.ctx.user_data().to_path_buf();
        let local = tokio::task::spawn_blocking(move || list_local_keyboard_uids(&user_data)).await;
        let mut uids: Vec<String> = local.map(|set| set.into_iter().collect()).unwrap_or_default();
        uids.sort();
        match self.hooks.typing_keyboards().await {
            Ok(cached) => {
                for uid in cached {
                    if !uids.contains(&uid) {
                        uids.push(uid);
                    }
                }
            }
            Err(err) => log::warn!("[sync-reset] reset local targets: analytics cache listing failed: {err}"),
        }
        for uid in &uids {
            if let Err(err) = self.hooks.delete_all_typing_for_keyboard(uid).await {
                log::warn!("[sync-reset] reset local targets: analytics cache cleanup failed: {err}");
            }
        }
    }

    /// The `reset_keyboard_data` command: removes `uid`'s local data and
    /// typing analytics, its Drive files when Drive allows it, and its
    /// keyboard name, so the other devices see the removal. Refused while
    /// a sync password change is in progress. When Drive cannot be checked
    /// (offline, signed out) or needs a newer app, the local reset still
    /// runs and only the Drive delete is left out: this machine's data is
    /// its own to remove.
    pub async fn reset_keyboard_data(&self, uid: &str) -> Result<(), DataError> {
        let keyboards = ResetKeyboards::Uids(vec![uid.to_owned()]);
        self.locked(&keyboards, RESET_BUSY_MESSAGE, async {
            let remote_delete_allowed = match self.preflight.assert_sync_allowed(None).await {
                Ok(()) => true,
                Err(PreflightError::Blocked(reason)) if reason != SyncBlockReason::UpdateRequired => {
                    return Err(PreflightError::Blocked(reason).into());
                }
                Err(_) => false,
            };
            let units = [format!("keyboards/{uid}/")];
            self.cancel(Some(&units), true)?;
            if let Err(err) = self.hooks.delete_all_typing_for_keyboard(uid).await {
                log::warn!("[sync-reset] reset keyboard: analytics cache cleanup failed: {err}");
            }
            self.cancel(Some(&units), false)?;
            remove_all(self.ctx.sync_dir().join("keyboards").join(uid)).await?;
            if remote_delete_allowed {
                // Best effort: a failure leaves the files for another reset.
                let _ = self.drive().delete_files_by_prefix(&format!("keyboards_{uid}_")).await;
            }
            if self.tombstone_keyboard(uid).await? == TombstoneOutcome::Tombstoned {
                self.ctx.notify(KEYBOARD_META_SYNC_UNIT);
            }
            Ok(())
        })
        .await
    }

    /// The `reset_local_targets` command: removes the chosen targets of
    /// this machine's data. Favorites take the other global user content
    /// with them: the typing-test texts and the key labels.
    pub async fn reset_local_targets(&self, targets: &LocalResetTargets) -> Result<(), DataError> {
        let keyboards = if targets.keyboards { ResetKeyboards::All } else { ResetKeyboards::None };
        self.locked(&keyboards, RESET_BUSY_MESSAGE, async {
            if targets.app_settings {
                self.preflight.assert_no_local_password_change().await?;
            }
            let cancelled: Option<Vec<String>> = (!targets.all_selected()).then(|| {
                let mut prefixes = Vec::new();
                if targets.keyboards {
                    prefixes.push("keyboards/".to_owned());
                }
                if targets.favorites {
                    prefixes.extend(
                        ["favorites/", TYPING_TEXT_SYNC_UNIT, KEY_LABEL_SYNC_UNIT].map(str::to_owned),
                    );
                }
                if targets.i18n_packs {
                    prefixes.push(I18N_SYNC_UNIT_PREFIX.to_owned());
                }
                if targets.theme_packs {
                    prefixes.push(THEME_SYNC_UNIT_PREFIX.to_owned());
                }
                prefixes
            });
            let before_cancel = targets.app_settings.then(|| self.pending.copy_state());
            self.cancel(cancelled.as_deref(), true)?;
            if let Some(copy) = before_cancel {
                if let Err(err) = self.hooks.sign_out_keeping_pending_locked().await {
                    self.pending.restore_cancelled(&copy);
                    return Err(DataError::Other(err));
                }
                // The app config is cleared below, auto sync with it.
                self.hooks.stop_polling();
            }
            if targets.keyboards {
                self.delete_typing_for_all_keyboards().await;
                self.cancel(cancelled.as_deref(), false)?;
                remove_all(self.ctx.sync_dir().join("keyboards")).await?;
            }
            let sync_dir = self.ctx.sync_dir();
            if targets.favorites {
                for dir in ["favorites", "typing-test-texts", "key-labels"] {
                    remove_all(sync_dir.join(dir)).await?;
                }
            }
            if targets.i18n_packs {
                remove_all(sync_dir.join("i18n")).await?;
            }
            if targets.theme_packs {
                remove_all(sync_dir.join("themes")).await?;
            }
            if targets.app_settings {
                self.hooks.clear_app_config().map_err(DataError::Other)?;
                // Right after the clear, which turns Debug Mode off: a later
                // removal that fails must not leave the log being written.
                self.hooks.clear_logs();
                let local = self.ctx.user_data().join("local");
                remove_all(local.join("auth")).await?;
                self.preflight.forget_change_state_cache();
                self.hooks.forget_secret_key().await;
                remove_all(local.join("downloads").join("languages")).await?;
                // Nothing writes `local/logs`: the logger writes
                // `<userData>/logs`, which `clear_logs` removes. The recorded
                // resets (tests/fixtures/ts_reset.json) expect `local/logs`
                // gone, so it is removed too.
                remove_all(local.join("logs")).await?;
            }
            Ok(())
        })
        .await
    }
}
