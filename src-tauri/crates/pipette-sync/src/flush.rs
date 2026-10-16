// SPDX-License-Identifier: GPL-2.0-or-later
//! Trigger A (src/main/sync/sync-flush.ts): the pending units are sent
//! [`DEBOUNCE`] after the last change, by a flush pass.
//!
//! One timer at most. A change ([`Flusher::notify_change`]) replaces it
//! with one firing the full [`DEBOUNCE`] from now. Everything else that
//! asks for a flush ([`Flusher::schedule_flush_if_pending`]: a retry, or a
//! reason a flush kept the units being gone) keeps a timer that fires no
//! later, so the earlier flush wins.
//!
//! A flush that finds the sync lock held waits once for the holder (until
//! it is free while quitting); still held after that, it tries again
//! [`DEBOUNCE`] later. Every flush that stops before the units keeps them
//! pending, and only an upload that succeeds settles a unit, unless the
//! unit changed again meanwhile (its generation). A flush tries again after
//! [`POLL_INTERVAL`] when the reason it stopped can clear up on its own: a
//! credential failure of [`RETRYABLE_CREDENTIAL_REASONS`], the sync guard,
//! a failed listing, marker or password-check (not a mismatch), or units it
//! could not send; after [`DEBOUNCE`] when a unit changed during the pass.
//! Auto sync off, the other credential failures and a password mismatch
//! wait for auto sync to be turned on, a sign-in or a stored password,
//! which schedule a flush themselves. Nothing is scheduled once the app
//! quits.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use pipette_drive::canonical::Listing;
use pipette_sync_pending::PendingStore;
use pipette_sync_runtime::{SyncCredentialFailureReason, SyncDirection, SyncProgress, SyncStatus};
use tokio::runtime::Handle;
use tokio::task::AbortHandle;
use tokio::time::Instant;

use crate::dispatch::UnitSync;
#[cfg(doc)]
use crate::execute::SYNC_CONCURRENCY;
use crate::execute::{POLL_INTERVAL, PassAccount};
use crate::limited::rosters_first;
use crate::password::guard::SyncBlockReason;
use crate::preflight::{Preflight, PreflightError};

/// How long after the last change the pending units are sent.
pub const DEBOUNCE: Duration = Duration::from_secs(10);

/// The credential failures that can clear up on their own.
pub const RETRYABLE_CREDENTIAL_REASONS: [SyncCredentialFailureReason; 3] = [
    SyncCredentialFailureReason::KeystoreUnavailable,
    SyncCredentialFailureReason::DecryptFailed,
    SyncCredentialFailureReason::RemoteCheckFailed,
];

/// Whether auto sync is on (`loadAppConfig().autoSync`). Called often and
/// from async code, so it must not block.
pub type AutoSync = Arc<dyn Fn() -> bool + Send + Sync>;

/// What a [`Flusher`] is built from.
pub struct FlushDeps {
    pub preflight: Arc<Preflight>,
    pub units: Arc<UnitSync>,
    pub pending: PendingStore,
    pub account: Arc<dyn PassAccount>,
    pub auto_sync: AutoSync,
    /// Where the timer runs.
    pub handle: Handle,
    /// How many units a flush syncs at a time ([`SYNC_CONCURRENCY`]); one
    /// makes the order of the requests fixed.
    pub concurrency: usize,
}

/// The flush timer and the flush pass. Cheap to clone; the clones share
/// the timer.
#[derive(Clone)]
pub struct Flusher {
    inner: Arc<Inner>,
}

struct Inner {
    preflight: Arc<Preflight>,
    units: Arc<UnitSync>,
    pending: PendingStore,
    account: Arc<dyn PassAccount>,
    auto_sync: AutoSync,
    handle: Handle,
    concurrency: usize,
    timer: Mutex<Timer>,
}

/// The one flush timer: when it fires, and its task. `armed` tells a fired
/// task whether it is still the current one.
#[derive(Default)]
struct Timer {
    due: Option<Instant>,
    task: Option<AbortHandle>,
    armed: u64,
}

