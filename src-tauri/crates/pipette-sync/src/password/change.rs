// SPDX-License-Identifier: GPL-2.0-or-later
//! The entry points of the resumable sync password change
//! (src/main/sync/sync-password-change.ts): start, resume, revert, abandon,
//! the deletion of files neither password opens, the recovery at startup
//! and the status for the renderer. The re-encryption is in
//! [`super::switch`], the local state and keys in [`super::state`], the
//! Drive lock in [`super::lock`].
//!
//! Every operation holds the password-change run of the sync runtime (the
//! sync lock, not waitable) until all of its work has ended, so no other
//! sync runs alongside it; none starts while sync work runs or a sign-in or
//! sign-out switches tokens, and a sign-out is refused while one runs. The
//! operations do not run the sync guard, which a change in progress would
//! stop: they check only that Drive needs no newer sync format, before
//! they take a lock or write data. Abandoning and the `locking` and
//! `cleanup` steps only remove our own lock and local files, so they stay
//! allowed; the way out of a change is never blocked.

use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use pipette_secret_store::SecretStore;
use pipette_sync_format::drive_names::is_data_file_name;
use serde::Serialize;

use super::change_error::{ChangeErrorKey, PasswordChangeError};
use super::check::find_password_check;
use super::lock::{AcquireOutcome, DriveLocks, LockTiming, PasswordChangeLock};
use super::state::{
    ChangeKeys, ChangeKeysFailure, ChangeStateRead, ChangeStep, ChangeTarget, PasswordChangeState,
    clear_change_keys, retrieve_change_keys, store_change_keys,
};
use super::switch::FileKeyState;
use crate::codec::EnvelopeCodec;
use crate::execute::SYNC_CONCURRENCY;
use crate::preflight::{Preflight, PreflightError};

/// `passwordChangeTuning`: files per batch (the lock is checked again
/// before each), passes over Drive before giving up while files keep
/// needing conversion (another machine writing with a stale key), and
/// files converted at a time.
#[derive(Clone, Copy, Debug)]
pub struct PasswordChangeTuning {
    pub chunk_size: usize,
    pub max_passes: usize,
    pub concurrency: usize,
}

impl Default for PasswordChangeTuning {
    fn default() -> Self {
        Self { chunk_size: 50, max_passes: 3, concurrency: SYNC_CONCURRENCY }
    }
}

/// This machine's hash (`getMachineHash`); the error is its message.
pub type MachineHash = Arc<dyn Fn() -> Result<String, String> + Send + Sync>;

/// A new random lock id (`randomUUID`).
pub type NewLockId = Arc<dyn Fn() -> String + Send + Sync>;

/// A random version-4 UUID, as `randomUUID` writes it.
pub fn random_lock_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// What a [`PasswordChange`] is built from.
pub struct PasswordChangeDeps {
    pub preflight: Arc<Preflight>,
    /// Where the change's keys are kept.
    pub secrets: Arc<SecretStore>,
    pub codec: Arc<dyn EnvelopeCodec>,
    pub machine_hash: MachineHash,
    pub new_lock_id: NewLockId,
    pub lock_timing: LockTiming,
    pub tuning: PasswordChangeTuning,
}

/// `PasswordChangeFile`: a Drive file neither password opens.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PasswordChangeFile {
    pub id: String,
    pub name: String,
}

/// What this process remembers of the change
/// (`passwordChangeUndecryptable`, `passwordChangeLockLost`).
#[derive(Default)]
pub(crate) struct ChangeMemory {
    pub undecryptable: Option<Vec<PasswordChangeFile>>,
    pub lock_lost: bool,
}

/// `PasswordChangeStatus`: no passwords, no lock ids.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PasswordChangeStatus {
    None,
    #[serde(rename_all = "camelCase")]
    InProgress {
        target: ChangeTarget,
        step: ChangeStep,
        started_at: f64,
        /// The last run stopped because this machine no longer held its
        /// lock.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        lock_lost: bool,
        /// The files that stopped the last run.
        #[serde(skip_serializing_if = "Option::is_none")]
        undecryptable: Option<Vec<PasswordChangeFile>>,
    },
    /// The local state file cannot be read.
    Invalid,
    /// The state is fine but the saved passwords cannot be read.
    #[serde(rename_all = "camelCase")]
    KeysUnavailable {
        reason: ChangeKeysFailure,
        target: ChangeTarget,
        step: ChangeStep,
        started_at: f64,
    },
}

