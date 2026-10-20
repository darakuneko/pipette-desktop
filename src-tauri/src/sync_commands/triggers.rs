// SPDX-License-Identifier: GPL-2.0-or-later
//! The automatic sync triggers (`pipette_sync::triggers`) in the app: every
//! store change goes through
//! [`notify_change`], the launch starts them ([`start`]), the app config's
//! `autoSync` turns them on and off ([`on_auto_sync_changed`]), and the
//! sign-in, the sign-out, a stored password, the passes and the quit
//! sequence call them directly. The sync-format status of an account that
//! signs in is checked by the sign-in's account listener
//! (super::preflight).

use std::sync::Arc;

use pipette_sync::dispatch::UnitSync;
use pipette_sync::execute::{PassAccount, SYNC_CONCURRENCY};
use pipette_sync::preflight::Preflight;
pub use pipette_sync::triggers::SyncTriggers;
use pipette_sync::triggers::TriggerDeps;
use pipette_sync_pending::PendingStore;
use tauri::{AppHandle, Manager, Runtime};

use crate::app_config::AppConfig;

/// `Boolean(config.autoSync)` of the stored config; off when it cannot be
/// read. Later values come from the config's change listener, which runs
/// under the config's lock, so the triggers never read the config.
fn stored_auto_sync<R: Runtime>(app: &AppHandle<R>) -> bool {
    let Some(config) = app.try_state::<AppConfig>() else { return false };
    match config.get("autoSync") {
        Ok(value) => value.as_ref().is_some_and(pipette_app_config::Value::is_truthy),
        Err(err) => {
            log::error!("[sync] failed to read autoSync: {err}");
            false
        }
    }
}

/// Builds the triggers of `units` on the app's async runtime and manages
/// them. Needs the pending units to be managed first.
pub fn manage<R: Runtime>(
    app: &AppHandle<R>,
    preflight: &Arc<Preflight>,
    units: &Arc<UnitSync>,
    account: Arc<dyn PassAccount>,
) -> Arc<SyncTriggers> {
    let triggers = Arc::new(SyncTriggers::new(TriggerDeps {
        preflight: Arc::clone(preflight),
        units: Arc::clone(units),
        pending: app.state::<PendingStore>().inner().clone(),
        account,
        auto_sync: stored_auto_sync(app),
        now_ms: Arc::new(|| u64::try_from(pipette_time::now_ms()).unwrap_or(0)),
        handle: tauri::async_runtime::handle().inner().clone(),
        concurrency: SYNC_CONCURRENCY,
    }));
    app.manage(Arc::clone(&triggers));
    triggers
}

/// The triggers of `app`, once managed.
pub fn triggers<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<SyncTriggers>> {
    app.try_state::<Arc<SyncTriggers>>().map(|state| Arc::clone(state.inner()))
}

/// Starts the triggers at launch.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    match triggers(app) {
        Some(triggers) => triggers.start(),
        None => log::error!("[sync] the sync triggers are not managed; nothing is synced automatically"),
    }
}

/// Records a change of `unit` and pushes the flush out.
/// Before the triggers exist the change is only recorded; the launch
/// schedules the flush of what is pending.
pub fn notify_change<R: Runtime>(app: &AppHandle<R>, unit: &str) {
    if let Some(triggers) = triggers(app) {
        triggers.notify_change(unit);
    } else if let Some(pending) = app.try_state::<PendingStore>() {
        pending.notify_change(unit);
    }
}

/// The app config's `autoSync` changed.
pub fn on_auto_sync_changed<R: Runtime>(app: &AppHandle<R>, on: bool) {
    if let Some(triggers) = triggers(app) {
        triggers.set_auto_sync(on);
    }
}
