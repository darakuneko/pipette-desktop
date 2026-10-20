// SPDX-License-Identifier: GPL-2.0-or-later
//! Startup of the typing analytics, in this order: the machine hash, then the
//! database (its schema brought up to date), then the cache freshness check,
//! rebuilding it when the schema migration dropped tables or `sync_state.json`
//! asks for it.
//!
//! The commands wait for [`TypingAnalytics::ready`]. One initialization
//! runs at a time and every caller waiting for it gets its outcome; after
//! a failure the next call starts again. Each initialization that succeeds
//! runs the hook of [`TypingAnalytics::on_initialized`], which starts the
//! apply of this device's own deleted ranges without waiting for it.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use pipette_entry_store::Clock;
use tokio::sync::watch;

use crate::Error;
use crate::cache_rebuild::ensure_cache_is_fresh;
use crate::db_actor::{DbActor, db_path};
use crate::identity::{IdentityError, MachineIdentity};
use crate::sync_state::{TypingSyncState, load_sync_state, save_sync_state};

/// Rebuilds the cache from the JSONL masters through the database thread:
/// `(db, userData, ownHash)`. Called on a thread that may block.
pub type RebuildCache = Arc<dyn Fn(&DbActor, &Path, &str) -> Result<(), Error> + Send + Sync>;

/// Runs after each initialization that succeeds, on the thread that ran
/// it; it must not block.
pub type InitializedHook = Box<dyn Fn() + Send + Sync>;

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
    initialized: OnceLock<InitializedHook>,
    /// Held by [`TypingAnalytics::update_sync_state`].
    sync_state_writes: Mutex<()>,
}

impl TypingAnalytics {
    pub fn new(
        user_data: &Path,
        identity: MachineIdentity,
        clock: Arc<dyn Clock>,
        rebuild: RebuildCache,
    ) -> Self {
        Self {
            user_data: user_data.to_path_buf(),
            identity,
            clock,
            rebuild,
            init: Mutex::new(Init::Idle),
            initialized: OnceLock::new(),
            sync_state_writes: Mutex::new(()),
        }
    }

    /// Sets the hook run after each initialization that succeeds; a second
    /// hook is ignored.
    pub fn on_initialized(&self, hook: InitializedHook) {
        let _ = self.initialized.set(hook);
    }

    /// The userData directory the analytics read and write.
    pub fn user_data(&self) -> &Path {
        &self.user_data
    }

    /// The machine hash, without waiting for the initialization: the keymap
    /// snapshot handlers need the hash and nothing else. Blocks on file I/O
    /// the first time.
    pub fn machine_hash(&self) -> Result<String, IdentityError> {
        self.identity.machine_hash()
    }

    /// `Date.now()` of the analytics' clock.
    pub fn now_ms(&self) -> i64 {
        self.clock.now_ms()
    }

    /// The analytics' clock.
    pub fn clock(&self) -> &Arc<dyn Clock> {
        &self.clock
    }

    /// The read-modify-write of `sync_state.json` the sync layer does after
    /// an upload or a merge: reads the file (an empty state for `own_hash`
    /// when there is none or it cannot be read), lets `update` change it,
    /// and writes it when `update` answers true. One runs at a time, so two
    /// of them never write over each other's change. The flush does not
    /// take this lock: it writes the state it keeps in memory. Blocks.
    pub fn update_sync_state(
        &self,
        own_hash: &str,
        update: impl FnOnce(&mut TypingSyncState) -> bool,
    ) -> std::io::Result<()> {
        let _writing = self.sync_state_writes.lock().unwrap_or_else(PoisonError::into_inner);
        let mut state = load_sync_state(&self.user_data).unwrap_or_else(|| TypingSyncState::empty(own_hash));
        if update(&mut state) { save_sync_state(&self.user_data, &state) } else { Ok(()) }
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
                        if result.is_ok()
                            && let Some(hook) = this.initialized.get()
                        {
                            hook();
                        }
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
        // A migration that dropped tables is committed with the rebuild
        // that refills them and rolled back on any failure, so the drop
        // never reaches the file without the rebuild and stays due.
        let freshness =
            ensure_cache_is_fresh(&self.user_data, &machine_hash, force, self.clock.as_ref(), || {
                (self.rebuild)(&db, &self.user_data, &machine_hash)?;
                Ok(db.call_blocking(|db| db.commit_migration())??)
            });
        let freshness = match freshness {
            Ok(freshness) => freshness,
            Err(err) => {
                // Rolled back here, before a retry opens the file again;
                // the database thread closing the connection after `db` is
                // dropped would roll it back too, but later. A failed
                // rollback is left to that close.
                let _ = db.call_blocking(|db| db.rollback_migration());
                return Err(err);
            }
        };
        Ok(Ready { machine_hash, db, sync_state: Mutex::new(freshness.state) })
    }

