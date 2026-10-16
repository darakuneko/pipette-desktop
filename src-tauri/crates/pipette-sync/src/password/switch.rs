// SPDX-License-Identifier: GPL-2.0-or-later
//! The switch run of a sync password change
//! (src/main/sync/sync-password-switch.ts): re-encrypt every Drive file
//! towards the state's target, then commit (password-check and stored
//! password) and clean up. The same run serves a change (target `new`)
//! and a rollback (target `old`); every step is safe to repeat after an
//! interruption, because each file is judged by which key opens it. Until
//! the commit, every data file opens with the old or the new password, so
//! a change stopped anywhere leaves Drive readable with the keys it keeps.
//!
//! The callers ([`super::change`]) hold the password-change run (the sync
//! lock) around [`PasswordChange::run_password_switch`].

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use futures_util::future::join_all;
use pipette_drive::DriveFile;
use pipette_drive::canonical::Listing;
use pipette_sync_format::Envelope;
use pipette_sync_format::drive_names::is_data_file_name;
use zeroize::Zeroizing;

use super::change::{PasswordChange, PasswordChangeFile};
use super::change_error::{ChangeErrorKey, PasswordChangeError};
use super::check::{find_password_check, listed_password_checks, password_check_file_name};
use super::state::{ChangeKeys, ChangeStep, ChangeTarget, PasswordChangeState, clear_change_keys};
use crate::preflight::PreflightError;

/// Which key opens a downloaded file.
pub(crate) enum FileKeyState {
    Target,
    /// The other key, with what it opened to.
    Other {
        plaintext: String,
        sync_unit: String,
    },
    Neither,
}

enum FileOutcome {
    Target,
    Neither,
    /// Written on the target key; the new `modifiedTime`.
    Converted(String),
}

/// Within one run: file id → the `modifiedTime` at which the file was known
/// to be on the target key (checked, or written by us). A later pass skips
/// the file while its listed `modifiedTime` still matches; a peer's write
/// changes it, so the file is checked again.
type ConfirmedOnTarget = HashMap<String, String>;

/// `runConcurrently` of src/shared/concurrency.ts: what the workers left.
struct ConcurrentRun<R> {
    /// By item; `None` for an item that failed or never started.
    results: Vec<Option<R>>,
    /// The failure of the first failed item in item order.
    first_error: Option<PasswordChangeError>,
    /// Whether an item was not started (after a failure or a stop).
    stopped: bool,
}

