// SPDX-License-Identifier: GPL-2.0-or-later
//! Trigger B (src/main/sync/sync-polling.ts): a poll pass every
//! [`POLL_INTERVAL`] while auto sync is on, and one [`STARTUP_POLL_DELAY`]
//! after a launch, keyboard connected or not.
//!
//! A pass takes the sync lock as a waitable holder, or does nothing when
//! it is held. It merges every Drive file whose revision it has not handled
//! (all of them on the first pass of a launch), one copy per name, except
//! the typing days and the run logs (the Analyze panel and the full syncs
//! carry those) and the keyboards with no local data. It records the files
//! it left alone on purpose, and a malformed bundle's revision, so the next
//! pass does not try them again; then it collects the pack garbage, queues
//! the apply of this device's own deleted ranges and tidies the names with
//! several copies on the same listing ([`crate::trash::tidy`]). A pass
//! blocked by the guard reports it; any other failure is silent, and the
//! next pass tries again.
//!
//! The delayed first pass waits for a holder of the sync lock instead of
//! skipping, so the launch pass is not lost; it is dropped when polling
//! stops meanwhile. A tick while the last pass still runs starts nothing.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use pipette_drive::DriveFile;
use pipette_drive::canonical::Listing;
use pipette_pack_stores::sync::run_pack_gc_after_pass;
use pipette_sync_format::drive_names::sync_unit_from_file_name;
use pipette_sync_runtime::{RemoteMemory, RemoteRevision, SyncDirection, SyncProgress, SyncStatus};
use tokio::runtime::Handle;
use tokio::task::AbortHandle;
use tokio::time::{Instant, MissedTickBehavior};

use crate::dispatch::UnitSync;
use crate::execute::POLL_INTERVAL;
use crate::flush::AutoSync;
use crate::limited::rosters_first;
use crate::merge::queue_own_deleted_ranges_apply;
use crate::preflight::{NowMs, Preflight};
use crate::scope::{SyncScope, list_local_keyboard_uids, should_download_sync_unit};
use crate::trash::tidy::{Tidy, TidyContext};
use crate::units::{is_analytics_sync_unit, is_run_log_sync_unit};

/// How long after a launch the first pass runs: time for the OS key store
/// and the Google token to become available, and for a connect-time
/// download to take the lock first.
pub const STARTUP_POLL_DELAY: Duration = Duration::from_secs(15);

/// What a [`Poller`] is built from.
pub struct PollDeps {
    pub preflight: Arc<Preflight>,
    pub units: Arc<UnitSync>,
    pub auto_sync: AutoSync,
    /// The clock of the trash names, in milliseconds.
    pub now_ms: NowMs,
    /// Where the timers and the passes run.
    pub handle: Handle,
    /// How many units a pass merges at a time
    /// ([`crate::execute::SYNC_CONCURRENCY`]).
    pub concurrency: usize,
}

/// The polling timers and the poll pass. Cheap to clone; the clones share
/// the timers.
#[derive(Clone)]
pub struct Poller {
    inner: Arc<Inner>,
}

struct Inner {
    deps: PollDeps,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    interval: Option<AbortHandle>,
    first_pass: Option<AbortHandle>,
    /// The pass that has not ended yet, by its number.
    in_flight: Option<u64>,
    passes: u64,
}

impl Poller {
    pub fn new(deps: PollDeps) -> Self {
        Self { inner: Arc::new(Inner { deps, state: Mutex::default() }) }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `startPolling`: a pass every [`POLL_INTERVAL`], and with
    /// `first_pass_delay` one more that long after the start. Does nothing
    /// while polling runs.
    pub fn start_polling(&self, first_pass_delay: Option<Duration>) {
        let mut state = self.state();
        if state.interval.is_some() {
            return;
        }
        // The times are taken now, not when the tasks first run.
        let now = Instant::now();
        let poller = self.clone();
        let interval = self.inner.deps.handle.spawn(async move {
            let mut ticks = tokio::time::interval_at(now + POLL_INTERVAL, POLL_INTERVAL);
            ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                ticks.tick().await;
                poller.start_tracked_pass();
            }
        });
        state.interval = Some(interval.abort_handle());
        if let Some(delay) = first_pass_delay {
            let poller = self.clone();
            let first = self.inner.deps.handle.spawn(async move {
                tokio::time::sleep_until(now + delay).await;
                poller.run_first_pass().await;
            });
            state.first_pass = Some(first.abort_handle());
        }
    }

    /// `startPollingIfAutoSync`: after a download, a sign-in or a stored
    /// password.
    pub fn start_polling_if_auto_sync(&self) {
        if (self.inner.deps.auto_sync)() {
            self.start_polling(None);
        }
    }

    /// `startPollingAtLaunch`: with the delayed first pass.
    pub fn start_polling_at_launch(&self) {
        if (self.inner.deps.auto_sync)() {
            self.start_polling(Some(STARTUP_POLL_DELAY));
        }
    }

    /// `stopPolling`: stops the timers; a pass already running runs on.
    pub fn stop_polling(&self) {
        let mut state = self.state();
        for task in [state.interval.take(), state.first_pass.take()].into_iter().flatten() {
            task.abort();
        }
    }

    /// Whether polling runs.
    pub fn is_polling(&self) -> bool {
        self.state().interval.is_some()
    }

