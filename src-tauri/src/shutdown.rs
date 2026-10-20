// SPDX-License-Identifier: GPL-2.0-or-later
//! The quit sequence: ordered asynchronous phases that run before the app
//! exits, bounded by one overall deadline (password change → pre-sync
//! finalizers → the running sync pass → the pending flush → the remaining
//! finalizers, 30 s in all).
//!
//! The coordinator knows nothing of Tauri: src/lifecycle.rs turns each exit
//! request into a [`QuitGuard`] decision, runs [`run_quit_sequence`] when
//! the guard says to start, and calls [`record_interruption`] before a
//! second request ends the app while the sequence runs.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use pipette_fs::write_file_atomic;
use serde::Serialize;
use tokio::time::Instant;

/// How long the quit sequence may run before the app exits anyway: a
/// stalled request has no timeout of its own and must not keep the app
/// from exiting.
pub const QUIT_DEADLINE: Duration = Duration::from_secs(30);

/// File name of the marker written when the sequence does not finish (the
/// deadline cuts it short, or a second exit request ends the app while it
/// runs), in the userData directory.
pub const PENDING_MARKER_FILE: &str = "quit-pending.json";

/// One step of the quit sequence. The future must not start its work
/// before it is first polled (`tokio::time::sleep` fixes its deadline when
/// created, so it goes inside an `async` block): every phase is built
/// before the first one runs.
pub struct QuitPhase {
    pub name: &'static str,
    pub run: Pin<Box<dyn Future<Output = ()> + Send>>,
}

impl QuitPhase {
    pub fn new(name: &'static str, run: impl Future<Output = ()> + Send + 'static) -> Self {
        Self { name, run: Box::pin(run) }
    }
}

/// How the quit sequence ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuitOutcome {
    Completed {
        elapsed: Duration,
    },
    /// The deadline passed while `unfinished` was running (`None` when it
    /// passed between phases). The phases after it never started.
    DeadlineReached {
        unfinished: Option<&'static str>,
    },
    /// A second exit request ended the app while `unfinished` was running
    /// (`None` when no phase was). The phases after it never start.
    Interrupted {
        unfinished: Option<&'static str>,
    },
}

/// What to do with an exit request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitDecision {
    /// The first request: stop the exit and start the quit sequence.
    StartSequence,
    /// The sequence is running and has not claimed the marker: this request
    /// owns the marker from now on. Record the interruption and let the exit
    /// through without waiting for the sequence.
    ExitNow,
    /// The sequence has claimed the marker, or an earlier request already
    /// owns it: wait for the sequence with [`QuitGuard::wait_until_finished`]
    /// and let the exit through, writing nothing.
    Exit,
}

/// Where the quit sequence is. The marker has exactly one writer per quit:
/// the sequence, once it moves `Running` to `Finalizing`, or the exit
/// request that moves `Running` to `Interrupted`. The two moves start from
/// the same state, so only the first of them happens.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum State {
    #[default]
    Idle,
    /// The phases are running and nobody has claimed the marker.
    Running,
    /// A second exit request owns the marker; the sequence leaves it alone.
    Interrupted,
    /// The sequence owns the marker and is updating it.
    Finalizing,
    /// The sequence has ended.
    Done,
}

#[derive(Debug, Default)]
struct GuardState {
    state: State,
    phase: Option<&'static str>,
}

/// The re-entry guard of the quit sequence. Every exit path (the tray, the last
/// window closing, a signal, the exit the sequence itself requests) asks it
/// what to do: the first request starts the sequence, a request while it runs
/// ends the app at once, and the exit the sequence requests when it ends goes
/// through.
///
/// It also decides who writes the pending marker (see [`State`]) and tracks
/// the phase [`run_quit_sequence`] is running, for the marker an early exit
/// writes.
#[derive(Debug, Default)]
pub struct QuitGuard {
    inner: Mutex<GuardState>,
    finished: Condvar,
}

