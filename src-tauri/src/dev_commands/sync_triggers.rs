// SPDX-License-Identifier: GPL-2.0-or-later
//! The automatic sync seen and driven from the e2e tests. A poll pass
//! (trigger B) runs on demand, so they need not wait for the launch's first
//! pass or the three-minute interval. The state tells whether sync work
//! runs or a flush or a poll pass is due, so a step that a running pass
//! would make skip (a connect's download, a reset) can wait for it. Builds
//! with the development tools only.

use std::sync::Arc;
use std::time::Duration;

use pipette_sync::preflight::Preflight;
use serde::Serialize;
use tauri::{AppHandle, State, Wry};

use crate::command_error::CommandError;
use crate::sync_commands::triggers::{SyncTriggers, triggers};

fn managed_triggers(app: &AppHandle<Wry>) -> Result<Arc<SyncTriggers>, CommandError> {
    triggers(app).ok_or_else(|| CommandError::new("the sync triggers are not managed"))
}

/// One poll pass, as the polling timer runs it, whether auto sync is on or
/// not. Resolves when the pass has ended; does nothing while another pass
/// or a sync holds the sync lock.
#[tauri::command]
pub async fn dev_sync_run_poll_now(app: AppHandle<Wry>) -> Result<(), CommandError> {
    managed_triggers(&app)?.poller().poll_for_remote_changes().await;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevSyncState {
    /// The sync lock is held or a lock-free writer (the Analyze sync, a
    /// lazy fetch) runs.
    work_running: bool,
    /// How long until the scheduled flush runs; null when none is.
    flush_due_in_ms: Option<u64>,
    /// How long until a polling timer starts a pass (zero while the launch's
    /// first pass waits for the lock); null while polling is stopped.
    poll_due_in_ms: Option<u64>,
}

#[tauri::command]
pub fn dev_sync_state(
    app: AppHandle<Wry>,
    preflight: State<'_, Arc<Preflight>>,
) -> Result<DevSyncState, CommandError> {
    let triggers = managed_triggers(&app)?;
    Ok(DevSyncState {
        work_running: preflight.runtime().sync_work_running(),
        flush_due_in_ms: triggers.flusher().due_in().map(millis),
        poll_due_in_ms: triggers.poller().next_poll_due_in().map(millis),
    })
}

fn millis(due: Duration) -> u64 {
    u64::try_from(due.as_millis()).unwrap_or(u64::MAX)
}
