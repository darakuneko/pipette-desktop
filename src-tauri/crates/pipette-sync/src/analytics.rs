// SPDX-License-Identifier: GPL-2.0-or-later
//! `executeAnalyticsSync` (src/main/sync/sync-analytics.ts): the sync the
//! Analyze panel runs for one keyboard when it opens (trigger F). It pulls
//! and pushes that keyboard's typing day files and every device's
//! deleted-ranges file, and nothing else.
//!
//! It does not take the sync lock. The keyboard is marked as syncing
//! instead ([`SyncRuntime::try_start_analytics_sync`]), so the polling and
//! the manual passes run on, while a password change, a reset of the
//! keyboard and a switch of accounts wait for it or refuse. The day and
//! deleted-ranges units it syncs go through the process's one
//! [`UnitSync`], whose `sync:` and `upload:` locks serialize them with a
//! pass that syncs the same unit. It never reconciles this device's days
//! with Drive: that is the upload pass's (`executeSync`), which runs under
//! the sync lock.
//!
//! Its listing is name-filtered to the keyboard, so the guard's files (the
//! password-change lock and the sync-format markers) and the
//! password-check are listed on their own.
//!
//! [`SyncRuntime::try_start_analytics_sync`]: pipette_sync_runtime::SyncRuntime::try_start_analytics_sync

use std::collections::HashSet;
use std::future::Future;
use std::sync::Arc;

use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use pipette_drive::canonical::Listing;
use pipette_sync_format::drive_names::{drive_filename_prefix, sync_unit_from_file_name};

use crate::bundle::collect_analytics_sync_units_for_uid;
use crate::dispatch::UnitSync;
use crate::execute::{PassHooks, SYNC_CONCURRENCY};
use crate::preflight::{Preflight, PreflightError};
use crate::units::{is_analytics_sync_unit, is_typing_deleted_ranges_sync_unit};

/// What an [`AnalyticsSync`] is built from.
pub struct AnalyticsSyncDeps {
    pub preflight: Arc<Preflight>,
    /// The process's one unit sync, shared with the passes.
    pub units: Arc<UnitSync>,
    /// Where the apply of this device's own deleted ranges is queued; the
    /// passes' hooks.
    pub hooks: Arc<dyn PassHooks>,
}

pub struct AnalyticsSync {
    preflight: Arc<Preflight>,
    units: Arc<UnitSync>,
    hooks: Arc<dyn PassHooks>,
    concurrency: usize,
}

/// Runs `items` [`AnalyticsSync::with_concurrency`] at a time; the units
/// whose sync succeeded, and whether any failed.
async fn run_limited<F>(items: Vec<F>, concurrency: usize) -> (HashSet<String>, bool)
where
    F: Future<Output = (String, bool)>,
{
    let mut waiting = items.into_iter();
    let mut running = FuturesUnordered::new();
    let (mut succeeded, mut failed) = (HashSet::new(), false);
    loop {
        while running.len() < concurrency {
            let Some(item) = waiting.next() else { break };
            running.push(item);
        }
        let Some((unit, ok)) = running.next().await else { break };
        if ok {
            succeeded.insert(unit);
        } else {
            failed = true;
        }
    }
    (succeeded, failed)
}

impl AnalyticsSync {
    pub fn new(deps: AnalyticsSyncDeps) -> Self {
        Self {
            preflight: deps.preflight,
            units: deps.units,
            hooks: deps.hooks,
            concurrency: SYNC_CONCURRENCY,
        }
    }

    /// How many units it syncs at a time; one makes the order of the
    /// requests fixed (the recorded syncs compare it).
    pub fn with_concurrency(mut self, concurrency: usize) -> Self {
        self.concurrency = concurrency.max(1);
        self
    }

    /// Syncs the typing analytics of keyboard `uid`. True when every unit
    /// synced, so the caller stamps its rate limit; false when it did not
    /// run (this keyboard syncs already, a reset of it runs, a switch of
    /// accounts runs, no credentials, a password change, a newer sync
    /// format on Drive), when the marker or the password-check failed, or
    /// when any unit failed, so the caller tries again on its next mount.
    pub async fn execute_analytics_sync(&self, uid: &str) -> bool {
        let Some(_syncing) = self.preflight.runtime().try_start_analytics_sync(uid) else { return false };
        match self.run(uid).await {
            Ok(complete) => complete,
            Err(err) => {
                log::warn!("[sync] the analytics sync of {uid} failed: {err}");
                false
            }
        }
    }

    async fn run(&self, uid: &str) -> Result<bool, PreflightError> {
        let preflight = &self.preflight;
        let Ok(password) = preflight.require_sync_credentials().await else { return Ok(false) };
        if preflight.local_sync_block().await.is_some() {
            return Ok(false);
        }
        let generation = preflight.sync_format_generation();
        let guard = preflight.list_guard_files().await?;
        if preflight.remote_sync_block(&guard, generation).is_some() {
            return Ok(false);
        }
        preflight.ensure_sync_format_marker(&guard, generation).await?;
        let checks = preflight.list_password_check_files().await?;
        preflight.ensure_password_check_validated(&password, &checks, generation).await?;

        // Drive filters by name; the unit checks below stay in case it
        // ever matches more loosely.
        let prefix = format!("keyboards/{uid}/devices/");
        let listing =
            Listing::new(preflight.drive().list_files(Some(&drive_filename_prefix(&prefix))).await?);
        let units = &self.units;
        let password = password.as_str();

        // One copy per name, so a unit with several files merges once. A
        // merge uploads whatever Drive lacks itself, so a unit it handled
        // is not pushed again below.
        let mut merges = Vec::new();
        for file in listing.canonical_files() {
            let Some(unit) = sync_unit_from_file_name(&file.name) else { continue };
            if !(is_analytics_sync_unit(&unit) || is_typing_deleted_ranges_sync_unit(&unit))
                || !unit.starts_with(&prefix)
            {
                continue;
            }
            let listing = &listing;
            merges.push(async move {
                let ok = units.merge_with_remote(file, &unit, password, Some(listing)).await.is_ok();
                (unit, ok)
            });
        }
        let (merged, merge_failed) = run_limited(merges, self.concurrency).await;

        let (ctx, owned_uid, own_hash) = (units.ctx().clone(), uid.to_owned(), units.own_hash());
        let local = tokio::task::spawn_blocking(move || {
            collect_analytics_sync_units_for_uid(&ctx, &owned_uid, own_hash)
        })
        .await
        .map_err(|err| PreflightError::Other(err.to_string()))?;
        let mut pushes = Vec::new();
        for unit in local.into_iter().filter(|unit| !merged.contains(unit)) {
            let listing = &listing;
            pushes.push(async move {
                let ok = units.sync_or_upload(&unit, password, listing).await.is_ok();
                (unit, ok)
            });
        }
        let (_, push_failed) = run_limited(pushes, self.concurrency).await;

        self.hooks.queue_own_deleted_ranges_apply(units.ops().clone(), units.holds());
        Ok(!merge_failed && !push_failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn send<F: Future + Send>(_: F) {}

    /// The command's future must be `Send` for every lifetime of its
    /// borrows; only the app's build would tell otherwise.
    #[expect(dead_code, reason = "checked when it compiles")]
    fn a_sync_is_send(sync: &AnalyticsSync) {
        send(sync.execute_analytics_sync("uid"));
    }
}
