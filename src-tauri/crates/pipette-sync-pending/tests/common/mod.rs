// SPDX-License-Identifier: GPL-2.0-or-later
//! A store on a temporary userData directory, with writes that run only when
//! a test lets the delay pass and a recorded status listener.

#![allow(dead_code, clippy::unwrap_used)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pipette_sync_pending::{PENDING_WRITE_DELAY, PendingStore, Scheduler};
use tempfile::TempDir;

type Task = Box<dyn FnOnce() + Send>;

/// Keeps the scheduled writes until [`ManualScheduler::advance`].
#[derive(Default)]
pub struct ManualScheduler {
    tasks: Mutex<Vec<Task>>,
    scheduled: Mutex<usize>,
}

impl Scheduler for ManualScheduler {
    fn schedule(&self, delay: Duration, task: Task) {
        assert_eq!(delay, PENDING_WRITE_DELAY);
        self.tasks.lock().unwrap().push(task);
        *self.scheduled.lock().unwrap() += 1;
    }
}

impl ManualScheduler {
    /// Lets the write delay pass: runs every task scheduled so far.
    pub fn advance(&self) {
        let tasks = std::mem::take(&mut *self.tasks.lock().unwrap());
        for task in tasks {
            task();
        }
    }

    /// How many tasks are waiting.
    pub fn waiting(&self) -> usize {
        self.tasks.lock().unwrap().len()
    }

    /// How many tasks were ever scheduled.
    pub fn scheduled(&self) -> usize {
        *self.scheduled.lock().unwrap()
    }
}

pub struct Harness {
    pub dir: TempDir,
    pub scheduler: Arc<ManualScheduler>,
    pub statuses: Arc<Mutex<Vec<bool>>>,
}

impl Harness {
    pub fn new() -> Self {
        Self { dir: TempDir::new().unwrap(), scheduler: Arc::default(), statuses: Arc::default() }
    }

    pub fn user_data(&self) -> &Path {
        self.dir.path()
    }

    pub fn pending_path(&self) -> PathBuf {
        self.user_data().join("local").join("sync-pending.json")
    }

    /// Restores a store from the userData directory, as a launch does.
    pub fn restore(&self) -> PendingStore {
        let statuses = Arc::clone(&self.statuses);
        PendingStore::restore(
            self.user_data(),
            Arc::clone(&self.scheduler) as Arc<dyn Scheduler>,
            Box::new(move |pending| statuses.lock().unwrap().push(pending)),
        )
    }

    /// Restores and lets the write-back run.
    pub fn launch(&self) -> PendingStore {
        let store = self.restore();
        self.scheduler.advance();
        store
    }

    pub fn write_file(&self, content: &str) {
        std::fs::create_dir_all(self.pending_path().parent().unwrap()).unwrap();
        std::fs::write(self.pending_path(), content).unwrap();
    }

    pub fn read_file(&self) -> String {
        std::fs::read_to_string(self.pending_path()).unwrap()
    }

    /// The file parsed, for comparing its content regardless of formatting.
    pub fn read_json(&self) -> serde_json::Value {
        serde_json::from_str(&self.read_file()).unwrap()
    }

    pub fn add_keyboard_dir(&self, uid: &str) {
        std::fs::create_dir_all(self.user_data().join("sync").join("keyboards").join(uid)).unwrap();
    }
}
