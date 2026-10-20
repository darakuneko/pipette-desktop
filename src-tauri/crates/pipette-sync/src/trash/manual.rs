// SPDX-License-Identifier: GPL-2.0-or-later
//! What the Data > Sync > Trash screen does with Drive trash files: list them,
//! rename one back to its original name, or delete some.
//!
//! Restore and delete hold the sync lock as a reset of the keyboards their
//! files belong to ([`restore_trash`], [`delete_trash`]); those keyboards
//! are looked up with a listing before the lock is taken. Inside the lock
//! each lists Drive again, so a file the poll renamed back (`tidy`) after
//! the screen loaded is not acted on, and a keyboard file the lock does not
//! cover is refused or skipped.

use pipette_drive::DriveFile;
use pipette_drive::canonical::Listing;
use pipette_drive::client::BulkOutcome;
use pipette_drive::trash_names::{TRASH_QUARANTINE_MS, TrashInfo, parse_trash_file};
use pipette_sync_format::drive_names::sync_unit_from_file_name;
use pipette_sync_runtime::ResetKeyboards;
use pipette_sync_runtime::runtime::TRASH_BUSY_MESSAGE;
use serde::Serialize;

use crate::data_error::DataError;
use crate::preflight::Preflight;
use crate::trash::tidy::is_own_typing_day_name;

pub const TRASH_NOT_FOUND_MESSAGE: &str = "sync.trash.notFound";
pub const TRASH_NOT_RESTORABLE_MESSAGE: &str = "sync.trash.notRestorable";

/// `SyncTrashFile`: a trash file as the screen lists it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTrashFile {
    pub file_id: String,
    pub original_name: String,
    pub sync_unit: Option<String>,
    /// When the copy was last written before it was moved to trash.
    pub updated_at: i64,
    /// When the poll may delete it for good.
    pub expires_at: i64,
    /// False for this machine's own typing days, which are never renamed
    /// back; such a file can only be deleted.
    pub restorable: bool,
}

/// What a trash action needs besides the Drive and the sync's memory: this
/// machine's hash (`getMachineHash`) and the time.
pub struct TrashEnv<'a> {
    pub preflight: &'a Preflight,
    pub own_hash: &'a (dyn Fn() -> Result<String, String> + Sync),
    pub now_ms: i64,
}

impl TrashEnv<'_> {
    /// One full listing, after the credentials and the sync guards pass.
    async fn list_allowed_files(&self) -> Result<Vec<DriveFile>, DataError> {
        let preflight = self.preflight;
        preflight.require_sync_credentials().await.map_err(DataError::Readiness)?;
        preflight.assert_no_local_password_change().await?;
        let generation = preflight.sync_format_generation();
        let listing =
            preflight.drive().list_files(None).await.map_err(crate::preflight::PreflightError::from)?;
        preflight.assert_sync_allowed(Some((&listing, generation))).await?;
        Ok(listing)
    }

    fn own_hash(&self) -> Result<String, DataError> {
        (self.own_hash)().map_err(DataError::Other)
    }

    /// Whether the reset lock the caller holds covers the trash file's
    /// keyboard.
    fn lock_covers(&self, trash: &TrashInfo) -> bool {
        trash_keyboard(trash).is_none_or(|uid| self.preflight.runtime().reset_holds_keyboard(&uid))
    }
}

/// The keyboard whose data the trash file holds; `None` for a unit that is
/// not tied to one keyboard.
fn trash_keyboard(trash: &TrashInfo) -> Option<String> {
    let unit = sync_unit_from_file_name(&trash.original_name)?;
    let rest = unit.strip_prefix("keyboards/")?;
    let uid = rest.split('/').next().unwrap_or("");
    (!uid.is_empty()).then(|| uid.to_owned())
}

fn trash_of(file: &DriveFile) -> Option<TrashInfo> {
    parse_trash_file(&file.id, &file.name)
}