impl QuitGuard {
    fn lock(&self) -> MutexGuard<'_, GuardState> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn on_exit_requested(&self) -> ExitDecision {
        let mut inner = self.lock();
        match inner.state {
            State::Idle => {
                inner.state = State::Running;
                ExitDecision::StartSequence
            }
            State::Running => {
                inner.state = State::Interrupted;
                ExitDecision::ExitNow
            }
            State::Interrupted | State::Finalizing | State::Done => ExitDecision::Exit,
        }
    }

    /// The first request's [`ExitDecision::StartSequence`] for a caller that
    /// must never interrupt or follow a quit already under way (the update
    /// of src/updater.rs): `true` when the guard was idle and is now
    /// running the sequence, `false`, changing nothing, otherwise.
    pub fn start_if_idle(&self) -> bool {
        let mut inner = self.lock();
        if inner.state == State::Idle {
            inner.state = State::Running;
            true
        } else {
            false
        }
    }

    /// Claims the marker for the sequence's own update. `false` when a second
    /// exit request already owns it: the sequence then neither writes nor
    /// removes the marker.
    fn claim_marker(&self) -> bool {
        let mut inner = self.lock();
        if inner.state == State::Running {
            inner.state = State::Finalizing;
            true
        } else {
            false
        }
    }

    /// Marks the sequence as ended, so the next exit request goes through,
    /// and wakes the requests waiting in [`Self::wait_until_finished`].
    pub fn finish(&self) {
        self.lock().state = State::Done;
        self.finished.notify_all();
    }

    /// Waits until the sequence has ended or `timeout` has passed. An exit
    /// request that arrives while the sequence updates the marker waits here,
    /// so the exit does not cut that update short.
    pub fn wait_until_finished(&self, timeout: Duration) {
        let inner = self.lock();
        let _ = self
            .finished
            .wait_timeout_while(inner, timeout, |inner| inner.state == State::Finalizing)
            .unwrap_or_else(PoisonError::into_inner);
    }

    /// The phase running now. A phase the deadline cut off stays recorded.
    pub fn running_phase(&self) -> Option<&'static str> {
        self.lock().phase
    }

    fn set_running_phase(&self, phase: Option<&'static str>) {
        self.lock().phase = phase;
    }

    /// Whether an exit has been requested. A window closed while quitting
    /// closes instead of hiding in the tray.
    pub fn is_quitting(&self) -> bool {
        self.lock().state != State::Idle
    }
}

/// Runs the phases one after another until they all end or `deadline`
/// passes, logging each phase's start and duration and recording the running
/// one in `guard`. A phase cut off by the deadline is dropped mid-await, so a
/// phase must leave nothing half-written at an await point.
async fn run_phases(phases: Vec<QuitPhase>, deadline: Duration, guard: &QuitGuard) -> QuitOutcome {
    let started = Instant::now();
    let mut current: Option<&'static str> = None;
    let sequence = async {
        for phase in phases {
            current = Some(phase.name);
            guard.set_running_phase(current);
            let phase_started = Instant::now();
            log::info!("[quit] +{}ms phase {} started", started.elapsed().as_millis(), phase.name);
            phase.run.await;
            log::info!(
                "[quit] +{}ms phase {} finished in {}ms",
                started.elapsed().as_millis(),
                phase.name,
                phase_started.elapsed().as_millis()
            );
            current = None;
            guard.set_running_phase(None);
        }
    };
    let result = tokio::time::timeout(deadline, sequence).await;
    match result {
        Ok(()) => QuitOutcome::Completed { elapsed: started.elapsed() },
        Err(_) => {
            log::warn!(
                "[quit] +{}ms deadline of {}ms reached during {}",
                started.elapsed().as_millis(),
                deadline.as_millis(),
                current.unwrap_or("(between phases)")
            );
            QuitOutcome::DeadlineReached { unfinished: current }
        }
    }
}

/// How long a marker update may take. The update syncs a file to disk, which
/// a stalled file system can hold up forever, so it runs on a blocking thread
/// and the exit goes ahead when this passes. The whole sequence therefore
/// ends within the phase deadline plus this, and an exit that interrupts it
/// is held up by at most this.
pub const MARKER_TIMEOUT: Duration = Duration::from_secs(3);

/// Writes or removes the pending marker for an outcome: the file path, the
/// outcome and the phase deadline.
type MarkerUpdate = fn(&Path, &QuitOutcome, Duration) -> std::io::Result<()>;