    /// [`ensure_cache_is_fresh`], forced, on the initialized
    /// analytics: rebuilds the cache and writes a new `sync_state.json`.
    /// The state the flush keeps in memory is left as it is, so the next
    /// flush writes it back with its `last_synced_at`. Blocks; the queries
    /// and the flush go on between the days it replays.
    pub fn rebuild_now(&self, ready: &Ready) -> Result<(), Error> {
        ensure_cache_is_fresh(&self.user_data, &ready.machine_hash, true, self.clock.as_ref(), || {
            (self.rebuild)(&ready.db, &self.user_data, &ready.machine_hash)
        })
        .map(drop)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use pipette_entry_store::{FixedClock, SequenceIds};
    use pipette_sync_format::{MachineIdError, machine_hash};
    use pipette_typing_analytics_db::{SCHEMA_VERSION, TypingAnalyticsDb};

    use super::*;

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
    async fn a_migration_that_dropped_tables_stays_due_after_failed_rebuilds() {
        let dir = tempfile::tempdir().unwrap();
        let hash = machine_hash("m", ID);
        std::fs::create_dir_all(dir.path().join("local")).unwrap();
        std::fs::write(dir.path().join("local").join("installation-id"), format!("{ID}\n")).unwrap();
        let saved = TypingSyncState { last_synced_at: 5.0, ..TypingSyncState::empty(&hash) };
        save_sync_state(dir.path(), &saved).unwrap();
        // A database from before the v6 migration, which drops the rollups.
        drop(TypingAnalyticsDb::open(&db_path(dir.path())).unwrap());
        rusqlite::Connection::open(db_path(dir.path()))
            .unwrap()
            .execute("UPDATE typing_analytics_meta SET value = '5' WHERE key = 'schema_version'", [])
            .unwrap();
        let version = || -> String {
            rusqlite::Connection::open(db_path(dir.path()))
                .unwrap()
                .query_row("SELECT value FROM typing_analytics_meta WHERE key = 'schema_version'", [], |r| {
                    r.get(0)
                })
                .unwrap()
        };

        let rebuilds = Arc::new(AtomicUsize::new(0));
        let launch = |fail: bool| {
            let identity = MachineIdentity::new(
                dir.path(),
                Arc::new(SequenceIds::new([ID])),
                Box::new(|| Ok("m".into())),
            );
            let rebuilds = rebuilds.clone();
            let rebuild: RebuildCache = Arc::new(move |_, _, _| {
                rebuilds.fetch_add(1, Ordering::SeqCst);
                if fail { Err(Error::CacheRebuild("no".into())) } else { Ok(()) }
            });
            Arc::new(TypingAnalytics::new(dir.path(), identity, Arc::new(FixedClock::new(9)), rebuild))
        };

        // A failed rebuild is retried in the same run and at the next launch.
        let ta = launch(true);
        assert!(matches!(ta.ready().await.err().as_deref(), Some(Error::CacheRebuild(_))));
        assert!(matches!(ta.ready().await.err().as_deref(), Some(Error::CacheRebuild(_))));
        assert_eq!(rebuilds.load(Ordering::SeqCst), 2);
        drop(ta);
        assert_eq!(version(), "5");
        assert_eq!(load_sync_state(dir.path()).unwrap(), saved);

        let ready = launch(false).ready().await.unwrap();
        assert_eq!(rebuilds.load(Ordering::SeqCst), 3);
        assert_eq!(*ready.sync_state.lock().unwrap(), TypingSyncState { last_synced_at: 9.0, ..saved });
        drop(ready);
        assert_eq!(version(), SCHEMA_VERSION.to_string());

        launch(false).ready().await.unwrap();
        assert_eq!(rebuilds.load(Ordering::SeqCst), 3);
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

    #[test]
    fn updates_of_the_sync_state_run_one_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        let ta = analytics(dir.path(), || Ok("m".into()), Arc::new(AtomicUsize::new(0)));
        // Each update adds one to what it reads.
        let add = |state: &mut TypingSyncState| {
            state.last_synced_at += 1.0;
            true
        };
        let (entered, first_inside) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let (ta, entered_too) = (&*ta, entered.clone());
        std::thread::scope(|scope| {
            let first = scope.spawn(move || {
                ta.update_sync_state("h", |state| {
                    entered.send("first").unwrap();
                    released.recv().unwrap();
                    add(state)
                })
            });
            assert_eq!(first_inside.recv().unwrap(), "first");
            let second = scope.spawn(move || {
                ta.update_sync_state("h", |state| {
                    entered_too.send("second").unwrap();
                    add(state)
                })
            });
            // The second waits for the first to write; it reads that write.
            assert!(first_inside.recv_timeout(std::time::Duration::from_millis(100)).is_err());
            release.send(()).unwrap();
            first.join().unwrap().unwrap();
            second.join().unwrap().unwrap();
        });
        assert_eq!(load_sync_state(dir.path()).unwrap().last_synced_at, 2.0);
    }
}
