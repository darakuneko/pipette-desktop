// SPDX-License-Identifier: GPL-2.0-or-later
//! The recording: events go into the
//! [`MinuteBuffer`] and the [`SessionDetector`] in the order they arrive,
//! and a flush writes what is ready to this device's day files, then the
//! same rows to the cache, then `last_synced_at` to `sync_state.json`, and
//! tells the sync layer which day units changed.
//!
//! Flushes run one at a time on the flush chain, behind every task queued
//! before them, so the debounce, the renderer's explicit flush and the quit
//! never write at once. A task queued on the chain runs to its end even
//! when its caller stops waiting (the quit's deadline does not cut a flush
//! in half). An event schedules a flush [`FLUSH_DEBOUNCE`] later; a task
//! that leaves something unwritten schedules the next one.
//!
//! A flush that fails to write leaves nothing lost: every retained minute
//! is reopened, so the next flush sends it whole again; the sessions it
//! took go back to the queue; nothing is announced.
//!
//! Recording does not wait for the analytics' initialization: only a flush
//! does, before it drains anything, so an initialization that fails keeps
//! the events buffered and the next flush tries again.

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use indexmap::IndexMap;
use pipette_entry_store::IdGen;
use pipette_js_json::{JsString, Value};
use tokio::sync::{mpsc, oneshot};

use crate::Error;
use crate::event::TypingEvent;
use crate::fingerprint::{Fingerprint, KeyboardInfo, OsInfo};
use crate::jsonl::paths::device_day_jsonl_path;
use crate::jsonl::reader_writer::append_lines_to_file;
use crate::jsonl::row::serialize_row;
use crate::minute_buffer::{MinuteBuffer, PeekCounts};
use crate::rows::{ResolvedScope, RowsByUidDay, group_rows_by_uid_day};
use crate::service::{Ready, TypingAnalytics};
use crate::session_detector::{FinalizedSession, SessionDetector};
use crate::sync_state::save_sync_state;
use crate::sync_units::typing_analytics_device_day_sync_unit;

/// `FLUSH_DEBOUNCE_MS`: how long after an event the flush runs.
pub const FLUSH_DEBOUNCE: Duration = Duration::from_millis(1_000);

/// How long after a failed initialization a debounced flush waits before
/// it tries again.
const INIT_RETRY_INTERVAL_MS: f64 = 30_000.0;

/// Runs a task once, after a delay. Never runs it before returning.
pub trait FlushTimer: Send + Sync {
    fn schedule(&self, delay: Duration, task: Box<dyn FnOnce() + Send>);
}

/// What the recorder needs from the app.
pub struct RecorderDeps {
    /// The ids of new sessions (`randomUUID`).
    pub ids: Arc<dyn IdGen>,
    /// The OS of the fingerprints.
    pub os: OsInfo,
    pub timer: Arc<dyn FlushTimer>,
    /// Records a changed sync unit (`notifyChange`).
    pub notify: Arc<dyn Fn(&str) + Send + Sync>,
    /// The application in focus (`getCurrentAppName`), or `None` when
    /// Monitor App is off or nothing is found. May block; it runs on a
    /// blocking-task thread.
    pub app_name: Arc<dyn Fn() -> Option<JsString> + Send + Sync>,
}

type Task = Pin<Box<dyn Future<Output = ()> + Send>>;

struct Job {
    task: Task,
    done: oneshot::Sender<()>,
}

struct State {
    buffer: MinuteBuffer,
    sessions: SessionDetector,
    /// Each keyboard's scope, resolved from its first event.
    scope_cache: HashMap<String, ResolvedScope>,
    /// Closed sessions not written yet.
    pending_sessions: Vec<FinalizedSession>,
    dirty: bool,
    /// Tasks queued on the flush chain and not finished.
    in_flight: usize,
    /// The armed debounce timer, by its generation.
    timer: Option<u64>,
    timer_generation: u64,
    /// The `updated_at` of the last rows this device wrote.
    last_flush_updated_at: f64,
    /// When the last initialization a flush waited for failed, while no
    /// later one has succeeded.
    init_failed_at: Option<f64>,
}

/// What one flush drained.
struct Batch {
    rows: RowsByUidDay,
    /// Every session the flush took, those dropped for a missing scope too.
    sessions: Vec<FinalizedSession>,
    updated_at: f64,
}

pub struct Recorder {
    analytics: Arc<TypingAnalytics>,
    deps: RecorderDeps,
    state: Mutex<State>,
    chain: mpsc::UnboundedSender<Job>,
    this: Weak<Recorder>,
}

