// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync of one unit: its upload, its merge with the Drive file of its name,
//! and the choice between them. Every pass and entry point funnels each unit
//! through [`UnitSync`].
//!
//! The revision a unit sync handled is recorded here and only on success (in the
//! runtime's `RemoteMemory`, SYNC-PROCESS §4): the merged Drive file when Drive
//! needs nothing, or the revision the upload answered once its bookkeeping (a
//! day's entry in `sync_state.json`) is written. A failure records nothing, so
//! the next poll still sees the file as changed; an upload that Drive took but
//! whose answer never arrived is a failure too.
//!
//! The locks, in the order a task takes them: the unit's `sync:` lock (a
//! device's deleted-ranges unit only, held from the download to the
//! record), the store lock of the unit's files (held only around a read or
//! a write), then the `upload:` lock (one upload of a unit at a time, so a
//! later one bundles the files the earlier one left). No task holds a store
//! lock while it takes another lock, and the lock of `sync_state.json` is
//! held only around its read and write.

use std::sync::Arc;

use pipette_drive::DriveFile;
use pipette_drive::canonical::Listing;
use pipette_drive::client::DriveClient;
use pipette_drive::retry::DriveFailure;
use pipette_entry_store::is_safe_path_segment;
use pipette_js_json::Value;
use pipette_keyboard_stores::StoreContext;
use pipette_sync_format::drive_names::drive_file_name;
use pipette_sync_runtime::{RemoteRevision, SyncRuntime};
use pipette_typing_analytics::DataOps;
use pipette_typing_analytics::deleted_ranges::apply::ResetHolds;
use zeroize::Zeroizing;

use crate::bundle::{BundleError, bundle_plaintext, bundle_sync_unit};
use crate::codec::EnvelopeCodec;
use crate::merge::{
    AnalyticsEnv, MergeEnv, MergeError, MergeEvents, PackRosters, merge_analytics_unit,
    merge_device_day_bundle, merge_sync_unit,
};
use crate::typing_remote::{pointer_key, set, uploaded_days};
use crate::unit_locks::UnitLocks;
use crate::units::{DeviceDayUnit, parse_device_day_unit};

