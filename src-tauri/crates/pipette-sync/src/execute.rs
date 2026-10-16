// SPDX-License-Identifier: GPL-2.0-or-later
//! `executeSync` (src/main/sync/sync-execute.ts): the full pass of the
//! Settings Sync button, the connect-time download, the Data modal's
//! download of a remote-only keyboard and the pack pull. One direction and
//! one scope ([`SyncScope`]) per pass.
//!
//! A pass takes the sync lock. When another pass holds it, the pass waits
//! for a holder that ends on its own (the polling, a reset) and answers
//! `busy` for any other (a flush, another `executeSync`), which is how the
//! renderer's parallel connect-time downloads dedupe. It then runs the
//! preflight in the order of SYNC-PROCESS §3 on one unfiltered listing,
//! and:
//!
//! - a download merges every Drive file the scope takes (one copy per
//!   name), the pack rosters before the pack bodies, 10 at a time, then
//!   collects the pack garbage; `'all'` also names the keyboards the
//!   keyboard names lack;
//! - an upload first reconciles this device's typing days with Drive (and
//!   lists Drive again only when that changed Drive), then syncs every
//!   local unit the scope takes. A unit it sent stops being pending unless
//!   it changed again meanwhile; a unit that failed becomes pending again
//!   for the account the pass ran as.
//!
//! Every pass ends by queueing the apply of this device's own deleted
//! ranges. The progress goes out in the shape of `SyncProgress`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use pipette_drive::DriveFile;
use pipette_drive::canonical::Listing;
use pipette_google_auth::GoogleAuth;
use pipette_keyboard_stores::KEYBOARD_META_SYNC_UNIT;
use pipette_pack_stores::sync::run_pack_gc_after_pass;
use pipette_sync_format::drive_names::sync_unit_from_file_name;
use pipette_sync_pending::PendingStore;
use pipette_sync_runtime::{SyncCredentialFailureReason, SyncDirection, SyncProgress, SyncStatus};

use crate::bundle::collect_all_sync_units;
use crate::dispatch::{UnitError, UnitSync};
use crate::merge::queue_own_deleted_ranges_apply;
use crate::password::guard::SyncBlockReason;
use crate::preflight::{BoxFuture, Preflight, PreflightError};
use crate::scope::{SyncScope, list_local_keyboard_uids, matches_scope, should_download_sync_unit};
use crate::typing_remote::reconcile_own_hash_typing_analytics;
use crate::units::pack_index_units_first;

/// How many units a pass syncs at a time.
pub const SYNC_CONCURRENCY: usize = 10;

/// How long the flush waits before it tries the units a pass could not
/// send again.
pub const POLL_INTERVAL: Duration = Duration::from_secs(3 * 60);

/// Why a pass did not run (`SyncSkipReason`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkipReason {
    /// Another pass that does not end on its own holds the sync lock.
    Busy,
    Credential(SyncCredentialFailureReason),
    Blocked(SyncBlockReason),
}

impl SkipReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::Credential(reason) => reason.as_str(),
            Self::Blocked(reason) => reason.as_str(),
        }
    }
}

/// What a pass did (`SyncExecuteResult`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SyncExecuteResult {
    Completed,
    Skipped(SkipReason),
    /// The units that failed, in the order they failed.
    Partial(Vec<String>),
}

/// The account a pass runs as: the `sub` of the stored sign-in
/// (`getAccountSub`), which the pending units are handed to.
pub trait PassAccount: Send + Sync {
    fn account_sub(&self) -> BoxFuture<'_, Option<String>>;
}

impl PassAccount for GoogleAuth {
    fn account_sub(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(GoogleAuth::account_sub(self))
    }
}

/// `backfillKeyboardMeta`: names the keyboards with files in `listing`
/// that the keyboard names lack; how many it named.
pub trait KeyboardMetaBackfill: Send + Sync {
    fn backfill<'a>(
        &'a self,
        password: &'a str,
        listing: &'a Listing,
    ) -> BoxFuture<'a, Result<usize, String>>;
}

/// The triggers a pass hands work to: the flush of the pending units
/// (`scheduleFlushIfPending`, after `delay`, or the flush's own delay for
/// `None`) and the polling.
pub trait PassHooks: Send + Sync {
    fn schedule_flush_if_pending(&self, delay: Option<Duration>);
    /// `startPollingIfAutoSync`, after a download.
    fn start_polling_if_auto_sync(&self);
}

