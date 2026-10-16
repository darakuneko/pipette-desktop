// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync lock and the reset lock built on it
//! (src/main/sync/sync-runtime-state.ts and sync-reset-lock.ts).
//!
//! One holder at a time owns the sync lock: a sync pass, a flush, or a
//! reset or delete of local data. The deletes, the import and the resets
//! hold it as a reset ([`SyncRuntime::with_reset_lock`],
//! [`SyncRuntime::with_reset_lock_when_free`]), naming the keyboards whose
//! data they remove, so no sync pass writes the files they remove or
//! replace. Two Drive writers do not take the lock: the analytics sync of a
//! keyboard and the fetch of a remote day. A reset refuses to start, or
//! waits, while one of them runs for one of its keyboards, and neither
//! starts for a keyboard a running reset holds.
//!
//! Every check and the claim that follows it happen under one mutex, so
//! two callers can never both pass a check and claim.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::Instant;

/// The busy errors; each is an i18n key the renderer shows
/// (`t(error, error)`).
pub const RESET_BUSY_MESSAGE: &str = "sync.resetBusy";
pub const DELETE_BUSY_MESSAGE: &str = "sync.deleteBusy";
pub const IMPORT_BUSY_MESSAGE: &str = "sync.importBusy";

/// How long [`SyncRuntime::with_reset_lock_when_free`] waits for running
/// sync work (`RESET_LOCK_WAIT_MS`).
pub const RESET_LOCK_WAIT: Duration = Duration::from_secs(30);

/// How often the wait for the lock-free writers checks again
/// (`WRITER_CHECK_INTERVAL_MS`).
const WRITER_CHECK_INTERVAL: Duration = Duration::from_millis(100);

/// The keyboards a reset removes the data of, or a lock-free writer check
/// covers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResetKeyboards {
    All,
    /// These uids; an empty list is none.
    Uids(Vec<String>),
    None,
}

/// The reset or delete could not start: the message is one of the busy
/// i18n keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct Busy(pub &'static str);

/// What a running reset holds (`syncRuntime.resetKeyboards`).
#[derive(Clone, Debug, PartialEq, Eq)]
enum HeldKeyboards {
    All,
    Uids(HashSet<String>),
}

impl HeldKeyboards {
    fn of(keyboards: &ResetKeyboards) -> Option<Self> {
        match keyboards {
            ResetKeyboards::All => Some(HeldKeyboards::All),
            ResetKeyboards::Uids(uids) if !uids.is_empty() => {
                Some(HeldKeyboards::Uids(uids.iter().cloned().collect()))
            }
            ResetKeyboards::Uids(_) | ResetKeyboards::None => None,
        }
    }
}

#[derive(Default)]
struct State {
    /// The holder of the sync lock: whether it is waitable, and the
    /// channel that tells waiters it released the lock.
    pass: Option<Pass>,
    reset_keyboards: Option<HeldKeyboards>,
    analytics_syncing_uids: HashSet<String>,
    remote_day_fetches: HashMap<String, usize>,
}

struct Pass {
    waitable: bool,
    released: watch::Receiver<bool>,
}

impl State {
    fn lock_free_writer_running(&self, keyboards: &ResetKeyboards) -> bool {
        match keyboards {
            ResetKeyboards::None => false,
            ResetKeyboards::All => {
                !self.analytics_syncing_uids.is_empty() || !self.remote_day_fetches.is_empty()
            }
            ResetKeyboards::Uids(uids) => uids.iter().any(|uid| {
                self.analytics_syncing_uids.contains(uid) || self.remote_day_fetches.contains_key(uid)
            }),
        }
    }

    fn reset_holds_keyboard(&self, uid: &str) -> bool {
        match &self.reset_keyboards {
            Some(HeldKeyboards::All) => true,
            Some(HeldKeyboards::Uids(uids)) => uids.contains(uid),
            None => false,
        }
    }

    /// Takes the lock for a new holder; the caller has checked it is free.
    fn claim(&mut self, runtime: &SyncRuntime, waitable: bool) -> SyncLockGuard {
        let (release, released) = watch::channel(false);
        self.pass = Some(Pass { waitable, released });
        SyncLockGuard { runtime: runtime.clone(), release }
    }
}

/// The sync lock, the keyboards a running reset holds, and the lock-free
/// writers. Cheap to clone; the clones share the state.
#[derive(Clone, Default)]
pub struct SyncRuntime {
    state: Arc<Mutex<State>>,
}