/// Why a unit sync failed; its text is the message the progress shows.
#[derive(Debug, thiserror::Error)]
pub enum UnitError {
    #[error(transparent)]
    Merge(#[from] MergeError),
    #[error(transparent)]
    Drive(#[from] DriveFailure),
    #[error(transparent)]
    Bundle(#[from] BundleError),
    /// The encryption, the text of the bundle, this device's machine hash,
    /// or a task that did not finish.
    #[error("{0}")]
    Other(String),
}

impl UnitError {
    /// `MalformedSyncBundleError`: the revision will never merge, so the
    /// polling records it instead of trying it every pass.
    pub fn is_malformed(&self) -> bool {
        matches!(self, Self::Merge(MergeError::Malformed(_)))
    }
}

fn other(err: impl std::fmt::Display) -> UnitError {
    UnitError::Other(err.to_string())
}

/// What a [`UnitSync`] is built from.
pub struct UnitSyncDeps {
    pub drive: DriveClient,
    pub runtime: SyncRuntime,
    /// The stores, with the write locks every store and merge shares.
    pub ctx: StoreContext,
    /// The typing analytics: the cache the analytics merges write, the
    /// machine hash and the clock of `sync_state.json`.
    pub ops: Arc<DataOps>,
    pub events: Arc<dyn MergeEvents>,
    pub codec: Arc<dyn EnvelopeCodec>,
}

/// The sync of one unit. One per process: the `sync:` and `upload:` locks
/// it holds serialize the entry points that sync the same unit.
pub struct UnitSync {
    drive: DriveClient,
    runtime: SyncRuntime,
    ctx: StoreContext,
    ops: Arc<DataOps>,
    events: Arc<dyn MergeEvents>,
    codec: Arc<dyn EnvelopeCodec>,
    rosters: Arc<PackRosters>,
    locks: UnitLocks,
}

impl UnitSync {
    pub fn new(deps: UnitSyncDeps) -> Self {
        Self {
            drive: deps.drive,
            runtime: deps.runtime,
            ctx: deps.ctx,
            ops: deps.ops,
            events: deps.events,
            codec: deps.codec,
            rosters: Arc::default(),
            locks: UnitLocks::new(),
        }
    }

    pub fn drive(&self) -> &DriveClient {
        &self.drive
    }

    pub fn runtime(&self) -> &SyncRuntime {
        &self.runtime
    }

    pub fn ctx(&self) -> &StoreContext {
        &self.ctx
    }

    pub fn ops(&self) -> &Arc<DataOps> {
        &self.ops
    }

    /// The keyboards the running reset holds.
    pub fn holds(&self) -> ResetHolds {
        let runtime = self.runtime.clone();
        Arc::new(move |uid: &str| runtime.reset_holds_keyboard(uid))
    }

    /// This device's machine hash.
    pub fn own_hash(&self) -> Result<String, UnitError> {
        self.ops.analytics().machine_hash().map_err(other)
    }

    /// Bundles `unit`'s local files and uploads them to its Drive file,
    /// one upload of the unit at a time. `listing` is the pass's listing
    /// (Drive is listed when none is given). Nothing is sent when the
    /// unit has nothing to bundle.
    pub async fn upload_sync_unit(
        &self,
        unit: &str,
        password: &str,
        listing: Option<&Listing>,
    ) -> Result<(), UnitError> {
        self.locks.with_lock(&format!("upload:{unit}"), self.upload_locked(unit, password, listing)).await
    }

    async fn upload_locked(
        &self,
        unit: &str,
        password: &str,
        listing: Option<&Listing>,
    ) -> Result<(), UnitError> {
        let (ctx, owned_unit) = (self.ctx.clone(), unit.to_owned());
        let bundle = tokio::task::spawn_blocking(move || bundle_sync_unit(&ctx, &owned_unit))
            .await
            .map_err(other)??;
        let Some(bundle) = bundle else { return Ok(()) };
        let content = self
            .codec
            .seal(bundle_plaintext(&bundle), Zeroizing::new(password.to_owned()), unit.to_owned())
            .await
            .map_err(UnitError::Other)?;

        let listed;
        let listing = match listing {
            Some(listing) => listing,
            None => {
                listed = Listing::new(self.drive.list_files(None).await?);
                &listed
            }
        };
        let name = drive_file_name(unit);
        let listed_id = listing.pick_canonical(&name).map(|file| file.id.clone());
        // A listing taken before an earlier upload of this run created the
        // file does not show it (an Analyze sync and a flush can both start
        // without today's day file): that file is updated rather than a
        // second one created with the name. The listing is not taken again,
        // which would multiply the listings of a pass that uploads many
        // units. A remembered id the listing shows under another name was
        // renamed to trash by another device; writing to it would put the
        // content where sync never reads it.
        let remembered = match listed_id {
            Some(_) => None,
            None => self.runtime.remote().created_file_id(&name),
        };
        let created_id = remembered.filter(|id| !listing.files().iter().any(|file| &file.id == id));
        // A remembered id may be gone since (a reset, another device), so a
        // missing file is created again; a listed id that is gone fails like
        // any other upload.
        let uploaded = match &created_id {
            Some(id) => self.drive.upload_file(&name, &content, Some(id), true).await?,
            None => self.drive.upload_file(&name, &content, listed_id.as_deref(), false).await?,
        };
        if listed_id.as_deref() != Some(uploaded.id.as_str()) {
            self.runtime.remote().remember_created_file(&name, &uploaded.id);
        }
        // Recorded after the bookkeeping: an upload whose bookkeeping
        // failed stays unknown, so the next pass uploads it again.
        if let Some(day) = parse_device_day_unit(unit) {
            self.record_day_uploaded(day).await?;
        }
        self.runtime
            .remote()
            .record(&name, RemoteRevision { id: uploaded.id, modified_time: uploaded.modified_time });
        Ok(())
    }

    /// Adds an uploaded day to `uploaded` of `sync_state.json`, so the
    /// reconcile tells "never uploaded" from "uploaded, then removed on
    /// Drive". The list stays sorted and free of duplicates; nothing is
    /// written when the day is in it already. The uploads of a pass run
    /// at once, so the read-modify-write goes through
    /// [`pipette_typing_analytics::TypingAnalytics::update_sync_state`], one
    /// at a time.
    async fn record_day_uploaded(&self, day: DeviceDayUnit<'_>) -> Result<(), UnitError> {
        let own = self.own_hash()?;
        let (analytics, now) = (self.ops.analytics().clone(), self.ops.analytics().now_ms());
        let (key, utc_day) = (pointer_key(day.uid, day.machine_hash), day.utc_day.to_owned());
        tokio::task::spawn_blocking(move || {
            analytics.update_sync_state(&own, |state| {
                let mut days = uploaded_days(&state.uploaded, &key);
                if !days.insert(utc_day) {
                    return false;
                }
                let mut days: Vec<String> = days.into_iter().collect();
                days.sort();
                set(&mut state.uploaded, &key, Value::Array(days.into_iter().map(Value::from).collect()));
                state.last_synced_at = now as f64;
                true
            })
        })
        .await
        .map_err(other)?
        .map_err(other)
    }

    /// Merges the Drive file `file` of `unit` into the local files, then
    /// uploads when Drive lacks something this device holds. `file` must
    /// be the copy [`Listing::pick_canonical`] chooses for its name, so
    /// an upload after the merge writes the same file.
    pub async fn merge_with_remote(
        &self,
        file: &DriveFile,
        unit: &str,
        password: &str,
        listing: Option<&Listing>,
    ) -> Result<(), UnitError> {
        self.locks.with_unit_sync_lock(unit, self.merge_unlocked(file, unit, password, listing)).await
    }

    async fn merge_unlocked(
        &self,
        file: &DriveFile,
        unit: &str,
        password: &str,
        listing: Option<&Listing>,
    ) -> Result<(), UnitError> {
        // This device's own days are append-only logs only it writes, so
        // nothing on Drive is newer: uploaded in place without a download.
        if let Some(day) = parse_device_day_unit(unit)
            && day.machine_hash == self.own_hash()?
        {
            // The uid comes from a Drive file name: checked before the
            // bundle joins it into a path.
            if !is_safe_path_segment(day.uid) {
                return Err(MergeError::Malformed(unit.to_owned()).into());
            }
            return self.upload_sync_unit(unit, password, listing).await;
        }

        let content = self.drive.download(&file.id).await?;
        let needs_upload = self.merge_content(unit, content, password, &file.modified_time).await?;
        if needs_upload {
            self.upload_sync_unit(unit, password, listing).await?;
        } else {
            self.runtime.remote().record(
                &file.name,
                RemoteRevision { id: file.id.clone(), modified_time: file.modified_time.clone() },
            );
        }
        self.rosters.mark_synced(unit);
        Ok(())
    }

    /// Opens the downloaded `content` and merges its bundle; whether
    /// Drive needs this device's copy.
    async fn merge_content(
        &self,
        unit: &str,
        content: Vec<u8>,
        password: &str,
        modified_time: &str,
    ) -> Result<bool, UnitError> {
        let plaintext =
            self.codec.open(content, Zeroizing::new(password.to_owned())).await.map_err(UnitError::Other)?;
        let bundle = pipette_js_json::parse(&plaintext).map_err(other)?;
        let (ctx, events, runtime, rosters) =
            (self.ctx.clone(), self.events.clone(), self.runtime.clone(), self.rosters.clone());
        let (owned_unit, modified_time) = (unit.to_owned(), modified_time.to_owned());
        let (merged, bundle) = tokio::task::spawn_blocking(move || {
            let env = MergeEnv { ctx: &ctx, events: &*events, remote: runtime.remote(), rosters: &rosters };
            (merge_sync_unit(&env, &owned_unit, &bundle, &modified_time), bundle)
        })
        .await
        .map_err(other)?;
        match merged {
            Err(MergeError::NotHandled(_)) => {
                let own = self.own_hash()?;
                let env = AnalyticsEnv { ctx: &self.ctx, ops: &self.ops, holds: self.holds() };
                // An own-hash apply it queued runs on without the pass.
                Ok(merge_analytics_unit(&env, unit, &bundle, &own).await?.remote_needs_update)
            }
            merged => Ok(merged?),
        }
    }

    /// Downloads another device's day file `file` of `day` and merges it,
    /// as the lazy fetch of a remote day does: without the unit's locks,
    /// recording no revision and uploading nothing (a day is never
    /// written back from here).
    pub async fn merge_remote_day(
        &self,
        file: &DriveFile,
        day: DeviceDayUnit<'_>,
        password: &str,
    ) -> Result<(), UnitError> {
        let content = self.drive.download(&file.id).await?;
        let plaintext =
            self.codec.open(content, Zeroizing::new(password.to_owned())).await.map_err(UnitError::Other)?;
        let bundle = pipette_js_json::parse(&plaintext).map_err(other)?;
        let own = self.own_hash()?;
        let env = AnalyticsEnv { ctx: &self.ctx, ops: &self.ops, holds: self.holds() };
        Ok(merge_device_day_bundle(&env, &bundle, day, &own).await?)
    }

    /// Merges `unit` with its Drive file in `listing` when there is
    /// one, otherwise uploads it.
    pub async fn sync_or_upload(
        &self,
        unit: &str,
        password: &str,
        listing: &Listing,
    ) -> Result<(), UnitError> {
        self.locks
            .with_unit_sync_lock(unit, async {
                match listing.pick_canonical(&drive_file_name(unit)) {
                    Some(file) => self.merge_unlocked(file, unit, password, Some(listing)).await,
                    None => {
                        self.upload_sync_unit(unit, password, Some(listing)).await?;
                        self.rosters.mark_synced(unit);
                        Ok(())
                    }
                }
            })
            .await
    }
}
