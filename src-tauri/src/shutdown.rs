// SPDX-License-Identifier: GPL-2.0-or-later
//! The quit sequence: ordered asynchronous phases that run before the app
//! exits, bounded by one overall deadline, the shape of the before-quit
//! handler of src/main/sync/sync-flush.ts (password change → pre-sync
//! finalizers → the running sync pass → the pending flush → the remaining
//! finalizers, 30 s in all).
//!
//! The coordinator knows nothing of Tauri: src/lifecycle.rs turns each exit
//! request into a [`QuitGuard`] decision and runs [`run_quit_sequence`]
//! when the guard says to start.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use serde::Serialize;
use tokio::time::Instant;

use crate::fs_atomic::write_file_atomic;

/// How long the quit sequence may run before the app exits anyway. Same
/// value as `QUIT_SYNC_DEADLINE_MS` in src/main/sync/sync-flush.ts: a
/// stalled request has no timeout of its own and must not keep the app
/// from exiting.
pub const QUIT_DEADLINE: Duration = Duration::from_secs(30);

/// File name of the marker written when the deadline cuts the sequence
/// short, in the app data directory.
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
}

/// What to do with an exit request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitDecision {
    /// The first request: stop the exit and start the quit sequence.
    StartSequence,
    /// The sequence is running: stop the exit; the sequence exits when it
    /// ends.
    Wait,
    /// The sequence has ended: let the exit through.
    Exit,
}

const IDLE: u8 = 0;
const RUNNING: u8 = 1;
const DONE: u8 = 2;

/// The re-entry guard of the quit sequence. Every exit path (the tray, the
/// last window closing, a signal, the exit the sequence itself requests)
/// asks it what to do, so the sequence runs once and the exit after it goes
/// through.
#[derive(Debug, Default)]
pub struct QuitGuard(AtomicU8);

impl QuitGuard {
    pub fn on_exit_requested(&self) -> ExitDecision {
        match self.0.compare_exchange(IDLE, RUNNING, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => ExitDecision::StartSequence,
            Err(RUNNING) => ExitDecision::Wait,
            Err(_) => ExitDecision::Exit,
        }
    }

    /// Marks the sequence as ended, so the next exit request goes through.
    pub fn finish(&self) {
        self.0.store(DONE, Ordering::Release);
    }

    /// Whether an exit has been requested. A window closed while quitting
    /// closes instead of hiding in the tray.
    pub fn is_quitting(&self) -> bool {
        self.0.load(Ordering::Acquire) != IDLE
    }
}

/// Runs the phases one after another until they all end or `deadline`
/// passes, logging each phase's start and duration. A phase cut off by the
/// deadline is dropped mid-await, so a phase must leave nothing half-written
/// at an await point.
async fn run_phases(phases: Vec<QuitPhase>, deadline: Duration) -> QuitOutcome {
    let started = Instant::now();
    let mut current: Option<&'static str> = None;
    let sequence = async {
        for phase in phases {
            current = Some(phase.name);
            let phase_started = Instant::now();
            eprintln!("[quit] +{}ms phase {} started", started.elapsed().as_millis(), phase.name);
            phase.run.await;
            eprintln!(
                "[quit] +{}ms phase {} finished in {}ms",
                started.elapsed().as_millis(),
                phase.name,
                phase_started.elapsed().as_millis()
            );
            current = None;
        }
    };
    let result = tokio::time::timeout(deadline, sequence).await;
    match result {
        Ok(()) => QuitOutcome::Completed { elapsed: started.elapsed() },
        Err(_) => {
            eprintln!(
                "[quit] +{}ms deadline of {}ms reached during {}",
                started.elapsed().as_millis(),
                deadline.as_millis(),
                current.unwrap_or("(between phases)")
            );
            QuitOutcome::DeadlineReached { unfinished: current }
        }
    }
}

/// How long the marker update may take after the phases end. The update
/// syncs a file to disk, which a stalled file system can hold up forever,
/// so it runs on a blocking thread and the exit goes ahead when this
/// passes. The whole sequence therefore ends within the phase deadline plus
/// this.
pub const MARKER_TIMEOUT: Duration = Duration::from_secs(3);