impl Recorder {
    /// The recorder of `analytics`, its flush chain running on `runtime`.
    pub fn new(
        analytics: Arc<TypingAnalytics>,
        deps: RecorderDeps,
        runtime: &tokio::runtime::Handle,
    ) -> Arc<Self> {
        let (chain, jobs) = mpsc::unbounded_channel();
        let state = State {
            buffer: MinuteBuffer::new(),
            sessions: SessionDetector::new(deps.ids.clone()),
            scope_cache: HashMap::new(),
            pending_sessions: Vec::new(),
            dirty: false,
            in_flight: 0,
            timer: None,
            timer_generation: 0,
            last_flush_updated_at: 0.0,
            init_failed_at: None,
        };
        let recorder = Arc::new_cyclic(|this| Self {
            analytics,
            deps,
            state: Mutex::new(state),
            chain,
            this: this.clone(),
        });
        runtime.spawn(run_chain(jobs, Arc::downgrade(&recorder)));
        recorder
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn now(&self) -> f64 {
        self.analytics.now_ms() as f64
    }

    /// The analytics the recorder writes to.
    pub fn analytics(&self) -> &Arc<TypingAnalytics> {
        &self.analytics
    }

    /// Records a changed sync unit (`notifySyncUnits`).
    pub fn notify(&self, unit: &str) {
        (self.deps.notify)(unit);
    }

    /// The `typingAnalyticsEvent` handler: takes `payload` if it is a valid
    /// event (anything else is ignored) and schedules a flush. Fails only
    /// when the machine hash of a keyboard's first event cannot be read.
    pub async fn ingest(&self, payload: &Value) -> Result<(), Error> {
        let Some(event) = TypingEvent::parse(payload) else { return Ok(()) };
        let resolved = self.resolve_scope(&event.keyboard).await?;
        let now = self.now();
        let mut state = self.state();
        state.buffer.add_event(&event, &resolved.fingerprint, now);
        // A release carries only a duration, possibly minutes after its
        // press; counting it would stretch or reopen an idle session.
        if event.is_keystroke()
            && let Some(closed) =
                state.sessions.record_event(&event.keyboard.uid, &resolved.scope_key, event.ts)
        {
            state.pending_sessions.push(closed);
        }
        state.dirty = true;
        self.schedule_flush(&mut state);
        Ok(())
    }

    /// `resolveScope`: the scope of the keyboard's first event, kept for
    /// its later events.
    async fn resolve_scope(&self, keyboard: &KeyboardInfo) -> Result<ResolvedScope, Error> {
        if let Some(resolved) = self.state().scope_cache.get(&keyboard.uid) {
            return Ok(resolved.clone());
        }
        let analytics = self.analytics.clone();
        let machine_hash = tokio::task::spawn_blocking(move || analytics.machine_hash())
            .await
            .map_err(|err| Error::Blocking(err.to_string()))??;
        let resolved = ResolvedScope::new(Fingerprint {
            machine_hash,
            os: self.deps.os.clone(),
            keyboard: keyboard.clone(),
        });
        self.state().scope_cache.insert(keyboard.uid.clone(), resolved.clone());
        Ok(resolved)
    }

    /// `closeSessionsForUid`: queues the open sessions of `uid` whose start
    /// `closes` accepts for the next flush.
    pub fn close_sessions_for_uid(&self, uid: &str, closes: impl Fn(f64) -> bool) {
        let mut state = self.state();
        let closed = state.sessions.close_for_uid(uid, closes);
        if !closed.is_empty() {
            state.pending_sessions.extend(closed);
            state.dirty = true;
        }
    }

    /// The `typingAnalyticsFlush` handler: closes the sessions of `uid` and
    /// writes everything buffered.
    pub fn flush_for_uid(&self, uid: &str) -> impl Future<Output = ()> + Send + 'static {
        self.close_sessions_for_uid(uid, |_| true);
        self.flush_now(true)
    }

    /// `hasTypingAnalyticsPendingWork`: anything buffered, queued or being
    /// written, so the quit waits even after a flush has drained the
    /// buffer.
    pub fn has_pending_work(&self) -> bool {
        let state = self.state();
        state.dirty
            || !state.pending_sessions.is_empty()
            || !state.buffer.is_empty()
            || state.sessions.has_any_active_session()
            || state.in_flight > 0
    }

