// SPDX-License-Identifier: GPL-2.0-or-later
//! One long-lived thread that owns a value and runs every call on it.
//!
//! hidapi ties state to the thread that made a call, and the blocking-pool
//! threads the commands run on exit after being idle:
//! - hidapi's macOS backend keeps one global `IOHIDManager` and schedules it
//!   on the run loop of the thread that first initialises the library
//!   (`init_hid_manager` in hidapi's `mac/hid.c`). Every later
//!   `hid_enumerate` resets the manager's matching, which schedules each
//!   attached device on that stored run loop; once the initialising thread
//!   has exited, the run loop is gone and the call crashes.
//! - hidapi's Windows backend leaves an overlapped read pending when
//!   `hid_read_timeout` times out (and a write when `hid_write` does), into
//!   buffers owned by the device. Windows cancels a thread's pending I/O
//!   when the thread exits, and `hid_close` cancels with `CancelIo`, which
//!   only reaches I/O the calling thread issued, before freeing the buffers.
//!
//! So the library context and each open device get a thread of their own
//! that outlives every call made on it. The same threads are used on every
//! OS so the behaviour is the same everywhere.

use std::any::Any;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use crate::error::HidError;

type Job<S> = Box<dyn FnOnce(&mut S) + Send>;

/// Owns an `S` (created with `Default` on the thread) and runs closures on
/// it one at a time, in the order they were sent. The thread starts on the
/// first call and ends once the owner is dropped and the queued calls are
/// done; dropping never waits for it, so a quit cannot hang on a call in
/// progress.
pub(crate) struct OwnerThread<S> {
    name: &'static str,
    jobs: Mutex<Option<Sender<Job<S>>>>,
}

impl<S: Default + 'static> OwnerThread<S> {
    pub(crate) const fn new(name: &'static str) -> Self {
        Self { name, jobs: Mutex::new(None) }
    }

    /// Runs `call` on the thread and waits for its result. A panic in
    /// `call` is caught there and returned as an error; the thread and its
    /// value stay for the next call.
    pub(crate) fn run<R, F>(&self, call: F) -> Result<R, HidError>
    where
        R: Send + 'static,
        F: FnOnce(&mut S) -> R + Send + 'static,
    {
        self.run_waiting(call, None)
    }

    /// [`OwnerThread::run`], waiting at most `limit` for the result. When the
    /// limit passes, the call still runs on the thread once its turn comes,
    /// and its result is dropped.
    pub(crate) fn run_within<R, F>(&self, call: F, limit: Duration) -> Result<R, HidError>
    where
        R: Send + 'static,
        F: FnOnce(&mut S) -> R + Send + 'static,
    {
        self.run_waiting(call, Some(limit))
    }

    fn run_waiting<R, F>(&self, call: F, limit: Option<Duration>) -> Result<R, HidError>
    where
        R: Send + 'static,
        F: FnOnce(&mut S) -> R + Send + 'static,
    {
        let (reply, result) = mpsc::sync_channel(1);
        let job: Job<S> = Box::new(move |state| {
            // The receiver is gone only if the caller is; nothing to report.
            let _ = reply.send(catch_unwind(AssertUnwindSafe(|| call(state))));
        });
        self.sender()?
            .send(job)
            .map_err(|_| HidError::Backend(format!("The {} thread is not running", self.name)))?;
        let received = match limit {
            None => result.recv().map_err(|_| RecvTimeoutError::Disconnected),
            Some(limit) => result.recv_timeout(limit),
        };
        match received {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(panic)) => Err(HidError::Backend(format!(
                "The {} thread panicked: {}",
                self.name,
                panic_message(&*panic)
            ))),
            Err(RecvTimeoutError::Timeout) => {
                Err(HidError::Backend(format!("The {} thread did not answer in time", self.name)))
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err(HidError::Backend(format!("The {} thread stopped", self.name)))
            }
        }
    }

    /// The sender to the thread, starting the thread on first use.
    fn sender(&self) -> Result<Sender<Job<S>>, HidError> {
        let mut jobs = self.jobs.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(sender) = jobs.as_ref() {
            return Ok(sender.clone());
        }
        let (sender, receiver) = mpsc::channel::<Job<S>>();
        thread::Builder::new()
            .name(self.name.to_owned())
            .spawn(move || {
                let mut state = S::default();
                while let Ok(job) = receiver.recv() {
                    job(&mut state);
                }
            })
            .map_err(|err| HidError::Backend(format!("Failed to start the {} thread: {err}", self.name)))?;
        *jobs = Some(sender.clone());
        Ok(sender)
    }
}