/// Writes or removes the pending marker for an outcome: the file path, the
/// outcome and the phase deadline.
type MarkerUpdate = fn(&Path, &QuitOutcome, Duration) -> std::io::Result<()>;

/// Runs the phases, then records what is left for the next launch: the
/// marker in `data_dir` is written when the deadline cut the sequence short
/// and removed when every phase ended. Without a data directory no marker
/// is kept. The sequence's outcome is returned whether the marker update
/// succeeded, failed or ran past [`MARKER_TIMEOUT`].
pub async fn run_quit_sequence(
    phases: Vec<QuitPhase>,
    deadline: Duration,
    data_dir: Option<&Path>,
) -> QuitOutcome {
    run_quit_sequence_with(phases, deadline, data_dir, update_marker, MARKER_TIMEOUT).await
}

async fn run_quit_sequence_with(
    phases: Vec<QuitPhase>,
    deadline: Duration,
    data_dir: Option<&Path>,
    update: MarkerUpdate,
    marker_timeout: Duration,
) -> QuitOutcome {
    let outcome = run_phases(phases, deadline).await;
    let Some(data_dir) = data_dir else { return outcome };
    let marker = data_dir.join(PENDING_MARKER_FILE);
    let task = {
        let (marker, outcome) = (marker.clone(), outcome.clone());
        tokio::task::spawn_blocking(move || update(&marker, &outcome, deadline))
    };
    // On a timeout the blocking thread is left running; it cannot be
    // cancelled, and the process exit ends it.
    match tokio::time::timeout(marker_timeout, task).await {
        Ok(Ok(Ok(()))) => {}
        Ok(Ok(Err(err))) => eprintln!("[quit] failed to update {}: {err}", marker.display()),
        Ok(Err(err)) => eprintln!("[quit] the update of {} did not finish: {err}", marker.display()),
        Err(_) => eprintln!(
            "[quit] gave up on updating {} after {}ms",
            marker.display(),
            marker_timeout.as_millis()
        ),
    }
    outcome
}

