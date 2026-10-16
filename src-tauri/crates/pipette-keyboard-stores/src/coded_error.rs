// SPDX-License-Identifier: GPL-2.0-or-later
//! The failures of the stores whose handlers answer an `errorCode` (the key
//! labels and the typing test texts): the store's own refusals with their
//! code, and the errors their handlers throw, answered as `IO_ERROR` with
//! `String(err)`.

use std::fmt::Debug;
use std::io;
use std::path::PathBuf;

use pipette_entry_store::EntryError;
use pipette_js_json::Value;

use crate::entry_files::{BodyPathError, entry_error_text};

/// The error codes of one store, as the renderer branches on them.
pub trait ErrorCode: Copy + Debug {
    /// The code of a thrown error.
    const IO_ERROR: Self;
    /// The code of a name the store refuses.
    const INVALID_NAME: Self;
    /// The code of a file the store refuses.
    const INVALID_FILE: Self;

    fn as_str(self) -> &'static str;
}

/// Why an operation of a store with error codes failed. The text is what
/// the handler answers as `error`: its own messages as they are, a thrown
/// error as `String(err)`. The texts of a file-system error and of a JSON
/// syntax error are this build's, not Node's and V8's.
#[derive(Debug, thiserror::Error)]
pub enum CodedStoreError<C: ErrorCode> {
    /// A failure the store answers with its own code and message.
    #[error("{1}")]
    Refused(C, String),
    #[error("Error: Invalid filename")]
    InvalidFilename,
    /// An entry whose `filename` is a truthy value that is not a string,
    /// which Node's `path.join` refuses.
    #[error("TypeError: The \"path\" argument must be of type string")]
    FilenameNotString,
    /// The TypeError of a string method called on a value that is not a
    /// string (a name of another type in the index).
    #[error("TypeError: {0}")]
    Type(String),
    #[error("SyntaxError: {0}")]
    Syntax(String),
    #[error("Error: {0}")]
    Io(#[from] io::Error),
    #[error("{}", entry_error_text(.0))]
    Entry(#[from] EntryError),
    #[error("Error: {}: nested too deeply to read", .0.display())]
    TooDeep(PathBuf),
}

impl<C: ErrorCode> CodedStoreError<C> {
    pub(crate) fn refused(code: C, message: &str) -> Self {
        CodedStoreError::Refused(code, message.to_owned())
    }

    pub(crate) fn invalid_name(message: &str) -> Self {
        Self::refused(C::INVALID_NAME, message)
    }

    pub(crate) fn invalid_file(message: &str) -> Self {
        Self::refused(C::INVALID_FILE, message)
    }

    /// The answer of a handler whose argument has the wrong type.
    pub fn invalid_argument(code: C, message: &str) -> Self {
        Self::refused(code, message)
    }

    /// The `cancelled` answer of a dialog the user closed.
    pub fn cancelled() -> Self {
        Self::refused(C::IO_ERROR, "cancelled")
    }

    /// The handler's `errorCode`: a thrown error is `IO_ERROR`.
    pub fn code(&self) -> &'static str {
        match self {
            CodedStoreError::Refused(code, _) => code.as_str(),
            _ => C::IO_ERROR.as_str(),
        }
    }
}

impl<C: ErrorCode> From<BodyPathError> for CodedStoreError<C> {
    fn from(err: BodyPathError) -> Self {
        match err {
            BodyPathError::Invalid => CodedStoreError::InvalidFilename,
            BodyPathError::NotString => CodedStoreError::FilenameNotString,
        }
    }
}

/// The handler's answer as JSON text ([`crate::coded_response`]).
pub fn coded_store_response<C: ErrorCode>(result: Result<Option<Value>, CodedStoreError<C>>) -> String {
    crate::coded_response_json(result.map_err(|err| (err.code(), err.to_string())))
}
