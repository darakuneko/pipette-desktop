// SPDX-License-Identifier: GPL-2.0-or-later
//! Sync-format markers: unencrypted `sync-format-v{n}.json` files in
//! appDataFolder that say which sync format the data on Drive needs.
//!
//! - The required version is the largest `n` listed. An app whose
//!   [`SYNC_FORMAT_VERSION`] is smaller stops syncing (`updateRequired`).
//!   Only names count: the content is there for anyone inspecting the
//!   Drive and is never read.
//! - Every pass that may write creates our own marker before touching any
//!   data. No marker is ever rewritten, so two machines syncing at once
//!   cannot lower the required version.
//! - Smaller markers are deleted only once our own marker is listed: a
//!   just-created marker can be missing from listings for a while, and
//!   deleting the smaller ones then would show other machines no marker.
//!   Markers with `n` >= ours are never deleted.

use std::sync::Arc;

use pipette_drive::DriveFile;
use pipette_sync_format::drive_names::{
    SYNC_FORMAT_FILE_PREFIX, parse_sync_format_file_name, sync_format_file_name,
};
use serde::Serialize;

use crate::preflight::{CREATED_MEMORY_MS, Preflight, PreflightError};

/// The sync format this app reads and writes (`SYNC_FORMAT_VERSION` of
/// src/shared/constants/sync-format.ts; the two must stay equal, which a
/// golden test checks).
pub const SYNC_FORMAT_VERSION: u64 = 2;

/// The content of our marker, as `JSON.stringify` writes it.
pub fn marker_content() -> String {
    format!(r#"{{"type":"sync-format","version":{SYNC_FORMAT_VERSION}}}"#)
}

/// `SyncFormatStatus` of src/shared/types/sync.ts: Drive's markers
/// compared with this app's format.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncFormatStatus {
    /// The largest marker version on Drive; `None` when Drive has none.
    pub required: Option<u64>,
    pub supported: u64,
    pub update_required: bool,
}

impl SyncFormatStatus {
    pub fn of(listing: &[DriveFile]) -> Self {
        Self {
            required: required_sync_format(listing),
            supported: SYNC_FORMAT_VERSION,
            update_required: is_sync_format_update_required(listing),
        }
    }
}

/// The largest marker version in `listing`; `None` when it has no marker.
pub fn required_sync_format(listing: &[DriveFile]) -> Option<u64> {
    listing.iter().filter_map(|file| parse_sync_format_file_name(&file.name)).max()
}

/// Whether `listing` holds a marker newer than this app's sync format.
pub fn is_sync_format_update_required(listing: &[DriveFile]) -> bool {
    required_sync_format(listing).unwrap_or(0) > SYNC_FORMAT_VERSION
}

impl Preflight {
    /// The sign-out generation: take it before requesting a listing and
    /// pass it with the listing, so a listing requested before a sign-out
    /// records nothing for the next account.
    pub fn sync_format_generation(&self) -> u64 {
        self.runtime.credentials().sync_format().generation
    }

    /// A listing of just the markers, for entry points whose own listing
    /// is name-filtered. `nameContains` matches more than markers, so the
    /// exact name pattern is applied as well.
    pub async fn list_sync_format_files(&self) -> Result<Vec<DriveFile>, PreflightError> {
        let files = self.drive.list_files(Some(SYNC_FORMAT_FILE_PREFIX)).await?;
        Ok(files.into_iter().filter(|file| parse_sync_format_file_name(&file.name).is_some()).collect())
    }

    /// Forgets the marker this process created and any creation in flight
    /// (sign-out): the next account's Drive is checked afresh.
    pub fn forget_created_sync_format_marker(&self) {
        self.runtime.credentials().forget_sync_format_marker();
        self.marker_creating.forget();
    }

    fn is_recent(&self, at_ms: Option<u64>) -> bool {
        at_ms.is_some_and(|at| self.now().saturating_sub(at) < CREATED_MEMORY_MS)
    }

