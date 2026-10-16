// SPDX-License-Identifier: GPL-2.0-or-later
//! [`DriveClient`]: the Drive operations the sync calls
//! (src/main/sync/google-drive.ts and `moveFilesToTrash` of
//! drive-trash.ts), each attempt through a [`DriveApi`] with the retries of
//! [`crate::retry`].

use std::sync::Arc;

use futures_util::StreamExt;
use futures_util::stream;

use crate::retry::{DriveFailure, RetryEnv, RetryPolicy, drive_request, drive_request_or_not_found};
use crate::trash_names::trash_file_name;
use crate::{DriveApi, DriveFile, ListQuery, UploadedFile};

/// The page size of a listing: Drive's largest.
const PAGE_SIZE: u32 = 1000;
/// How many deletes or renames of a bulk operation are sent at a time.
const BULK_CONCURRENCY: usize = 5;

const fn policy(label: &'static str, retry_transient: bool) -> RetryPolicy {
    RetryPolicy { label, retry_transient }
}

const LIST: RetryPolicy = policy("list", true);
const DOWNLOAD: RetryPolicy = policy("download", true);
/// After a 5xx or a request without an answer the file may already have
/// been created, and sending the create again would leave two files with
/// the same name; only rate limits, which Drive refuses before doing any
/// work, are retried.
const UPLOAD: RetryPolicy = policy("upload", false);
const UPDATE: RetryPolicy = policy("update", true);
/// Renaming to the same name again changes nothing, so it is retried.
const RENAME: RetryPolicy = policy("rename", true);
const DELETE: RetryPolicy = policy("delete", true);

/// The outcome of a bulk delete or rename (`DeleteMatchingFilesResult`):
/// `attempted` files, of which `failed` failed. `first_error` is the error
/// of the first failed file in the order the files were given, not the
/// first to fail in time (`moveFilesToTrash` of drive-trash.ts keeps the
/// one that completes first); it is only shown as a message.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BulkOutcome {
    pub attempted: usize,
    pub failed: usize,
    pub first_error: Option<String>,
}

impl BulkOutcome {
    fn from_results(attempted: usize, failures: impl IntoIterator<Item = String>) -> Self {
        let failures: Vec<String> = failures.into_iter().collect();
        Self { attempted, failed: failures.len(), first_error: failures.into_iter().next() }
    }
}

/// The Drive operations of the sync, with their retries.
#[derive(Clone)]
pub struct DriveClient {
    drive: Arc<dyn DriveApi>,
    env: Arc<dyn RetryEnv>,
}

impl DriveClient {
    pub fn new(drive: Arc<dyn DriveApi>, env: Arc<dyn RetryEnv>) -> Self {
        Self { drive, env }
    }

    /// Every file in `appDataFolder` whose name contains `name_contains`
    /// (every file for `None` or an empty text), following the pages until
    /// Drive stops giving a next one.
    pub async fn list_files(&self, name_contains: Option<&str>) -> Result<Vec<DriveFile>, DriveFailure> {
        let name_contains = name_contains.filter(|part| !part.is_empty()).map(str::to_owned);
        let mut files = Vec::new();
        let mut page_token = None;
        loop {
            let query = ListQuery { name_contains: name_contains.clone(), page_token, page_size: PAGE_SIZE };
            let page = drive_request(&*self.env, LIST, || self.drive.list_page(query.clone())).await?;
            files.extend(page.files);
            page_token = page.next_page_token;
            if page_token.is_none() {
                return Ok(files);
            }
        }
    }

    /// The content of a file, unparsed (`downloadRawFile`).
    pub async fn download(&self, id: &str) -> Result<Vec<u8>, DriveFailure> {
        drive_request(&*self.env, DOWNLOAD, || self.drive.download(id.to_owned())).await
    }

    /// Updates `existing_id` with `content`, or creates `name` when no id
    /// is given or, with `create_if_missing`, when that id no longer exists
    /// (an id remembered from an earlier create rather than taken from a
    /// listing). The answer is the file written and its new modifiedTime.
    pub async fn upload_file(
        &self,
        name: &str,
        content: &str,
        existing_id: Option<&str>,
        create_if_missing: bool,
    ) -> Result<UploadedFile, DriveFailure> {
        if let Some(id) = existing_id.filter(|id| !id.is_empty()) {
            let update = || self.drive.update(id.to_owned(), content.to_owned());
            if !create_if_missing {
                return drive_request(&*self.env, UPDATE, update).await;
            }
            if let Some(file) = drive_request_or_not_found(&*self.env, UPDATE, update).await? {
                return Ok(file);
            }
        }
        drive_request(&*self.env, UPLOAD, || self.drive.create(name.to_owned(), content.to_owned())).await
    }

