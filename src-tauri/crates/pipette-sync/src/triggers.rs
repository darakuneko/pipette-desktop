// SPDX-License-Identifier: GPL-2.0-or-later
//! The automatic triggers (the trigger table of the sync rules): the flush of
//! the pending units (A, [`crate::flush`]), the polling (B, [`crate::polling`])
//! and their part of the quit sequence (C), and what starts and stops them:
//!
//! - at launch, the units the last run left pending are scheduled and
//!   polling starts when auto sync is on, its first pass delayed;
//! - turning auto sync on starts polling and schedules a flush, turning it
//!   off stops polling;
//! - a sign-in and a stored password schedule a flush and start polling
//!   when auto sync is on; a sign-out stops polling;
//! - a download pass starts polling when auto sync is on, and a pass that
//!   leaves units pending schedules a flush ([`PassHooks`]);
//! - the quit stops polling and the flush timer and marks the app as
//!   quitting, then waits for a running password change, then for the pass
//!   holding the sync lock, then flushes what is pending.
//!
//! Whether auto sync is on is kept here: the app sets it once from its
//! config and again on each change, so no trigger reads the config.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use pipette_sync_pending::PendingStore;
use pipette_sync_runtime::SyncRuntime;
use tokio::runtime::Handle;

use crate::dispatch::UnitSync;
use crate::execute::{PassAccount, PassHooks};
use crate::flush::{AutoSync, DEBOUNCE, FlushDeps, Flusher};
use crate::polling::{PollDeps, Poller};
use crate::preflight::{NowMs, Preflight};

/// What [`SyncTriggers`] are built from.
pub struct TriggerDeps {
    pub preflight: Arc<Preflight>,
    pub units: Arc<UnitSync>,
    pub pending: PendingStore,
    pub account: Arc<dyn PassAccount>,
    /// Whether auto sync is on at the start.
    pub auto_sync: bool,
    /// The clock of the trash names, in milliseconds.
    pub now_ms: NowMs,
    /// Where the timers and the passes they start run.
    pub handle: Handle,
    /// How many units a pass syncs at a time
    /// ([`crate::execute::SYNC_CONCURRENCY`]).
    pub concurrency: usize,
}

/// The flush and the polling of the process.
pub struct SyncTriggers {
    flusher: Flusher,
    poller: Poller,
    runtime: SyncRuntime,
    pending: PendingStore,
    auto_sync: Arc<AtomicBool>,
}

impl PassHooks for SyncTriggers {
    fn schedule_flush_if_pending(&self, delay: Option<Duration>) {
        self.flusher.schedule_flush_if_pending(delay.unwrap_or(DEBOUNCE));
    }

    fn start_polling_if_auto_sync(&self) {
        self.poller.start_polling_if_auto_sync();
    }
}

impl SyncTriggers {
    pub fn new(deps: TriggerDeps) -> Self {
        let auto_sync = Arc::new(AtomicBool::new(deps.auto_sync));
        let read = Arc::clone(&auto_sync);
        let is_on: AutoSync = Arc::new(move || read.load(Ordering::SeqCst));
        let flusher = Flusher::new(FlushDeps {
            preflight: Arc::clone(&deps.preflight),
            units: Arc::clone(&deps.units),
            pending: deps.pending.clone(),
            account: deps.account,
            auto_sync: Arc::clone(&is_on),
            handle: deps.handle.clone(),
            concurrency: deps.concurrency,
        });
        let runtime = deps.preflight.runtime().clone();
        let poller = Poller::new(PollDeps {
            preflight: deps.preflight,
            units: deps.units,
            auto_sync: is_on,
            now_ms: deps.now_ms,
            handle: deps.handle,
            concurrency: deps.concurrency,
        });
        Self { flusher, poller, runtime, pending: deps.pending, auto_sync }
    }

    pub fn flusher(&self) -> &Flusher {
        &self.flusher
    }

    pub fn poller(&self) -> &Poller {
        &self.poller
    }

    /// At launch: the units the last run left pending go out after the
    /// debounce, and polling starts when auto sync is on.
    pub fn start(&self) {
        self.flusher.schedule_flush_if_pending(DEBOUNCE);
        self.poller.start_polling_at_launch();
    }

    /// Records a change of `unit` and pushes the flush out by the full
    /// debounce.
    pub fn notify_change(&self, unit: &str) {
        self.flusher.notify_change(unit);
    }

    /// Auto sync was turned on or off.
    pub fn set_auto_sync(&self, on: bool) {
        self.auto_sync.store(on, Ordering::SeqCst);
        if on {
            self.poller.start_polling(None);
            // A flush with auto sync off keeps its pending units.
            self.flusher.schedule_flush_if_pending(DEBOUNCE);
        } else {
            self.poller.stop_polling();
        }
    }

    /// A sign-in or a stored password: what a flush or a poll waited for
    /// may be there now.
    pub fn credentials_ready(&self) {
        self.flusher.schedule_flush_if_pending(DEBOUNCE);
        self.poller.start_polling_if_auto_sync();
    }

    /// A sign-out that went through.
    pub fn signed_out(&self) {
        self.poller.stop_polling();
    }

    /// The start of the quit: polling stops, the app counts as quitting
    /// (no flush is scheduled, and the Drive retries and the tidying stop
    /// early) and the flush timer goes. Whether the sync has work for the
    /// quit phases: pending units, a holder of the sync lock or a running
    /// password change.
    pub fn begin_quit(&self) -> bool {
        self.poller.stop_polling();
        let work = self.pending.has_pending_changes()
            || self.runtime.is_syncing()
            || self.runtime.password_change_running();
        self.runtime.set_quitting();
        self.flusher.clear_timer();
        work
    }

    /// The inFlightSync quit phase: waits for the holder of the sync lock
    /// (a flush, a manual sync, a poll, a reset).
    pub async fn in_flight_pass_ended(&self) {
        if let Some(pass) = self.runtime.in_flight_pass() {
            pass.released().await;
        }
    }

    /// The flushPending quit phase: sends what is still pending, waiting
    /// for the sync lock for as long as it is held (the quit's deadline
    /// bounds it).
    pub async fn flush_pending(&self) {
        self.flusher.flush_pending_changes().await;
    }
}