/// Runs `worker` over `items`, at most `concurrency` at a time, starting
/// them in order. Once one fails or `should_stop` answers true no further
/// item starts, and it returns only after every started worker has ended.
async fn run_concurrently<'a, T, R, F, Fut>(
    items: &'a [T],
    concurrency: usize,
    worker: F,
    should_stop: impl Fn() -> bool,
) -> ConcurrentRun<R>
where
    F: Fn(&'a T) -> Fut,
    Fut: Future<Output = Result<R, PasswordChangeError>>,
{
    let next = AtomicUsize::new(0);
    let started = AtomicUsize::new(0);
    let halted = AtomicBool::new(false);
    let results: Mutex<Vec<Option<R>>> = Mutex::new((0..items.len()).map(|_| None).collect());
    let errors: Mutex<Vec<(usize, PasswordChangeError)>> = Mutex::new(Vec::new());
    let lane = || async {
        while next.load(Ordering::SeqCst) < items.len() {
            if halted.load(Ordering::SeqCst) || should_stop() {
                halted.store(true, Ordering::SeqCst);
                return;
            }
            let index = next.fetch_add(1, Ordering::SeqCst);
            started.fetch_add(1, Ordering::SeqCst);
            match worker(&items[index]).await {
                Ok(result) => results.lock().unwrap_or_else(|e| e.into_inner())[index] = Some(result),
                Err(err) => {
                    errors.lock().unwrap_or_else(|e| e.into_inner()).push((index, err));
                    halted.store(true, Ordering::SeqCst);
                }
            }
        }
    };
    join_all((0..concurrency.max(1).min(items.len())).map(|_| lane())).await;
    let mut errors = errors.into_inner().unwrap_or_else(|e| e.into_inner());
    errors.sort_by_key(|(index, _)| *index);
    ConcurrentRun {
        results: results.into_inner().unwrap_or_else(|e| e.into_inner()),
        first_error: errors.into_iter().next().map(|(_, err)| err),
        stopped: started.into_inner() < items.len(),
    }
}

fn other(err: String) -> PasswordChangeError {
    PasswordChangeError::Other(err)
}

impl PasswordChange {
    pub(crate) async fn write_state(&self, state: &PasswordChangeState) -> Result<(), PasswordChangeError> {
        self.preflight.change_state.write(state).await.map_err(other)
    }

    /// `clearLocalChange`: removes the local keys and state file, and what
    /// this run remembered about the change. Drive is not touched.
    pub(crate) async fn clear_local_change(&self) -> Result<(), PasswordChangeError> {
        clear_change_keys(&self.secrets).await.map_err(other)?;
        self.preflight.change_state.clear().await.map_err(other)?;
        let mut memory = self.memory();
        memory.undecryptable = None;
        memory.lock_lost = false;
        Ok(())
    }

    /// Whether this machine still holds the lock it saved.
    pub(crate) async fn is_own_lock_held(
        &self,
        state: &PasswordChangeState,
    ) -> Result<bool, PasswordChangeError> {
        match &state.lock_file_id {
            Some(file_id) => self.locks().is_held(file_id).await,
            None => Ok(false),
        }
    }

    /// Our lock is gone (another machine released it) or another lock is
    /// earlier: stop writing. Keys and state stay, so the change can be
    /// resumed (with a new lock) or abandoned; the status reports
    /// `lockLost`.
    async fn ensure_lock_held(&self, state: &PasswordChangeState) -> Result<(), PasswordChangeError> {
        if self.is_own_lock_held(state).await? {
            return Ok(());
        }
        self.memory().lock_lost = true;
        Err(ChangeErrorKey::LockLost.into())
    }

    /// The plaintext and sync unit of a downloaded envelope; `None` when it
    /// is not an envelope or `password` does not open it.
    async fn open_envelope(&self, raw: &[u8], password: &str) -> Option<(String, String)> {
        let envelope: Envelope = serde_json::from_str(&String::from_utf8_lossy(raw)).ok()?;
        let password = Zeroizing::new(password.to_owned());
        let plaintext = self.codec.open(raw.to_vec(), password).await.ok()?;
        Some((plaintext, envelope.sync_unit))
    }

    /// `fileOpensWith`: whether `password` opens the downloaded `file`.
    pub(crate) async fn file_opens_with(
        &self,
        file: &DriveFile,
        password: &str,
    ) -> Result<bool, PasswordChangeError> {
        let raw = self.preflight.drive.download(&file.id).await?;
        Ok(self.open_envelope(&raw, password).await.is_some())
    }

    /// `readFileKeyState`: downloads `file` and reports which key opens it.
    /// A failed download fails; only a failed open is `Neither`.
    /// `other_first` tries the other key first: each wrong try costs a key
    /// derivation, so the likelier key goes first.
    pub(crate) async fn read_file_key_state(
        &self,
        file: &DriveFile,
        keys: &ChangeKeys,
        target: ChangeTarget,
        other_first: bool,
    ) -> Result<FileKeyState, PasswordChangeError> {
        let raw = self.preflight.drive.download(&file.id).await?;
        if !other_first && self.open_envelope(&raw, keys.key_for(target)).await.is_some() {
            return Ok(FileKeyState::Target);
        }
        if let Some((plaintext, sync_unit)) = self.open_envelope(&raw, keys.other_key(target)).await {
            return Ok(FileKeyState::Other { plaintext, sync_unit });
        }
        if other_first && self.open_envelope(&raw, keys.key_for(target)).await.is_some() {
            return Ok(FileKeyState::Target);
        }
        Ok(FileKeyState::Neither)
    }

    async fn convert_file(
        &self,
        file: &DriveFile,
        keys: &ChangeKeys,
        target: ChangeTarget,
        other_first: bool,
    ) -> Result<FileOutcome, PasswordChangeError> {
        let (plaintext, sync_unit) = match self.read_file_key_state(file, keys, target, other_first).await? {
            FileKeyState::Target => return Ok(FileOutcome::Target),
            FileKeyState::Neither => return Ok(FileOutcome::Neither),
            FileKeyState::Other { plaintext, sync_unit } => (plaintext, sync_unit),
        };
        let password = Zeroizing::new(keys.key_for(target).to_owned());
        let content = self.codec.seal(plaintext, password, sync_unit).await.map_err(other)?;
        let uploaded = self.preflight.drive.upload_file(&file.name, &content, Some(&file.id), false).await?;
        Ok(FileOutcome::Converted(uploaded.modified_time))
    }

    /// Renames every listed data file that is not the chosen copy of its
    /// name to a trash name. Sync reads only the chosen copy, and
    /// re-encrypting the others under their shared name would move the
    /// newest `modifiedTime`, and with it the choice, to whichever finished
    /// last. A failed rename fails the pass; a resume renames the copy
    /// again (a copy already gone counts as renamed). Returns whether
    /// anything was renamed.
    async fn trash_unchosen_copies(&self, listed: &[DriveFile]) -> Result<bool, PasswordChangeError> {
        let listing = Listing::new(listed.to_vec());
        let chosen: Vec<&str> = listing.canonical_files().into_iter().map(|file| file.id.as_str()).collect();
        let extras: Vec<DriveFile> =
            listed.iter().filter(|file| !chosen.contains(&file.id.as_str())).cloned().collect();
        if extras.is_empty() {
            return Ok(false);
        }
        let now_ms = i64::try_from(self.preflight.now()).unwrap_or(i64::MAX);
        let remote = self.preflight.runtime().remote();
        let outcome = self
            .preflight
            .drive
            .move_files_to_trash(&extras, now_ms, &|id| remote.forget_created_file_id(id))
            .await;
        if outcome.failed > 0 {
            return Err(other(format!(
                "Failed to move {} of {} duplicate files to trash: {}",
                outcome.failed,
                outcome.attempted,
                outcome.first_error.unwrap_or_default()
            )));
        }
        Ok(true)
    }

    /// One pass over every data file: duplicate copies are renamed to
    /// trash first, then every listed file (trash files too, so one can
    /// still be renamed back and read after the change) is re-encrypted.
    /// Files are written by id, so a copy renamed in this pass is converted
    /// under its trash name. A failure ends the pass once the started
    /// workers end; the lock is checked again after the renames and before
    /// each batch after the first. Returns how many files were converted
    /// and the files neither key opens.
    async fn run_pass(
        &self,
        state: &PasswordChangeState,
        keys: &ChangeKeys,
        listed: &[DriveFile],
        confirmed: &mut ConfirmedOnTarget,
        other_first: bool,
    ) -> Result<(usize, Vec<DriveFile>), PasswordChangeError> {
        let (mut converted, mut undecryptable) = (0, Vec::new());
        // The caller checked the lock right before this pass; after renames
        // it is checked again, even when nothing is left to convert.
        if self.trash_unchosen_copies(listed).await? {
            self.ensure_lock_held(state).await?;
        }
        let files: Vec<&DriveFile> =
            listed.iter().filter(|file| confirmed.get(&file.id) != Some(&file.modified_time)).collect();
        let runtime = self.preflight.runtime();
        for (index, chunk) in files.chunks(self.tuning.chunk_size.max(1)).enumerate() {
            if runtime.is_quitting() {
                return Err(ChangeErrorKey::Interrupted.into());
            }
            if index > 0 {
                self.ensure_lock_held(state).await?;
            }
            let run = run_concurrently(
                chunk,
                self.tuning.concurrency,
                |file| self.convert_file(file, keys, state.target, other_first),
                || runtime.is_quitting(),
            )
            .await;
            if let Some(err) = run.first_error {
                return Err(err);
            }
            if run.stopped {
                return Err(ChangeErrorKey::Interrupted.into());
            }
            for (file, outcome) in chunk.iter().zip(run.results) {
                match outcome {
                    Some(FileOutcome::Target) => {
                        confirmed.insert(file.id.clone(), file.modified_time.clone());
                    }
                    Some(FileOutcome::Converted(modified_time)) => {
                        converted += 1;
                        confirmed.insert(file.id.clone(), modified_time);
                    }
                    Some(FileOutcome::Neither) => undecryptable.push((*file).clone()),
                    None => {}
                }
            }
        }
        Ok((converted, undecryptable))
    }

    /// Repeats passes until one finds every file already on the target key
    /// (a pass that skips every file counts), so files another machine
    /// wrote back with the other key are picked up.
    async fn reencrypt_all(
        &self,
        state: &PasswordChangeState,
        keys: &ChangeKeys,
    ) -> Result<(), PasswordChangeError> {
        let mut confirmed = ConfirmedOnTarget::new();
        for pass in 0..self.tuning.max_passes {
            // Checked on every pass, also one that ends up skipping every file.
            if self.preflight.runtime().is_quitting() {
                return Err(ChangeErrorKey::Interrupted.into());
            }
            self.ensure_lock_held(state).await?;
            let generation = self.preflight.sync_format_generation();
            let listed = self.preflight.drive.list_files(None).await?;
            self.preflight.assert_sync_format_supported(Some((&listed, generation))).await?;
            let other_first = if pass == 0 {
                // The re-encrypted files are data in our format, so our
                // marker goes first, as in every other pass that writes
                // data.
                self.preflight.ensure_sync_format_marker(&listed, generation).await?;
                // Mid-change the password-check may be on either key; a
                // third key means another machine changed the password, so
                // nothing is written. Data files most likely share its key,
                // so the first pass tries that key first.
                match find_password_check(&listed) {
                    Some(check) => match self.read_file_key_state(check, keys, state.target, false).await? {
                        FileKeyState::Neither => return Err(PreflightError::PasswordMismatch.into()),
                        FileKeyState::Other { .. } => true,
                        FileKeyState::Target => false,
                    },
                    None => false,
                }
            } else {
                false
            };
            let data_files: Vec<DriveFile> =
                listed.into_iter().filter(|file| is_data_file_name(&file.name)).collect();
            let (converted, undecryptable) =
                self.run_pass(state, keys, &data_files, &mut confirmed, other_first).await?;
            if !undecryptable.is_empty() {
                self.memory().undecryptable = Some(
                    undecryptable
                        .into_iter()
                        .map(|file| PasswordChangeFile { id: file.id, name: file.name })
                        .collect(),
                );
                return Err(ChangeErrorKey::Undecryptable.into());
            }
            self.memory().undecryptable = None;
            if converted == 0 {
                return Ok(());
            }
        }
        Err(ChangeErrorKey::NotConverged.into())
    }

    /// Every data file is on the target key: points the password-check and
    /// the stored password at it too. The lock is not checked between these
    /// writes: stopping halfway would leave data and password-check on
    /// different keys.
    async fn commit(
        &self,
        state: &PasswordChangeState,
        keys: &ChangeKeys,
    ) -> Result<(), PasswordChangeError> {
        let password = keys.key_for(state.target);
        let listing = self.preflight.drive.list_files(Some(&password_check_file_name())).await?;
        let checks = listed_password_checks(&listing);
        let existing = find_password_check(&listing).map(|check| check.id.as_str());
        let written = self.preflight.write_password_check(password, existing).await?;
        // Extra password-checks (two machines creating one at once) would
        // still open with the other key; only the one just written stays.
        for extra in checks {
            if extra.id != written.id {
                self.preflight.drive.delete_file(&extra.id).await?;
            }
        }
        self.preflight.passwords.store(password).await.map_err(other)?;
        self.preflight.reset_password_check_cache();
        Ok(())
    }

    /// `cleanupChange`: releases our lock, then forgets the change.
    pub(crate) async fn cleanup_change(
        &self,
        state: &PasswordChangeState,
    ) -> Result<(), PasswordChangeError> {
        if let Some(file_id) = &state.lock_file_id {
            self.locks().release(file_id).await?;
        }
        self.clear_local_change().await
    }

    /// `runPasswordSwitch`: runs the remaining steps from `initial.step`,
    /// whose lock the caller holds. A failure before `committing` leaves
    /// the state at `reencrypting` for a resume or revert. `committing`
    /// runs the passes again first, so every data file is confirmed on the
    /// target key (and the lock held) before the password-check moves.
    pub(crate) async fn run_password_switch(
        &self,
        initial: PasswordChangeState,
        keys: &ChangeKeys,
    ) -> Result<(), PasswordChangeError> {
        let mut state = initial;
        if matches!(state.step, ChangeStep::Reencrypting | ChangeStep::Committing) {
            if let Err(err) = self.reencrypt_all(&state, keys).await {
                // The pre-commit check found files to fix: back to
                // `reencrypting`, where deleting undecryptable files and
                // reverting are allowed.
                if state.step == ChangeStep::Committing && err.is_not_converged() {
                    self.write_state(&PasswordChangeState { step: ChangeStep::Reencrypting, ..state })
                        .await?;
                }
                return Err(err);
            }
            if state.step == ChangeStep::Reencrypting {
                state.step = ChangeStep::Committing;
                self.write_state(&state).await?;
            }
        }
        if state.step == ChangeStep::Committing {
            self.commit(&state, keys).await?;
            state.step = ChangeStep::Cleanup;
            self.write_state(&state).await?;
        }
        if state.step == ChangeStep::Cleanup {
            self.cleanup_change(&state).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU32;

    use super::*;

    #[tokio::test]
    async fn a_failure_stops_new_items_and_the_started_ones_end() {
        let items: Vec<u32> = (0..10).collect();
        let started = AtomicU32::new(0);
        let run = run_concurrently(
            &items,
            3,
            |item| {
                started.fetch_add(1, Ordering::SeqCst);
                let item = *item;
                async move {
                    tokio::task::yield_now().await;
                    if item == 1 { Err(PasswordChangeError::Other(format!("boom {item}"))) } else { Ok(item) }
                }
            },
            || false,
        )
        .await;
        assert_eq!(run.first_error, Some(PasswordChangeError::Other("boom 1".into())));
        assert!(run.stopped);
        // The first lane ends its item before the second fails and starts
        // one more, as the lanes of `runConcurrently` do; then nothing.
        assert_eq!(started.load(Ordering::SeqCst), 4);
        assert_eq!(run.results[0], Some(0));
        assert_eq!(run.results[2], Some(2));
    }

    #[tokio::test]
    async fn a_stop_starts_nothing_more() {
        let items: Vec<u32> = (0..4).collect();
        let stop = AtomicBool::new(false);
        let run = run_concurrently(
            &items,
            1,
            |item| {
                if *item == 1 {
                    stop.store(true, Ordering::SeqCst);
                }
                std::future::ready(Ok(*item))
            },
            || stop.load(Ordering::SeqCst),
        )
        .await;
        assert!(run.first_error.is_none() && run.stopped);
        assert_eq!(run.results, vec![Some(0), Some(1), None, None]);
        let all = run_concurrently(&items, 10, |item| std::future::ready(Ok(*item)), || false).await;
        assert!(!all.stopped && all.results.iter().all(Option::is_some));
    }
}