fn panic_message(panic: &(dyn Any + Send)) -> &str {
    panic
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("unknown panic")
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::sync::Arc;
    use std::thread::ThreadId;

    use super::*;

    fn worker() -> OwnerThread<Vec<u32>> {
        OwnerThread::new("test-owner")
    }

    #[test]
    fn calls_return_their_results_and_share_the_value() {
        let worker = worker();
        assert_eq!(worker.run(|v| v.push(1)).unwrap(), ());
        assert_eq!(worker.run(|v| v.push(2)).unwrap(), ());
        assert_eq!(worker.run(|v| v.clone()).unwrap(), [1, 2]);
    }

    #[test]
    fn an_error_from_the_call_is_returned_as_is() {
        let worker = worker();
        let result: Result<(), HidError> = worker.run(|_| Err(HidError::NotOpen)).unwrap();
        assert!(matches!(result, Err(HidError::NotOpen)));
    }

    #[test]
    fn a_panic_is_an_error_and_the_thread_keeps_serving() {
        let worker = worker();
        worker.run(|v| v.push(7)).unwrap();
        let err = worker.run(|_| -> u32 { panic!("boom") }).unwrap_err();
        assert_eq!(err.to_string(), "The test-owner thread panicked: boom");
        let err = worker.run(|_| -> u32 { panic!("{}", String::from("formatted")) }).unwrap_err();
        assert_eq!(err.to_string(), "The test-owner thread panicked: formatted");
        assert_eq!(worker.run(|v| v.clone()).unwrap(), [7]);
    }

    #[test]
    fn every_call_runs_on_one_named_thread_that_outlives_its_callers() {
        let worker = Arc::new(worker());
        let id_on = |worker: &Arc<OwnerThread<Vec<u32>>>| {
            let worker = Arc::clone(worker);
            thread::spawn(move || {
                let (id, name) = worker
                    .run(|_| (thread::current().id(), thread::current().name().map(str::to_owned)))
                    .unwrap();
                (id, name, thread::current().id())
            })
            .join()
            .unwrap()
        };
        // The first caller starts the thread and exits.
        let (first, name, caller) = id_on(&worker);
        assert_ne!(first, caller);
        assert_eq!(name.as_deref(), Some("test-owner"));
        for _ in 0..3 {
            assert_eq!(id_on(&worker).0, first);
        }
        assert_eq!(worker.run(|_| thread::current().id()).unwrap(), first);
    }

    #[test]
    fn concurrent_callers_each_get_their_own_result() {
        let worker = Arc::new(worker());
        let callers: Vec<_> = (0..8u32)
            .map(|n| {
                let worker = Arc::clone(&worker);
                thread::spawn(move || {
                    (0..50u32)
                        .map(|i| {
                            let value = n * 1000 + i;
                            worker.run(move |v| {
                                v.push(value);
                                (value, thread::current().id())
                            })
                        })
                        .map(Result::unwrap)
                        .collect::<Vec<(u32, ThreadId)>>()
                })
            })
            .collect();
        let mut threads = Vec::new();
        for (n, caller) in callers.into_iter().enumerate() {
            let results = caller.join().unwrap();
            let expected: Vec<u32> = (0..50u32).map(|i| u32::try_from(n).unwrap() * 1000 + i).collect();
            assert_eq!(results.iter().map(|r| r.0).collect::<Vec<_>>(), expected);
            threads.extend(results.into_iter().map(|r| r.1));
        }
        threads.dedup();
        assert_eq!(threads.len(), 1);
        assert_eq!(worker.run(|v| v.len()).unwrap(), 400);
    }

    #[test]
    fn dropping_the_owner_ends_the_thread_without_waiting_for_it() {
        let (entered, wait_entered) = mpsc::channel();
        let (release, wait_release) = mpsc::channel::<()>();
        let (ended, wait_ended) = mpsc::channel::<()>();
        let worker = OwnerThread::<DropSignal>::new("test-drop");
        worker.run(move |s| s.0 = Some(ended)).unwrap();
        // A call still running on the thread when the owner goes away.
        let busy: Job<DropSignal> = Box::new(move |_| {
            entered.send(()).unwrap();
            wait_release.recv().unwrap();
        });
        worker.sender().unwrap().send(busy).unwrap();
        wait_entered.recv().unwrap();
        drop(worker);
        assert!(wait_ended.try_recv().is_err_and(|e| e == mpsc::TryRecvError::Empty));
        release.send(()).unwrap();
        // Then the thread exits and drops its value.
        assert_eq!(
            wait_ended.recv_timeout(std::time::Duration::from_secs(10)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
    }

    /// Drops its sender when the thread drops the value.
    #[derive(Default)]
    struct DropSignal(Option<mpsc::Sender<()>>);
}
