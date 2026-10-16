// SPDX-License-Identifier: GPL-2.0-or-later
//! The error codes of the typing test text store and the handlers' answer.

use pipette_js_json::Value;

use crate::coded_error::{CodedStoreError, ErrorCode, coded_store_response};

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

impl ErrorCode for TypingTextErrorCode {
    const IO_ERROR: Self = TypingTextErrorCode::IoError;
    const INVALID_NAME: Self = TypingTextErrorCode::InvalidName;
    const INVALID_FILE: Self = TypingTextErrorCode::InvalidFile;

    fn as_str(self) -> &'static str {
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

/// Why a typing test text operation failed.
pub type TypingTextError = CodedStoreError<TypingTextErrorCode>;

pub(super) fn duplicate_name() -> TypingTextError {
    TypingTextError::refused(TypingTextErrorCode::DuplicateName, "A text with the same name already exists")
}

pub(super) fn not_found() -> TypingTextError {
    TypingTextError::refused(TypingTextErrorCode::NotFound, "Text not found")
}

/// The handler's answer as JSON text ([`crate::coded_response`]).
pub fn typing_text_response(result: Result<Option<Value>, TypingTextError>) -> String {
    coded_store_response(result)
}
