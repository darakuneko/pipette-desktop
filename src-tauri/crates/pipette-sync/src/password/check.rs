// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync credentials and the password-check: an envelope on Drive,
//! `password-check.enc`, that opens only with the sync password. Every pass
//! opens it before it writes with the stored password, so a machine holding an
//! old password stops instead of writing data the others cannot read.

use std::sync::{Arc, MutexGuard, PoisonError};

use pipette_drive::canonical::{is_newer_copy, modified_ms};
use pipette_drive::{DriveFile, UploadedFile};
use pipette_sync_format::Envelope;
use pipette_sync_format::drive_names::drive_file_name;
use pipette_sync_format::password_check::{
    PASSWORD_CHECK_UNIT, encrypt_password_check, password_check_matches,
};
use pipette_sync_runtime::{
    RemoteRevision, SyncCredentialFailureReason, SyncRuntime, ValidatedPasswordCheck,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::crypto::run_key_derivation;
use crate::preflight::{CREATED_MEMORY_MS, CreatedPasswordCheck, Preflight, PreflightError};
use crate::single_flight::Role;

/// The Drive file name of the password-check.
pub fn password_check_file_name() -> String {
    drive_file_name(PASSWORD_CHECK_UNIT)
}

/// Every password-check in `listing`. More than one can exist (two
/// machines creating it at once); see [`find_password_check`].
pub fn listed_password_checks(listing: &[DriveFile]) -> Vec<&DriveFile> {
    let name = password_check_file_name();
    listing.iter().filter(|file| file.name == name).collect()
}

/// The password-check every machine uses when several are listed: the copy
/// `Listing::pick_canonical` chooses, the newest `modifiedTime` with ties broken
/// by the smallest id.
pub fn find_password_check(listing: &[DriveFile]) -> Option<&DriveFile> {
    listed_password_checks(listing).into_iter().reduce(|best, file| {
        if is_newer_copy(modified_ms(file), &file.id, modified_ms(best), &best.id) { file } else { best }
    })
}

/// The password-check last validated, if `password` opened it. Every entry
/// point validates one before it writes, so during a pass this is the pass's
/// password-check.
pub fn validated_password_check(runtime: &SyncRuntime, password: &str) -> Option<RemoteRevision> {
    let check = runtime.credentials().validated_password_check()?;
    (check.password_fingerprint == fingerprint(password))
        .then_some(RemoteRevision { id: check.id, modified_time: check.modified_time })
}

fn revision(file: &DriveFile) -> UploadedFile {
    UploadedFile { id: file.id.clone(), modified_time: file.modified_time.clone(), version: file.version }
}

/// The SHA-256 digest of `password`, kept with the validated
/// password-check so a pass holding another password validates again.
fn fingerprint(password: &str) -> [u8; 32] {
    Sha256::digest(password.as_bytes()).into()
}

impl Preflight {
    fn created_password_check(&self) -> MutexGuard<'_, Option<CreatedPasswordCheck>> {
        self.password_check_created.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The stored password once signed in.
    pub async fn require_sync_credentials(&self) -> Result<Zeroizing<String>, SyncCredentialFailureReason> {
        if !self.sign_in.is_signed_in().await {
            return Err(SyncCredentialFailureReason::Unauthenticated);
        }
        self.passwords.retrieve().await
    }

    /// Fails with [`PreflightError::AccountChanged`] once the sign-out
    /// generation moved on from `generation`.
    fn assert_same_account(&self, generation: u64) -> Result<(), PreflightError> {
        if self.sync_format_generation() == generation { Ok(()) } else { Err(PreflightError::AccountChanged) }
    }

    /// The content of a password-check that opens with `password`.
    async fn password_check_content(password: &str) -> Result<String, PreflightError> {
        let password = Zeroizing::new(password.to_owned());
        let envelope = run_key_derivation(move || encrypt_password_check(&password))
            .await?
            .map_err(|err| PreflightError::Other(err.to_string()))?;
        serde_json::to_string(&envelope).map_err(|err| PreflightError::Other(err.to_string()))
    }

    /// Encrypts the password-check with `password` and uploads it, over
    /// `existing_id` when given, otherwise as a new file.
    pub async fn write_password_check(
        &self,
        password: &str,
        existing_id: Option<&str>,
    ) -> Result<UploadedFile, PreflightError> {
        let content = Self::password_check_content(password).await?;
        Ok(self.drive.upload_file(&password_check_file_name(), &content, existing_id, false).await?)
    }

    /// Remembers `file` as opened by `password`, unless the sign-in changed
    /// since `generation`.
    fn remember_validated(
        &self,
        file: &UploadedFile,
        password: &str,
        generation: u64,
    ) -> Result<(), PreflightError> {
        let check = ValidatedPasswordCheck {
            id: file.id.clone(),
            modified_time: file.modified_time.clone(),
            password_fingerprint: fingerprint(password),
        };
        if self.runtime.credentials().set_validated_password_check_in(generation, check) {
            Ok(())
        } else {
            Err(PreflightError::AccountChanged)
        }
    }

    fn forget_created_password_check(&self) {
        *self.created_password_check() = None;
    }

    /// The password-check this process created in `generation` recently
    /// enough that a listing without it is put down to listing lag; an
    /// older one is forgotten.
    fn recently_created_password_check(
        &self,
        created: &mut Option<CreatedPasswordCheck>,
        generation: u64,
    ) -> Option<UploadedFile> {
        let recent = created.as_ref()?;
        if recent.generation != generation {
            return None;
        }
        if self.now().saturating_sub(recent.at_ms) < CREATED_MEMORY_MS {
            return Some(recent.file.clone());
        }
        *created = None;
        None
    }

    /// Opens `file` with `password` and remembers it as validated; a
    /// password that does not open it is a mismatch. Content that is not
    /// JSON fails as it is; JSON that is not an envelope does not open.
    async fn open_password_check(
        &self,
        password: &str,
        file: &UploadedFile,
        generation: u64,
    ) -> Result<(), PreflightError> {
        let bytes = self.drive.download(&file.id).await?;
        let value: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes))
            .map_err(|err| PreflightError::Other(err.to_string()))?;
        let opens = match serde_json::from_value::<Envelope>(value) {
            Ok(envelope) => {
                let secret = Zeroizing::new(password.to_owned());
                run_key_derivation(move || password_check_matches(&envelope, &secret)).await?
            }
            Err(_) => false,
        };
        if !opens {
            self.runtime.credentials().forget_validated_password_check();
            return Err(PreflightError::PasswordMismatch);
        }
        self.remember_validated(file, password, generation)
    }

    /// The creation run: our sync-format marker first
    /// ([`Preflight::ensure_sync_format_marker_known`]: the caller's
    /// listing may be name-filtered; when the marker cannot be created,
    /// neither is the password-check), then the upload, sent only while
    /// the sign-in is still the one of `generation`. The created file is
    /// remembered under the created-file lock with the generation checked
    /// again, so a sign-out either refuses it or forgets it afterwards.
    /// When the sign-in changed while the upload was in flight, the file
    /// is deleted again by id: the request may have gone out with the next
    /// account's token, and a newer password-check there would replace
    /// that account's password. Under the previous account's token the
    /// delete finds nothing.
    async fn create_password_check(
        self: Arc<Self>,
        password: Zeroizing<String>,
        generation: u64,
    ) -> Result<UploadedFile, PreflightError> {
        self.ensure_sync_format_marker_known().await?;
        let content = Self::password_check_content(&password).await?;
        self.assert_same_account(generation)?;
        let file = self.drive.upload_file(&password_check_file_name(), &content, None, false).await?;
        {
            let mut created = self.created_password_check();
            if self.sync_format_generation() == generation {
                *created = Some(CreatedPasswordCheck { file: file.clone(), at_ms: self.now(), generation });
                return Ok(file);
            }
        }
        if let Err(err) = self.drive.delete_file(&file.id).await {
            log::warn!("password-check: cannot delete the one created across a sign-in change: {err}");
        }
        Err(PreflightError::AccountChanged)
    }

    /// Opens the password-check this process created recently, or creates
    /// it. The lookup and the start of (or join to) the creation happen
    /// under the created-file lock, which the creation also takes to
    /// remember its file before its run ends: a caller sees either the
    /// created file or the run under way, never neither. A caller that
    /// joins a run waits for it and opens what it created: that run may
    /// have used another password.
    async fn open_or_create_password_check(
        self: &Arc<Self>,
        password: &str,
        generation: u64,
    ) -> Result<(), PreflightError> {
        let flight = {
            let mut created = self.created_password_check();
            match self.recently_created_password_check(&mut created, generation) {
                Some(recent) => Err(recent),
                None => {
                    let preflight = Arc::clone(self);
                    let password = Zeroizing::new(password.to_owned());
                    Ok(self
                        .password_check_creating
                        .run(move || preflight.create_password_check(password, generation)))
                }
            }
        };
        let (role, created) = match flight {
            Err(recent) => return self.open_password_check(password, &recent, generation).await,
            Ok(flight) => flight,
        };
        let file = created.await?;
        match role {
            Role::Started => self.remember_validated(&file, password, generation),
            Role::Joined => self.open_password_check(password, &file, generation).await,
        }
    }

    /// Opens the chosen password-check ([`find_password_check`]) with
    /// `password` and remembers it as validated. When `listing` has none it
    /// is created, unless this process created one the listing does not
    /// show yet; that one is opened by id. Fails with a mismatch when the
    /// password-check does not open, and with
    /// [`PreflightError::AccountChanged`] when the sign-in changed since
    /// `generation` ([`Preflight::sync_format_generation`] taken before
    /// `listing` was requested).
    pub async fn validate_password_check(
        self: &Arc<Self>,
        password: &str,
        listing: &[DriveFile],
        generation: u64,
    ) -> Result<(), PreflightError> {
        if let Some(existing) = find_password_check(listing) {
            self.forget_created_password_check();
            return self.open_password_check(password, &revision(existing), generation).await;
        }
        self.open_or_create_password_check(password, generation).await
    }

    /// [`Preflight::validate_password_check`] unless the chosen
    /// password-check is the one last validated (same id and
    /// `modifiedTime`) and `password` is the one it opened with. A pass
    /// that read the stored password before a re-enter replaced it
    /// therefore validates again, and fails instead of writing with the
    /// old password. `listing` must be one that would show the
    /// password-check when it exists; `generation` is taken before it was
    /// requested.
    pub async fn ensure_password_check_validated(
        self: &Arc<Self>,
        password: &str,
        listing: &[DriveFile],
        generation: u64,
    ) -> Result<(), PreflightError> {
        if let (Some(existing), Some(validated)) =
            (find_password_check(listing), self.runtime.credentials().validated_password_check())
            && existing.id == validated.id
            && existing.modified_time == validated.modified_time
            && validated.password_fingerprint == fingerprint(password)
        {
            self.forget_created_password_check();
            return Ok(());
        }
        self.validate_password_check(password, listing, generation).await
    }

    /// A listing of just the password-check, for entry points whose own
    /// listing is name-filtered.
    pub async fn list_password_check_files(&self) -> Result<Vec<DriveFile>, PreflightError> {
        Ok(self.drive.list_files(Some(&password_check_file_name())).await?)
    }

    /// Forgets the validated and the created password-check.
    pub fn reset_password_check_cache(&self) {
        self.runtime.credentials().forget_validated_password_check();
        self.forget_created_password_check();
    }

    /// Whether Drive has a password-check.
    pub async fn password_check_exists(&self) -> Result<bool, PreflightError> {
        let listing = self.drive.list_files(None).await?;
        Ok(find_password_check(&listing).is_some())
    }

    /// Fails (`keystoreUnavailable`) when the OS key store cannot hold a
    /// password, so a save is refused before it touches Drive.
    fn assert_keystore_available<T>(
        stored: &Result<T, SyncCredentialFailureReason>,
    ) -> Result<(), PreflightError> {
        match stored {
            Err(SyncCredentialFailureReason::KeystoreUnavailable) => {
                Err(PreflightError::Credential(SyncCredentialFailureReason::KeystoreUnavailable))
            }
            _ => Ok(()),
        }
    }

    /// Sets the first password. Refused while a password change is in progress
    /// or Drive needs a newer app, before the password is stored; refused when
    /// a readable password is already stored, and when the OS key store is
    /// unavailable, both before any Drive call. A stored password that no
    /// longer decrypts is not refused: setting a new one is how it is replaced.
    /// A password that does not open the password-check on Drive, or that was
    /// validated against an account signed out meanwhile, is removed again.
    /// Sets and replaces run one at a time, so a second set sees the password
    /// the first one stored.
    pub async fn set_password_and_validate(self: &Arc<Self>, password: &str) -> Result<(), PreflightError> {
        let _setting = self.password_setting.lock().await;
        self.assert_no_local_password_change().await?;
        let stored = self.passwords.retrieve().await;
        Self::assert_keystore_available(&stored)?;
        // A failed validation below clears the stored password, so
        // overwriting a readable one here could erase the correct one;
        // re-enter and change are the paths that replace it.
        if stored.is_ok() {
            return Err(PreflightError::PasswordAlreadySet);
        }
        let generation = self.sync_format_generation();
        let listing = self.drive.list_files(None).await?;
        self.assert_sync_allowed(Some((&listing, generation))).await?;
        self.passwords.store(password).await.map_err(PreflightError::Other)?;
        self.reset_password_check_cache();
        if let Err(err) = self.validate_password_check(password, &listing, generation).await {
            self.passwords.clear().await;
            return Err(err);
        }
        Ok(())
    }

    /// Replaces the stored password with `password` once it opens the chosen
    /// password-check on Drive, for a password changed on another machine.
    /// Nothing is stored until it opens, so a mismatch or a Drive failure
    /// leaves the stored password as it was; so does a sign-in change before
    /// the store, since the password opened the previous account's
    /// password-check. Refused while signed out, while a password change is in
    /// progress or Drive needs a newer app, when Drive has no password-check,
    /// and (before any Drive call) when the OS key store is unavailable. Runs
    /// one at a time with the sets.
    pub async fn replace_password_and_validate(
        self: &Arc<Self>,
        password: &str,
    ) -> Result<(), PreflightError> {
        let _setting = self.password_setting.lock().await;
        if !self.sign_in.is_signed_in().await {
            return Err(PreflightError::Credential(SyncCredentialFailureReason::Unauthenticated));
        }
        self.assert_no_local_password_change().await?;
        Self::assert_keystore_available(&self.passwords.retrieve().await)?;
        let generation = self.sync_format_generation();
        let listing = self.drive.list_files(None).await?;
        self.assert_sync_allowed(Some((&listing, generation))).await?;
        let check = find_password_check(&listing).ok_or(PreflightError::NoRemotePasswordCheck)?;
        self.open_password_check(password, &revision(check), generation).await?;
        self.forget_created_password_check();
        // The validation belongs to `password`; on a refusal or a failed
        // store the stored one is unchanged.
        let stored = match self.assert_same_account(generation) {
            Ok(()) => self.passwords.store(password).await.map_err(PreflightError::Other),
            Err(err) => Err(err),
        };
        if let Err(err) = stored {
            self.runtime.credentials().forget_validated_password_check();
            return Err(err);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(id: &str, modified_time: &str) -> DriveFile {
        DriveFile {
            id: id.to_owned(),
            name: password_check_file_name(),
            modified_time: modified_time.to_owned(),
            created_time: None,
            version: None,
        }
    }

    #[test]
    fn the_newest_password_check_is_chosen_and_ties_go_to_the_smaller_id() {
        let older = file("a", "2026-01-01T00:00:00.000Z");
        let newer = file("b", "2026-01-01T00:00:01.000Z");
        let tie = file("0", "2026-01-01T00:00:01.000Z");
        let other = DriveFile { name: "x.enc".into(), ..file("c", "2027-01-01T00:00:00.000Z") };
        assert_eq!(find_password_check(&[older.clone(), newer.clone(), other.clone()]), Some(&newer));
        assert_eq!(find_password_check(&[newer.clone(), tie.clone(), older]), Some(&tie));
        assert_eq!(find_password_check(&[other]), None);
        assert_eq!(fingerprint("pw"), fingerprint("pw"));
        assert_ne!(fingerprint("pw"), fingerprint("pW"));
    }
}