impl Timer {
    fn clear(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        self.due = None;
    }
}

impl Flusher {
    pub fn new(deps: FlushDeps) -> Self {
        Self {
            inner: Arc::new(Inner {
                preflight: deps.preflight,
                units: deps.units,
                pending: deps.pending,
                account: deps.account,
                auto_sync: deps.auto_sync,
                handle: deps.handle,
                concurrency: deps.concurrency.max(1),
                timer: Mutex::default(),
            }),
        }
    }

    fn timer(&self) -> MutexGuard<'_, Timer> {
        self.inner.timer.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `notifyChange`: records a change of `unit` and pushes the flush out
    /// by the full [`DEBOUNCE`].
    pub fn notify_change(&self, unit: &str) {
        self.inner.pending.notify_change(unit);
        let mut timer = self.timer();
        self.arm(&mut timer, DEBOUNCE);
    }

    /// `scheduleFlushIfPending`: a flush after `delay` when units are
    /// pending and the app is not quitting, unless one fires no later.
    pub fn schedule_flush_if_pending(&self, delay: Duration) {
        if self.inner.pending.has_pending_changes() {
            self.schedule_flush(delay);
        }
    }

    /// `scheduleFlush`: a flush after `delay`, unless the timer fires no
    /// later or the app quits. The quit is checked holding the timer, so a
    /// timer the quit clears is never armed again after it.
    fn schedule_flush(&self, delay: Duration) {
        let mut timer = self.timer();
        if self.inner.preflight.runtime().is_quitting()
            || timer.task.is_some() && timer.due.is_some_and(|due| due <= Instant::now() + delay)
        {
            return;
        }
        self.arm(&mut timer, delay);
    }

    /// `armFlushTimer`: replaces the timer with one firing `delay` from now.
    fn arm(&self, timer: &mut Timer, delay: Duration) {
        timer.clear();
        timer.armed += 1;
        let (armed, due) = (timer.armed, Instant::now() + delay);
        let flusher = self.clone();
        let task = self.inner.handle.spawn(async move {
            tokio::time::sleep_until(due).await;
            if flusher.take_fired(armed) {
                flusher.flush_pending_changes().await;
            }
        });
        timer.due = Some(due);
        timer.task = Some(task.abort_handle());
    }

    /// Whether the timer `armed` is still the current one; it is cleared
    /// when it is, so nothing aborts the flush it starts.
    fn take_fired(&self, armed: u64) -> bool {
        let mut timer = self.timer();
        if timer.armed != armed || timer.task.is_none() {
            return false;
        }
        timer.task = None;
        timer.due = None;
        true
    }

    /// `clearFlushTimer`: drops the timer; a flush it already started runs
    /// on.
    pub fn clear_timer(&self) {
        self.timer().clear();
    }

    /// How long until the timer fires; `None` when there is none.
    pub fn due_in(&self) -> Option<Duration> {
        let timer = self.timer();
        timer.task.as_ref().and(timer.due).map(|due| due.saturating_duration_since(Instant::now()))
    }

    fn emit(&self, status: SyncStatus, message: impl Into<String>) {
        let progress = SyncProgress {
            message: Some(message.into()),
            ..SyncProgress::new(SyncDirection::Upload, status)
        };
        self.inner.preflight.runtime().progress().emit(&progress);
    }

    /// `reportBlockedFlush`: the guard stopped the flush.
    fn report_blocked(&self, reason: SyncBlockReason) {
        self.inner.preflight.emit_sync_blocked(SyncDirection::Upload, reason);
        self.schedule_flush_if_pending(POLL_INTERVAL);
    }

    /// `reportFailedFlush`: the flush failed before its units.
    fn report_failed(&self, message: String) {
        self.emit(SyncStatus::Error, message);
        self.schedule_flush_if_pending(POLL_INTERVAL);
    }

