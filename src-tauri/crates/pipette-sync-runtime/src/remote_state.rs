// SPDX-License-Identifier: GPL-2.0-or-later
//! What this machine knows about the files on Drive
//! (`lastKnownRemoteState` and `createdFileIds` of
//! src/main/sync/sync-runtime-state.ts). Memory only.
//!
//! The handled revisions are never cleared, not even when the account
//! changes: a revision is the file id with its `modifiedTime`, and another
//! account's files have other ids, so none of them looks handled. The ids
//! of created files are cleared when the account changes or signs out.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

/// One revision of a Drive file: which file and when it was written. The
/// id is part of it because Drive can list several files with one name:
/// when another copy becomes the chosen one, even with the same
/// `modifiedTime`, it is a change.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteRevision {
    pub id: String,
    pub modified_time: String,
}

#[derive(Default)]
pub struct RemoteMemory {
    /// Drive file name → the revision this machine last handled.
    handled: Mutex<HashMap<String, RemoteRevision>>,
    /// Drive file name → id of each data file an upload of this run
    /// created, so a pass whose listing was taken before that create
    /// updates the file instead of creating a second one with the name.
    created: Mutex<HashMap<String, String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl RemoteMemory {
    /// `recordRemoteState`: marks `revision` as the one handled for
    /// `name`. Other names are left alone, so a file nobody handled still
    /// looks changed to the next poll.
    pub fn record(&self, name: &str, revision: RemoteRevision) {
        lock(&self.handled).insert(name.to_owned(), revision);
    }

    /// `forgetRemoteState`: the next pass downloads `name` again even when
    /// Drive has not changed it.
    pub fn forget(&self, name: &str) {
        lock(&self.handled).remove(name);
    }

    /// `isKnownRemoteRevision`: whether the file `id` of `name` with
    /// `modified_time` is the revision last handled.
    pub fn is_known(&self, name: &str, id: &str, modified_time: &str) -> bool {
        lock(&self.handled)
            .get(name)
            .is_some_and(|known| known.id == id && known.modified_time == modified_time)
    }

    /// The id of the file an upload of this run created for `name`.
    pub fn created_file_id(&self, name: &str) -> Option<String> {
        lock(&self.created).get(name).cloned()
    }

    pub fn remember_created_file(&self, name: &str, id: &str) {
        lock(&self.created).insert(name.to_owned(), id.to_owned());
    }

    /// Forgets every name whose created file is `id` (the file was renamed
    /// away), so a later upload of the name does not write to it.
    pub fn forget_created_file_id(&self, id: &str) {
        lock(&self.created).retain(|_, created| created != id);
    }

    /// For a change of account or a sign-out.
    pub fn clear_created_files(&self) {
        lock(&self.created).clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn revision(id: &str, modified_time: &str) -> RemoteRevision {
        RemoteRevision { id: id.to_owned(), modified_time: modified_time.to_owned() }
    }

    #[test]
    fn a_revision_is_known_by_its_id_and_modified_time() {
        let memory = RemoteMemory::default();
        assert!(!memory.is_known("a.enc", "1", "t1"));
        memory.record("a.enc", revision("1", "t1"));
        memory.record("b.enc", revision("2", "t1"));
        assert!(memory.is_known("a.enc", "1", "t1"));
        assert!(!memory.is_known("a.enc", "1", "t2"));
        assert!(!memory.is_known("a.enc", "3", "t1"));
        memory.forget("a.enc");
        assert!(!memory.is_known("a.enc", "1", "t1"));
        assert!(memory.is_known("b.enc", "2", "t1"));
    }

    #[test]
    fn created_files_are_forgotten_by_id_or_all_at_once() {
        let memory = RemoteMemory::default();
        memory.remember_created_file("a.enc", "1");
        memory.remember_created_file("b.enc", "2");
        memory.remember_created_file("c.enc", "1");
        memory.forget_created_file_id("1");
        assert_eq!(memory.created_file_id("a.enc"), None);
        assert_eq!(memory.created_file_id("c.enc"), None);
        assert_eq!(memory.created_file_id("b.enc").as_deref(), Some("2"));
        memory.record("b.enc", revision("2", "t"));
        memory.clear_created_files();
        assert_eq!(memory.created_file_id("b.enc"), None);
        // The handled revisions stay.
        assert!(memory.is_known("b.enc", "2", "t"));
    }
}
