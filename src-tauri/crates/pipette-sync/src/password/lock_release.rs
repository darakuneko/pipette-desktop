// SPDX-License-Identifier: GPL-2.0-or-later
//! Reading and force-removing the password-change lock from a machine that
//! has no password change of its own (src/main/sync/
//! sync-password-lock-release.ts). When the machine holding the lock broke
//! or never comes back, every other machine stays blocked by the sync
//! guard; removing the lock is the only way out, so neither operation here
//! runs the guard's Drive lock check. The release still refuses while this
//! machine has a change of its own, and while Drive needs a newer sync
//! format: an app too old for Drive's data leaves the lock to an updated
//! one.

use serde::Serialize;

use super::change::PasswordChange;
use super::change_error::PasswordChangeError;

/// `PasswordChangeLockStatus`: the lock as shown to the user, without lock
/// ids.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordChangeLockStatus {
    /// ISO 8601 start by the holder's clock; `None` when the lock's content
    /// cannot be read.
    pub started_at: Option<String>,
    /// The lock was left by this machine (its machine hash matches), e.g.
    /// after an abandoned change failed to remove it.
    pub own_machine: bool,
}

impl PasswordChange {
    /// `getPasswordChangeLockStatus`: the earliest lock on Drive (the one
    /// that blocks syncing), `None` when there is none. Reads only.
    pub async fn lock_status(&self) -> Result<Option<PasswordChangeLockStatus>, PasswordChangeError> {
        let locks = self.locks();
        let Some(holder) = locks.list_locks().await?.into_iter().next() else { return Ok(None) };
        let Some(info) = locks.read_info(&holder).await else {
            return Ok(Some(PasswordChangeLockStatus { started_at: None, own_machine: false }));
        };
        let own_hash = (self.machine_hash)().map_err(PasswordChangeError::Other)?;
        Ok(Some(PasswordChangeLockStatus {
            started_at: Some(info.started_at),
            own_machine: info.machine_hash == own_hash,
        }))
    }

    /// `releasePasswordChangeLocks`: deletes every password-change lock on
    /// Drive. Refused while this machine has a change of its own (its lock
    /// is still needed to finish or revert it), while Drive needs a newer
    /// sync format, and while sync work runs here; holds the sync lock so
    /// no password change starts meanwhile.
    pub async fn release_locks(&self) -> Result<(), PasswordChangeError> {
        self.preflight.assert_no_local_password_change().await?;
        let runtime = self.preflight.runtime();
        if runtime.sync_work_running() {
            return Err(PasswordChangeError::ReleaseBusy);
        }
        let Some(_lock) = runtime.try_claim_sync_lock(false) else {
            return Err(PasswordChangeError::ReleaseBusy);
        };
        self.preflight.assert_sync_format_supported(None).await?;
        let locks = self.locks();
        for lock in locks.list_locks().await? {
            locks.release(&lock.id).await?;
        }
        Ok(())
    }
}