/// The sync lock while held; dropping it releases the lock and wakes the
/// callers waiting for it.
#[must_use = "the lock is released when the guard is dropped"]
pub struct SyncLockGuard {
    runtime: SyncRuntime,
    release: watch::Sender<bool>,
}

impl Drop for SyncLockGuard {
    fn drop(&mut self) {
        self.runtime.lock().pass = None;
        self.release.send_replace(true);
    }
}

/// A reset holding the sync lock: dropping it clears the keyboards it
/// holds, then releases the lock.
struct ResetHold {
    lock: Option<SyncLockGuard>,
}

impl Drop for ResetHold {
    fn drop(&mut self) {
        if let Some(lock) = self.lock.take() {
            lock.runtime.lock().reset_keyboards = None;
        }
    }
}

/// A running lock-free writer; dropping it ends it.
#[must_use = "the writer ends when the guard is dropped"]
pub struct LockFreeWriter {
    runtime: SyncRuntime,
    uid: String,
    kind: WriterKind,
}

enum WriterKind {
    AnalyticsSync,
    RemoteDayFetch,
}

impl Drop for LockFreeWriter {
    fn drop(&mut self) {
        let mut state = self.runtime.lock();
        match self.kind {
            WriterKind::AnalyticsSync => {
                state.analytics_syncing_uids.remove(&self.uid);
            }
            WriterKind::RemoteDayFetch => {
                if let Some(count) = state.remote_day_fetches.get_mut(&self.uid) {
                    *count -= 1;
                    if *count == 0 {
                        state.remote_day_fetches.remove(&self.uid);
                    }
                }
            }
        }
    }
}

