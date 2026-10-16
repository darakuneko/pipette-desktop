// SPDX-License-Identifier: GPL-2.0-or-later
//! Startup of the typing analytics (`setupTypingAnalytics`,
//! src/main/typing-analytics/typing-analytics-service.ts), in the same
//! order: the machine hash, then the database (its schema brought up to
//! date), then the cache freshness check, rebuilding it when the schema
//! migration dropped tables or `sync_state.json` asks for it.
//!
//! The commands wait for [`TypingAnalytics::ready`]. One initialization
//! runs at a time and every caller waiting for it gets its outcome; after
//! a failure the next call starts again.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use pipette_entry_store::Clock;
use pipette_typing_analytics_db::TypingAnalyticsDb;
use tokio::sync::watch;

use crate::Error;
use crate::cache_rebuild::ensure_cache_is_fresh;
use crate::db_actor::{DbActor, db_path};
use crate::identity::MachineIdentity;
use crate::sync_state::TypingSyncState;

/// Rebuilds the cache from the JSONL masters on the database thread:
/// `(db, userData, ownHash)`.
pub type RebuildCache = Arc<dyn Fn(&mut TypingAnalyticsDb, &Path, &str) -> Result<(), Error> + Send + Sync>;

/// What a finished initialization holds.
pub struct Ready {
    pub machine_hash: String,
    pub db: DbActor,
    /// The state the freshness check read or wrote; the flush and the sync
    /// pass keep it up to date.
    pub sync_state: Mutex<TypingSyncState>,
}

/// The outcome every waiter of one initialization gets.
type Outcome = Result<Arc<Ready>, Arc<Error>>;

enum Init {
    Idle,
    Running(watch::Receiver<Option<Outcome>>),
    Ready(Arc<Ready>),
}

pub struct TypingAnalytics {
    user_data: PathBuf,
    identity: MachineIdentity,
    clock: Arc<dyn Clock>,
    rebuild: RebuildCache,
    init: Mutex<Init>,
}

impl TypingAnalytics {
    pub fn new(
        user_data: &Path,
        identity: MachineIdentity,
        clock: Arc<dyn Clock>,
        rebuild: RebuildCache,
    ) -> Self {
        Self { user_data: user_data.to_path_buf(), identity, clock, rebuild, init: Mutex::new(Init::Idle) }
    }

    fn lock(&self) -> MutexGuard<'_, Init> {
        self.init.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The initialized analytics, starting the initialization when none has
    /// finished or is running. It runs on a blocking thread, so dropping
    /// this future does not stop it.
    pub async fn ready(self: &Arc<Self>) -> Result<Arc<Ready>, Arc<Error>> {
        let mut outcome = {
            let mut init = self.lock();
            match &*init {
                Init::Ready(ready) => return Ok(ready.clone()),
                Init::Running(outcome) => outcome.clone(),
                Init::Idle => {
                    let (finish, outcome) = watch::channel(None);
                    *init = Init::Running(outcome.clone());
                    let this = self.clone();
                    tokio::task::spawn_blocking(move || {
                        let result = catch_unwind(AssertUnwindSafe(|| this.initialize()))
                            .unwrap_or(Err(Error::InitializationLost))
                            .map(Arc::new)
                            .map_err(Arc::new);
                        *this.lock() = match &result {
                            Ok(ready) => Init::Ready(ready.clone()),
                            Err(_) => Init::Idle,
                        };
                        finish.send_replace(Some(result));
                    });
                    outcome
                }
            }
        };
        let finished =
            outcome.wait_for(Option::is_some).await.map_err(|_| Arc::new(Error::InitializationLost))?;
        finished.clone().unwrap_or_else(|| Err(Arc::new(Error::InitializationLost)))
    }