/// Runs the phases, then records what is left for the next launch: the
/// marker in `data_dir` is written when the deadline cut the sequence short
/// and removed when every phase ended. When a second exit request has
/// claimed the marker in `guard` the sequence leaves it as that request
/// wrote it. The sequence's
/// outcome is returned whether the marker update succeeded, failed or ran
/// past [`MARKER_TIMEOUT`].
pub async fn run_quit_sequence(
    phases: Vec<QuitPhase>,
    deadline: Duration,
    data_dir: &Path,
    guard: &QuitGuard,
) -> QuitOutcome {
    run_quit_sequence_with(phases, deadline, data_dir, guard, update_marker, MARKER_TIMEOUT).await
}

async fn run_quit_sequence_with(
    phases: Vec<QuitPhase>,
    deadline: Duration,
    data_dir: &Path,
    guard: &QuitGuard,
    update: MarkerUpdate,
    marker_timeout: Duration,
) -> QuitOutcome {
    let outcome = run_phases(phases, deadline, guard).await;
    if !guard.claim_marker() {
        log::info!("[quit] the marker belongs to the exit request that interrupted the sequence");
        return outcome;
    }
    update_marker_bounded(data_dir, &outcome, deadline, update, marker_timeout).await;
    outcome
}

/// Writes the marker for a sequence that a second exit request ends while
/// `unfinished` runs, before the app exits. Only the request that got
/// [`ExitDecision::ExitNow`] calls this: that decision hands it the marker,
/// and the sequence no longer touches it. Returns within [`MARKER_TIMEOUT`]
/// whether the write succeeded, failed or stalled.
///
/// A request that lands after the last phase ended but before the sequence
/// claims the marker writes it too; it only makes the next launch look at
/// work that is already done.
pub async fn record_interruption(unfinished: Option<&'static str>, deadline: Duration, data_dir: &Path) {
    record_interruption_with(unfinished, deadline, data_dir, update_marker, MARKER_TIMEOUT).await;
}

async fn record_interruption_with(
    unfinished: Option<&'static str>,
    deadline: Duration,
    data_dir: &Path,
    update: MarkerUpdate,
    marker_timeout: Duration,
) {
    let outcome = QuitOutcome::Interrupted { unfinished };
    update_marker_bounded(data_dir, &outcome, deadline, update, marker_timeout).await;
}

/// Runs `update` for the marker in `data_dir` on a blocking thread, giving up
/// after `marker_timeout`; failures are logged.
async fn update_marker_bounded(
    data_dir: &Path,
    outcome: &QuitOutcome,
    deadline: Duration,
    update: MarkerUpdate,
    marker_timeout: Duration,
) {
    let marker = data_dir.join(PENDING_MARKER_FILE);
    let task = {
        let (marker, outcome) = (marker.clone(), outcome.clone());
        tokio::task::spawn_blocking(move || update(&marker, &outcome, deadline))
    };
    // On a timeout the blocking thread is left running; it cannot be
    // cancelled, and the process exit ends it.
    match tokio::time::timeout(marker_timeout, task).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(err))) => log::error!("[quit] failed to update {}: {err}", marker.display()),
        Ok(Err(err)) => log::error!("[quit] the update of {} did not finish: {err}", marker.display()),
        Err(_) => log::error!(
            "[quit] gave up on updating {} after {}ms",
            marker.display(),
            marker_timeout.as_millis()
        ),
    }
}

fn update_marker(marker: &Path, outcome: &QuitOutcome, deadline: Duration) -> std::io::Result<()> {
    match outcome {
        QuitOutcome::Completed { .. } => remove_marker(marker),
        QuitOutcome::DeadlineReached { unfinished } => write_marker(marker, *unfinished, deadline, false),
        QuitOutcome::Interrupted { unfinished } => write_marker(marker, *unfinished, deadline, true),
    }
}

