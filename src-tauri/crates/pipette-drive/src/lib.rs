// SPDX-License-Identifier: GPL-2.0-or-later
//! The Google Drive v3 client of the sync on `appDataFolder`:
//!
//! - [`DriveApi`]: one attempt of each operation (a listing page, a
//!   download, the two creates, a content update, a rename and a delete).
//!   A failed attempt is a [`DriveError`] with what the retries need: the
//!   status, the start of the body and `Retry-After`. [`http::HttpDrive`]
//!   sends the requests over HTTP;
//! - [`retry`]: the retries around each attempt;
//! - [`client::DriveClient`]: the operations the sync calls, with their
//!   retries, the 404s they accept and the bulk deletes and renames;
//! - [`canonical`]: the copy every lookup by name uses when Drive lists
//!   several files with the same name;
//! - [`trash_names`]: the names copies are renamed to instead of being
//!   deleted.
//!
//! With the `test-util` feature, [`fake::InMemoryDrive`] is a Drive in
//! memory. Every Rust test of the sync runs on it; the Node fake Drive
//! (scripts/fake-drive/server.ts) passes the same conformance cases
//! (scripts/fake-drive/conformance-cases.json).

pub mod canonical;
pub mod client;
#[cfg(feature = "test-util")]
pub mod fake;
pub mod http;
pub mod retry;
pub mod trash_names;

use std::future::Future;
use std::pin::Pin;

/// A file as a listing shows it (`DriveFile`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    /// RFC 3339, as Drive writes it.
    pub modified_time: String,
    /// When Drive created the file; absent when the response leaves it out.
    pub created_time: Option<String>,
}

/// One listing request (`listFiles` asks for every page in turn).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListQuery {
    /// The `name contains '…'` filter. Drive matches a prefix of the name
    /// or of a word in it, never the middle of a word, so callers send a
    /// prefix of the name.
    pub name_contains: Option<String>,
    pub page_token: Option<String>,
    pub page_size: u32,
}

/// One page of a listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileList {
    pub files: Vec<DriveFile>,
    /// The token of the next page; `None` on the last one.
    pub next_page_token: Option<String>,
}

/// The revision an upload wrote (`UploadedFile`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadedFile {
    pub id: String,
    pub modified_time: String,
}

/// Why an attempt failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DriveError {
    /// Drive answered with a status other than 2xx.
    #[error("{status} {body}")]
    Status {
        status: u16,
        /// The start of the response body.
        body: String,
        retry_after: Option<String>,
    },
    /// No answer: the connection, a timeout, a refused destination.
    #[error("{0}")]
    Network(String),
    /// A request that fails the same way each time it is sent: the answer
    /// is larger than the client accepts, or the client refused the
    /// destination. Never retried.
    #[error("{0}")]
    Rejected(String),
    /// A 2xx answer whose body is not what the operation returns.
    #[error("unexpected Drive response: {0}")]
    BadResponse(String),
    /// No access token for the request: not signed in, or the token could
    /// not be had. Never retried.
    #[error("{0}")]
    Auth(String),
}

impl DriveError {
    /// The status of a [`DriveError::Status`].
    pub fn status(&self) -> Option<u16> {
        match self {
            DriveError::Status { status, .. } => Some(*status),
            _ => None,
        }
    }
}

pub type DriveFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, DriveError>> + Send + 'a>>;

/// One attempt of each Drive operation on `appDataFolder`. The retries,
/// the access token and the acceptance of a 404 are the caller's.
pub trait DriveApi: Send + Sync {
    /// One page of the files whose names contain `name_contains`.
    fn list_page(&self, query: ListQuery) -> DriveFuture<'_, FileList>;
    /// The content of a file (`alt=media`).
    fn download(&self, id: String) -> DriveFuture<'_, Vec<u8>>;
    /// Creates a file with `content` (the multipart create of
    /// `uploadFile`) and returns the revision it wrote.
    fn create(&self, name: String, content: String) -> DriveFuture<'_, UploadedFile>;
    /// Creates a file with `content` and returns only its id
    /// (`createRawFile`).
    fn create_raw(&self, name: String, content: String) -> DriveFuture<'_, String>;
    /// Replaces the content of a file and returns the revision it wrote.
    fn update(&self, id: String, content: String) -> DriveFuture<'_, UploadedFile>;
    /// Renames a file; the content is not touched.
    fn rename(&self, id: String, name: String) -> DriveFuture<'_, DriveFile>;
    fn delete(&self, id: String) -> DriveFuture<'_, ()>;
}