    fn initialize(&self) -> Result<Ready, Error> {
        let machine_hash = self.identity.machine_hash()?;
        let db = DbActor::open(&db_path(&self.user_data))?;
        let force = db.call_blocking(|db| db.cache_needs_rebuild())?;
        let freshness =
            ensure_cache_is_fresh(&self.user_data, &machine_hash, force, self.clock.as_ref(), || {
                let (rebuild, user_data, hash) =
                    (self.rebuild.clone(), self.user_data.clone(), machine_hash.clone());
                db.call_blocking(move |db| rebuild(db, &user_data, &hash))?
            })?;
        Ok(Ready { machine_hash, db, sync_state: Mutex::new(freshness.state) })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use pipette_entry_store::{FixedClock, SequenceIds};
    use pipette_sync_format::{MachineIdError, machine_hash};

    use super::*;
    use crate::sync_state::{load_sync_state, save_sync_state};

    const ID: &str = "0f1e2d3c-4b5a-4697-8877-665544332211";

    fn analytics(
        dir: &Path,
        machine_id: impl Fn() -> Result<String, MachineIdError> + Send + Sync + 'static,
        rebuilds: Arc<AtomicUsize>,
    ) -> Arc<TypingAnalytics> {
        let identity = MachineIdentity::new(dir, Arc::new(SequenceIds::new([ID])), Box::new(machine_id));
        let rebuild: RebuildCache = Arc::new(move |_, _, _| {
            rebuilds.fetch_add(1, Ordering::SeqCst);
            Ok(())
        });
        Arc::new(TypingAnalytics::new(dir, identity, Arc::new(FixedClock::new(9)), rebuild))
    }

    #[tokio::test]
    async fn initializes_once_for_every_waiter() {
        let dir = tempfile::tempdir().unwrap();
        let rebuilds = Arc::new(AtomicUsize::new(0));
        let ta = analytics(dir.path(), || Ok("m".into()), rebuilds.clone());
        let (a, b) = tokio::join!(ta.ready(), ta.ready());
        let (a, b) = (a.unwrap(), b.unwrap());
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(a.machine_hash, machine_hash("m", ID));
        assert_eq!(rebuilds.load(Ordering::SeqCst), 1);
        let state = load_sync_state(dir.path()).unwrap();
        assert_eq!(state, TypingSyncState { last_synced_at: 9.0, ..TypingSyncState::empty(&a.machine_hash) });
        assert_eq!(*a.sync_state.lock().unwrap(), state);
        assert!(Arc::ptr_eq(&ta.ready().await.unwrap(), &a));
    }

    #[tokio::test]
    async fn a_fresh_cache_is_not_rebuilt() {
        let dir = tempfile::tempdir().unwrap();
        let hash = machine_hash("m", ID);
        std::fs::create_dir_all(dir.path().join("local")).unwrap();
        std::fs::write(dir.path().join("local").join("installation-id"), format!("{ID}\n")).unwrap();
        let saved = TypingSyncState { last_synced_at: 5.0, ..TypingSyncState::empty(&hash) };
        save_sync_state(dir.path(), &saved).unwrap();
        let rebuilds = Arc::new(AtomicUsize::new(0));
        let ready = analytics(dir.path(), || Ok("m".into()), rebuilds.clone()).ready().await.unwrap();
        assert_eq!(rebuilds.load(Ordering::SeqCst), 0);
        assert_eq!(*ready.sync_state.lock().unwrap(), saved);
    }

    #[tokio::test]
    async fn a_failure_reaches_every_waiter_and_the_next_call_retries() {
        let dir = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let ta = analytics(
            dir.path(),
            move || match counted.fetch_add(1, Ordering::SeqCst) {
                0 => Err(MachineIdError::NotFound),
                _ => Ok("m".into()),
            },
            Arc::new(AtomicUsize::new(0)),
        );
        let (a, b) = tokio::join!(ta.ready(), ta.ready());
        assert!(matches!(a.err().as_deref(), Some(Error::Identity(_))));
        assert!(matches!(b.err().as_deref(), Some(Error::Identity(_))));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(ta.ready().await.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