/// `PasswordChangeRecovery`: what the startup recovery did.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PasswordChangeRecovery {
    None,
    Invalid,
    Busy,
    Abandoned,
    AwaitingUser,
    LockLost,
    KeysUnavailable,
    Completed,
    Failed,
}

/// `DeleteUndecryptableResult`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct DeleteUndecryptableResult {
    pub deleted: Vec<String>,
    /// Ids that are not data files on Drive or open with one of the keys.
    pub skipped: Vec<String>,
}

/// The password change of this machine.
pub struct PasswordChange {
    pub(crate) preflight: Arc<Preflight>,
    pub(crate) secrets: Arc<SecretStore>,
    pub(crate) codec: Arc<dyn EnvelopeCodec>,
    pub(crate) machine_hash: MachineHash,
    new_lock_id: NewLockId,
    lock_timing: LockTiming,
    pub(crate) tuning: PasswordChangeTuning,
    memory: Mutex<ChangeMemory>,
}

/// The file id of a lock taken, or the error of one not taken.
fn acquired_file_id(outcome: AcquireOutcome) -> Result<String, PasswordChangeError> {
    match outcome {
        AcquireOutcome::Acquired(file_id) => Ok(file_id),
        AcquireOutcome::Locked(_) => Err(ChangeErrorKey::Locked.into()),
        AcquireOutcome::Lost => Err(ChangeErrorKey::Lost.into()),
    }
}

impl PasswordChange {
    pub fn new(deps: PasswordChangeDeps) -> Arc<Self> {
        Arc::new(Self {
            preflight: deps.preflight,
            secrets: deps.secrets,
            codec: deps.codec,
            machine_hash: deps.machine_hash,
            new_lock_id: deps.new_lock_id,
            lock_timing: deps.lock_timing,
            tuning: deps.tuning,
            memory: Mutex::default(),
        })
    }

    pub fn preflight(&self) -> &Arc<Preflight> {
        &self.preflight
    }