    /// Whether this process created its marker recently enough that a
    /// listing without it is put down to listing lag; an older creation
    /// is forgotten.
    fn recently_created_own_marker(&self) -> bool {
        let memory = self.runtime.credentials();
        let Some(created_at) = memory.sync_format().created_at_ms else { return false };
        if self.now().saturating_sub(created_at) < CREATED_MEMORY_MS {
            return true;
        }
        memory.clear_sync_format_created();
        false
    }

    /// Creates our marker, or waits for the creation already in flight. A
    /// failed create is not retried here: the caller's pass stops and the
    /// next pass tries again.
    async fn create_own_marker_once(&self, generation: u64) -> Result<(), PreflightError> {
        let (drive, runtime, now_ms) = (self.drive.clone(), self.runtime.clone(), Arc::clone(&self.now_ms));
        let (_, created) = self.marker_creating.run(move || async move {
            drive.create_raw_file(&sync_format_file_name(SYNC_FORMAT_VERSION), &marker_content()).await?;
            runtime.credentials().record_sync_format_created(generation, now_ms());
            Ok(())
        });
        created.await
    }

    /// Best effort: a smaller marker left behind changes nothing, since
    /// only the largest one decides.
    async fn delete_older_markers(&self, listing: &[DriveFile]) {
        for file in listing {
            let Some(version) = parse_sync_format_file_name(&file.name) else { continue };
            if version >= SYNC_FORMAT_VERSION {
                continue;
            }
            if let Err(err) = self.drive.delete_file(&file.id).await {
                log::warn!("sync-format: cannot delete {}: {err}", file.name);
            }
        }
    }

    /// Run by every entry point that may write to Drive, after the guard
    /// passed and before any data is read or written. `listing` must
    /// include the markers (an unfiltered listing, or
    /// [`Preflight::list_sync_format_files`]). Fails when our marker is
    /// missing and cannot be created; the pass must then stop without
    /// writing data. `generation` is [`Preflight::sync_format_generation`]
    /// taken before `listing` was requested.
    pub async fn ensure_sync_format_marker(
        &self,
        listing: &[DriveFile],
        generation: u64,
    ) -> Result<(), PreflightError> {
        let own = sync_format_file_name(SYNC_FORMAT_VERSION);
        if listing.iter().any(|file| file.name == own) {
            self.runtime.credentials().record_sync_format_seen(generation, self.now());
            self.delete_older_markers(listing).await;
            return Ok(());
        }
        if self.recently_created_own_marker() {
            return Ok(());
        }
        self.create_own_marker_once(generation).await
    }

    /// [`Preflight::ensure_sync_format_marker`] for a write whose caller
    /// may hold only a name-filtered listing (creating the
    /// password-check): skipped when our marker was created or listed
    /// within [`CREATED_MEMORY_MS`], otherwise run on a markers-only
    /// listing.
    pub async fn ensure_sync_format_marker_known(&self) -> Result<(), PreflightError> {
        if self.is_recent(self.runtime.credentials().sync_format().seen_at_ms)
            || self.recently_created_own_marker()
        {
            return Ok(());
        }
        let generation = self.sync_format_generation();
        let markers = self.list_sync_format_files().await?;
        self.ensure_sync_format_marker(&markers, generation).await
    }

    /// The markers on Drive compared with this app's sync format. Lists
    /// only the markers; Drive errors are returned.
    pub async fn sync_format_status(&self) -> Result<SyncFormatStatus, PreflightError> {
        Ok(SyncFormatStatus::of(&self.list_sync_format_files().await?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str) -> DriveFile {
        DriveFile {
            id: name.to_owned(),
            name: name.to_owned(),
            modified_time: String::new(),
            created_time: None,
        }
    }

    #[test]
    fn the_required_version_is_the_largest_marker_name() {
        assert_eq!(required_sync_format(&[]), None);
        let listing = [file("sync-format-v1.json"), file("sync-format-v3.json"), file("sync-format-v9.txt")];
        assert_eq!(required_sync_format(&listing), Some(3));
        assert!(is_sync_format_update_required(&listing));
        assert!(!is_sync_format_update_required(&listing[..1]));
        assert_eq!(marker_content(), r#"{"type":"sync-format","version":2}"#);
    }
}