/// What a [`SyncExecutor`] is built from.
pub struct ExecuteDeps {
    pub preflight: Arc<Preflight>,
    pub units: Arc<UnitSync>,
    pub pending: PendingStore,
    pub account: Arc<dyn PassAccount>,
    pub backfill: Arc<dyn KeyboardMetaBackfill>,
    pub hooks: Arc<dyn PassHooks>,
}

pub struct SyncExecutor {
    preflight: Arc<Preflight>,
    units: Arc<UnitSync>,
    pending: PendingStore,
    account: Arc<dyn PassAccount>,
    backfill: Arc<dyn KeyboardMetaBackfill>,
    hooks: Arc<dyn PassHooks>,
    concurrency: usize,
}

/// What the sync of one unit of a pass does.
enum Work<'a> {
    /// A download: merges the chosen copy of the unit's Drive file.
    Merge { file: &'a DriveFile, listing: &'a Listing },
    /// An upload: merges with the unit's Drive file when there is one,
    /// otherwise creates it.
    SyncOrUpload { listing: &'a Listing },
}

/// The units of a pass that synced and that failed, each in the order
/// they ended.
#[derive(Default)]
struct Outcomes {
    succeeded: Vec<String>,
    failed: Vec<String>,
}

impl SyncExecutor {
    pub fn new(deps: ExecuteDeps) -> Self {
        Self {
            preflight: deps.preflight,
            units: deps.units,
            pending: deps.pending,
            account: deps.account,
            backfill: deps.backfill,
            hooks: deps.hooks,
            concurrency: SYNC_CONCURRENCY,
        }
    }

    /// How many units a pass syncs at a time; one makes the order of the
    /// requests fixed (the recorded passes compare it).
    pub fn with_concurrency(mut self, concurrency: usize) -> Self {
        self.concurrency = concurrency.max(1);
        self
    }

    pub fn hooks(&self) -> &Arc<dyn PassHooks> {
        &self.hooks
    }

    fn emit(&self, progress: SyncProgress) {
        self.preflight.runtime().progress().emit(&progress);
    }

    fn blocked(&self, direction: SyncDirection, reason: SyncBlockReason) -> SyncExecuteResult {
        self.preflight.emit_sync_blocked(direction, reason);
        SyncExecuteResult::Skipped(SkipReason::Blocked(reason))
    }

    /// The sync of one unit of a pass.
    async fn sync_unit(&self, unit: &str, work: Work<'_>, password: &str) -> Result<(), UnitError> {
        match work {
            Work::Merge { file, listing } => {
                self.units.merge_with_remote(file, unit, password, Some(listing)).await
            }
            Work::SyncOrUpload { listing } => self.units.sync_or_upload(unit, password, listing).await,
        }
    }

    /// Runs a pass of `direction` over `scope`. A failure before the units
    /// (the listing, the marker, the password-check) is reported as a final
    /// `error` progress and returned.
    pub async fn execute_sync(
        &self,
        direction: SyncDirection,
        scope: &SyncScope,
    ) -> Result<SyncExecuteResult, PreflightError> {
        let runtime = self.preflight.runtime();
        let _lock = loop {
            if let Some(lock) = runtime.try_claim_sync_lock(false) {
                break lock;
            }
            match runtime.in_flight_pass() {
                Some(pass) if pass.waitable() => pass.released().await,
                Some(_) => return Ok(SyncExecuteResult::Skipped(SkipReason::Busy)),
                // Released meanwhile.
                None => {}
            }
        };
        let result = self.run(direction, scope).await;
        if let Err(err) = &result {
            self.emit(SyncProgress {
                message: Some(err.to_string()),
                ..SyncProgress::new(direction, SyncStatus::Error)
            });
        }
        result
    }

