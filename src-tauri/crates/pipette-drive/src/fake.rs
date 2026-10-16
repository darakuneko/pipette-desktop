// SPDX-License-Identifier: GPL-2.0-or-later
//! A Drive in memory, for the tests of the sync. It behaves as the Node
//! fake Drive (scripts/fake-drive/server.ts) does; both pass the
//! conformance cases of scripts/fake-drive/conformance-cases.json:
//!
//! - files are listed in the order they were created; `name_contains` is a
//!   substring match; a page holds up to `page_size` files (1 to 1000);
//! - ids are `fake-1`, `fake-2`, …;
//! - every write (create, update, rename) moves the clock one second on
//!   from 2026-01-01T00:00:00.000Z and stamps the file with it, so each
//!   write has a later `modifiedTime` than the one before. A rename counts
//!   as a write: real Drive may or may not move `modifiedTime` on a
//!   rename, and the sync must work either way;
//! - an unknown id is 404; [`InMemoryDrive::inject`] makes the next
//!   requests fail with a status of the test's choosing.

use std::collections::VecDeque;
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::{DriveApi, DriveError, DriveFile, DriveFuture, FileList, ListQuery, UploadedFile};

/// 2026-01-01T00:00:00.000Z.
const CLOCK_START_MS: i64 = 1_767_225_600_000;
const CLOCK_STEP_MS: i64 = 1000;
const MAX_PAGE_SIZE: u32 = 1000;

/// The operations, for [`Fault::only`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriveOp {
    List,
    Download,
    Create,
    Update,
    Rename,
    Delete,
}

/// A failure the next requests get instead of their answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fault {
    pub status: u16,
    pub retry_after: Option<String>,
    pub body: String,
    /// How many requests fail.
    pub count: u32,
    /// Only requests of this operation fail; `None` for any.
    pub only: Option<DriveOp>,
}

impl Fault {
    /// Drive's answer to too many requests: 429 with the
    /// `rateLimitExceeded` reason.
    pub fn rate_limit(retry_after: Option<&str>) -> Self {
        Self {
            status: 429,
            retry_after: retry_after.map(str::to_owned),
            body: error_body(429, "Rate Limit Exceeded", "rateLimitExceeded"),
            count: 1,
            only: None,
        }
    }

    /// A failure with `status` and a Drive error body.
    pub fn with_status(status: u16) -> Self {
        Self {
            status,
            retry_after: None,
            body: error_body(status, "Injected failure", "backendError"),
            count: 1,
            only: None,
        }
    }
}

/// A Drive v3 error body.
fn error_body(code: u16, message: &str, reason: &str) -> String {
    format!(
        r#"{{"error":{{"code":{code},"message":"{message}","errors":[{{"reason":"{reason}","message":"{message}"}}]}}}}"#
    )
}

/// A file with its content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredFile {
    pub file: DriveFile,
    pub content: Vec<u8>,
}

#[derive(Default)]
struct State {
    /// In the order they were created.
    files: Vec<StoredFile>,
    next_id: u64,
    clock_ms: i64,
    faults: VecDeque<Fault>,
}

impl State {
    fn tick(&mut self) -> String {
        self.clock_ms = if self.clock_ms == 0 { CLOCK_START_MS } else { self.clock_ms + CLOCK_STEP_MS };
        pipette_time::iso_8601_millis(self.clock_ms)
    }

    /// The injected failure for a request of `op`, if one is due.
    fn take_fault(&mut self, op: DriveOp) -> Option<DriveError> {
        let index = self.faults.iter().position(|fault| fault.only.is_none_or(|only| only == op))?;
        let fault = &mut self.faults[index];
        let error = DriveError::Status {
            status: fault.status,
            body: fault.body.clone(),
            retry_after: fault.retry_after.clone(),
        };
        fault.count = fault.count.saturating_sub(1);
        if fault.count == 0 {
            self.faults.remove(index);
        }
        Some(error)
    }

    fn file_mut(&mut self, id: &str) -> Result<&mut StoredFile, DriveError> {
        self.files.iter_mut().find(|stored| stored.file.id == id).ok_or_else(|| not_found(id))
    }

