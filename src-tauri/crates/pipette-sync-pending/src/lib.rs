// SPDX-License-Identifier: GPL-2.0-or-later
//! The pending sync units kept on disk (`local/sync-pending.json` in the
//! userData directory), so changes not yet uploaded when the app exits,
//! crashes or is killed are sent after the next launch. The same state and
//! file as the Electron build's src/main/sync/sync-pending-store.ts and the
//! pending part of src/main/sync/sync-runtime-state.ts: the active units
//! with the account they were changed under, and the units held for other
//! accounts.
//!
//! Every change to the set goes through [`PendingStore::notify_change`],
//! which gives the unit a new generation and writes the whole state
//! [`PENDING_WRITE_DELAY`] after the first change of a burst. Each write
//! replaces the file through a temp file and a rename, and writes never
//! interleave: they take one lock in turn, and each writes the state as it
//! is when it starts.

mod file;

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use indexmap::IndexMap;
use pipette_js_json::JsString;

use crate::file::PendingFile;

/// How long a change waits before the pending state is written. Changes in
/// that window share one write. `PENDING_WRITE_DELAY_MS` of
/// src/main/sync/sync-pending-store.ts.
pub const PENDING_WRITE_DELAY: Duration = Duration::from_millis(100);

/// Where the file is, under the userData directory.
pub const PENDING_FILE: [&str; 2] = ["local", "sync-pending.json"];

/// Runs the delayed writes.
pub trait Scheduler: Send + Sync {
    /// Runs `task` once, after `delay`, on a thread where it may block on
    /// file I/O. Never runs it before returning.
    fn schedule(&self, delay: Duration, task: Box<dyn FnOnce() + Send>);
}

/// Told whether anything is pending after each change, under the store's
/// lock so the values arrive in the order of the changes. It must not call
/// back into the store.
pub type StatusListener = Box<dyn Fn(bool) + Send + Sync>;

/// The pending state of this process and the file that keeps it. Cheap to
/// clone; the clones share the state.
#[derive(Clone)]
pub struct PendingStore {
    shared: Arc<Shared>,
}

struct Shared {
    path: PathBuf,
    /// False when the file existed at startup but could not be read: it is
    /// left as it is, and the state is kept in memory only.
    persist: bool,
    scheduler: Arc<dyn Scheduler>,
    listener: StatusListener,
    state: Mutex<State>,
    /// Taken for each write, before `state`. Holds whether this process has
    /// created the file's directory.
    write: Mutex<bool>,
}