    /// `flushTypingAnalyticsBeforeQuit`: closes every session and writes
    /// everything buffered, the minute being typed included.
    pub fn flush_before_quit(&self) -> impl Future<Output = ()> + Send + 'static {
        {
            let mut state = self.state();
            let closed = state.sessions.close_all();
            state.pending_sessions.extend(closed);
            if !state.pending_sessions.is_empty() {
                state.dirty = true;
            }
        }
        self.flush_now(true)
    }

    /// `flushNow`: a flush behind everything on the chain; `all` drains
    /// every minute, otherwise only the minutes past their grace.
    pub fn flush_now(&self, all: bool) -> impl Future<Output = ()> + Send + 'static {
        let this = self.this.clone();
        self.run_on_flush_chain(async move {
            if let Some(recorder) = this.upgrade() {
                recorder.flush_pass(all).await;
            }
        })
    }

    /// `runOnFlushChain`: queues `task` behind everything already on the
    /// chain. It runs whether or not the returned future is awaited; the
    /// future ends when the task has.
    pub fn run_on_flush_chain(
        &self,
        task: impl Future<Output = ()> + Send + 'static,
    ) -> impl Future<Output = ()> + Send + 'static {
        let (done, finished) = oneshot::channel();
        self.state().in_flight += 1;
        if self.chain.send(Job { task: Box::pin(task), done }).is_err() {
            self.state().in_flight -= 1;
        }
        async move {
            let _ = finished.await;
        }
    }

    /// `claimOwnRowUpdatedAt`: the `updated_at` of the next rows this
    /// device writes to its own day files, above every earlier one (the
    /// cache keeps a row only over an older one, so two flushes in one
    /// millisecond would lose the second) and above `above_ms`. A clock set
    /// back does not take it back: rows of one device compete only with
    /// that device's own.
    pub fn claim_own_row_updated_at(&self, above_ms: f64) -> f64 {
        let now = self.now();
        claim_updated_at(&mut self.state(), now, above_ms)
    }

    /// `dropBufferedTyping`: drops what `uid` has buffered whose time
    /// `drops` accepts, minutes by their start and unwritten sessions by
    /// theirs. For tasks on the flush chain.
    pub fn drop_buffered_typing(&self, uid: &str, drops: impl Fn(f64) -> bool) {
        let mut state = self.state();
        state.buffer.discard_for_uid(uid, &drops);
        state.pending_sessions.retain(|session| session.uid != uid || !drops(session.start_ms));
    }

    /// `peekMatrixCountsForUid` of the buffer.
    pub fn peek_matrix_counts_for_uid(
        &self,
        uid: &str,
        machine_hash: &str,
        layer: f64,
    ) -> IndexMap<String, PeekCounts> {
        self.state().buffer.peek_matrix_counts_for_uid(uid, machine_hash, layer)
    }

    /// `scheduleFlush`: arms the debounce timer unless it is armed.
    fn schedule_flush(&self, state: &mut State) {
        if state.timer.is_some() {
            return;
        }
        state.timer_generation += 1;
        let generation = state.timer_generation;
        state.timer = Some(generation);
        let this = self.this.clone();
        self.deps.timer.schedule(
            FLUSH_DEBOUNCE,
            Box::new(move || {
                let Some(recorder) = this.upgrade() else { return };
                {
                    let mut state = recorder.state();
                    // A flush that ran since disarmed this timer.
                    if state.timer != Some(generation) {
                        return;
                    }
                    state.timer = None;
                }
                drop(recorder.flush_now(false));
            }),
        );
    }

    /// What the chain does after each task, before its caller resumes.
    fn after_task(&self) {
        let mut state = self.state();
        state.in_flight -= 1;
        if state.dirty || !state.pending_sessions.is_empty() {
            self.schedule_flush(&mut state);
        }
    }

    /// `doFlushPass`.
    async fn flush_pass(self: Arc<Self>, all: bool) {
        {
            let mut state = self.state();
            if !state.dirty && state.pending_sessions.is_empty() {
                return;
            }
            state.timer = None;
        }
        // A debounced flush right after a failed initialization keeps the
        // events buffered without trying again, so a lasting failure is not
        // retried (the database opened, the rebuild run) every second. A
        // final flush always tries.
        let failed_at = self.state().init_failed_at;
        if !all && failed_at.is_some_and(|at| self.now() - at < INIT_RETRY_INTERVAL_MS) {
            return;
        }
        // The cache must be usable before anything is drained, or a failure
        // would throw the drained counts away.
        let ready = match self.analytics.ready().await {
            Ok(ready) => {
                self.state().init_failed_at = None;
                ready
            }
            Err(err) => {
                let now = self.now();
                if self.state().init_failed_at.replace(now).is_none() {
                    log::error!("typing-analytics DB open failed: {err}");
                }
                return;
            }
        };
        // Once per flush, before the drain, so the drained minutes carry it.
        if let Some(app_name) = self.app_name().await {
            self.state().buffer.mark_app_name(&app_name);
        }
        let Some(batch) = self.take_batch(all) else { return };
        let (rows, updated_at) = (batch.rows, batch.updated_at);
        let user_data = self.analytics.user_data().to_path_buf();
        let hash = ready.machine_hash.clone();
        let written = tokio::task::spawn_blocking(move || persist(&user_data, &ready, rows, updated_at))
            .await
            .map_err(|err| Error::Blocking(err.to_string()))
            .and_then(|written| written);
        let written = match written {
            Ok(written) => written,
            Err(err) => {
                log::error!("typing-analytics flush failed: {err}");
                let mut state = self.state();
                state.buffer.reopen_all();
                state.pending_sessions.extend(batch.sessions);
                state.dirty = true;
                return;
            }
        };
        for (uid, days) in written {
            for day in days {
                (self.deps.notify)(&typing_analytics_device_day_sync_unit(&uid, &hash, &day));
            }
        }
        let mut state = self.state();
        state.dirty = !state.buffer.is_empty();
    }

    async fn app_name(&self) -> Option<JsString> {
        let source = self.deps.app_name.clone();
        tokio::task::spawn_blocking(move || source()).await.unwrap_or_else(|err| {
            log::warn!("typing-analytics app-name tag failed: {err}");
            None
        })
    }

    /// Drains what this flush writes and builds its rows, in one hold of
    /// the state: an event arriving meanwhile may reopen a drained entry,
    /// so the rows are built before anything else can touch it. `None` when
    /// there is nothing to write.
    fn take_batch(&self, all: bool) -> Option<Batch> {
        let now = self.now();
        let mut state = self.state();
        let snapshots = if all { state.buffer.drain_all() } else { state.buffer.drain_closed(now) };
        let sessions = std::mem::take(&mut state.pending_sessions);
        if snapshots.is_empty() && sessions.is_empty() {
            state.dirty = !state.buffer.is_empty();
            return None;
        }
        // A session without a scope (its keyboard never sent an event) is
        // dropped rather than queued again, which would repeat forever.
        let mut valid = Vec::new();
        for session in &sessions {
            match state.scope_cache.get(&session.uid) {
                Some(resolved) => valid.push((session.clone(), resolved.clone())),
                None => log::warn!(
                    "typing-analytics session dropped — scope missing for {} ({} keystrokes)",
                    session.uid,
                    session.keystroke_count
                ),
            }
        }
        let mut scopes = IndexMap::new();
        for snapshot in &snapshots {
            scopes.insert(snapshot.scope_id.clone(), snapshot.fingerprint.clone());
        }
        for (_, resolved) in &valid {
            scopes.insert(resolved.scope_key.clone(), resolved.fingerprint.clone());
        }
        let updated_at = claim_updated_at(&mut state, self.now(), 0.0);
        let rows = group_rows_by_uid_day(&scopes, &snapshots, &valid, updated_at);
        if rows.is_empty() {
            state.dirty = !state.buffer.is_empty();
            return None;
        }
        Some(Batch { rows, sessions, updated_at })
    }
}

