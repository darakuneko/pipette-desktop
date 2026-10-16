// SPDX-License-Identifier: GPL-2.0-or-later
//! The failures of the typing test text store and the handlers' answer.

use std::io;
use std::path::PathBuf;

use pipette_entry_store::EntryError;
use pipette_js_json::Value;

use crate::entry_files::{BodyPathError, entry_error_text};

/// The error codes the renderer branches on (`TypingTestTextStoreErrorCode`
/// in src/shared/types/typing-test-text-store.ts).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TypingTextErrorCode {
    InvalidName,
    DuplicateName,
    NotFound,
    InvalidFile,
    EmptyText,
    TooLarge,
    NotUtf8,
    IoError,
}

impl TypingTextErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            TypingTextErrorCode::InvalidName => "INVALID_NAME",
            TypingTextErrorCode::DuplicateName => "DUPLICATE_NAME",
            TypingTextErrorCode::NotFound => "NOT_FOUND",
            TypingTextErrorCode::InvalidFile => "INVALID_FILE",
            TypingTextErrorCode::EmptyText => "EMPTY_TEXT",
            TypingTextErrorCode::TooLarge => "TOO_LARGE",
            TypingTextErrorCode::NotUtf8 => "NOT_UTF8",
            TypingTextErrorCode::IoError => "IO_ERROR",
        }
    }
}

/// Why a typing test text operation failed. The text is what the handler
/// answers as `error`: its own messages as they are, a thrown error as
/// `String(err)`. The texts of a file-system error and of a JSON syntax
/// error are this build's, not Node's and V8's.
#[derive(Debug, thiserror::Error)]
pub enum TypingTextError {
    /// A failure the store answers with its own code and message.
    #[error("{1}")]
    Refused(TypingTextErrorCode, String),
    #[error("Error: Invalid filename")]
    InvalidFilename,
    /// An entry whose `filename` is a truthy value that is not a string,
    /// which Node's `path.join` refuses.
    #[error("TypeError: The \"path\" argument must be of type string")]
    FilenameNotString,
    /// The TypeError of a string method called on a name that is not a
    /// string.
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

impl TypingTextError {
    pub(crate) fn refused(code: TypingTextErrorCode, message: &str) -> Self {
        TypingTextError::Refused(code, message.to_owned())
    }

    pub(crate) fn invalid_name(message: &str) -> Self {
        Self::refused(TypingTextErrorCode::InvalidName, message)
    }

    pub(crate) fn duplicate_name() -> Self {
        Self::refused(TypingTextErrorCode::DuplicateName, "A text with the same name already exists")
    }

    pub(crate) fn not_found() -> Self {
        Self::refused(TypingTextErrorCode::NotFound, "Text not found")
    }

    pub(crate) fn invalid_file(message: &str) -> Self {
        Self::refused(TypingTextErrorCode::InvalidFile, message)
    }

    /// The answer of a handler whose argument has the wrong type.
    pub fn invalid_argument(code: TypingTextErrorCode, message: &str) -> Self {
        Self::refused(code, message)
    }

    /// The `cancelled` answer of a dialog the user closed.
    pub fn cancelled() -> Self {
        Self::refused(TypingTextErrorCode::IoError, "cancelled")
    }

    /// The handler's `errorCode`: a thrown error is `IO_ERROR`.
    pub fn code(&self) -> &'static str {
        match self {
            TypingTextError::Refused(code, _) => code.as_str(),
            _ => TypingTextErrorCode::IoError.as_str(),
        }
    }
}

impl From<BodyPathError> for TypingTextError {
    fn from(err: BodyPathError) -> Self {
        match err {
            BodyPathError::Invalid => TypingTextError::InvalidFilename,
            BodyPathError::NotString => TypingTextError::FilenameNotString,
        }
    }
}

/// The handler's answer as JSON text ([`crate::coded_response`]).
pub fn typing_text_response(result: Result<Option<Value>, TypingTextError>) -> String {
    crate::coded_response_json(result.map_err(|err| (err.code(), err.to_string())))
}
