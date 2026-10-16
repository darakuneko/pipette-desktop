// SPDX-License-Identifier: GPL-2.0-or-later
//! The check every sync entry point runs before it downloads, uploads or
//! deletes anything on Drive (src/main/sync/sync-password-guard.ts): no
//! sync while a sync password change is in progress, on this machine or on
//! another one, and none while Drive needs a newer sync format.
//!
//! - This machine: a local password-change state file (any step, even an
//!   unreadable one) blocks every entry point. Only the password-change
//!   operations themselves run then; they do not call this guard but
//!   [`Preflight::assert_sync_format_supported`].
//! - Another machine: a password-change lock in the Drive listing blocks.
//!   Our own lock can only exist while our local state does, and that
//!   already blocks.
//! - Sync format: a marker newer than
//!   [`crate::format::SYNC_FORMAT_VERSION`] blocks
//!   (`updateRequired`) and is recorded in the status the update banner
//!   reads.

use pipette_drive::DriveFile;
use pipette_sync_format::drive_names::{PASSWORD_CHANGE_LOCK_FILE, is_password_change_lock_file};
use pipette_sync_runtime::{SyncDirection, SyncProgress, SyncStatus};
use serde::Serialize;

use crate::format::{is_sync_format_update_required, required_sync_format};
use crate::preflight::{Preflight, PreflightError};

/// `SyncBlockReason` of src/shared/types/sync.ts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncBlockReason {
    /// Drive holds a password-change lock and this machine has no change
    /// of its own.
    BlockedByOtherDevice,
    /// This machine has an unfinished password change.
    BlockedLocal,
    /// Drive holds a sync-format marker newer than this app's.
    UpdateRequired,
}

impl SyncBlockReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::BlockedByOtherDevice => "blockedByOtherDevice",
            Self::BlockedLocal => "blockedLocal",
            Self::UpdateRequired => "updateRequired",
        }
    }

    /// `syncBlockI18nKey`.
    pub fn i18n_key(self) -> String {
        match self {
            Self::UpdateRequired => "sync.updateRequired".to_owned(),
            other => format!("sync.passwordChange.{}", other.as_str()),
        }
    }
}

/// A listing the caller already has, with the sign-out generation taken
/// before it was requested (`PrefetchedListing`). `None`: the guard lists
/// Drive itself.
pub type Prefetched<'a> = Option<(&'a [DriveFile], u64)>;

impl Preflight {
    /// `blockedLocal` while this machine has a password-change state; no
    /// Drive access.
    pub async fn local_sync_block(&self) -> Option<SyncBlockReason> {
        self.change_state.has().await.then_some(SyncBlockReason::BlockedLocal)
    }

    /// Fails with `blockedLocal` while this machine has a password-change
    /// state.
    pub async fn assert_no_local_password_change(&self) -> Result<(), PreflightError> {
        match self.local_sync_block().await {
            Some(reason) => Err(PreflightError::Blocked(reason)),
            None => Ok(()),
        }
    }

    /// `hasChangeState` for the password-change operations, which then
    /// read the state themselves.
    pub fn forget_change_state_cache(&self) {
        self.change_state.forget_cache();
    }

    /// Whether `listing` holds a marker newer than this app's; when it
    /// does, the update banner's status is set as well.
    fn blocks_on_sync_format(&self, listing: &[DriveFile], generation: u64) -> bool {
        if !is_sync_format_update_required(listing) {
            return false;
        }
        self.note_sync_format_update_required(required_sync_format(listing), generation);
        true
    }

    /// `updateRequired` when `listing` has a marker newer than this app's,
    /// otherwise `blockedByOtherDevice` when it has a password-change lock.
    /// The format comes first: finishing a password change would not let
    /// this app sync.
    pub fn remote_sync_block(&self, listing: &[DriveFile], generation: u64) -> Option<SyncBlockReason> {
        if self.blocks_on_sync_format(listing, generation) {
            return Some(SyncBlockReason::UpdateRequired);
        }
        listing
            .iter()
            .any(|file| is_password_change_lock_file(&file.name))
            .then_some(SyncBlockReason::BlockedByOtherDevice)
    }

    /// The files [`Preflight::remote_sync_block`] looks at, through two
    /// narrow listings (the lock and the markers) sent at once, for entry
    /// points without an unfiltered listing.
    pub async fn list_guard_files(&self) -> Result<Vec<DriveFile>, PreflightError> {
        let (locks, markers) = tokio::join!(
            self.drive.list_files(Some(PASSWORD_CHANGE_LOCK_FILE)),
            self.list_sync_format_files()
        );
        let mut files = locks?;
        files.extend(markers?);
        Ok(files)
    }

    /// The local check, then the remote check against `prefetched` (an
    /// unfiltered listing the caller already has) or, without one, the
    /// guard's own listings. `None` when syncing may go ahead.
    pub async fn sync_block(
        &self,
        prefetched: Prefetched<'_>,
    ) -> Result<Option<SyncBlockReason>, PreflightError> {
        if let Some(local) = self.local_sync_block().await {
            return Ok(Some(local));
        }
        if let Some((listing, generation)) = prefetched {
            return Ok(self.remote_sync_block(listing, generation));
        }
        let generation = self.sync_format_generation();
        Ok(self.remote_sync_block(&self.list_guard_files().await?, generation))
    }

    /// [`Preflight::sync_block`] that fails with the reason.
    pub async fn assert_sync_allowed(&self, prefetched: Prefetched<'_>) -> Result<(), PreflightError> {
        match self.sync_block(prefetched).await? {
            Some(reason) => Err(PreflightError::Blocked(reason)),
            None => Ok(()),
        }
    }

    /// Fails with `updateRequired` when `prefetched` (any listing that
    /// includes the markers; without one, a markers-only listing) holds a
    /// marker newer than this app's. For the password-change operations,
    /// which do not run the full guard.
    pub async fn assert_sync_format_supported(
        &self,
        prefetched: Prefetched<'_>,
    ) -> Result<(), PreflightError> {
        let blocked = match prefetched {
            Some((listing, generation)) => self.blocks_on_sync_format(listing, generation),
            None => {
                let generation = self.sync_format_generation();
                let markers = self.list_sync_format_files().await?;
                self.blocks_on_sync_format(&markers, generation)
            }
        };
        if blocked { Err(PreflightError::Blocked(SyncBlockReason::UpdateRequired)) } else { Ok(()) }
    }

    /// Reports a blocked pass as a final `error` progress whose message is
    /// the reason's i18n key.
    pub fn emit_sync_blocked(&self, direction: SyncDirection, reason: SyncBlockReason) {
        let progress = SyncProgress {
            message: Some(reason.i18n_key()),
            ..SyncProgress::new(direction, SyncStatus::Error)
        };
        self.runtime.progress().emit(&progress);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reasons_have_the_keys_and_names_of_the_renderer() {
        assert_eq!(SyncBlockReason::UpdateRequired.i18n_key(), "sync.updateRequired");
        assert_eq!(SyncBlockReason::BlockedLocal.i18n_key(), "sync.passwordChange.blockedLocal");
        assert_eq!(
            serde_json::to_value(SyncBlockReason::BlockedByOtherDevice).unwrap(),
            SyncBlockReason::BlockedByOtherDevice.as_str()
        );
    }
}