    async fn run(
        &self,
        direction: SyncDirection,
        scope: &SyncScope,
    ) -> Result<SyncExecuteResult, PreflightError> {
        let preflight = &self.preflight;
        if let Some(reason) = preflight.local_sync_block().await {
            return Ok(self.blocked(direction, reason));
        }
        let password = match preflight.require_sync_credentials().await {
            Ok(password) => password,
            Err(reason) => {
                self.emit(SyncProgress {
                    reason: Some(reason),
                    message: Some(format!("sync.readiness.{}", reason.as_str())),
                    ..SyncProgress::new(direction, SyncStatus::Error)
                });
                return Ok(SyncExecuteResult::Skipped(SkipReason::Credential(reason)));
            }
        };
        // Units changed under another account are held for it; units this
        // pass marks pending belong to the account it runs as.
        let owner = self.account.account_sub().await;
        self.pending.adopt_for_account(owner.as_deref());

        self.emit(SyncProgress {
            message: Some("Starting sync...".to_owned()),
            ..SyncProgress::new(direction, SyncStatus::Syncing)
        });
        let generation = preflight.sync_format_generation();
        let listing = Listing::new(preflight.drive().list_files(None).await?);
        if let Some(reason) = preflight.remote_sync_block(listing.files(), generation) {
            return Ok(self.blocked(direction, reason));
        }
        preflight.ensure_sync_format_marker(listing.files(), generation).await?;
        // `'all'` always validates again; a scoped pass skips it while the
        // password-check is the one last validated.
        if *scope == SyncScope::All {
            preflight.validate_password_check(&password, listing.files(), generation).await?;
        } else {
            preflight.ensure_password_check_validated(&password, listing.files(), generation).await?;
        }

        let failed = match direction {
            SyncDirection::Download => {
                let failed = self.download(&password, &listing, scope).await;
                if *scope == SyncScope::All {
                    let resolved =
                        self.backfill.backfill(&password, &listing).await.map_err(PreflightError::Other)?;
                    if resolved > 0 {
                        self.pending.mark_pending_for(owner.as_deref(), KEYBOARD_META_SYNC_UNIT);
                        self.pending.broadcast_status();
                        self.hooks.schedule_flush_if_pending(None);
                    }
                }
                failed
            }
            SyncDirection::Upload => {
                let generations: HashMap<String, u64> = self
                    .pending
                    .snapshot_generations()
                    .into_iter()
                    .filter_map(|(unit, generation)| Some((unit.as_str()?.to_owned(), generation)))
                    .collect();
                let outcomes = self.upload(&password, listing, scope).await?;
                for unit in &outcomes.succeeded {
                    self.pending.settle(unit, generations.get(unit).copied().unwrap_or(0));
                }
                for unit in &outcomes.failed {
                    self.pending.mark_pending_for(owner.as_deref(), unit);
                }
                self.pending.broadcast_status();
                if !outcomes.failed.is_empty() {
                    self.hooks.schedule_flush_if_pending(Some(POLL_INTERVAL));
                }
                outcomes.failed
            }
        };

        drop(queue_own_deleted_ranges_apply(self.units.ops().clone(), self.units.holds()));

        if failed.is_empty() {
            self.emit(SyncProgress {
                message: Some("Sync complete".to_owned()),
                ..SyncProgress::new(direction, SyncStatus::Success)
            });
            return Ok(SyncExecuteResult::Completed);
        }
        self.emit(SyncProgress {
            message: Some(format!("{} sync unit(s) failed", failed.len())),
            failed_units: Some(failed.clone()),
            ..SyncProgress::new(direction, SyncStatus::Partial)
        });
        Ok(SyncExecuteResult::Partial(failed))
    }