    /// Creates `name` with `content` as it is (no envelope) and answers its
    /// id (`createRawFile`).
    pub async fn create_raw_file(&self, name: &str, content: &str) -> Result<String, DriveFailure> {
        drive_request(&*self.env, UPLOAD, || self.drive.create_raw(name.to_owned(), content.to_owned())).await
    }

    /// Renames a file without touching its content; `None` when it no
    /// longer exists.
    pub async fn rename_file(&self, id: &str, name: &str) -> Result<Option<DriveFile>, DriveFailure> {
        drive_request_or_not_found(&*self.env, RENAME, || self.drive.rename(id.to_owned(), name.to_owned()))
            .await
    }

    /// Deletes a file; one already gone is what a delete wants.
    pub async fn delete_file(&self, id: &str) -> Result<(), DriveFailure> {
        drive_request_or_not_found(&*self.env, DELETE, || self.drive.delete(id.to_owned())).await.map(|_| ())
    }

    /// Deletes every file of `ids`, 5 at a time. A failed delete does not
    /// stop the others; each is logged.
    pub async fn delete_files_by_id(&self, ids: &[String]) -> BulkOutcome {
        // The requests are made before the stream runs: a closure the
        // stream held across its awaits would keep the caller's future from
        // being `Send` for every lifetime (a command's future must be).
        let deletes: Vec<_> = ids.iter().map(|id| self.delete_file(id)).collect();
        let results: Vec<Result<(), DriveFailure>> =
            stream::iter(deletes).buffered(BULK_CONCURRENCY).collect().await;
        let failures = ids.iter().zip(results).filter_map(|(id, result)| {
            let err = result.err()?;
            log::warn!("[google-drive] delete of {id} failed: {err}");
            Some(err.to_string())
        });
        BulkOutcome::from_results(ids.len(), failures)
    }

    /// Deletes every file whose name starts with `prefix`; a trash file
    /// starts with its original name, so it goes too. A failed listing is
    /// the error.
    pub async fn delete_files_by_prefix(&self, prefix: &str) -> Result<BulkOutcome, DriveFailure> {
        let files = self.list_files(None).await?;
        let ids: Vec<String> =
            files.into_iter().filter(|file| file.name.starts_with(prefix)).map(|file| file.id).collect();
        Ok(self.delete_files_by_id(&ids).await)
    }

    /// Renames each of `files` to its trash name for `now_ms`, 5 at a time.
    /// A file whose id a trash name cannot carry is left alone and not
    /// counted; one already gone counts as moved. `forget_created` gets the
    /// id of each file before its rename, so the caller drops it from the
    /// ids it created (`createdFileIds`) and a later upload of the name does
    /// not write into the trash file. A failed rename does not stop the
    /// others; each is logged.
    pub async fn move_files_to_trash(
        &self,
        files: &[DriveFile],
        now_ms: i64,
        forget_created: &(dyn Fn(&str) + Sync),
    ) -> BulkOutcome {
        let moves: Vec<(&str, String)> = files
            .iter()
            .filter_map(|file| Some((file.id.as_str(), trash_file_name(file, now_ms)?)))
            .collect();
        // Made before the stream runs, as in `delete_files_by_id`; each id
        // is still forgotten before its rename is sent.
        let renames: Vec<_> = moves
            .iter()
            .map(|(id, name)| async move {
                forget_created(id);
                self.rename_file(id, name).await
            })
            .collect();
        let results: Vec<Result<Option<DriveFile>, DriveFailure>> =
            stream::iter(renames).buffered(BULK_CONCURRENCY).collect().await;
        let failures = moves.iter().zip(results).filter_map(|((id, _), result)| {
            let err = result.err()?;
            log::warn!("[drive-trash] rename of {id} failed: {err}");
            Some(err.to_string())
        });
        BulkOutcome::from_results(moves.len(), failures)
    }
}
