// SPDX-License-Identifier: GPL-2.0-or-later
//! The automatic tidying of Drive names with several copies, which the poll
//! pass runs on its own listing. Only file metadata changes (renames, and
//! deletes of trash files); no content is downloaded or merged. Per name:
//!
//! - two or more copies: every copy but the chosen one
//!   ([`Listing::pick_canonical`]) is renamed to a trash name;
//! - at least one copy: trash files renamed [`TRASH_QUARANTINE_MS`] or more
//!   ago are deleted, so the last copy of a name is never deleted. Drive is
//!   listed again by name right before the delete, so a trash file another
//!   machine renamed back since the pass's listing is kept;
//! - no copy but trash: the trash file with the newest content
//!   (`preModifiedMs`) is renamed back to the name.
//!
//! Two machines tidying at once converge: a copy each renamed away leaves
//! only trash, which the next pass renames back.
//!
//! [`TRASH_QUARANTINE_MS`]: pipette_drive::trash_names::TRASH_QUARANTINE_MS

use std::collections::HashSet;

use pipette_drive::DriveFile;
use pipette_drive::canonical::{Listing, TrashCopy, is_newer_copy};
use pipette_drive::client::DriveClient;
use pipette_drive::trash_names::is_trash_expired;
use pipette_entry_store::is_safe_path_segment;
use pipette_sync_format::drive_names::{is_data_file_name, sync_unit_from_file_name};
use pipette_sync_runtime::SyncRuntime;

use crate::scope::{SyncScope, should_download_sync_unit};
use crate::units::parse_device_day_unit;

/// Names tidied per pass, so a Drive with many duplicates is worked
/// through over several passes instead of holding the sync lock for long.
pub const TRASH_NAMES_PER_PASS: usize = 5;

/// What the tidying of one pass needs to know.
pub struct TidyContext<'a> {
    /// Keyboards with local data; other keyboards' files are left alone,
    /// as the poll's merge leaves them.
    pub local_keyboard_uids: &'a HashSet<String>,
    pub own_hash: &'a str,
    pub now_ms: i64,
}

/// Whether `name` is one of this machine's own typing days
/// (`isOwnTypingDayName`). Such a day is never renamed back from trash: a
/// day this machine deleted must stay deleted, and one it still has
/// locally is uploaded again by the next sync anyway.
pub fn is_own_typing_day_name(name: &str, own_hash: &str) -> bool {
    sync_unit_from_file_name(name)
        .is_some_and(|unit| parse_device_day_unit(&unit).is_some_and(|day| day.machine_hash == own_hash))
}

/// Whether this machine tidies `name` (`nameScope`): `None` when it does
/// not, otherwise whether `name` is one of its own typing days. Another
/// machine's typing days are only tidied by that machine, and this
/// machine's days are left to an analytics sync of their keyboard that
/// runs, which uploads them with its own listing.
fn name_scope(name: &str, ctx: &TidyContext<'_>, runtime: &SyncRuntime) -> Option<bool> {
    let unit = sync_unit_from_file_name(name).filter(|_| is_data_file_name(name))?;
    if !unit.split('/').all(is_safe_path_segment)
        || !should_download_sync_unit(Some(&unit), &SyncScope::All, ctx.local_keyboard_uids)
    {
        return None;
    }
    let Some(day) = parse_device_day_unit(&unit) else { return Some(false) };
    (day.machine_hash == ctx.own_hash && !runtime.is_analytics_syncing(day.uid)).then_some(true)
}

/// The trash file with the newest content.
fn newest_trash<'a>(trash: &[TrashCopy<'a>]) -> Option<TrashCopy<'a>> {
    trash.iter().copied().reduce(|best, copy| {
        let newer = is_newer_copy(
            copy.trash.pre_modified_ms as f64,
            &copy.file.id,
            best.trash.pre_modified_ms as f64,
            &best.file.id,
        );
        if newer { copy } else { best }
    })
}

/// The tidying of one poll pass on Drive.
pub struct Tidy<'a> {
    pub drive: &'a DriveClient,
    pub runtime: &'a SyncRuntime,
}

impl Tidy<'_> {
    /// `tidyDuplicateCopies`: tidies up to [`TRASH_NAMES_PER_PASS`] names
    /// of `listing` and stops early once the app quits. A failed rename or
    /// delete is logged and left to the next pass; nothing here fails.
    pub async fn tidy_duplicate_copies(&self, listing: &Listing, ctx: &TidyContext<'_>) {
        let mut names: Vec<&str> = listing.duplicated_names();
        for name in listing.names_with_trash() {
            if !names.contains(&name) {
                names.push(name);
            }
        }
        let mut tidied = 0;
        for name in names {
            if tidied >= TRASH_NAMES_PER_PASS || self.runtime.is_quitting() {
                return;
            }
            let Some(own_day) = name_scope(name, ctx, self.runtime) else { continue };
            if self.tidy_name(listing, name, own_day, ctx.now_ms).await {
                tidied += 1;
            }
        }
    }

    /// Those of `ids` that a fresh listing of `name` still shows as expired
    /// trash of it while a copy of it exists.
    async fn still_expired_trash(
        &self,
        name: &str,
        ids: &[String],
        now_ms: i64,
    ) -> Result<Vec<String>, String> {
        let fresh = Listing::new(self.drive.list_files(Some(name)).await.map_err(|err| err.to_string())?);
        if fresh.files_named(name).is_empty() {
            return Ok(Vec::new());
        }
        Ok(fresh
            .trash_copies_of(name)
            .into_iter()
            .filter(|copy| ids.contains(&copy.file.id) && is_trash_expired(copy.trash, now_ms))
            .map(|copy| copy.file.id.clone())
            .collect())
    }

    /// Tidies one name; whether anything was changed or attempted.
    async fn tidy_name(&self, listing: &Listing, name: &str, own_day: bool, now_ms: i64) -> bool {
        let live = listing.files_named(name);
        let trash = listing.trash_copies_of(name);
        let mut acted = false;

        if live.len() > 1 {
            let chosen = listing.pick_canonical(name).map(|file| file.id.as_str());
            let others: Vec<DriveFile> = live
                .iter()
                .filter(|file| Some(file.id.as_str()) != chosen)
                .map(|file| (*file).clone())
                .collect();
            let remote = self.runtime.remote();
            let result = self
                .drive
                .move_files_to_trash(&others, now_ms, &|id| remote.forget_created_file_id(id))
                .await;
            if result.failed > 0 {
                log::warn!(
                    "sync: moving duplicate copies to trash failed: {}",
                    result.first_error.unwrap_or_default()
                );
            }
            acted = true;
        }

        if !live.is_empty() {
            let expired: Vec<String> = trash
                .iter()
                .filter(|copy| is_trash_expired(copy.trash, now_ms))
                .map(|copy| copy.file.id.clone())
                .collect();
            if !expired.is_empty() {
                match self.still_expired_trash(name, &expired, now_ms).await {
                    Ok(ids) => {
                        let result = self.drive.delete_files_by_id(&ids).await;
                        if result.failed > 0 {
                            log::warn!(
                                "sync: deleting expired trash failed: {}",
                                result.first_error.unwrap_or_default()
                            );
                        }
                    }
                    Err(err) => log::warn!("sync: listing before deleting expired trash failed: {err}"),
                }
                acted = true;
            }
        } else if let Some(restore) = newest_trash(&trash).filter(|_| !own_day) {
            if let Err(err) = self.drive.rename_file(&restore.file.id, name).await {
                log::warn!("sync: renaming trash back failed: {err}");
            }
            acted = true;
        }
        acted
    }
}