    /// Syncs `items` (a unit and what its sync needs), the pack rosters to
    /// the end before the other units, [`Self::with_concurrency`] at a
    /// time, reporting each as it starts and each failure as it ends.
    async fn run_units(
        &self,
        direction: SyncDirection,
        items: Vec<(String, Work<'_>)>,
        password: &str,
    ) -> Outcomes {
        let total = u32::try_from(items.len()).unwrap_or(u32::MAX);
        let (rosters, rest) = pack_index_units_first(items, |(unit, _)| unit);
        let mut started = 0u32;
        let mut outcomes = Outcomes::default();
        for group in [rosters, rest] {
            let mut waiting = group.into_iter();
            let mut running = FuturesUnordered::new();
            loop {
                while running.len() < self.concurrency {
                    let Some((unit, item)) = waiting.next() else { break };
                    started += 1;
                    self.emit(SyncProgress {
                        sync_unit: Some(unit.clone()),
                        current: Some(started),
                        total: Some(total),
                        ..SyncProgress::new(direction, SyncStatus::Syncing)
                    });
                    running.push(async move {
                        let result = self.sync_unit(&unit, item, password).await;
                        (unit, result)
                    });
                }
                let Some((unit, result)) = running.next().await else { break };
                match result {
                    Ok(()) => outcomes.succeeded.push(unit),
                    Err(err) => {
                        self.emit(SyncProgress {
                            sync_unit: Some(unit.clone()),
                            message: Some(err.to_string()),
                            ..SyncProgress::new(direction, SyncStatus::Error)
                        });
                        outcomes.failed.push(unit);
                    }
                }
            }
        }
        outcomes
    }

    /// `executeDownloadSync`: merges the Drive files of `scope`; the units
    /// that failed.
    async fn download(&self, password: &str, listing: &Listing, scope: &SyncScope) -> Vec<String> {
        let user_data = self.units.ctx().user_data().to_path_buf();
        let local = tokio::task::spawn_blocking(move || list_local_keyboard_uids(&user_data))
            .await
            .unwrap_or_default();
        let mut items = Vec::new();
        for file in listing.canonical_files() {
            if let Some(unit) = sync_unit_from_file_name(&file.name)
                && should_download_sync_unit(Some(&unit), scope, &local)
            {
                items.push((unit, Work::Merge { file, listing }));
            }
        }
        let attempted: Vec<String> = items.iter().map(|(unit, _)| unit.clone()).collect();
        let outcomes = self.run_units(SyncDirection::Download, items, password).await;
        // After the pass, never from a unit's merge: a store whose unit
        // failed keeps its files.
        let (ctx, failed) = (self.units.ctx().clone(), outcomes.failed.clone());
        if let Err(err) =
            tokio::task::spawn_blocking(move || run_pack_gc_after_pass(&ctx, &attempted, &failed)).await
        {
            log::warn!("pack-gc: the sweep did not finish: {err}");
        }
        outcomes.failed
    }

    /// The keyboards this device recorded typing for, with its machine
    /// hash (`listLocalKeyboardUids` of the cache).
    async fn own_typing(&self) -> Result<(String, Vec<String>), String> {
        let hash = self.units.own_hash().map_err(|err| err.to_string())?;
        let ready = self.units.ops().analytics().ready().await.map_err(|err| err.to_string())?;
        let own = hash.clone();
        let uids = ready
            .db
            .call(move |db| db.local_keyboard_uids(&own))
            .await
            .map_err(|err| err.to_string())?
            .map_err(|err| err.to_string())?;
        Ok((hash, uids))
    }

    /// `executeUploadSync`: syncs every local unit of `scope`.
    async fn upload(
        &self,
        password: &str,
        listing: Listing,
        scope: &SyncScope,
    ) -> Result<Outcomes, PreflightError> {
        // Before the units are collected, so a day removed on one side is
        // not uploaded again. It deletes only on a divergence; otherwise the
        // pass's listing stays good and Drive is not listed again.
        let reconciled = match self.units.own_hash() {
            Ok(hash) => {
                let analytics = self.units.ops().analytics();
                reconcile_own_hash_typing_analytics(
                    self.units.drive(),
                    &listing,
                    self.units.ctx().user_data(),
                    &hash,
                    analytics.clock().as_ref(),
                )
                .await
                .map_err(|err| err.to_string())
            }
            Err(err) => Err(err.to_string()),
        };
        let mutated = reconciled.map(|r| r.mutated).unwrap_or_else(|err| {
            log::warn!("typing-analytics reconcile failed: Error: {err}");
            false
        });
        let ctx = self.units.ctx().clone();
        let own_typing = self.own_typing().await;
        let mut units = tokio::task::spawn_blocking(move || collect_all_sync_units(&ctx, own_typing))
            .await
            .map_err(|err| PreflightError::Other(err.to_string()))?;
        if *scope != SyncScope::All {
            units.retain(|unit| matches_scope(Some(unit), scope));
        }
        let listing =
            if mutated { Listing::new(self.units.drive().list_files(None).await?) } else { listing };
        let items = units.into_iter().map(|unit| (unit, Work::SyncOrUpload { listing: &listing })).collect();
        Ok(self.run_units(SyncDirection::Upload, items, password).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn send<F: std::future::Future + Send>(_: F) {}

    /// A command's future must be `Send` for every lifetime of its borrows;
    /// a closure held across an await (a stream's `map`) breaks that, and
    /// only the app's build would tell.
    #[expect(dead_code, reason = "checked when it compiles")]
    fn a_pass_is_send(executor: &SyncExecutor, scope: &SyncScope) {
        send(executor.execute_sync(SyncDirection::Download, scope));
    }
}