fn claim_updated_at(state: &mut State, now: f64, above_ms: f64) -> f64 {
    let updated_at = now.max(state.last_flush_updated_at + 1.0).max(above_ms + 1.0);
    state.last_flush_updated_at = updated_at;
    updated_at
}

/// Writes a flush's rows: each keyboard's days in ascending order, each day
/// appended to this device's day file (the file is the master: a cache
/// that fails to apply is rebuilt from it) and then applied to the cache;
/// then `last_synced_at`. `uploaded` is the sync layer's: it records what
/// the cloud has confirmed. Returns the days written per keyboard.
fn persist(
    user_data: &Path,
    ready: &Ready,
    rows: RowsByUidDay,
    updated_at: f64,
) -> Result<Vec<(String, Vec<String>)>, Error> {
    let mut written = Vec::new();
    for (uid, by_day) in rows {
        let mut days: Vec<_> = by_day.into_iter().filter(|(_, rows)| !rows.is_empty()).collect();
        days.sort_by(|a, b| a.0.cmp(&b.0));
        let mut written_days = Vec::new();
        for (day, rows) in days {
            let lines: String = rows.iter().map(serialize_row).collect();
            append_lines_to_file(
                &device_day_jsonl_path(user_data, &uid, &ready.machine_hash, &day),
                lines.clone(),
            )?;
            ready.db.call_blocking(move |db| db.apply_day_jsonl(&lines))??;
            written_days.push(day);
        }
        if !written_days.is_empty() {
            written.push((uid, written_days));
        }
    }
    let mut state = ready.sync_state.lock().unwrap_or_else(PoisonError::into_inner);
    state.last_synced_at = updated_at;
    save_sync_state(user_data, &state)?;
    Ok(written)
}

/// The flush chain: runs the jobs one at a time, in the order queued. Each
/// runs as a task of its own, so a panic loses only that job.
async fn run_chain(mut jobs: mpsc::UnboundedReceiver<Job>, recorder: Weak<Recorder>) {
    while let Some(job) = jobs.recv().await {
        if let Err(err) = tokio::spawn(job.task).await {
            log::error!("typing-analytics flush chain task failed: {err}");
        }
        if let Some(recorder) = recorder.upgrade() {
            recorder.after_task();
        }
        let _ = job.done.send(());
    }
}

#[cfg(test)]
mod tests;
