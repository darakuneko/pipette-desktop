// SPDX-License-Identifier: GPL-2.0-or-later
//! One run of a piece of work shared by every caller that asks for it while it
//! is under way. The work runs as its own task, so it finishes even when every
//! caller stops waiting, and each caller gets a clone of its result.

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use tokio::sync::watch;

use crate::preflight::PreflightError;

type Slot<T> = Arc<Mutex<Option<(u64, watch::Receiver<Option<T>>)>>>;

/// Whether a caller started the run or joined one already under way.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Started,
    Joined,
}

pub struct SingleFlight<T> {
    slot: Slot<Result<T, PreflightError>>,
    ids: AtomicU64,
}

impl<T> Default for SingleFlight<T> {
    fn default() -> Self {
        Self { slot: Arc::default(), ids: AtomicU64::new(0) }
    }
}

impl<T: Clone + Send + Sync + 'static> SingleFlight<T> {
    /// Joins the run under way, or starts `work` as a task. The slot is
    /// emptied when the run ends, after `work` (and what it records) is
    /// done and before the callers wake.
    pub fn run<F, Fut>(
        &self,
        work: F,
    ) -> (Role, impl Future<Output = Result<T, PreflightError>> + use<T, F, Fut>)
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, PreflightError>> + Send + 'static,
    {
        let mut slot = self.slot.lock().unwrap_or_else(PoisonError::into_inner);
        let (role, receiver) = match &*slot {
            Some((_, receiver)) => (Role::Joined, receiver.clone()),
            None => {
                let id = self.ids.fetch_add(1, Ordering::Relaxed);
                let (sender, receiver) = watch::channel(None);
                let shared = Arc::clone(&self.slot);
                let future = work();
                tokio::spawn(async move {
                    let result = future.await;
                    {
                        let mut slot = shared.lock().unwrap_or_else(PoisonError::into_inner);
                        if slot.as_ref().is_some_and(|(current, _)| *current == id) {
                            *slot = None;
                        }
                    }
                    sender.send_replace(Some(result));
                });
                *slot = Some((id, receiver.clone()));
                (Role::Started, receiver)
            }
        };
        drop(slot);
        (role, wait(receiver))
    }

    /// Forgets the run under way: the next caller starts a new one, while
    /// the callers already waiting still get the forgotten run's result.
    pub fn forget(&self) {
        *self.slot.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }
}

async fn wait<T: Clone>(
    mut receiver: watch::Receiver<Option<Result<T, PreflightError>>>,
) -> Result<T, PreflightError> {
    match receiver.wait_for(Option::is_some).await {
        Ok(result) => result.clone().unwrap_or_else(|| Err(lost())),
        Err(_) => Err(lost()),
    }
}

/// The task ended without a result (it panicked).
fn lost() -> PreflightError {
    PreflightError::Other("the shared run ended without a result".to_owned())
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;

    #[tokio::test]
    async fn callers_during_a_run_share_it_and_later_ones_start_another() {
        let flight = SingleFlight::<usize>::default();
        let runs = Arc::new(AtomicUsize::new(0));
        let start = || {
            let runs = Arc::clone(&runs);
            move || async move { Ok(runs.fetch_add(1, Ordering::SeqCst)) }
        };
        let (first, a) = flight.run(start());
        let (second, b) = flight.run(start());
        assert_eq!((first, second), (Role::Started, Role::Joined));
        assert_eq!((a.await.unwrap(), b.await.unwrap()), (0, 0));
        let (third, c) = flight.run(start());
        assert_eq!(third, Role::Started);
        assert_eq!(c.await.unwrap(), 1);
    }

    #[tokio::test]
    async fn a_forgotten_run_still_answers_its_callers() {
        let flight = SingleFlight::<u8>::default();
        let (gate, open) = tokio::sync::oneshot::channel::<()>();
        let (_, waiting) = flight.run(|| async move {
            let _ = open.await;
            Ok(1)
        });
        flight.forget();
        let (later_gate, later_open) = tokio::sync::oneshot::channel::<()>();
        let (role, next) = flight.run(|| async move {
            let _ = later_open.await;
            Ok(2)
        });
        assert_eq!(role, Role::Started);
        gate.send(()).unwrap();
        assert_eq!(waiting.await.unwrap(), 1);
        // The forgotten run ending leaves the newer run in its slot.
        let (role, joined) = flight.run(|| async { Ok(3) });
        assert_eq!(role, Role::Joined);
        later_gate.send(()).unwrap();
        assert_eq!((next.await.unwrap(), joined.await.unwrap()), (2, 2));
    }

    #[tokio::test]
    async fn a_run_that_panics_is_an_error_for_its_callers() {
        let flight = SingleFlight::<u8>::default();
        let (_, waiting) = flight.run(|| async { panic!("boom") });
        assert!(waiting.await.is_err());
    }
}
