// SPDX-License-Identifier: GPL-2.0-or-later
//! The SQLite cache on a thread of its own. Every database call is a job
//! sent to that thread, which runs them one at a time in the order they
//! were sent.
//!
//! The thread owns the only connection and ends, closing it, when the last
//! [`DbActor`] handle is dropped. A job that panics loses its answer but
//! not the thread: an open transaction is rolled back when the panic drops
//! it, and the next job runs.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::sync::mpsc;

use pipette_typing_analytics_db::TypingAnalyticsDb;

use crate::Error;

type Job = Box<dyn FnOnce(&mut TypingAnalyticsDb) + Send>;

/// A handle to the database thread. Cheap to clone; the clones share the
/// thread.
#[derive(Clone)]
pub struct DbActor {
    jobs: mpsc::Sender<Job>,
}

impl DbActor {
    /// Opens (creating it and its directory when missing) the database at
    /// `path` on a new thread, bringing its schema up to date, and returns
    /// once it is open.
    pub fn open(path: &Path) -> Result<Self, Error> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let path = path.to_path_buf();
        Self::spawn(move || TypingAnalyticsDb::open(&path))
    }

    /// An in-memory database, for tests.
    pub fn open_in_memory() -> Result<Self, Error> {
        Self::spawn(TypingAnalyticsDb::open_in_memory)
    }

    fn spawn(
        open: impl FnOnce() -> Result<TypingAnalyticsDb, pipette_typing_analytics_db::Error> + Send + 'static,
    ) -> Result<Self, Error> {
        let (jobs, queue) = mpsc::channel::<Job>();
        let (opened_tx, opened) = mpsc::sync_channel(1);
        std::thread::Builder::new().name("typing-analytics-db".into()).spawn(move || {
            let mut db = match open() {
                Ok(db) => db,
                Err(err) => {
                    let _ = opened_tx.send(Err(err));
                    return;
                }
            };
            let _ = opened_tx.send(Ok(()));
            for job in queue {
                // The job's own panic message is printed by the panic hook;
                // its caller sees the answer channel close.
                let _ = catch_unwind(AssertUnwindSafe(|| job(&mut db)));
            }
        })?;
        opened.recv().map_err(|_| Error::DbThreadGone)??;
        Ok(Self { jobs })
    }

    /// Runs `job` on the database thread after every job sent before it,
    /// and returns its answer.
    pub async fn call<T: Send + 'static>(
        &self,
        job: impl FnOnce(&mut TypingAnalyticsDb) -> T + Send + 'static,
    ) -> Result<T, Error> {
        let (answer, answered) = tokio::sync::oneshot::channel();
        self.send(Box::new(move |db| {
            let _ = answer.send(job(db));
        }))?;
        answered.await.map_err(|_| Error::DbThreadGone)
    }

    /// [`Self::call`] for a thread that may block; must not be called from
    /// an async task.
    pub fn call_blocking<T: Send + 'static>(
        &self,
        job: impl FnOnce(&mut TypingAnalyticsDb) -> T + Send + 'static,
    ) -> Result<T, Error> {
        let (answer, answered) = mpsc::sync_channel(1);
        self.send(Box::new(move |db| {
            let _ = answer.send(job(db));
        }))?;
        answered.recv().map_err(|_| Error::DbThreadGone)
    }

    fn send(&self, job: Job) -> Result<(), Error> {
        self.jobs.send(job).map_err(|_| Error::DbThreadGone)
    }
}

/// `local/typing-analytics.db` under the userData directory.
pub fn db_path(user_data: &Path) -> PathBuf {
    user_data.join("local").join("typing-analytics.db")
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    #[test]
    fn runs_jobs_in_order_on_one_thread() {
        let db = DbActor::open_in_memory().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let mut threads = Vec::new();
        for i in 0..20 {
            let seen = seen.clone();
            db.call_blocking(move |_| seen.lock().unwrap().push(i)).unwrap();
            threads.push(db.call_blocking(|_| std::thread::current().id()).unwrap());
        }
        assert_eq!(*seen.lock().unwrap(), (0..20).collect::<Vec<_>>());
        assert!(threads.windows(2).all(|w| w[0] == w[1]));
        assert_ne!(threads[0], std::thread::current().id());
    }

    #[tokio::test]
    async fn answers_async_callers() {
        let db = DbActor::open_in_memory().unwrap();
        let rebuild = db.call(|db| db.cache_needs_rebuild()).await.unwrap();
        assert!(!rebuild);
    }

    #[test]
    fn a_panicking_job_loses_only_its_answer() {
        let db = DbActor::open_in_memory().unwrap();
        let lost = db.call_blocking(|_| -> u8 { panic!("job failed") });
        assert!(matches!(lost, Err(Error::DbThreadGone)));
        assert_eq!(db.call_blocking(|_| 7).unwrap(), 7);
    }

    #[test]
    fn opens_a_file_and_its_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = db_path(dir.path());
        let db = DbActor::open(&path).unwrap();
        assert!(!db.call_blocking(|db| db.cache_needs_rebuild()).unwrap());
        assert!(path.exists());
    }

    #[test]
    fn an_open_failure_is_returned() {
        let dir = tempfile::tempdir().unwrap();
        // A directory where the file would be.
        let path = db_path(dir.path());
        std::fs::create_dir_all(&path).unwrap();
        assert!(matches!(DbActor::open(&path), Err(Error::Db(_))));
    }
}