    /// The delayed first pass: waits out each holder of the sync lock, then
    /// starts. Dropped with its task when polling stops.
    async fn run_first_pass(&self) {
        let runtime = self.inner.deps.preflight.runtime();
        while let Some(pass) = runtime.in_flight_pass() {
            pass.released().await;
        }
        self.state().first_pass = None;
        self.start_tracked_pass();
    }

    /// `startTrackedPass`: a pass, unless the last one still runs.
    fn start_tracked_pass(&self) {
        let number = {
            let mut state = self.state();
            if state.in_flight.is_some() {
                return;
            }
            state.passes += 1;
            state.in_flight = Some(state.passes);
            state.passes
        };
        let poller = self.clone();
        self.inner.deps.handle.spawn(async move {
            poller.poll_for_remote_changes().await;
            let mut state = poller.state();
            if state.in_flight == Some(number) {
                state.in_flight = None;
            }
        });
    }

    /// Whether a pass runs.
    pub fn pass_running(&self) -> bool {
        self.state().in_flight.is_some()
    }

    /// `pollForRemoteChanges`: one poll pass.
    pub async fn poll_for_remote_changes(&self) {
        let deps = &self.inner.deps;
        let (preflight, runtime) = (&deps.preflight, deps.preflight.runtime());
        let Some(_lock) = runtime.try_claim_sync_lock(true) else { return };

        if let Some(reason) = preflight.local_sync_block().await {
            return preflight.emit_sync_blocked(SyncDirection::Download, reason);
        }
        // Silent: a manual sync shows the reason.
        let Ok(password) = preflight.require_sync_credentials().await else { return };
        let generation = preflight.sync_format_generation();
        let Ok(files) = preflight.drive().list_files(None).await else { return };
        let listing = Listing::new(files);
        if let Some(reason) = preflight.remote_sync_block(listing.files(), generation) {
            return preflight.emit_sync_blocked(SyncDirection::Download, reason);
        }
        // Merges may upload, so the marker comes first, even on the first
        // poll.
        if preflight.ensure_sync_format_marker(listing.files(), generation).await.is_err()
            || preflight
                .ensure_password_check_validated(&password, listing.files(), generation)
                .await
                .is_err()
        {
            return;
        }

        let user_data = deps.units.ctx().user_data().to_path_buf();
        let local = tokio::task::spawn_blocking(move || list_local_keyboard_uids(&user_data))
            .await
            .unwrap_or_default();
        // One copy per name: the handled revisions are kept by name, so a
        // second copy would overwrite the chosen one's and look changed on
        // every pass.
        let listed = listing.canonical_files();
        let changed: Vec<(&DriveFile, String)> = listed
            .iter()
            .filter(|file| !runtime.remote().is_known(&file.name, &file.id, &file.modified_time))
            .filter_map(|file| {
                let unit = sync_unit_from_file_name(&file.name)?;
                let polled = !is_analytics_sync_unit(&unit)
                    && !is_run_log_sync_unit(&unit)
                    && should_download_sync_unit(Some(&unit), &SyncScope::All, &local);
                polled.then_some((*file, unit))
            })
            .collect();
        // The files evaluated and left alone on purpose; a changed file is
        // recorded by its merge, only when it succeeds.
        let changed_names: HashSet<&str> = changed.iter().map(|(file, _)| file.name.as_str()).collect();
        for file in listed.iter().filter(|file| !changed_names.contains(file.name.as_str())) {
            record(runtime.remote(), file);
        }

        let attempted: Vec<String> = changed.iter().map(|(_, unit)| unit.clone()).collect();
        let (listing_ref, password) = (&listing, &*password);
        let results = rosters_first(
            changed,
            |(_, unit)| unit,
            deps.concurrency,
            |(file, unit)| async move {
                match deps.units.merge_with_remote(file, &unit, password, Some(listing_ref)).await {
                    Ok(()) => {
                        runtime.progress().emit(&SyncProgress {
                            sync_unit: Some(unit),
                            message: Some("Sync complete".to_owned()),
                            ..SyncProgress::new(SyncDirection::Download, SyncStatus::Success)
                        });
                        None
                    }
                    Err(err) => {
                        if err.is_malformed() {
                            // Its exact revision, so the next pass does not try
                            // it again (a new revision is). The unit only, never
                            // the content.
                            record(runtime.remote(), file);
                            log::warn!("sync: {err}");
                        }
                        Some(unit)
                    }
                }
            },
        )
        .await;
        let failed: Vec<String> = results.into_iter().flatten().collect();

        let ctx = deps.units.ctx().clone();
        if let Err(err) =
            tokio::task::spawn_blocking(move || run_pack_gc_after_pass(&ctx, &attempted, &failed)).await
        {
            log::warn!("pack-gc: the sweep did not finish: {err}");
        }
        drop(queue_own_deleted_ranges_apply(deps.units.ops().clone(), deps.units.holds()));
        // Last, on the same listing: the merges read only the chosen copy
        // of each name, which the tidying never renames.
        if let Ok(own_hash) = deps.units.own_hash() {
            let ctx = TidyContext {
                local_keyboard_uids: &local,
                own_hash: &own_hash,
                now_ms: i64::try_from((deps.now_ms)()).unwrap_or(i64::MAX),
            };
            Tidy { drive: preflight.drive(), runtime }.tidy_duplicate_copies(&listing, &ctx).await;
        }
    }
}

fn record(remote: &RemoteMemory, file: &DriveFile) {
    remote.record(
        &file.name,
        RemoteRevision { id: file.id.clone(), modified_time: file.modified_time.clone() },
    );
}
