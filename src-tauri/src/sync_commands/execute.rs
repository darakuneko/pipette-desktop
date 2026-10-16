// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync passes of the renderer (`syncExecute` of src/main/sync/sync-ipc.ts)
//! and what they report: the progress (`sync:progress`) and the units a
//! merge rewrote (`sync:unit-applied`, and the pack lists' own events), on
//! the channels of the Electron main process.
//!
//! The one [`UnitSync`] of the process is managed here too: every entry
//! point that syncs a unit goes through it, so its `sync:` and `upload:`
//! locks serialize them.

use std::sync::Arc;
use std::time::Duration;

use pipette_drive::canonical::Listing;
use pipette_keyboard_stores::StoreContext;
use pipette_sync::codec::EnvelopeCrypto;
use pipette_sync::dispatch::{UnitSync, UnitSyncDeps};
use pipette_sync::execute::{ExecuteDeps, KeyboardMetaBackfill, PassHooks, SyncExecuteResult, SyncExecutor};
use pipette_sync::merge::{MergeEvents, PackKind};
use pipette_sync::preflight::{BoxFuture, Preflight, PreflightError};
use pipette_sync::scope::SyncScope;
use pipette_sync_pending::PendingStore;
use pipette_sync_runtime::{SyncDirection, SyncProgress, SyncStatus};
use pipette_typing_analytics::DataOps;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, State};

use super::SyncSecrets;
use super::result::SyncOperationResult;
use crate::command_error::CommandError;
use crate::events::{I18N_PACK_CHANGED, SYNC_PROGRESS, SYNC_UNIT_APPLIED, THEME_PACK_CHANGED, emit_all};

/// The merges' reports as the events of the pages.
struct AppMergeEvents<R: Runtime>(AppHandle<R>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UnitApplied<'a> {
    sync_unit: &'a str,
}

impl<R: Runtime> MergeEvents for AppMergeEvents<R> {
    fn unit_applied(&self, unit: &str) {
        emit_all(&self.0, SYNC_UNIT_APPLIED, UnitApplied { sync_unit: unit });
    }

    fn pack_changed(&self, kind: PackKind) {
        let event = match kind {
            PackKind::I18n => I18N_PACK_CHANGED,
            PackKind::Theme => THEME_PACK_CHANGED,
        };
        emit_all(&self.0, event, ());
    }
}

/// `SyncProgress` of src/shared/types/sync.ts; the absent fields are left
/// out.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload<'a> {
    direction: &'static str,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sync_unit: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    current: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failed_units: Option<&'a [String]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

fn direction_name(direction: SyncDirection) -> &'static str {
    match direction {
        SyncDirection::Upload => "upload",
        SyncDirection::Download => "download",
    }
}

impl<'a> From<&'a SyncProgress> for ProgressPayload<'a> {
    fn from(p: &'a SyncProgress) -> Self {
        let status = match p.status {
            SyncStatus::Idle => "idle",
            SyncStatus::Syncing => "syncing",
            SyncStatus::Error => "error",
            SyncStatus::Success => "success",
            SyncStatus::Partial => "partial",
        };
        Self {
            direction: direction_name(p.direction),
            status,
            message: p.message.as_deref(),
            sync_unit: p.sync_unit.as_deref(),
            current: p.current,
            total: p.total,
            failed_units: p.failed_units.as_deref(),
            reason: p.reason.map(|reason| reason.as_str()),
        }
    }
}

/// The keyboard-name backfill of a download of `'all'`: names nothing
/// until the keyboard names' sync provides it.
struct NoBackfill;

impl KeyboardMetaBackfill for NoBackfill {
    fn backfill<'a>(&'a self, _: &'a str, _: &'a Listing) -> BoxFuture<'a, Result<usize, String>> {
        Box::pin(std::future::ready(Ok(0)))
    }
}

/// The flush and the polling a pass hands work to: none runs yet, so the
/// pending units wait for the next pass.
struct NoTriggers;

impl PassHooks for NoTriggers {
    fn schedule_flush_if_pending(&self, _: Option<Duration>) {}

    fn start_polling_if_auto_sync(&self) {}
}

