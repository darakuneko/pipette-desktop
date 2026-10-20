// SPDX-License-Identifier: GPL-2.0-or-later
//! The operations of the Data modal on the typing data, and the ones the
//! sync layer and the startup run on it: deleting local days
//! (day_delete.rs), deleting everything of a keyboard (retention.rs),
//! deleting another device's data (device_delete.rs), applying this
//! device's own deleted ranges (deleted_ranges/apply.rs), the export and
//! the import (import_export.rs), and the cache rebuild.
//!
//! None of them takes the sync lock: the commands hold it. What writes this
//! device's own day files runs on the recorder's flush chain, the one writer of
//! those files.

use std::future::Future;
use std::io;
use std::path::Path;
use std::sync::Arc;

use pipette_entry_store::{IdGen, WriteLocks};
use tokio::sync::oneshot;

use crate::Error;
use crate::pipeline::Recorder;
use crate::service::TypingAnalytics;

/// Removes a file (`unlink`).
pub type RemoveFile = Arc<dyn Fn(&Path) -> io::Result<()> + Send + Sync>;

pub struct DataOps {
    recorder: Arc<Recorder>,
    locks: Arc<WriteLocks>,
    ids: Arc<dyn IdGen>,
    remove_file: RemoveFile,
}

impl DataOps {
    /// The operations on the data of `recorder`'s analytics. `locks` must be
    /// the write locks of the process (the deleted-ranges files are written
    /// under the lock of their sync unit); `ids` gives the ids of new
    /// deleted ranges (`randomUUID`).
    pub fn new(recorder: Arc<Recorder>, locks: Arc<WriteLocks>, ids: Arc<dyn IdGen>) -> Self {
        Self { recorder, locks, ids, remove_file: Arc::new(|path| std::fs::remove_file(path)) }
    }

    /// The operations with `remove_file` in place of `std::fs::remove_file`,
    /// for tests that make a removal fail.
    #[doc(hidden)]
    #[must_use]
    pub fn with_remove_file(mut self, remove_file: RemoveFile) -> Self {
        self.remove_file = remove_file;
        self
    }

    pub fn recorder(&self) -> &Arc<Recorder> {
        &self.recorder
    }

    pub fn analytics(&self) -> &Arc<TypingAnalytics> {
        self.recorder.analytics()
    }

    pub(crate) fn locks(&self) -> &Arc<WriteLocks> {
        &self.locks
    }

    pub(crate) fn new_id(&self) -> String {
        self.ids.new_id()
    }

    pub(crate) fn remove_file(&self) -> &RemoveFile {
        &self.remove_file
    }

    /// The machine hash, read on a blocking thread (file I/O the first
    /// time).
    pub(crate) async fn machine_hash(&self) -> Result<String, Error> {
        let analytics = self.analytics().clone();
        blocking(move || analytics.machine_hash()).await
    }

    /// `runOnFlushChain` for a task with an answer: runs `task` behind
    /// everything already on the chain and returns what it returned.
    pub(crate) async fn on_chain<T: Send + 'static>(
        &self,
        task: impl Future<Output = Result<T, Error>> + Send + 'static,
    ) -> Result<T, Error> {
        let (answer, answered) = oneshot::channel();
        drop(self.recorder.run_on_flush_chain(async move {
            let _ = answer.send(task.await);
        }));
        answered.await.map_err(|_| Error::ChainTaskLost)?
    }
}

/// Runs `work` on a blocking-task thread.
pub(crate) async fn blocking<T: Send + 'static, E>(
    work: impl FnOnce() -> Result<T, E> + Send + 'static,
) -> Result<T, Error>
where
    E: Send + 'static,
    Error: From<E>,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|err| Error::Blocking(err.to_string()))?
        .map_err(Error::from)
}
