// SPDX-License-Identifier: GPL-2.0-or-later
//! The pending sync units (crates/pipette-sync-pending) in the app: restored
//! at startup, the `syncHasPendingChanges` command and the
//! `sync:pending-status` event of the shim (src/tauri-shim/api/sync-pending.ts),
//! and the write of the quit sequence's flushPending phase.
//!
//! The pending units are only recorded here; uploading them is the sync
//! service's job.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use pipette_sync_pending::{PendingStore, Scheduler};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::events::{SYNC_PENDING_STATUS, emit_all};
use crate::shutdown::QuitPhase;

/// Runs the delayed writes on the async runtime, the write itself on a
/// blocking-task thread (it syncs the file to disk).
struct RuntimeScheduler;

impl Scheduler for RuntimeScheduler {
    fn schedule(&self, delay: Duration, task: Box<dyn FnOnce() + Send>) {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            if let Err(err) = tauri::async_runtime::spawn_blocking(task).await {
                log::error!("[sync-pending] the pending write did not finish: {err}");
            }
        });
    }
}

/// Restores the pending state of `user_data` and manages it for the
/// commands, before anything can change it. Each change tells every page
/// whether anything is pending.
pub fn manage<R: Runtime>(app: &AppHandle<R>, user_data: &Path) {
    app.manage(restore(app, user_data, Arc::new(RuntimeScheduler)));
}

fn restore<R: Runtime>(app: &AppHandle<R>, user_data: &Path, scheduler: Arc<dyn Scheduler>) -> PendingStore {
    let handle = app.clone();
    PendingStore::restore(
        user_data,
        scheduler,
        Box::new(move |pending| emit_all(&handle, SYNC_PENDING_STATUS, pending)),
    )
}

#[tauri::command]
pub fn sync_has_pending_changes(store: State<'_, PendingStore>) -> bool {
    store.has_pending_changes()
}

/// The quit sequence's flushPending phase: writes the pending state at once,
/// in place of a write that is due, so a change made just before the quit
/// is on disk for the next launch. `then` is how long the phase waits
/// afterwards.
pub fn flush_phase(store: PendingStore, name: &'static str, then: Duration) -> QuitPhase {
    QuitPhase::new(name, async move {
        if let Err(err) = tokio::task::spawn_blocking(move || store.persist_now()).await {
            log::error!("[sync-pending] the pending write did not finish: {err}");
        }
        tokio::time::sleep(then).await;
    })
}

/// Writes the pending state once the quit sequence has ended, however it
/// ended, as the before-quit handler of src/main/sync/sync-flush.ts does
/// after its phases and after its deadline alike: a deadline that cut the
/// sequence short skips the flushPending phase, and the units the phases
/// before it recorded would otherwise wait for a delayed write the exit
/// never runs. A file system that stalls the write is given up on after
/// `timeout`, so the exit is held up by at most that.
pub async fn persist_after_quit(store: PendingStore, timeout: Duration) {
    let write = tokio::task::spawn_blocking(move || store.persist_now());
    match tokio::time::timeout(timeout, write).await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => log::error!("[sync-pending] the pending write did not finish: {err}"),
        Err(_) => log::error!("[sync-pending] gave up on the pending write after {}ms", timeout.as_millis()),
    }
}

/// Drops every task: the delayed writes never run, so nothing is written
/// after a test's userData directory is gone.
#[cfg(test)]
struct NoWrites;

#[cfg(test)]
impl Scheduler for NoWrites {
    fn schedule(&self, _: Duration, _: Box<dyn FnOnce() + Send>) {}
}

/// A store of `user_data` whose delayed writes never run, for the tests.
#[cfg(test)]
pub(crate) fn store_without_delayed_writes(user_data: &Path) -> PendingStore {
    PendingStore::restore(user_data, Arc::new(NoWrites), Box::new(|_| {}))
}

/// [`manage`] for the tests: the delayed writes never run.
#[cfg(test)]
pub(crate) fn manage_without_delayed_writes<R: Runtime>(app: &AppHandle<R>, user_data: &Path) {
    app.manage(restore(app, user_data, Arc::new(NoWrites)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tauri::Listener;
    use tempfile::TempDir;

    #[test]
    fn a_change_tells_every_page_that_something_is_pending() {
        let user_data = TempDir::new().unwrap();
        let app = tauri::test::mock_app();
        let store = restore(app.handle(), user_data.path(), Arc::new(NoWrites));
        let received = Arc::new(Mutex::new(Vec::<String>::new()));
        let record = Arc::clone(&received);
        app.handle().listen_any(SYNC_PENDING_STATUS, move |event| {
            record.lock().unwrap().push(event.payload().to_owned());
        });

        store.notify_change("favorites/macro");

        assert_eq!(*received.lock().unwrap(), ["true"]);
    }

    #[test]
    fn the_flush_phase_writes_at_once() {
        let user_data = TempDir::new().unwrap();
        let app = tauri::test::mock_app();
        let store = restore(app.handle(), user_data.path(), Arc::new(NoWrites));
        store.notify_change("favorites/macro");
        let file = user_data.path().join("local").join("sync-pending.json");
        assert!(!file.exists());

        let phase = flush_phase(store, "flushPending", Duration::ZERO);
        tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(phase.run);

        assert_eq!(
            std::fs::read_to_string(file).unwrap(),
            r#"{"version":1,"owner":null,"units":["favorites/macro"],"held":{}}"#
        );
    }
}