fn update_marker(marker: &Path, outcome: &QuitOutcome, deadline: Duration) -> std::io::Result<()> {
    match outcome {
        QuitOutcome::Completed { .. } => remove_marker(marker),
        QuitOutcome::DeadlineReached { unfinished } => write_marker(marker, *unfinished, deadline),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingMarker {
    unfinished_phase: Option<&'static str>,
    deadline_ms: u128,
}

fn write_marker(marker: &Path, unfinished: Option<&'static str>, deadline: Duration) -> std::io::Result<()> {
    if let Some(dir) = marker.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_vec(&PendingMarker {
        unfinished_phase: unfinished,
        deadline_ms: deadline.as_millis(),
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
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Arc, Mutex};

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

    fn temp_dir(tag: &str) -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "pipette-quit-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
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
            let outcome = run_phases(phases, QUIT_DEADLINE).await;
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
            let outcome = run_phases(phases, QUIT_DEADLINE).await;
            assert_eq!(started.elapsed(), QUIT_DEADLINE);
            assert_eq!(outcome, QuitOutcome::DeadlineReached { unfinished: Some("b") });
            assert_eq!(*log.lock().unwrap(), ["start a", "end a", "start b"]);
        });
    }

    #[test]
    fn a_phase_that_never_ends_is_cut_at_the_deadline() {
        paused(async {
            let outcome =
                run_phases(vec![QuitPhase::new("stuck", std::future::pending())], Duration::from_secs(5))
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
            run_phases(vec![phase], QUIT_DEADLINE).await;
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
            let sequence = run_phases(vec![first, sleeping_phase(&log, "second", 1)], QUIT_DEADLINE);
            let cut = tokio::time::timeout(Duration::from_secs(1), sequence).await;
            assert!(cut.is_err());
            assert_eq!(dropped.load(Ordering::SeqCst), 1);
            assert!(log.lock().unwrap().is_empty());
        });
    }

    #[test]
    fn an_empty_sequence_completes_at_once() {
        paused(async {
            let outcome = run_phases(Vec::new(), QUIT_DEADLINE).await;
            assert_eq!(outcome, QuitOutcome::Completed { elapsed: Duration::ZERO });
        });
    }

    #[test]
    fn the_deadline_writes_the_pending_marker() {
        paused(async {
            let dir = temp_dir("deadline");
            let phases = vec![QuitPhase::new("flushPending", std::future::pending())];
            let outcome = run_quit_sequence(phases, QUIT_DEADLINE, Some(&dir)).await;
            assert_eq!(outcome, QuitOutcome::DeadlineReached { unfinished: Some("flushPending") });
            let body = std::fs::read_to_string(dir.join(PENDING_MARKER_FILE)).unwrap();
            assert_eq!(body, r#"{"unfinishedPhase":"flushPending","deadlineMs":30000}"#);
            std::fs::remove_dir_all(dir).unwrap();
        });
    }

    #[test]
    fn a_completed_sequence_removes_a_stale_marker() {
        paused(async {
            let dir = temp_dir("completed");
            let marker = dir.join(PENDING_MARKER_FILE);
            std::fs::write(&marker, "{}").unwrap();
            let outcome = run_quit_sequence(Vec::new(), QUIT_DEADLINE, Some(&dir)).await;
            assert!(matches!(outcome, QuitOutcome::Completed { .. }));
            assert!(!marker.exists());
            std::fs::remove_dir_all(dir).unwrap();
        });
    }

    #[test]
    fn the_marker_directory_is_created_when_missing() {
        paused(async {
            let dir = temp_dir("missing").join("nested");
            run_quit_sequence(
                vec![QuitPhase::new("x", std::future::pending())],
                Duration::from_secs(1),
                Some(&dir),
            )
            .await;
            assert!(dir.join(PENDING_MARKER_FILE).exists());
            std::fs::remove_dir_all(dir.parent().unwrap()).unwrap();
        });
    }

    #[test]
    fn without_a_data_directory_the_outcome_is_still_returned() {
        paused(async {
            let phases = vec![QuitPhase::new("stuck", std::future::pending())];
            let outcome = run_quit_sequence(phases, Duration::from_secs(1), None).await;
            assert_eq!(outcome, QuitOutcome::DeadlineReached { unfinished: Some("stuck") });
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
        let dir = temp_dir("stalled");
        let deadline = Duration::from_millis(100);
        let marker_timeout = Duration::from_millis(200);
        let started = std::time::Instant::now();
        let outcome = real_time(run_quit_sequence_with(
            vec![QuitPhase::new("flushPending", std::future::pending())],
            deadline,
            Some(&dir),
            stalled_writer,
            marker_timeout,
        ));
        let elapsed = started.elapsed();
        assert_eq!(outcome, QuitOutcome::DeadlineReached { unfinished: Some("flushPending") });
        assert!(elapsed >= deadline + marker_timeout, "ended after {elapsed:?}");
        assert!(elapsed < deadline + marker_timeout + Duration::from_secs(2), "ended after {elapsed:?}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_failed_marker_update_still_returns_the_outcome() {
        let dir = temp_dir("failed");
        let outcome = real_time(run_quit_sequence_with(
            Vec::new(),
            QUIT_DEADLINE,
            Some(&dir),
            failing_writer,
            MARKER_TIMEOUT,
        ));
        assert!(matches!(outcome, QuitOutcome::Completed { .. }));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_guard_starts_once_waits_while_running_and_exits_after() {
        let guard = QuitGuard::default();
        assert!(!guard.is_quitting());
        assert_eq!(guard.on_exit_requested(), ExitDecision::StartSequence);
        assert!(guard.is_quitting());
        assert_eq!(guard.on_exit_requested(), ExitDecision::Wait);
        assert_eq!(guard.on_exit_requested(), ExitDecision::Wait);
        guard.finish();
        assert_eq!(guard.on_exit_requested(), ExitDecision::Exit);
        assert_eq!(guard.on_exit_requested(), ExitDecision::Exit);
        assert!(guard.is_quitting());
    }

    #[test]
    fn concurrent_exit_requests_start_the_sequence_once() {
        let guard = Arc::new(QuitGuard::default());
        let starts: usize = (0..16)
            .map(|_| {
                let guard = Arc::clone(&guard);
                std::thread::spawn(move || guard.on_exit_requested() == ExitDecision::StartSequence)
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| usize::from(h.join().unwrap()))
            .sum();
        assert_eq!(starts, 1);
    }
}