/// `listTrashFiles`: every trash file on Drive, the most recently moved
/// first. Names only: nothing is downloaded.
pub async fn list_trash_files(env: &TrashEnv<'_>) -> Result<Vec<SyncTrashFile>, DataError> {
    let listing = env.list_allowed_files().await?;
    let own_hash = env.own_hash()?;
    let mut rows: Vec<SyncTrashFile> = listing
        .iter()
        .filter_map(|file| {
            let trash = trash_of(file)?;
            Some(SyncTrashFile {
                file_id: file.id.clone(),
                sync_unit: sync_unit_from_file_name(&trash.original_name),
                updated_at: trash.pre_modified_ms,
                expires_at: trash.renamed_at_ms + TRASH_QUARANTINE_MS,
                restorable: !is_own_typing_day_name(&trash.original_name, &own_hash),
                original_name: trash.original_name,
            })
        })
        .collect();
    rows.sort_by_key(|row| std::cmp::Reverse(row.expires_at));
    Ok(rows)
}

/// `trashFileKeyboards`: the keyboards whose data the trash files of
/// `file_ids` hold, in listed order. Ids that are not trash files add
/// nothing; the action itself lists again and skips them.
pub async fn trash_file_keyboards(env: &TrashEnv<'_>, file_ids: &[String]) -> Result<Vec<String>, DataError> {
    let mut uids: Vec<String> = Vec::new();
    for file in env.list_allowed_files().await? {
        if !file_ids.contains(&file.id) {
            continue;
        }
        let uid = trash_of(&file).and_then(|trash| trash_keyboard(&trash));
        if let Some(uid) = uid.filter(|uid| !uids.contains(uid)) {
            uids.push(uid);
        }
    }
    Ok(uids)
}

/// The reset-lock target for acting on `file_ids` (`trashLockTarget`):
/// their keyboards, or none when none of them holds keyboard data.
async fn trash_lock_target(env: &TrashEnv<'_>, file_ids: &[String]) -> Result<ResetKeyboards, DataError> {
    let uids = trash_file_keyboards(env, file_ids).await?;
    Ok(if uids.is_empty() { ResetKeyboards::None } else { ResetKeyboards::Uids(uids) })
}

/// Renames `files` back to `name` after a restore stopped halfway. A
/// failure is logged, not answered: the restore's own error is the one the
/// user sees.
async fn rename_back(env: &TrashEnv<'_>, files: &[DriveFile], name: &str) {
    for file in files {
        if let Err(err) = env.preflight.drive().rename_file(&file.id, name).await {
            log::warn!("sync: undoing a trash restore failed: {err}");
        }
    }
}

fn bulk_failure(verb: &str, outcome: &BulkOutcome) -> DataError {
    DataError::Other(format!(
        "Failed to {verb} {} of {} files{}: {}",
        outcome.failed,
        outcome.attempted,
        if verb == "move" { " to trash" } else { "" },
        outcome.first_error.as_deref().unwrap_or("undefined")
    ))
}

/// `restoreTrashFile`: swaps `file_id` in for the current copies of its
/// original name: every current copy is moved to trash first, then
/// `file_id` is renamed back. Refused with [`TRASH_NOT_FOUND_MESSAGE`] when
/// `file_id` is not a trash file any more, with
/// [`TRASH_NOT_RESTORABLE_MESSAGE`] for one of this machine's own typing
/// days, and as busy for a keyboard the held lock does not cover. When the
/// rename back fails, the moved copies are renamed back to the name; what
/// that cannot undo is left to the poll, which renames the trash file with
/// the newest content back when a name has no copy.
pub async fn restore_trash_file(env: &TrashEnv<'_>, file_id: &str) -> Result<(), DataError> {
    let listing = Listing::new(env.list_allowed_files().await?);
    let found = listing.files().iter().find(|file| file.id == file_id).and_then(trash_of);
    let Some(trash) = found else { return Err(DataError::Other(TRASH_NOT_FOUND_MESSAGE.to_owned())) };
    if is_own_typing_day_name(&trash.original_name, &env.own_hash()?) {
        return Err(DataError::Other(TRASH_NOT_RESTORABLE_MESSAGE.to_owned()));
    }
    if !env.lock_covers(&trash) {
        return Err(DataError::Other(TRASH_BUSY_MESSAGE.to_owned()));
    }
    let name = trash.original_name;
    let current: Vec<DriveFile> = listing.files_named(&name).into_iter().cloned().collect();
    let remote = env.preflight.runtime().remote();
    let moved = env
        .preflight
        .drive()
        .move_files_to_trash(&current, env.now_ms, &|id| remote.forget_created_file_id(id))
        .await;
    if moved.failed > 0 {
        rename_back(env, &current, &name).await;
        return Err(bulk_failure("move", &moved));
    }
    match env.preflight.drive().rename_file(file_id, &name).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) => {
            rename_back(env, &current, &name).await;
            Err(DataError::Other(TRASH_NOT_FOUND_MESSAGE.to_owned()))
        }
        Err(err) => {
            rename_back(env, &current, &name).await;
            Err(DataError::Other(err.to_string()))
        }
    }
}

