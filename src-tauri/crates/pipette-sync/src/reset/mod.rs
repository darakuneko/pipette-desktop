// SPDX-License-Identifier: GPL-2.0-or-later
//! The resets and deletes of synced data: the delete of chosen Drive files, the
//! reset of chosen targets on Drive, the reset of one keyboard's data, and the
//! reset of this machine's data ([`local`]). Each holds the sync lock as a
//! reset for its whole run (`SyncRuntime::with_reset_lock`), naming the
//! keyboards whose data it removes, and is refused at once while a sync holds
//! the lock or an analytics sync or remote day fetch of those keyboards runs.
//!
//! What a reset removes from Drive is removed from the pending units first: the
//! first cancel always writes the pending file, so a disk failure stops the
//! reset before anything is removed. No store lock is taken around a removal:
//! the sync lock keeps the passes out, and the stores write under their own
//! locks.

pub mod local;
pub mod targets;

use std::future::Future;
use std::path::Path;
use std::sync::Arc;

use pipette_drive::canonical::Listing;
use pipette_drive::client::{BulkOutcome, DriveClient};
use pipette_keyboard_stores::{
    KEY_LABEL_SYNC_UNIT, KEYBOARD_META_SYNC_UNIT, StoreContext, TYPING_TEXT_SYNC_UNIT, TombstoneOutcome,
    tombstone_all_keyboard_meta, tombstone_keyboard_meta,
};
use pipette_sync_format::drive_names::drive_file_name;
use pipette_sync_pending::PendingStore;
use pipette_sync_runtime::ResetKeyboards;
use pipette_sync_runtime::runtime::{DELETE_BUSY_MESSAGE, RESET_BUSY_MESSAGE};

use crate::data_error::DataError;
use crate::preflight::{BoxFuture, Preflight, PreflightError};
use targets::{KeyboardTargets, SyncResetTargets};

pub const I18N_SYNC_UNIT_PREFIX: &str = "i18n/";
pub const THEME_SYNC_UNIT_PREFIX: &str = "themes/";

/// What a reset asks of the rest of the app.
pub trait ResetHooks: Send + Sync {
    /// Signs out under the sync lock the reset holds, holding the account's
    /// pending units for its next sign-in. A failure keeps the sign-in.
    fn sign_out_keeping_pending_locked(&self) -> BoxFuture<'_, Result<(), String>>;
    /// Stops the polling.
    fn stop_polling(&self);
    /// Puts the app config back to its defaults, and the sync's auto sync
    /// with it.
    fn clear_app_config(&self) -> Result<(), String>;
    /// Removes this userData's master key from the OS key store, once the
    /// files it opened are gone. Never fails: a key left behind opens
    /// nothing.
    fn forget_secret_key(&self) -> BoxFuture<'_, ()>;
    /// The keyboards the typing-analytics cache has rows of.
    fn typing_keyboards(&self) -> BoxFuture<'_, Result<Vec<String>, String>>;
    /// Flushes and removes this machine's day files of `uid` and hides every
    /// device's rows of it in the cache, so Analyze stops showing the keyboard.
    fn delete_all_typing_for_keyboard<'a>(&'a self, uid: &'a str) -> BoxFuture<'a, Result<(), String>>;
}

/// What the resets are built from.
pub struct ResetDeps {
    pub preflight: Arc<Preflight>,
    pub pending: PendingStore,
    pub ctx: StoreContext,
    pub hooks: Arc<dyn ResetHooks>,
}

/// The resets and deletes of synced data.
pub struct Resets {
    pub(crate) preflight: Arc<Preflight>,
    pub(crate) pending: PendingStore,
    pub(crate) ctx: StoreContext,
    pub(crate) hooks: Arc<dyn ResetHooks>,
}

/// Runs a store operation on a blocking-task thread.
pub(crate) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, DataError> {
    tokio::task::spawn_blocking(work).await.map_err(DataError::other)?.map_err(DataError::Other)
}

/// `rm(path, { recursive: true, force: true })`.
pub(crate) async fn remove_all(path: impl AsRef<Path>) -> Result<(), DataError> {
    let path = path.as_ref().to_path_buf();
    blocking(move || match std::fs::remove_dir_all(&path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        // A file in the place of the directory goes too.
        Err(_) if path.is_file() => std::fs::remove_file(&path).map_err(|err| err.to_string()),
        other => other.map_err(|err| err.to_string()),
    })
    .await
}

impl Resets {
    pub fn new(deps: ResetDeps) -> Arc<Self> {
        Arc::new(Self { preflight: deps.preflight, pending: deps.pending, ctx: deps.ctx, hooks: deps.hooks })
    }

    fn drive(&self) -> &DriveClient {
        self.preflight.drive()
    }

    /// Runs `work` holding the sync lock as a reset of `keyboards`.
    async fn locked<T>(
        &self,
        keyboards: &ResetKeyboards,
        busy: &'static str,
        work: impl Future<Output = Result<T, DataError>>,
    ) -> Result<T, DataError> {
        self.preflight.runtime().with_reset_lock(keyboards, busy, work).await?
    }

    /// Cancels the pending units of `prefixes` (`PendingStore::cancel`); `None` cancels
    /// every unit.
    fn cancel(&self, prefixes: Option<&[String]>, write_always: bool) -> Result<(), DataError> {
        let prefixes: Option<Vec<&str>> = prefixes.map(|list| list.iter().map(String::as_str).collect());
        self.pending.cancel(prefixes.as_deref(), write_always).map_err(DataError::other)
    }