    /// `flushPendingChanges`: uploads the pending units of the signed-in
    /// account in one pass holding the sync lock.
    pub async fn flush_pending_changes(&self) {
        let (pending, runtime) = (&self.inner.pending, self.inner.preflight.runtime());
        if !pending.has_pending_changes() {
            return;
        }
        let mut waited = false;
        let _lock = loop {
            if let Some(lock) = runtime.try_claim_sync_lock(false) {
                break lock;
            }
            match runtime.in_flight_pass() {
                Some(_) if waited && !runtime.is_quitting() => {
                    self.schedule_flush_if_pending(DEBOUNCE);
                    return;
                }
                Some(pass) => {
                    pass.released().await;
                    waited = true;
                }
                // Released meanwhile.
                None => {}
            }
        };
        // The pass waited for may have sent everything.
        if !pending.has_pending_changes() {
            return;
        }
        self.clear_timer();
        self.run().await;
    }

    async fn run(&self) {
        let Inner { preflight, units, pending, account, auto_sync, concurrency, .. } = &*self.inner;
        // Turning auto sync on schedules a flush.
        if !auto_sync() {
            return;
        }
        if let Some(reason) = preflight.local_sync_block().await {
            return self.report_blocked(reason);
        }
        let password = match preflight.require_sync_credentials().await {
            Ok(password) => password,
            Err(reason) => {
                if RETRYABLE_CREDENTIAL_REASONS.contains(&reason) {
                    self.schedule_flush_if_pending(POLL_INTERVAL);
                }
                return;
            }
        };
        // Units changed under another account are held for it.
        let owner = account.account_sub().await;
        pending.adopt_for_account(owner.as_deref());
        if !pending.has_pending_changes() {
            return;
        }

        self.emit(SyncStatus::Syncing, "Auto-sync starting...");
        let generation = preflight.sync_format_generation();
        let listing = match preflight.drive().list_files(None).await {
            Ok(files) => Listing::new(files),
            Err(err) => return self.report_failed(err.to_string()),
        };
        if let Some(reason) = preflight.remote_sync_block(listing.files(), generation) {
            return self.report_blocked(reason);
        }
        if let Err(err) = preflight.ensure_sync_format_marker(listing.files(), generation).await {
            return self.report_failed(err.to_string());
        }
        match preflight.ensure_password_check_validated(&password, listing.files(), generation).await {
            Ok(()) => {}
            // Waits for the new password; storing it schedules a flush.
            Err(PreflightError::PasswordMismatch) => {
                return self.emit(SyncStatus::Error, PreflightError::PasswordMismatch.to_string());
            }
            Err(err) => return self.report_failed(err.to_string()),
        }

        // In the order the units were first marked.
        let snapshot: Vec<(String, u64)> = pending
            .snapshot_generations()
            .into_iter()
            .filter_map(|(unit, generation)| Some((unit.as_str()?.to_owned(), generation)))
            .collect();
        let generations: HashMap<&str, u64> = snapshot.iter().map(|(unit, g)| (unit.as_str(), *g)).collect();
        let items: Vec<(&str, u64)> = snapshot.iter().map(|(unit, g)| (unit.as_str(), *g)).collect();
        let (listing, password) = (&listing, &*password);
        let outcomes = rosters_first(
            items,
            |(unit, _)| unit,
            *concurrency,
            |(unit, generation)| async move {
                let result = units.sync_or_upload(unit, password, listing).await;
                if result.is_ok() {
                    pending.settle(unit, generation);
                }
                result.is_ok()
            },
        )
        .await;
        pending.broadcast_status();

        if outcomes.contains(&false) {
            self.emit(SyncStatus::Error, "Some sync units failed");
        } else {
            self.emit(SyncStatus::Success, "Sync complete");
        }

        if pending.has_pending_changes() {
            // A unit changed during the pass goes out after the usual
            // debounce; units that only failed wait a polling interval.
            let changed = pending.snapshot_generations().into_iter().any(|(unit, now)| {
                unit.as_str().and_then(|u| generations.get(u)).copied().unwrap_or(0) != now
            });
            self.schedule_flush(if changed { DEBOUNCE } else { POLL_INTERVAL });
        }
    }
}