    pub(crate) fn memory(&self) -> MutexGuard<'_, ChangeMemory> {
        self.memory.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn locks(&self) -> DriveLocks<'_> {
        DriveLocks { drive: &self.preflight.drive, timing: &self.lock_timing }
    }

    /// `withSyncLock`: runs `work` as the password-change run. Refused at
    /// once while sync work runs or tokens are being switched.
    async fn with_sync_lock<T>(
        &self,
        work: impl Future<Output = Result<T, PasswordChangeError>>,
    ) -> Result<T, PasswordChangeError> {
        let Some(run) = self.preflight.runtime().try_start_password_change() else {
            return Err(PasswordChangeError::Refused);
        };
        let answer = work.await;
        drop(run);
        answer
    }

    async fn load_state(&self) -> Result<PasswordChangeState, PasswordChangeError> {
        match self.preflight.change_state.read().await {
            ChangeStateRead::None => Err(ChangeErrorKey::NotInProgress.into()),
            ChangeStateRead::Invalid => Err(ChangeErrorKey::InvalidState.into()),
            ChangeStateRead::Ok(state) => Ok(state),
        }
    }

    async fn load_keys(&self) -> Result<ChangeKeys, PasswordChangeError> {
        retrieve_change_keys(&self.secrets).await.map_err(|_| ChangeErrorKey::KeysUnavailable.into())
    }

    /// Our lock's file id: the saved one, or the one found by `lockId`
    /// when it was never saved.
    async fn own_lock_file_id(
        &self,
        state: &PasswordChangeState,
    ) -> Result<Option<String>, PasswordChangeError> {
        match &state.lock_file_id {
            Some(file_id) => Ok(Some(file_id.clone())),
            None => self.locks().find_own(&state.lock_id).await,
        }
    }

    /// Removes our lock if Drive has it, then forgets the change. When the
    /// removal fails the local state stays, so the lock can still be found
    /// later.
    async fn abandon_locking(&self, state: &PasswordChangeState) -> Result<(), PasswordChangeError> {
        if let Some(file_id) = self.own_lock_file_id(state).await? {
            self.locks().release(&file_id).await?;
        }
        self.clear_local_change().await
    }

    /// Takes the Drive lock for `state`, saving the new file id in the
    /// state as soon as Drive creates it. Returns the state as saved.
    async fn acquire_lock_for(
        &self,
        state: &PasswordChangeState,
    ) -> Result<(PasswordChangeState, AcquireOutcome), PasswordChangeError> {
        let machine_hash = (self.machine_hash)().map_err(PasswordChangeError::Other)?;
        // `new Date(startedAt).toISOString()`.
        let started_at = pipette_time::iso_8601_millis_checked(state.started_at.trunc() as i64)
            .ok_or_else(|| PasswordChangeError::Other("Invalid time value".to_owned()))?;
        let lock = PasswordChangeLock { lock_id: state.lock_id.clone(), machine_hash, started_at };
        let saved = Mutex::new(state.clone());
        let saved_ref = &saved;
        let outcome = self
            .locks()
            .acquire(&lock, move |file_id| async move {
                let current = PasswordChangeState { lock_file_id: Some(file_id), ..state.clone() };
                self.write_state(&current).await?;
                *saved_ref.lock().unwrap_or_else(PoisonError::into_inner) = current;
                Ok(())
            })
            .await?;
        Ok((saved.into_inner().unwrap_or_else(PoisonError::into_inner), outcome))
    }

    /// Before a run: keeps our lock while we hold it; when it is gone and
    /// no other lock exists, takes a new one; when another machine's lock
    /// exists, fails with `locked` and leaves the state as it is.
    async fn hold_lock_for_run(
        &self,
        state: PasswordChangeState,
    ) -> Result<PasswordChangeState, PasswordChangeError> {
        let mut state = state;
        if !self.is_own_lock_held(&state).await? {
            let (saved, outcome) = self.acquire_lock_for(&state).await?;
            state = PasswordChangeState { lock_file_id: Some(acquired_file_id(outcome)?), ..saved };
            self.write_state(&state).await?;
        }
        self.memory().lock_lost = false;
        Ok(state)
    }

    /// `startPasswordChange`: saves the progress and both passwords
    /// locally, takes the Drive lock, then runs the switch. A failure after
    /// the lock is taken leaves the change at `reencrypting` for a resume
    /// or a revert.
    pub async fn start(&self, new_password: &str) -> Result<(), PasswordChangeError> {
        self.with_sync_lock(async {
            if self.preflight.change_state.read().await != ChangeStateRead::None {
                return Err(ChangeErrorKey::AlreadyInProgress.into());
            }
            let old_password =
                self.preflight.require_sync_credentials().await.map_err(PreflightError::Credential)?;
            if new_password == old_password.as_str() {
                return Err(PasswordChangeError::SamePassword);
            }
            let generation = self.preflight.sync_format_generation();
            let listing = self.preflight.drive.list_files(None).await?;
            self.preflight.assert_sync_format_supported(Some((&listing, generation))).await?;
            // A missing password-check is created at commit.
            if let Some(check) = find_password_check(&listing)
                && !self.file_opens_with(check, &old_password).await?
            {
                return Err(PreflightError::PasswordMismatch.into());
            }

            // The state before the keys: keys without a state are removed
            // at startup, while a state without keys can still be abandoned.
            let mut state = PasswordChangeState {
                target: ChangeTarget::New,
                step: ChangeStep::Locking,
                lock_id: (self.new_lock_id)(),
                lock_file_id: None,
                started_at: self.preflight.now() as f64,
            };
            self.write_state(&state).await?;
            let keys = ChangeKeys::new(&old_password, new_password);
            if let Err(err) = store_change_keys(&self.secrets, &keys).await {
                if let Err(clear) = self.preflight.change_state.clear().await {
                    log::warn!("sync password change: cannot remove the state after a failed start: {clear}");
                }
                return Err(PasswordChangeError::Other(err));
            }
            self.memory().lock_lost = false;

            // When undoing the lock attempt fails, the `locking` state stays
            // for the startup recovery to remove the lock.
            let acquired = self.acquire_lock_for(&state).await;
            let (saved, outcome) = match acquired {
                Ok(acquired) => acquired,
                Err(err) => {
                    self.undo_locking(&state).await;
                    return Err(err);
                }
            };
            state = saved;
            let file_id = match acquired_file_id(outcome) {
                Ok(file_id) => file_id,
                Err(err) => {
                    self.undo_locking(&state).await;
                    return Err(err);
                }
            };
            state =
                PasswordChangeState { lock_file_id: Some(file_id), step: ChangeStep::Reencrypting, ..state };
            self.write_state(&state).await?;
            self.run_password_switch(state, &keys).await
        })
        .await
    }

    async fn undo_locking(&self, state: &PasswordChangeState) {
        if let Err(err) = self.abandon_locking(state).await {
            log::warn!("sync password change: cannot undo the lock attempt: {err}");
        }
    }

    /// `resumePasswordChange`: continues an interrupted change (or
    /// rollback) in its direction. `locking` and `cleanup` need no keys.
    pub async fn resume(&self) -> Result<(), PasswordChangeError> {
        self.with_sync_lock(async {
            let state = self.load_state().await?;
            match state.step {
                ChangeStep::Locking => {
                    self.abandon_locking(&state).await?;
                    return Err(ChangeErrorKey::NotStarted.into());
                }
                ChangeStep::Cleanup => return self.cleanup_change(&state).await,
                ChangeStep::Reencrypting | ChangeStep::Committing => {}
            }
            self.preflight.assert_sync_format_supported(None).await?;
            let keys = self.load_keys().await?;
            let held = self.hold_lock_for_run(state).await?;
            self.run_password_switch(held, &keys).await
        })
        .await
    }

    /// `revertPasswordChange`: turns an interrupted change around and runs
    /// it. Only while re-encrypting: from `committing` on the change
    /// finishes, and a new change is the way back.
    pub async fn revert(&self) -> Result<(), PasswordChangeError> {
        self.with_sync_lock(async {
            let state = self.load_state().await?;
            if state.step != ChangeStep::Reencrypting {
                return Err(ChangeErrorKey::WrongStep.into());
            }
            self.preflight.assert_sync_format_supported(None).await?;
            let keys = self.load_keys().await?;
            let held = self.hold_lock_for_run(state).await?;
            let reverted = PasswordChangeState { target: held.target.flipped(), ..held };
            self.write_state(&reverted).await?;
            self.run_password_switch(reverted, &keys).await
        })
        .await
    }

    /// `abandonPasswordChange`: gives a change up without the keys,
    /// releasing our lock (best effort) and removing the local keys and
    /// state. Drive files stay on whichever key they are on, so they may
    /// stay mixed. For when the keys cannot be read or the password-check
    /// opens with neither key.
    pub async fn abandon(&self) -> Result<(), PasswordChangeError> {
        self.with_sync_lock(async {
            match self.preflight.change_state.read().await {
                ChangeStateRead::None => return Err(ChangeErrorKey::NotInProgress.into()),
                ChangeStateRead::Ok(state) => {
                    let released = match self.own_lock_file_id(&state).await {
                        Ok(Some(file_id)) => self.locks().release(&file_id).await,
                        Ok(None) => Ok(()),
                        Err(err) => Err(err),
                    };
                    if let Err(err) = released {
                        log::warn!("sync password change: cannot release the lock while abandoning: {err}");
                    }
                }
                ChangeStateRead::Invalid => {}
            }
            self.clear_local_change().await
        })
        .await
    }

    /// `deletePasswordChangeUndecryptableFiles`: deletes the given Drive
    /// files, each only after checking again that it is a data file neither
    /// password opens. Only while re-encrypting and holding the lock.
    pub async fn delete_undecryptable(
        &self,
        file_ids: &[String],
    ) -> Result<DeleteUndecryptableResult, PasswordChangeError> {
        self.with_sync_lock(async {
            let state = self.load_state().await?;
            if state.step != ChangeStep::Reencrypting {
                return Err(ChangeErrorKey::WrongStep.into());
            }
            self.preflight.assert_sync_format_supported(None).await?;
            let keys = self.load_keys().await?;
            self.hold_lock_for_run(state.clone()).await?;

            let listing = self.preflight.drive.list_files(None).await?;
            let mut result = DeleteUndecryptableResult::default();
            for id in file_ids {
                let file = listing.iter().find(|file| &file.id == id && is_data_file_name(&file.name));
                let neither = match file {
                    Some(file) => matches!(
                        self.read_file_key_state(file, &keys, state.target, false).await?,
                        FileKeyState::Neither
                    ),
                    None => false,
                };
                if neither {
                    self.preflight.drive.delete_file(id).await?;
                    result.deleted.push(id.clone());
                } else {
                    result.skipped.push(id.clone());
                }
            }
            let mut memory = self.memory();
            if let Some(remaining) = memory.undecryptable.take() {
                let remaining: Vec<_> =
                    remaining.into_iter().filter(|file| !result.deleted.contains(&file.id)).collect();
                memory.undecryptable = (!remaining.is_empty()).then_some(remaining);
            }
            Ok(result)
        })
        .await
    }

    /// `recoverPasswordChangeOnStartup`, run once at startup. No state:
    /// keys left by a start that never wrote its state are removed.
    /// `locking`: the change never started, so our lock is removed and the
    /// change forgotten. `reencrypting`: waits for the user's resume or
    /// revert, and reports `lockLost` when our lock is gone. `committing`
    /// and `cleanup`: finished here. Failures are logged, never returned;
    /// the state stays for the next try.
    pub async fn recover_on_startup(&self) -> PasswordChangeRecovery {
        // Whatever an earlier check cached is not taken for the file.
        self.preflight.forget_change_state_cache();
        match self.recover().await {
            Ok(recovery) => recovery,
            Err(err) => {
                log::error!("sync password change: startup recovery failed: {err}");
                PasswordChangeRecovery::Failed
            }
        }
    }

    /// Removes keys a start left without writing its state. Only as the
    /// password-change run, with the state read again under it: a change
    /// started meanwhile writes its state before its keys, and its keys
    /// must stay. While other work holds the run they are left for the
    /// next launch.
    async fn clear_keys_left_without_state(&self) -> Result<(), PasswordChangeError> {
        let Some(run) = self.preflight.runtime().try_start_password_change() else { return Ok(()) };
        let cleared = match self.preflight.change_state.read().await {
            ChangeStateRead::None => {
                clear_change_keys(&self.secrets).await.map_err(PasswordChangeError::Other)
            }
            ChangeStateRead::Ok(_) | ChangeStateRead::Invalid => Ok(()),
        };
        drop(run);
        cleared
    }

    async fn recover(&self) -> Result<PasswordChangeRecovery, PasswordChangeError> {
        let state = match self.preflight.change_state.read().await {
            ChangeStateRead::None => {
                self.clear_keys_left_without_state().await?;
                return Ok(PasswordChangeRecovery::None);
            }
            ChangeStateRead::Invalid => {
                log::warn!(
                    "sync password change: state file is unreadable; Drive files are left as they are"
                );
                return Ok(PasswordChangeRecovery::Invalid);
            }
            ChangeStateRead::Ok(state) => state,
        };
        let runtime = self.preflight.runtime();
        if runtime.sync_work_running() || runtime.account_switching() {
            return Ok(PasswordChangeRecovery::Busy);
        }
        self.with_sync_lock(async {
            match state.step {
                ChangeStep::Locking => {
                    self.abandon_locking(&state).await?;
                    return Ok(PasswordChangeRecovery::Abandoned);
                }
                ChangeStep::Reencrypting => {
                    if self.is_own_lock_held(&state).await? {
                        return Ok(PasswordChangeRecovery::AwaitingUser);
                    }
                    self.memory().lock_lost = true;
                    log::warn!("sync password change: this machine no longer holds the Drive lock");
                    return Ok(PasswordChangeRecovery::LockLost);
                }
                ChangeStep::Cleanup => {
                    self.cleanup_change(&state).await?;
                    return Ok(PasswordChangeRecovery::Completed);
                }
                ChangeStep::Committing => {}
            }
            self.preflight.assert_sync_format_supported(None).await?;
            let keys = match retrieve_change_keys(&self.secrets).await {
                Ok(keys) => keys,
                Err(reason) => {
                    log::warn!("sync password change: cannot read the change keys ({})", reason.as_str());
                    return Ok(PasswordChangeRecovery::KeysUnavailable);
                }
            };
            let held = self.hold_lock_for_run(state.clone()).await?;
            self.run_password_switch(held, &keys).await?;
            Ok(PasswordChangeRecovery::Completed)
        })
        .await
    }

    /// `getPasswordChangeStatus`: the progress for the renderer.
    pub async fn status(&self) -> PasswordChangeStatus {
        let state = match self.preflight.change_state.read().await {
            ChangeStateRead::None => return PasswordChangeStatus::None,
            ChangeStateRead::Invalid => return PasswordChangeStatus::Invalid,
            ChangeStateRead::Ok(state) => state,
        };
        let PasswordChangeState { target, step, started_at, .. } = state;
        if let Err(reason) = retrieve_change_keys(&self.secrets).await {
            return PasswordChangeStatus::KeysUnavailable { reason, target, step, started_at };
        }
        let memory = self.memory();
        PasswordChangeStatus::InProgress {
            target,
            step,
            started_at,
            lock_lost: memory.lock_lost,
            undecryptable: memory.undecryptable.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lock_id_is_a_random_uuid_as_random_uuid_writes_it() {
        let id = random_lock_id();
        assert_eq!(id.len(), 36);
        assert_eq!(id.as_bytes()[14], b'4');
        assert!(id.chars().all(|c| c == '-' || c.is_ascii_digit() || c.is_ascii_lowercase()));
        assert_ne!(id, random_lock_id());
    }
}