/// What a delete of trash files did: the ids deleted, and those skipped
/// because they were no longer trash files or their keyboard is not held.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct TrashDeleteResult {
    pub deleted: Vec<String>,
    pub skipped: Vec<String>,
}

/// `deleteTrashFiles`: deletes those of `file_ids` that are still trash
/// files of data the caller's lock covers; the others are skipped.
pub async fn delete_trash_files(
    env: &TrashEnv<'_>,
    file_ids: &[String],
) -> Result<TrashDeleteResult, DataError> {
    let listing = env.list_allowed_files().await?;
    let deletable: Vec<&str> = listing
        .iter()
        .filter(|file| trash_of(file).is_some_and(|trash| env.lock_covers(&trash)))
        .map(|file| file.id.as_str())
        .collect();
    let (deleted, skipped): (Vec<String>, Vec<String>) =
        file_ids.iter().cloned().partition(|id| deletable.contains(&id.as_str()));
    let outcome = env.preflight.drive().delete_files_by_id(&deleted).await;
    if outcome.failed > 0 {
        return Err(bulk_failure("delete", &outcome));
    }
    Ok(TrashDeleteResult { deleted, skipped })
}

/// The `SYNC_RESTORE_TRASH` handler: [`restore_trash_file`] holding the
/// sync lock as a reset of the file's keyboard, or busy
/// (`sync.trashBusy`) at once.
pub async fn restore_trash(env: &TrashEnv<'_>, file_id: &str) -> Result<(), DataError> {
    let target = trash_lock_target(env, &[file_id.to_owned()]).await?;
    let runtime = env.preflight.runtime();
    runtime.with_reset_lock(&target, TRASH_BUSY_MESSAGE, restore_trash_file(env, file_id)).await?
}

/// The `SYNC_DELETE_TRASH` handler: [`delete_trash_files`] holding the
/// sync lock as a reset of the files' keyboards, or busy at once.
pub async fn delete_trash(env: &TrashEnv<'_>, file_ids: &[String]) -> Result<TrashDeleteResult, DataError> {
    let target = trash_lock_target(env, file_ids).await?;
    let runtime = env.preflight.runtime();
    runtime.with_reset_lock(&target, TRASH_BUSY_MESSAGE, delete_trash_files(env, file_ids)).await?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(name: &str) -> TrashInfo {
        TrashInfo { original_name: name.to_owned(), renamed_at_ms: 0, pre_modified_ms: 0 }
    }

    #[test]
    fn a_keyboard_file_names_its_keyboard() {
        assert_eq!(trash_keyboard(&info("keyboards_uid1_settings.enc")), Some("uid1".to_owned()));
        assert_eq!(trash_keyboard(&info("favorites_macro.enc")), None);
    }

    #[test]
    fn bulk_failures_read_as_a_count_and_the_first_error() {
        let outcome =
            BulkOutcome { attempted: 3, failed: 1, first_error: Some("Drive API error 403".into()) };
        assert_eq!(
            bulk_failure("delete", &outcome).to_string(),
            "Failed to delete 1 of 3 files: Drive API error 403"
        );
        assert_eq!(
            bulk_failure("move", &outcome).to_string(),
            "Failed to move 1 of 3 files to trash: Drive API error 403"
        );
    }
}
