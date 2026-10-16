// SPDX-License-Identifier: GPL-2.0-or-later
//! The result envelope of the pack stores' handlers
//! (`I18nPackStoreResult` of src/shared/types/i18n-store.ts and its theme
//! twin): `{success: true, data?}` or `{success: false, errorCode, error}`.

use std::fmt::Display;

use pipette_entry_store::EntryError;
use pipette_js_json::{Object, Value};

/// The `errorCode` of a failed operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCode {
    NotFound,
    InvalidName,
    InvalidFile,
    DuplicateName,
    IoError,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::NotFound => "NOT_FOUND",
            ErrorCode::InvalidName => "INVALID_NAME",
            ErrorCode::InvalidFile => "INVALID_FILE",
            ErrorCode::DuplicateName => "DUPLICATE_NAME",
            ErrorCode::IoError => "IO_ERROR",
        }
    }
}

/// A failed operation: its code and the text the handler answers as
/// `error`. The handlers' own messages are Electron's; the text of a thrown
/// error is `String(err)` there, which this build matches for the errors
/// JavaScript itself throws and not for the OS's or `JSON.parse`'s.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackError {
    pub code: ErrorCode,
    pub message: String,
}

impl PackError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    /// A thrown error caught as `IO_ERROR` with its `String(err)`.
    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::IoError, message)
    }

    /// A file-system error, as `IO_ERROR` with the OS's text after `Error: `.
    pub fn from_io(err: &std::io::Error) -> Self {
        Self::io(format!("Error: {err}"))
    }
}

impl From<std::io::Error> for PackError {
    fn from(err: std::io::Error) -> Self {
        Self::from_io(&err)
    }
}

impl From<EntryError> for PackError {
    fn from(err: EntryError) -> Self {
        let name = match err {
            EntryError::TimeOutOfRange => "RangeError",
            EntryError::UnattendedRevive => "Error",
        };
        Self::io(format!("{name}: {err}"))
    }
}

impl Display for PackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

/// What an operation answers: its `data` (none for an operation that
/// answers no data), or the failure.
pub type PackResult<T> = Result<T, PackError>;

/// The handler's answer for `result` as an object
/// ([`pipette_keyboard_stores::coded_response`]).
pub fn response(result: PackResult<Option<Value>>) -> Object {
    pipette_keyboard_stores::coded_response(result.map_err(|err| (err.code.as_str(), err.message)))
}

/// [`response`] as the JSON text `JSON.stringify` writes for it.
pub fn response_json(result: PackResult<Option<Value>>) -> String {
    pipette_js_json::stringify(&Value::Object(response(result)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_carry_the_data_or_the_code_and_error() {
        assert_eq!(response_json(Ok(None)), r#"{"success":true}"#);
        assert_eq!(response_json(Ok(Some(true.into()))), r#"{"success":true,"data":true}"#);
        assert_eq!(
            response_json(Err(PackError::not_found("Invalid id"))),
            r#"{"success":false,"errorCode":"NOT_FOUND","error":"Invalid id"}"#
        );
    }

    #[test]
    fn entry_errors_read_as_the_errors_javascript_throws() {
        assert_eq!(PackError::from(EntryError::TimeOutOfRange).message, "RangeError: Invalid time value");
        assert_eq!(
            PackError::from(EntryError::UnattendedRevive).message,
            "Error: An unattended write cannot bring back a deleted entry"
        );
    }
}