/// Manages the unit sync and the passes on the preflight's Drive. Needs the
/// preflight ([`super::preflight::manage`]), the stores, the typing
/// analytics and the pending units to be managed first. The progress of
/// every pass, the preflight's blocked reports included, goes to the pages
/// from here on.
pub fn manage<R: Runtime>(app: &AppHandle<R>) {
    let preflight = Arc::clone(app.state::<Arc<Preflight>>().inner());
    let runtime = preflight.runtime().clone();
    let units = Arc::new(UnitSync::new(UnitSyncDeps {
        drive: preflight.drive().clone(),
        runtime: runtime.clone(),
        ctx: app.state::<StoreContext>().inner().clone(),
        ops: Arc::clone(app.state::<Arc<DataOps>>().inner()),
        events: Arc::new(AppMergeEvents(app.clone())),
        codec: Arc::new(EnvelopeCrypto),
    }));
    let executor = SyncExecutor::new(ExecuteDeps {
        preflight,
        units: Arc::clone(&units),
        pending: app.state::<PendingStore>().inner().clone(),
        account: Arc::clone(&app.state::<SyncSecrets>().auth) as _,
        backfill: Arc::new(NoBackfill),
        hooks: Arc::new(NoTriggers),
    });
    let handle = app.clone();
    runtime.progress().set(move |progress: &SyncProgress| {
        emit_all(&handle, SYNC_PROGRESS, ProgressPayload::from(progress))
    });
    app.manage(units);
    app.manage(Arc::new(executor));
}

/// What `syncExecute` answers for a pass that ran or was skipped.
fn answer(result: &SyncExecuteResult) -> SyncOperationResult {
    match result {
        SyncExecuteResult::Completed => SyncOperationResult::SUCCESS.with_status("completed", None),
        SyncExecuteResult::Skipped(reason) => {
            SyncOperationResult::SUCCESS.with_status("skipped", Some(reason.as_str()))
        }
        // `success` is true: the call did not fail, the units did.
        SyncExecuteResult::Partial(units) => SyncOperationResult::SUCCESS
            .with_status("partial", None)
            .with_error(format!("{} sync unit(s) failed", units.len())),
    }
}

/// Runs a sync pass of `direction` (`'download'`, anything else uploads)
/// over `scope` (`'all'` when absent). A scope the renderer may not ask for
/// is refused before anything runs.
#[tauri::command]
pub async fn sync_execute(
    executor: State<'_, Arc<SyncExecutor>>,
    direction: String,
    scope: Option<Value>,
) -> Result<SyncOperationResult, CommandError> {
    let scope = match scope.filter(|scope| !scope.is_null()) {
        None => SyncScope::All,
        Some(raw) => match SyncScope::from_json(&raw) {
            Some(scope) => scope,
            None => return Ok(SyncOperationResult::failure("Invalid sync scope".to_owned(), None)),
        },
    };
    let direction = if direction == "download" { SyncDirection::Download } else { SyncDirection::Upload };
    Ok(match executor.execute_sync(direction, &scope).await {
        Ok(result) => {
            if direction == SyncDirection::Download {
                executor.hooks().start_polling_if_auto_sync();
            }
            answer(&result)
        }
        Err(err @ PreflightError::Credential(reason)) => {
            SyncOperationResult::from(Err(err)).with_status("skipped", Some(reason.as_str()))
        }
        Err(err) => SyncOperationResult::failure(err.to_string(), None),
    })
}

#[cfg(test)]
mod tests {
    use pipette_sync::execute::SkipReason;
    use pipette_sync_runtime::SyncCredentialFailureReason;
    use serde_json::json;

    use super::*;

    #[test]
    fn answers_as_the_ipc_handler_does() {
        let json = |result: SyncExecuteResult| serde_json::to_value(answer(&result)).unwrap();
        assert_eq!(json(SyncExecuteResult::Completed), json!({ "success": true, "status": "completed" }));
        assert_eq!(
            json(SyncExecuteResult::Skipped(SkipReason::Busy)),
            json!({ "success": true, "status": "skipped", "skipReason": "busy" })
        );
        assert_eq!(
            json(SyncExecuteResult::Partial(vec!["a".into(), "b".into()])),
            json!({ "success": true, "status": "partial", "error": "2 sync unit(s) failed" })
        );
    }

    #[test]
    fn sends_progress_in_the_shape_of_sync_progress() {
        let progress = SyncProgress {
            message: Some("sync.readiness.decryptFailed".into()),
            reason: Some(SyncCredentialFailureReason::DecryptFailed),
            ..SyncProgress::new(SyncDirection::Download, SyncStatus::Error)
        };
        assert_eq!(
            serde_json::to_value(ProgressPayload::from(&progress)).unwrap(),
            json!({ "direction": "download", "status": "error", "message": "sync.readiness.decryptFailed", "reason": "decryptFailed" })
        );
        let unit = SyncProgress {
            sync_unit: Some("favorites/macro".into()),
            current: Some(1),
            total: Some(3),
            failed_units: Some(vec!["x".into()]),
            ..SyncProgress::new(SyncDirection::Upload, SyncStatus::Partial)
        };
        assert_eq!(
            serde_json::to_value(ProgressPayload::from(&unit)).unwrap(),
            json!({ "direction": "upload", "status": "partial", "syncUnit": "favorites/macro", "current": 1, "total": 3, "failedUnits": ["x"] })
        );
    }
}