    fn create(&mut self, name: String, content: String) -> UploadedFile {
        self.next_id += 1;
        let id = format!("fake-{}", self.next_id);
        let now = self.tick();
        self.files.push(StoredFile {
            file: DriveFile {
                id: id.clone(),
                name,
                modified_time: now.clone(),
                created_time: Some(now.clone()),
            },
            content: content.into_bytes(),
        });
        UploadedFile { id, modified_time: now }
    }

    fn list(&self, query: &ListQuery) -> Result<FileList, DriveError> {
        let size = query.page_size.clamp(1, MAX_PAGE_SIZE) as usize;
        let start = match &query.page_token {
            None => 0,
            Some(token) => token
                .strip_prefix("page-")
                .and_then(|offset| offset.parse::<usize>().ok())
                .ok_or_else(|| DriveError::Status {
                    status: 400,
                    body: error_body(400, "Invalid Value", "invalid"),
                    retry_after: None,
                })?,
        };
        let matching: Vec<&StoredFile> = self
            .files
            .iter()
            .filter(|stored| {
                query.name_contains.as_ref().is_none_or(|part| stored.file.name.contains(part.as_str()))
            })
            .collect();
        let files = matching.iter().skip(start).take(size).map(|stored| stored.file.clone()).collect();
        let next = start + size;
        Ok(FileList { files, next_page_token: (next < matching.len()).then(|| format!("page-{next}")) })
    }
}

fn not_found(id: &str) -> DriveError {
    DriveError::Status {
        status: 404,
        body: error_body(404, &format!("File not found: {id}."), "notFound"),
        retry_after: None,
    }
}

/// The in-memory Drive. Every operation answers at once.
#[derive(Default)]
pub struct InMemoryDrive {
    state: Mutex<State>,
}

impl InMemoryDrive {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Makes the next requests fail (after the faults injected before).
    pub fn inject(&self, fault: Fault) {
        if fault.count > 0 {
            self.lock().faults.push_back(fault);
        }
    }

    /// Every file with its content, in the order they were created.
    pub fn files(&self) -> Vec<StoredFile> {
        self.lock().files.clone()
    }

    /// Runs `op` on the state unless an injected failure is due.
    fn answer<T: Send + 'static>(
        &self,
        op: DriveOp,
        run: impl FnOnce(&mut State) -> Result<T, DriveError>,
    ) -> DriveFuture<'_, T> {
        let mut state = self.lock();
        let result = match state.take_fault(op) {
            Some(fault) => Err(fault),
            None => run(&mut state),
        };
        Box::pin(std::future::ready(result))
    }
}

impl DriveApi for InMemoryDrive {
    fn list_page(&self, query: ListQuery) -> DriveFuture<'_, FileList> {
        self.answer(DriveOp::List, |state| state.list(&query))
    }

    fn download(&self, id: String) -> DriveFuture<'_, Vec<u8>> {
        self.answer(DriveOp::Download, |state| Ok(state.file_mut(&id)?.content.clone()))
    }

    fn create(&self, name: String, content: String) -> DriveFuture<'_, UploadedFile> {
        self.answer(DriveOp::Create, |state| Ok(state.create(name, content)))
    }

    fn create_raw(&self, name: String, content: String) -> DriveFuture<'_, String> {
        self.answer(DriveOp::Create, |state| Ok(state.create(name, content).id))
    }

    fn update(&self, id: String, content: String) -> DriveFuture<'_, UploadedFile> {
        self.answer(DriveOp::Update, |state| {
            state.file_mut(&id)?;
            let now = state.tick();
            let stored = state.file_mut(&id)?;
            stored.content = content.into_bytes();
            stored.file.modified_time = now.clone();
            Ok(UploadedFile { id, modified_time: now })
        })
    }

    fn rename(&self, id: String, name: String) -> DriveFuture<'_, DriveFile> {
        self.answer(DriveOp::Rename, |state| {
            state.file_mut(&id)?;
            let now = state.tick();
            let stored = state.file_mut(&id)?;
            stored.file.name = name;
            stored.file.modified_time = now;
            // A rename answers the fields it asks for: no createdTime.
            Ok(DriveFile { created_time: None, ..stored.file.clone() })
        })
    }

    fn delete(&self, id: String) -> DriveFuture<'_, ()> {
        self.answer(DriveOp::Delete, |state| {
            let index =
                state.files.iter().position(|stored| stored.file.id == id).ok_or_else(|| not_found(&id))?;
            state.files.remove(index);
            Ok(())
        })
    }
}