/// The body of the pending marker:
/// - `unfinishedPhase`: the phase that was running, `null` when none was;
/// - `deadlineMs`: the phase deadline of the sequence;
/// - `interrupted`: present, and `true`, only when a second exit request
///   ended the app before the sequence ended. A marker without it was
///   written at the deadline.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingMarker {
    unfinished_phase: Option<&'static str>,
    deadline_ms: u128,
    #[serde(skip_serializing_if = "is_false")]
    interrupted: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

fn write_marker(
    marker: &Path,
    unfinished: Option<&'static str>,
    deadline: Duration,
    interrupted: bool,
) -> std::io::Result<()> {
    if let Some(dir) = marker.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_vec(&PendingMarker {
        unfinished_phase: unfinished,
        deadline_ms: deadline.as_millis(),
        interrupted,
    })
    .map_err(std::io::Error::other)?;
    write_file_atomic(marker, &body)
}

fn remove_marker(marker: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(marker) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    type Log = Arc<Mutex<Vec<String>>>;

    /// A phase that logs its start and end and sleeps `ms` in between.
    fn sleeping_phase(log: &Log, name: &'static str, ms: u64) -> QuitPhase {
        let log = Arc::clone(log);
        QuitPhase::new(name, async move {
            log.lock().unwrap().push(format!("start {name}"));
            tokio::time::sleep(Duration::from_millis(ms)).await;
            log.lock().unwrap().push(format!("end {name}"));
        })
    }

    /// Records its drop, to observe a phase future being cancelled.
    struct DropFlag(Arc<AtomicUsize>);
    impl Drop for DropFlag {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    /// Runs `test` on a current-thread runtime whose clock is paused, so the
    /// sleeps and the deadline advance without real waiting.
    fn paused(test: impl Future<Output = ()>) {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .start_paused(true)
            .build()
            .unwrap()
            .block_on(test);
    }

    /// A guard whose sequence has started, as the first exit request leaves it.
    fn running_guard() -> QuitGuard {
        let guard = QuitGuard::default();
        assert_eq!(guard.on_exit_requested(), ExitDecision::StartSequence);
        guard
    }

    #[test]
    fn runs_the_phases_in_order_one_after_another() {
        paused(async {
            let log: Log = Arc::default();
            let phases = vec![
                sleeping_phase(&log, "a", 300),
                sleeping_phase(&log, "b", 100),
                sleeping_phase(&log, "c", 200),
            ];
            let outcome = run_phases(phases, QUIT_DEADLINE, &QuitGuard::default()).await;
            assert_eq!(outcome, QuitOutcome::Completed { elapsed: Duration::from_millis(600) });
            assert_eq!(*log.lock().unwrap(), ["start a", "end a", "start b", "end b", "start c", "end c"]);
        });
    }

    #[test]
    fn stops_at_the_deadline_and_never_starts_the_later_phases() {
        paused(async {
            let log: Log = Arc::default();
            let phases = vec![
                sleeping_phase(&log, "a", 10_000),
                sleeping_phase(&log, "b", 25_000),
                sleeping_phase(&log, "c", 1),
            ];
            let started = Instant::now();
            let outcome = run_phases(phases, QUIT_DEADLINE, &QuitGuard::default()).await;
            assert_eq!(started.elapsed(), QUIT_DEADLINE);
            assert_eq!(outcome, QuitOutcome::DeadlineReached { unfinished: Some("b") });
            assert_eq!(*log.lock().unwrap(), ["start a", "end a", "start b"]);
        });
    }

    #[test]
    fn a_phase_that_never_ends_is_cut_at_the_deadline() {
        paused(async {
            let outcome = run_phases(
                vec![QuitPhase::new("stuck", std::future::pending())],
                Duration::from_secs(5),
                &QuitGuard::default(),
            )
            .await;
            assert_eq!(outcome, QuitOutcome::DeadlineReached { unfinished: Some("stuck") });
        });
    }

    #[test]
    fn the_deadline_drops_the_running_phase() {
        paused(async {
            let dropped = Arc::new(AtomicUsize::new(0));
            let flag = DropFlag(Arc::clone(&dropped));
            let phase = QuitPhase::new("slow", async move {
                let _flag = flag;
                tokio::time::sleep(Duration::from_secs(60)).await;
            });
            run_phases(vec![phase], QUIT_DEADLINE, &QuitGuard::default()).await;
            assert_eq!(dropped.load(Ordering::SeqCst), 1);
        });
    }

    #[test]
    fn dropping_the_sequence_cancels_the_running_phase_and_starts_no_other() {
        paused(async {
            let log: Log = Arc::default();
            let dropped = Arc::new(AtomicUsize::new(0));
            let flag = DropFlag(Arc::clone(&dropped));
            let first = QuitPhase::new("first", async move {
                let _flag = flag;
                tokio::time::sleep(Duration::from_secs(10)).await;
            });
            let guard = QuitGuard::default();
            let sequence = run_phases(vec![first, sleeping_phase(&log, "second", 1)], QUIT_DEADLINE, &guard);
            let cut = tokio::time::timeout(Duration::from_secs(1), sequence).await;
            assert!(cut.is_err());
            assert_eq!(dropped.load(Ordering::SeqCst), 1);
            assert!(log.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn an_empty_sequence_completes_at_once() {
        paused(async {
            let outcome = run_phases(Vec::new(), QUIT_DEADLINE, &QuitGuard::default()).await;
            assert_eq!(outcome, QuitOutcome::Completed { elapsed: Duration::ZERO });
        });
    }

    #[test]
    fn the_deadline_writes_the_pending_marker() {
        paused(async {
            let tmp = TempDir::new().unwrap();
            let dir = tmp.path().to_path_buf();
            let phases = vec![QuitPhase::new("flushPending", std::future::pending())];
            let outcome = run_quit_sequence(phases, QUIT_DEADLINE, &dir, &running_guard()).await;
            assert_eq!(outcome, QuitOutcome::DeadlineReached { unfinished: Some("flushPending") });
            let body = std::fs::read_to_string(dir.join(PENDING_MARKER_FILE)).unwrap();
            assert_eq!(body, r#"{"unfinishedPhase":"flushPending","deadlineMs":30000}"#);
        });
    }

    #[test]
    fn a_completed_sequence_removes_a_stale_marker() {
        paused(async {
            let tmp = TempDir::new().unwrap();
            let dir = tmp.path().to_path_buf();
            let marker = dir.join(PENDING_MARKER_FILE);
            std::fs::write(&marker, "{}").unwrap();
            let outcome = run_quit_sequence(Vec::new(), QUIT_DEADLINE, &dir, &running_guard()).await;
            assert!(matches!(outcome, QuitOutcome::Completed { .. }));
            assert!(!marker.exists());
        });
    }

    #[test]
    fn the_marker_directory_is_created_when_missing() {
        paused(async {
            let tmp = TempDir::new().unwrap();
            let dir = tmp.path().join("nested");
            run_quit_sequence(
                vec![QuitPhase::new("x", std::future::pending())],
                Duration::from_secs(1),
                &dir,
                &running_guard(),
            )
            .await;
            assert!(dir.join(PENDING_MARKER_FILE).exists());
        });
    }

    /// Runs `test` on a current-thread runtime with the real clock: a paused
    /// clock does not advance while a blocking task runs, so the marker
    /// timeout could never pass.
    fn real_time<T>(test: impl Future<Output = T>) -> T {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        let result = runtime.block_on(test);
        // Leaves a stalled writer thread behind instead of waiting for it.
        runtime.shutdown_background();
        result
    }

    fn stalled_writer(_: &Path, _: &QuitOutcome, _: Duration) -> std::io::Result<()> {
        std::thread::sleep(Duration::from_secs(10));
        Ok(())
    }

    fn failing_writer(_: &Path, _: &QuitOutcome, _: Duration) -> std::io::Result<()> {
        Err(std::io::Error::other("disk gone"))
    }

    #[test]
    fn a_stalled_marker_update_does_not_hold_up_the_end_of_the_sequence() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        let deadline = Duration::from_millis(100);
        let marker_timeout = Duration::from_millis(200);
        let started = std::time::Instant::now();
        let outcome = real_time(run_quit_sequence_with(
            vec![QuitPhase::new("flushPending", std::future::pending())],
            deadline,
            &dir,
            &running_guard(),
            stalled_writer,
            marker_timeout,
        ));
        let elapsed = started.elapsed();
        assert_eq!(outcome, QuitOutcome::DeadlineReached { unfinished: Some("flushPending") });
        assert!(elapsed >= deadline + marker_timeout, "ended after {elapsed:?}");
        assert!(elapsed < deadline + marker_timeout + Duration::from_secs(2), "ended after {elapsed:?}");
    }

    #[test]
    fn a_failed_marker_update_still_returns_the_outcome() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        let outcome = real_time(run_quit_sequence_with(
            Vec::new(),
            QUIT_DEADLINE,
            &dir,
            &running_guard(),
            failing_writer,
            MARKER_TIMEOUT,
        ));
        assert!(matches!(outcome, QuitOutcome::Completed { .. }));
    }

    #[test]
    fn the_guard_starts_once_exits_now_once_while_running_and_exits_after() {
        let guard = QuitGuard::default();
        assert!(!guard.is_quitting());
        assert_eq!(guard.on_exit_requested(), ExitDecision::StartSequence);
        assert!(guard.is_quitting());
        assert_eq!(guard.on_exit_requested(), ExitDecision::ExitNow);
        // The first interrupting request owns the marker; the next ones only
        // exit.
        assert_eq!(guard.on_exit_requested(), ExitDecision::Exit);
        guard.finish();
        assert_eq!(guard.on_exit_requested(), ExitDecision::Exit);
        assert_eq!(guard.on_exit_requested(), ExitDecision::Exit);
        assert!(guard.is_quitting());
    }

    #[test]
    fn start_if_idle_starts_only_an_idle_guard_and_leaves_a_running_quit_alone() {
        let guard = QuitGuard::default();
        assert!(guard.start_if_idle());
        assert!(guard.is_quitting());
        // Neither a second start nor a running sequence's marker changes.
        assert!(!guard.start_if_idle());
        assert!(guard.claim_marker());

        let running = QuitGuard::default();
        assert_eq!(running.on_exit_requested(), ExitDecision::StartSequence);
        assert!(!running.start_if_idle());
        // The next exit request still owns the marker.
        assert_eq!(running.on_exit_requested(), ExitDecision::ExitNow);

        let done = QuitGuard::default();
        assert!(done.start_if_idle());
        done.finish();
        assert!(!done.start_if_idle());
        assert_eq!(done.on_exit_requested(), ExitDecision::Exit);
    }

    #[test]
    fn concurrent_exit_requests_start_the_sequence_once_and_exit_now_once() {
        let guard = Arc::new(QuitGuard::default());
        let decisions: Vec<ExitDecision> = (0..16)
            .map(|_| {
                let guard = Arc::clone(&guard);
                std::thread::spawn(move || guard.on_exit_requested())
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect();
        let starts = decisions.iter().filter(|&&d| d == ExitDecision::StartSequence).count();
        let exits_now = decisions.iter().filter(|&&d| d == ExitDecision::ExitNow).count();
        assert_eq!((starts, exits_now), (1, 1));
    }

    #[test]
    fn the_guard_tracks_the_running_phase() {
        paused(async {
            let guard = Arc::new(QuitGuard::default());
            let seen: Log = Arc::default();
            let probe = |name: &'static str| {
                let (guard, seen) = (Arc::clone(&guard), Arc::clone(&seen));
                QuitPhase::new(name, async move {
                    seen.lock().unwrap().push(format!("{:?}", guard.running_phase()));
                })
            };
            let phases = vec![probe("a"), probe("b")];
            run_phases(phases, QUIT_DEADLINE, &guard).await;
            assert_eq!(*seen.lock().unwrap(), [r#"Some("a")"#, r#"Some("b")"#]);
            assert_eq!(guard.running_phase(), None);

            run_phases(vec![QuitPhase::new("stuck", std::future::pending())], QUIT_DEADLINE, &guard).await;
            assert_eq!(guard.running_phase(), Some("stuck"));
        });
    }

    static RECORDED: Mutex<Vec<(PathBuf, QuitOutcome, Duration)>> = Mutex::new(Vec::new());

    fn recording_writer(marker: &Path, outcome: &QuitOutcome, deadline: Duration) -> std::io::Result<()> {
        RECORDED.lock().unwrap().push((marker.to_path_buf(), outcome.clone(), deadline));
        Ok(())
    }

    /// What [`recording_writer`] got for the marker in `dir`. Tests run in
    /// parallel and share the log, so each one reads only its own directory.
    fn recorded_in(dir: &Path) -> Vec<QuitOutcome> {
        let marker = dir.join(PENDING_MARKER_FILE);
        RECORDED.lock().unwrap().iter().filter(|(m, ..)| *m == marker).map(|(_, o, _)| o.clone()).collect()
    }

    #[test]
    fn an_interrupted_sequence_that_then_completes_leaves_the_marker_alone() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        let guard = running_guard();
        assert_eq!(guard.on_exit_requested(), ExitDecision::ExitNow);
        real_time(async {
            record_interruption_with(
                Some("flushPending"),
                QUIT_DEADLINE,
                &dir,
                recording_writer,
                MARKER_TIMEOUT,
            )
            .await;
            let outcome = run_quit_sequence_with(
                Vec::new(),
                QUIT_DEADLINE,
                &dir,
                &guard,
                recording_writer,
                MARKER_TIMEOUT,
            )
            .await;
            assert!(matches!(outcome, QuitOutcome::Completed { .. }));
        });
        assert_eq!(recorded_in(&dir), [QuitOutcome::Interrupted { unfinished: Some("flushPending") }]);
    }

    #[test]
    fn an_interrupted_sequence_that_then_reaches_the_deadline_leaves_the_marker_alone() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        let guard = running_guard();
        assert_eq!(guard.on_exit_requested(), ExitDecision::ExitNow);
        real_time(async {
            record_interruption_with(
                Some("flushPending"),
                QUIT_DEADLINE,
                &dir,
                recording_writer,
                MARKER_TIMEOUT,
            )
            .await;
            let outcome = run_quit_sequence_with(
                vec![QuitPhase::new("flushPending", std::future::pending())],
                Duration::from_millis(10),
                &dir,
                &guard,
                recording_writer,
                MARKER_TIMEOUT,
            )
            .await;
            assert_eq!(outcome, QuitOutcome::DeadlineReached { unfinished: Some("flushPending") });
        });
        assert_eq!(recorded_in(&dir), [QuitOutcome::Interrupted { unfinished: Some("flushPending") }]);
    }

    #[test]
    fn a_request_after_the_sequence_claimed_the_marker_exits_without_writing() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        let guard = running_guard();
        let outcome = real_time(run_quit_sequence_with(
            Vec::new(),
            QUIT_DEADLINE,
            &dir,
            &guard,
            recording_writer,
            MARKER_TIMEOUT,
        ));
        assert!(matches!(outcome, QuitOutcome::Completed { .. }));
        assert_eq!(guard.on_exit_requested(), ExitDecision::Exit);
        guard.finish();
        assert_eq!(guard.on_exit_requested(), ExitDecision::Exit);
        assert_eq!(recorded_in(&dir).len(), 1);
        assert!(matches!(recorded_in(&dir)[0], QuitOutcome::Completed { .. }));
    }

    #[test]
    fn waiting_for_the_sequence_returns_at_once_unless_it_is_updating_the_marker() {
        let guard = running_guard();
        let started = std::time::Instant::now();
        guard.wait_until_finished(Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(guard.claim_marker());
        let started = std::time::Instant::now();
        guard.wait_until_finished(Duration::from_millis(100));
        assert!(started.elapsed() >= Duration::from_millis(100));
        guard.finish();
        let started = std::time::Instant::now();
        guard.wait_until_finished(Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    /// Races a second exit request against the end of the sequence, with the
    /// real marker writer, many times over: whichever side the guard picks,
    /// the marker the exit leaves is the one that side wrote.
    #[test]
    fn a_second_request_racing_the_end_of_the_sequence_leaves_one_consistent_marker() {
        let runtime =
            tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_time().build().unwrap();
        let mut picks = [0usize; 2];
        for i in 0..200 {
            let tmp = TempDir::new().unwrap();
            let dir = tmp.path().to_path_buf();
            let marker = dir.join(PENDING_MARKER_FILE);
            let guard = Arc::new(running_guard());
            let hits_deadline = i % 2 == 1;
            let phases = if hits_deadline {
                vec![QuitPhase::new("flushPending", std::future::pending())]
            } else {
                Vec::new()
            };
            let sequence = {
                let (guard, dir) = (Arc::clone(&guard), dir.clone());
                runtime.spawn(async move {
                    run_quit_sequence(phases, Duration::from_millis(1), &dir, &guard).await;
                    guard.finish();
                })
            };
            // Spreads the request over the end of the sequence: before the
            // phases end, while the sequence updates the marker, and after.
            let lead = Duration::from_micros(100 * (i as u64 / 2 % 20));
            let spin = std::time::Instant::now();
            while spin.elapsed() < lead {
                std::hint::spin_loop();
            }
            let decision = guard.on_exit_requested();
            match decision {
                ExitDecision::ExitNow => {
                    let phase = guard.running_phase();
                    runtime.block_on(record_interruption(phase, QUIT_DEADLINE, &dir));
                }
                ExitDecision::Exit => guard.wait_until_finished(MARKER_TIMEOUT),
                ExitDecision::StartSequence => unreachable!(),
            }
            // The state the exit would leave behind.
            let at_exit = std::fs::read_to_string(&marker).ok();
            runtime.block_on(sequence).unwrap();
            let after = std::fs::read_to_string(&marker).ok();
            assert_eq!(at_exit, after, "iteration {i}: the marker changed after the exit");
            match decision {
                ExitDecision::ExitNow => {
                    picks[0] += 1;
                    assert!(
                        after.as_deref().is_some_and(|b| b.ends_with(r#""interrupted":true}"#)),
                        "{after:?}"
                    );
                }
                _ => {
                    picks[1] += 1;
                    if hits_deadline {
                        assert_eq!(
                            after.as_deref(),
                            Some(r#"{"unfinishedPhase":"flushPending","deadlineMs":1}"#),
                            "iteration {i}"
                        );
                    } else {
                        assert_eq!(after, None, "iteration {i}");
                    }
                }
            }
        }
        eprintln!("interrupt won {} times, the sequence {} times", picks[0], picks[1]);
    }

    #[test]
    fn an_interruption_hands_the_running_phase_to_the_marker_writer() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        real_time(record_interruption_with(
            Some("flushPending"),
            QUIT_DEADLINE,
            &dir,
            recording_writer,
            MARKER_TIMEOUT,
        ));
        let marker = dir.join(PENDING_MARKER_FILE);
        let recorded: Vec<_> =
            RECORDED.lock().unwrap().iter().filter(|(m, ..)| *m == marker).cloned().collect();
        assert_eq!(
            recorded,
            [(marker, QuitOutcome::Interrupted { unfinished: Some("flushPending") }, QUIT_DEADLINE)]
        );
    }

    #[test]
    fn an_interruption_writes_the_interrupted_marker() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        real_time(record_interruption(Some("flushPending"), QUIT_DEADLINE, &dir));
        let body = std::fs::read_to_string(dir.join(PENDING_MARKER_FILE)).unwrap();
        assert_eq!(body, r#"{"unfinishedPhase":"flushPending","deadlineMs":30000,"interrupted":true}"#);

        real_time(record_interruption(None, QUIT_DEADLINE, &dir));
        let body = std::fs::read_to_string(dir.join(PENDING_MARKER_FILE)).unwrap();
        assert_eq!(body, r#"{"unfinishedPhase":null,"deadlineMs":30000,"interrupted":true}"#);
    }

    #[test]
    fn a_stalled_interruption_write_does_not_hold_up_the_exit() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        let marker_timeout = Duration::from_millis(200);
        let started = std::time::Instant::now();
        real_time(record_interruption_with(
            Some("flushPending"),
            QUIT_DEADLINE,
            &dir,
            stalled_writer,
            marker_timeout,
        ));
        let elapsed = started.elapsed();
        assert!(elapsed >= marker_timeout, "ended after {elapsed:?}");
        assert!(elapsed < marker_timeout + Duration::from_secs(2), "ended after {elapsed:?}");
    }
}