impl SyncRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `isSyncInProgress`: whether anything holds the sync lock.
    pub fn is_syncing(&self) -> bool {
        self.lock().pass.is_some()
    }

    /// Whether the holder of the sync lock settles on its own, so a sync
    /// pass waits for it instead of skipping (`inFlightPassWaitable`).
    pub fn holder_is_waitable(&self) -> bool {
        self.lock().pass.as_ref().is_some_and(|pass| pass.waitable)
    }

    /// `tryClaimSyncLock`: the lock, unless something holds it.
    pub fn try_claim_sync_lock(&self, waitable: bool) -> Option<SyncLockGuard> {
        let mut state = self.lock();
        if state.pass.is_some() {
            return None;
        }
        Some(state.claim(self, waitable))
    }

    /// `claimSyncLockBy`: the lock as a waitable holder, waiting for each
    /// holder to release it; `None` when it is still held at `deadline`.
    /// `on_claimed` runs under the state's mutex in the step that claims.
    async fn claim_sync_lock_by(
        &self,
        deadline: Instant,
        on_claimed: impl Fn(&mut State),
    ) -> Option<SyncLockGuard> {
        loop {
            let mut released = {
                let mut state = self.lock();
                match &state.pass {
                    None => {
                        on_claimed(&mut state);
                        return Some(state.claim(self, true));
                    }
                    Some(pass) => pass.released.clone(),
                }
            };
            // A closed channel means the holder is gone too.
            let wait = released.wait_for(|released| *released);
            if tokio::time::timeout_at(deadline, wait).await.is_err() {
                return None;
            }
        }
    }

    /// `lockFreeWriterRunning`: whether an analytics sync or a remote day
    /// fetch runs for one of `keyboards`.
    pub fn lock_free_writer_running(&self, keyboards: &ResetKeyboards) -> bool {
        self.lock().lock_free_writer_running(keyboards)
    }

    /// `resetHoldsKeyboard`: whether the running reset removes `uid`'s
    /// data.
    pub fn reset_holds_keyboard(&self, uid: &str) -> bool {
        self.lock().reset_holds_keyboard(uid)
    }

    /// Starts the analytics sync of `uid`, unless one runs for it or a
    /// reset holds it.
    pub fn try_start_analytics_sync(&self, uid: &str) -> Option<LockFreeWriter> {
        let mut state = self.lock();
        if state.reset_holds_keyboard(uid) || !state.analytics_syncing_uids.insert(uid.to_owned()) {
            return None;
        }
        Some(LockFreeWriter { runtime: self.clone(), uid: uid.to_owned(), kind: WriterKind::AnalyticsSync })
    }

    /// Starts a remote day fetch of `uid` (several may run at once), unless
    /// a reset holds it.
    pub fn try_start_remote_day_fetch(&self, uid: &str) -> Option<LockFreeWriter> {
        let mut state = self.lock();
        if state.reset_holds_keyboard(uid) {
            return None;
        }
        *state.remote_day_fetches.entry(uid.to_owned()).or_default() += 1;
        Some(LockFreeWriter { runtime: self.clone(), uid: uid.to_owned(), kind: WriterKind::RemoteDayFetch })
    }

    /// `withResetLock`: runs `work` holding the sync lock as a waitable
    /// holder with `keyboards` held, or answers `busy` at once when the
    /// lock is held or a lock-free writer of `keyboards` runs.
    pub async fn with_reset_lock<T>(
        &self,
        keyboards: &ResetKeyboards,
        busy: &'static str,
        work: impl Future<Output = T>,
    ) -> Result<T, Busy> {
        let hold = {
            let mut state = self.lock();
            if state.lock_free_writer_running(keyboards) || state.pass.is_some() {
                return Err(Busy(busy));
            }
            state.reset_keyboards = HeldKeyboards::of(keyboards);
            ResetHold { lock: Some(state.claim(self, true)) }
        };
        let answer = work.await;
        drop(hold);
        Ok(answer)
    }

    /// `withResetLockWhenFree`: [`Self::with_reset_lock`] for an action
    /// the user starts while a sync pass may hold the lock for a few
    /// seconds. Waits up to [`RESET_LOCK_WAIT`] for the lock, holds
    /// `keyboards` (so no new lock-free writer of them starts) and waits,
    /// within the same time, for the running ones to end. Answers `busy`
    /// when the time runs out first.
    pub async fn with_reset_lock_when_free<T>(
        &self,
        keyboards: &ResetKeyboards,
        busy: &'static str,
        work: impl Future<Output = T>,
    ) -> Result<T, Busy> {
        let deadline = Instant::now() + RESET_LOCK_WAIT;
        let held = HeldKeyboards::of(keyboards);
        let lock = self
            .claim_sync_lock_by(deadline, |state| state.reset_keyboards = held.clone())
            .await
            .ok_or(Busy(busy))?;
        let hold = ResetHold { lock: Some(lock) };
        while self.lock_free_writer_running(keyboards) {
            if Instant::now() >= deadline {
                drop(hold);
                return Err(Busy(busy));
            }
            tokio::time::sleep_until((Instant::now() + WRITER_CHECK_INTERVAL).min(deadline)).await;
        }
        let answer = work.await;
        drop(hold);
        Ok(answer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uids(list: &[&str]) -> ResetKeyboards {
        ResetKeyboards::Uids(list.iter().map(|uid| (*uid).to_owned()).collect())
    }

    #[tokio::test]
    async fn holds_the_keyboards_while_the_work_runs() {
        let runtime = SyncRuntime::new();
        let inside = runtime
            .with_reset_lock(&uids(&["a"]), DELETE_BUSY_MESSAGE, async {
                (
                    runtime.is_syncing(),
                    runtime.holder_is_waitable(),
                    runtime.reset_holds_keyboard("a"),
                    runtime.reset_holds_keyboard("b"),
                    runtime.try_start_analytics_sync("a").is_none(),
                    runtime.try_start_remote_day_fetch("b").is_some(),
                )
            })
            .await
            .unwrap();
        assert_eq!(inside, (true, true, true, false, true, true));
        assert!(!runtime.is_syncing());
        assert!(!runtime.reset_holds_keyboard("a"));
        let all = runtime.with_reset_lock(&ResetKeyboards::All, RESET_BUSY_MESSAGE, async {
            runtime.reset_holds_keyboard("z")
        });
        assert_eq!(all.await, Ok(true));
        let empty = uids(&[]);
        let none =
            runtime.with_reset_lock(&empty, RESET_BUSY_MESSAGE, async { runtime.reset_holds_keyboard("z") });
        assert_eq!(none.await, Ok(false));
    }

    #[tokio::test]
    async fn refuses_while_the_lock_is_held_or_a_writer_of_the_keyboards_runs() {
        let runtime = SyncRuntime::new();
        let pass = runtime.try_claim_sync_lock(false).unwrap();
        assert!(runtime.try_claim_sync_lock(false).is_none());
        let refused = runtime.with_reset_lock(&ResetKeyboards::None, IMPORT_BUSY_MESSAGE, async {}).await;
        assert_eq!(refused, Err(Busy(IMPORT_BUSY_MESSAGE)));
        drop(pass);

        let writer = runtime.try_start_analytics_sync("a").unwrap();
        assert!(runtime.try_start_analytics_sync("a").is_none());
        assert_eq!(
            runtime.with_reset_lock(&uids(&["a"]), DELETE_BUSY_MESSAGE, async {}).await,
            Err(Busy(DELETE_BUSY_MESSAGE))
        );
        assert_eq!(
            runtime.with_reset_lock(&ResetKeyboards::All, RESET_BUSY_MESSAGE, async {}).await,
            Err(Busy(RESET_BUSY_MESSAGE))
        );
        assert_eq!(runtime.with_reset_lock(&uids(&["b"]), DELETE_BUSY_MESSAGE, async { 1 }).await, Ok(1));
        drop(writer);
        assert_eq!(runtime.with_reset_lock(&uids(&["a"]), DELETE_BUSY_MESSAGE, async { 2 }).await, Ok(2));
    }

    #[tokio::test]
    async fn remote_fetches_are_counted() {
        let runtime = SyncRuntime::new();
        let first = runtime.try_start_remote_day_fetch("a").unwrap();
        let second = runtime.try_start_remote_day_fetch("a").unwrap();
        drop(first);
        assert!(runtime.lock_free_writer_running(&uids(&["a"])));
        drop(second);
        assert!(!runtime.lock_free_writer_running(&ResetKeyboards::All));
    }

    #[tokio::test(start_paused = true)]
    async fn waits_for_the_holder_to_release_the_lock() {
        let runtime = SyncRuntime::new();
        let pass = runtime.try_claim_sync_lock(false).unwrap();
        let release = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(10)).await;
            drop(pass);
        });
        let started = Instant::now();
        let keyboards = uids(&["a"]);
        let answer = runtime.with_reset_lock_when_free(&keyboards, DELETE_BUSY_MESSAGE, async {
            runtime.reset_holds_keyboard("a")
        });
        assert_eq!(answer.await, Ok(true));
        assert_eq!(started.elapsed(), Duration::from_secs(10));
        release.await.unwrap();
        assert!(!runtime.is_syncing());
    }

    #[tokio::test(start_paused = true)]
    async fn gives_up_on_a_holder_after_30_seconds() {
        let runtime = SyncRuntime::new();
        let _pass = runtime.try_claim_sync_lock(false).unwrap();
        let started = Instant::now();
        let answer =
            runtime.with_reset_lock_when_free(&ResetKeyboards::All, RESET_BUSY_MESSAGE, async {}).await;
        assert_eq!(answer, Err(Busy(RESET_BUSY_MESSAGE)));
        assert_eq!(started.elapsed(), RESET_LOCK_WAIT);
    }

    #[tokio::test(start_paused = true)]
    async fn holds_the_keyboards_while_waiting_for_their_writers() {
        let runtime = SyncRuntime::new();
        let writer = runtime.try_start_remote_day_fetch("a").unwrap();
        let checker = runtime.clone();
        let end = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            // The reset holds "a" by now: no new writer of it starts.
            let blocked = checker.try_start_analytics_sync("a").is_none();
            drop(writer);
            blocked
        });
        let started = Instant::now();
        let answer = runtime.with_reset_lock_when_free(&uids(&["a"]), DELETE_BUSY_MESSAGE, async { 3 }).await;
        assert_eq!(answer, Ok(3));
        assert!(end.await.unwrap());
        assert!(started.elapsed() >= Duration::from_secs(5) && started.elapsed() < Duration::from_secs(6));
        assert!(!runtime.reset_holds_keyboard("a") && !runtime.is_syncing());
    }

    #[tokio::test(start_paused = true)]
    async fn releases_everything_when_a_writer_outlasts_the_wait() {
        let runtime = SyncRuntime::new();
        let _writer = runtime.try_start_analytics_sync("a").unwrap();
        let answer = runtime.with_reset_lock_when_free(&uids(&["a"]), DELETE_BUSY_MESSAGE, async {}).await;
        assert_eq!(answer, Err(Busy(DELETE_BUSY_MESSAGE)));
        assert!(!runtime.reset_holds_keyboard("a") && !runtime.is_syncing());
    }

    #[tokio::test]
    async fn a_cancelled_reset_releases_the_lock() {
        let runtime = SyncRuntime::new();
        let reset =
            runtime.with_reset_lock(&ResetKeyboards::All, RESET_BUSY_MESSAGE, std::future::pending::<()>());
        let polled = tokio::time::timeout(Duration::from_millis(10), reset).await;
        assert!(polled.is_err());
        assert!(!runtime.is_syncing() && !runtime.reset_holds_keyboard("a"));
    }
}