#[derive(Default)]
struct State {
    /// The active units in the order they were first marked, each with its
    /// generation.
    units: IndexMap<JsString, u64>,
    /// Source of the generations. Never reset: values stay unique, so a
    /// unit removed and changed again never matches an older generation.
    last_generation: u64,
    owner: Option<JsString>,
    held: Vec<(JsString, Vec<JsString>)>,
    /// The ticket of the write that is due, if one is.
    due_write: Option<u64>,
    last_ticket: u64,
    /// True while the last write failed; the next change writes again.
    dirty: bool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl PendingStore {
    /// Loads the pending state an earlier run left in `user_data` and starts
    /// keeping it on disk; `restorePendingFromDisk` of
    /// src/main/sync/sync-pending-store.ts. The restored units get new
    /// generations in file order. Units that are not safe paths, and units of
    /// a keyboard whose directory is gone, are dropped, and a write is
    /// scheduled so they leave the file too. A file that exists but cannot be
    /// read is left as it is, and nothing is ever written.
    pub fn restore(user_data: &Path, scheduler: Arc<dyn Scheduler>, listener: StatusListener) -> Self {
        let path = PENDING_FILE.iter().fold(user_data.to_path_buf(), |path, part| path.join(part));
        let restored = file::read(&path, &user_data.join("sync").join("keyboards"));
        let persist = restored.is_some();
        let PendingFile { owner, units, held } = restored.unwrap_or_default();
        let mut state = State { owner, held, ..State::default() };
        for unit in units {
            state.mark(unit);
        }
        let store = Self {
            shared: Arc::new(Shared {
                path,
                persist,
                scheduler,
                listener,
                state: Mutex::new(state),
                write: Mutex::new(false),
            }),
        };
        if persist {
            let ticket = lock(&store.shared.state).reserve_write();
            store.schedule_write(ticket);
        }
        store
    }

    /// Records a change to `unit`: a new generation, a write unless one is
    /// due or the unit is already on disk, and the status to the listener;
    /// what `notifyChange` of src/main/sync/sync-flush.ts does before it arms
    /// the upload.
    pub fn notify_change(&self, unit: &str) {
        let ticket = {
            let mut state = lock(&self.shared.state);
            let added = state.mark(JsString::from(unit));
            // A unit already pending is on disk unless the last write failed.
            let ticket =
                if self.shared.persist && (added || state.dirty) { state.reserve_write() } else { None };
            (self.shared.listener)(!state.units.is_empty());
            ticket
        };
        self.schedule_write(ticket);
    }

    pub fn has_pending_changes(&self) -> bool {
        !lock(&self.shared.state).units.is_empty()
    }

    /// `unit`'s current generation; 0 when it is not pending. Generations
    /// start at 1.
    pub fn pending_generation_of(&self, unit: &str) -> u64 {
        lock(&self.shared.state).units.get(unit).copied().unwrap_or(0)
    }

    /// Writes the pending state now, in place of any write that is due; a
    /// failure is logged and left to the next write. `persistPendingNow` of
    /// src/main/sync/sync-runtime-state.ts, for the quit sequence.
    pub fn persist_now(&self) {
        if let Some(Err(err)) = self.write(None) {
            log::warn!("[sync-pending] failed to write the pending changes: {err}");
        }
    }

    fn schedule_write(&self, ticket: Option<u64>) {
        let Some(ticket) = ticket else { return };
        let store = self.clone();
        self.shared.scheduler.schedule(
            PENDING_WRITE_DELAY,
            Box::new(move || {
                if let Some(Err(err)) = store.write(Some(ticket)) {
                    log::warn!("[sync-pending] failed to write the pending changes: {err}");
                }
            }),
        );
    }

    /// Writes the state as it is now. With a `ticket`, only while that write
    /// is still the one due (`None` returned otherwise); without one, in
    /// place of whatever write is due. Nothing is written when the file
    /// could not be read at startup.
    fn write(&self, ticket: Option<u64>) -> Option<std::io::Result<()>> {
        if !self.shared.persist {
            return None;
        }
        let mut dir_ready = lock(&self.shared.write);
        let content = {
            let mut state = lock(&self.shared.state);
            if ticket.is_some() && state.due_write != ticket {
                return None;
            }
            state.due_write = None;
            file::content(state.owner.as_ref(), state.units.keys(), &state.held)
        };
        let result = write_file(&self.shared.path, content.as_bytes(), &mut dir_ready);
        lock(&self.shared.state).dirty = result.is_err();
        Some(result)
    }
}

impl State {
    /// Adds `unit` with a new generation; whether it was not pending.
    fn mark(&mut self, unit: JsString) -> bool {
        self.last_generation += 1;
        self.units.insert(unit, self.last_generation).is_none()
    }

    /// A ticket for a new write, or `None` when one is already due: a burst
    /// of changes shares the write the first one scheduled.
    fn reserve_write(&mut self) -> Option<u64> {
        if self.due_write.is_some() {
            return None;
        }
        self.last_ticket += 1;
        self.due_write = Some(self.last_ticket);
        self.due_write
    }
}

/// Writes `content` to `path` atomically, creating the directory the first
/// time and again when it has been removed since (e.g. by a reset of local
/// data).
fn write_file(path: &Path, content: &[u8], dir_ready: &mut bool) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    if !*dir_ready {
        std::fs::create_dir_all(dir)?;
        *dir_ready = true;
    }
    match pipette_fs::write_file_atomic(path, content) {
        Err(err) if err.kind() == ErrorKind::NotFound => {
            std::fs::create_dir_all(dir)?;
            pipette_fs::write_file_atomic(path, content)
        }
        result => result,
    }
}