    /// The `sync_delete_files` command: deletes the Drive files of
    /// `file_ids` (only those ids, as listed on the screen), refused with
    /// `sync.deleteBusy` while a sync runs and by the sync guards.
    pub async fn delete_files(&self, file_ids: &[String]) -> Result<(), DataError> {
        self.locked(&ResetKeyboards::None, DELETE_BUSY_MESSAGE, async {
            self.preflight.assert_sync_allowed(None).await?;
            let outcome = self.drive().delete_files_by_id(file_ids).await;
            if outcome.failed > 0 {
                return Err(DataError::Other(format!(
                    "Failed to delete {} of {} files: {}",
                    outcome.failed,
                    outcome.attempted,
                    outcome.first_error.as_deref().unwrap_or("undefined")
                )));
            }
            Ok(())
        })
        .await
    }

    /// Deletes every Drive copy of `name` and every trash file of it, the reset
    /// of a unit with no subtree (a prefix would also catch other names
    /// starting with it). The trash goes too, or the poll would rename it back
    /// to the emptied name.
    async fn delete_files_by_exact_name(&self, name: &str) -> Result<BulkOutcome, DataError> {
        let listing = Listing::new(self.drive().list_files(Some(name)).await.map_err(PreflightError::from)?);
        let ids: Vec<String> =
            listing.files_named_with_trash(name).into_iter().map(|file| file.id.clone()).collect();
        Ok(self.drive().delete_files_by_id(&ids).await)
    }

    async fn delete_files_by_prefix(&self, prefix: &str) -> Result<BulkOutcome, DataError> {
        Ok(self.drive().delete_files_by_prefix(prefix).await.map_err(PreflightError::from)?)
    }

    /// The `sync_reset_targets` command: removes the chosen targets from
    /// Drive, and the keyboard names of removed keyboards, so the other
    /// devices learn of it. Every target is attempted; those with a failed
    /// delete are named in the error.
    pub async fn reset_sync_targets(&self, targets: &SyncResetTargets) -> Result<(), DataError> {
        let keyboards = match &targets.keyboards {
            KeyboardTargets::All => ResetKeyboards::All,
            KeyboardTargets::Uids(uids) => ResetKeyboards::Uids(uids.clone()),
            KeyboardTargets::None => ResetKeyboards::None,
        };
        self.locked(&keyboards, RESET_BUSY_MESSAGE, async {
            self.preflight.assert_sync_allowed(None).await?;
            let mut prefixes: Vec<String> = Vec::new();
            match &targets.keyboards {
                KeyboardTargets::All => prefixes.push("keyboards/".into()),
                KeyboardTargets::Uids(uids) => {
                    prefixes.extend(uids.iter().map(|uid| format!("keyboards/{uid}/")))
                }
                KeyboardTargets::None => {}
            }
            let named = [
                (targets.favorites, "favorites/"),
                (targets.i18n_packs, I18N_SYNC_UNIT_PREFIX),
                (targets.theme_packs, THEME_SYNC_UNIT_PREFIX),
                (targets.key_labels, KEY_LABEL_SYNC_UNIT),
                (targets.typing_test_texts, TYPING_TEXT_SYNC_UNIT),
            ];
            prefixes.extend(named.iter().filter(|(on, _)| *on).map(|(_, prefix)| (*prefix).to_owned()));
            self.cancel(Some(&prefixes), true)?;

            let mut failed: Vec<String> = Vec::new();
            let mut meta_changed = false;
            match &targets.keyboards {
                KeyboardTargets::All => {
                    if self.delete_files_by_prefix("keyboards_").await?.failed > 0 {
                        failed.push("keyboards".into());
                    }
                    let ctx = self.ctx.clone();
                    let count =
                        blocking(move || tombstone_all_keyboard_meta(&ctx).map_err(|e| e.to_string()))
                            .await?;
                    meta_changed |= count > 0;
                }
                KeyboardTargets::Uids(uids) => {
                    for uid in uids {
                        if self.delete_files_by_prefix(&format!("keyboards_{uid}_")).await?.failed > 0 {
                            failed.push(format!("keyboards/{uid}"));
                        }
                        meta_changed |= self.tombstone_keyboard(uid).await? == TombstoneOutcome::Tombstoned;
                    }
                }
                KeyboardTargets::None => {}
            }
            let prefixed = [
                (targets.favorites, "favorites_", "favorites"),
                (targets.i18n_packs, "i18n_", "i18nPacks"),
                (targets.theme_packs, "themes_", "themePacks"),
            ];
            for (_, prefix, label) in prefixed.iter().filter(|(on, ..)| *on) {
                if self.delete_files_by_prefix(prefix).await?.failed > 0 {
                    failed.push((*label).into());
                }
            }
            let exact = [
                (targets.key_labels, KEY_LABEL_SYNC_UNIT, "keyLabels"),
                (targets.typing_test_texts, TYPING_TEXT_SYNC_UNIT, "typingTestTexts"),
            ];
            for (_, unit, label) in exact.iter().filter(|(on, ..)| *on) {
                if self.delete_files_by_exact_name(&drive_file_name(unit)).await?.failed > 0 {
                    failed.push((*label).into());
                }
            }
            if meta_changed {
                self.ctx.notify(KEYBOARD_META_SYNC_UNIT);
            }
            if !failed.is_empty() {
                return Err(DataError::Other(format!(
                    "Failed to delete remote data for: {}",
                    failed.join(", ")
                )));
            }
            Ok(())
        })
        .await
    }

    /// Deletes the keyboard name of `uid` ([`tombstone_keyboard_meta`]).
    async fn tombstone_keyboard(&self, uid: &str) -> Result<TombstoneOutcome, DataError> {
        let (ctx, uid) = (self.ctx.clone(), uid.to_owned());
        blocking(move || tombstone_keyboard_meta(&ctx, &uid).map_err(|err| err.to_string())).await
    }
}
