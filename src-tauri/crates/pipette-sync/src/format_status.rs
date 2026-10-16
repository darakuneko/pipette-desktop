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
//!
//! Both are checked under the status lock, in the same hold that stores
//! the status. A clear bumps the generation before it takes that lock, so
//! a write either sees the new generation and records nothing, or lands
//! first and is cleared after it.

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

/// Records `status` when `allowed` holds for what is known, checked in
/// the same hold of the lock, and reports it when it changed. The listener
/// lock is held from before the status lock until the listener returns,
/// so the reports go out in the order the statuses were recorded; the
/// listener must therefore not record a status or set a listener itself.
fn store_if(
    cache: &FormatStatusCache,
    status: Option<SyncFormatStatus>,
    allowed: impl FnOnce(&Known) -> bool,
) {
    let listener = lock(&cache.listener);
    {
        let mut known = lock(&cache.known);
        if !allowed(&known) {
            return;
        }
        known.version += 1;
        if known.status == status {
            return;
        }
        known.status = status;
    }
    if let Some(listener) = listener.as_ref() {
        listener(status);
    }
}

impl Preflight {
    /// Calls `listener` with the new status (`None` once forgotten)
    /// whenever it changes, one call at a time in the order of the
    /// changes. The listener must not record a status or set a listener.
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
                match preflight.sync_format_status().await {
                    Ok(status) => store_if(&preflight.format_status, Some(status), |known| {
                        known.version == started_at && preflight.sync_format_generation() == started_in
                    }),
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
        store_if(&self.format_status, None, |_| true);
    }

    /// Records that an entry point found a marker `required` newer than
    /// this app's. `generation` is the sign-out generation taken before
    /// the entry point's listing was requested.
    pub fn note_sync_format_update_required(&self, required: Option<u64>, generation: u64) {
        let status = SyncFormatStatus { required, supported: SYNC_FORMAT_VERSION, update_required: true };
        store_if(&self.format_status, Some(status), |_| generation == self.sync_format_generation());
    }
}
