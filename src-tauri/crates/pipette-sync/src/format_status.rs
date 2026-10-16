// SPDX-License-Identifier: GPL-2.0-or-later
//! The latest known sync-format status of the signed-in account's Drive,
//! for the renderer's "update Pipette" banner
//! (src/main/sync/sync-format-status.ts). Filled by a markers-only listing
//! (at startup and after sign-in) and by the guard whenever an entry point
//! stops with `updateRequired`; forgotten when the sign-in changes. `None`
//! means unknown. Every change goes to the listener (the app sends it as
//! `sync:format-status-changed`).
//!
//! Two counters keep stale results out:
//! - the sign-out generation ([`Preflight::sync_format_generation`]):
//!   clearing bumps it, so a listing or a blocked pass that started for
//!   the previous account records nothing;
//! - `version`, bumped by every write: a refresh result is stored only when
//!   nothing was recorded since the refresh started, so a slow listing
//!   cannot overwrite a newer block.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::format::{SYNC_FORMAT_VERSION, SyncFormatStatus};
use crate::preflight::Preflight;
use crate::single_flight::SingleFlight;

type Listener = Arc<dyn Fn(Option<SyncFormatStatus>) + Send + Sync>;

#[derive(Default)]
struct Known {
    status: Option<SyncFormatStatus>,
    version: u64,
}

#[derive(Default)]
pub(crate) struct FormatStatusCache {
    known: Arc<Mutex<Known>>,
    listener: Arc<Mutex<Option<Listener>>>,
    refreshing: SingleFlight<Option<SyncFormatStatus>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Records `status` and reports it when it changed. The listener is called
/// outside the lock.
fn store(known: &Mutex<Known>, listener: &Mutex<Option<Listener>>, status: Option<SyncFormatStatus>) {
    {
        let mut known = lock(known);
        known.version += 1;
        if known.status == status {
            return;
        }
        known.status = status;
    }
    let listener = lock(listener).clone();
    if let Some(listener) = listener {
        listener(status);
    }
}

impl Preflight {
    /// Calls `listener` with the new status (`None` once forgotten)
    /// whenever it changes.
    pub fn set_sync_format_status_listener(
        &self,
        listener: impl Fn(Option<SyncFormatStatus>) + Send + Sync + 'static,
    ) {
        *lock(&self.format_status.listener) = Some(Arc::new(listener));
    }

    pub fn cached_sync_format_status(&self) -> Option<SyncFormatStatus> {
        lock(&self.format_status.known).status
    }

    /// Lists the markers on Drive and stores the result. Never fails: a
    /// failure is logged and the current status (possibly `None`) is
    /// returned. Calls made while a listing is in flight share it.
    pub async fn refresh_sync_format_status(self: &Arc<Self>) -> Option<SyncFormatStatus> {
        let preflight = Arc::clone(self);
        let (_, refreshed) = self.format_status.refreshing.run(move || {
            // Taken when the refresh is asked for, not when its task runs.
            let started_in = preflight.sync_format_generation();
            let started_at = lock(&preflight.format_status.known).version;
            async move {
                let cache = &preflight.format_status;
                match preflight.sync_format_status().await {
                    Ok(status) => {
                        let unchanged = lock(&cache.known).version == started_at;
                        if preflight.sync_format_generation() == started_in && unchanged {
                            store(&cache.known, &cache.listener, Some(status));
                        }
                    }
                    Err(err) => log::warn!("sync-format: status check failed: {err}"),
                }
                let current = preflight.sync_format_generation() == started_in;
                Ok(if current { preflight.cached_sync_format_status() } else { None })
            }
        });
        refreshed.await.unwrap_or(None)
    }

    /// Forgets the status, any listing in flight and the marker this
    /// process created (sign-out, sign-in).
    pub fn clear_sync_format_status(&self) {
        self.forget_created_sync_format_marker();
        self.format_status.refreshing.forget();
        store(&self.format_status.known, &self.format_status.listener, None);
    }

    /// Records that an entry point found a marker `required` newer than
    /// this app's. `generation` is the sign-out generation taken before
    /// the entry point's listing was requested.
    pub fn note_sync_format_update_required(&self, required: Option<u64>, generation: u64) {
        if generation != self.sync_format_generation() {
            return;
        }
        let status = SyncFormatStatus { required, supported: SYNC_FORMAT_VERSION, update_required: true };
        store(&self.format_status.known, &self.format_status.listener, Some(status));
    }
}
