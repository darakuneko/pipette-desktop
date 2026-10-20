// SPDX-License-Identifier: GPL-2.0-or-later
//! The text of a downloaded Aozora Bunko zip, the steps of the import
//! between the download and the save: the `.txt` entry, its Shift_JIS, the
//! replacement-character check and the cleaning.

use crate::aozora_clean::{InvalidCodePoint, clean_aozora_text, has_content};
use crate::shift_jis::decode_shift_jis;
use crate::units::REPLACEMENT_CHARACTER;
use crate::zip::{ZipError, largest_text_entry};

/// Above this share of U+FFFD in the decoded text the Shift_JIS decode
/// counts as failed: a typing test cannot get through a run of them.
const REPLACEMENT_RATIO_THRESHOLD: f64 = 0.005;

/// Why a zip gave no text. The messages are the `error` strings of
/// `importAozoraWork`.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum AozoraTextError {
    /// `String(err)` of fflate's `Error` after the prefix.
    #[error("Failed to unzip: Error: {0}")]
    Unzip(ZipError),
    #[error("Zip contains no .txt entry")]
    NoTextEntry,
    #[error("Decoded text exceeds the replacement-character threshold")]
    DecodeFailed,
    #[error("Cleaned text is empty")]
    EmptyText,
    /// `importAozoraWork` throws here (the IPC call rejects) instead of
    /// returning an error code.
    #[error(transparent)]
    InvalidCodePoint(InvalidCodePoint),
}

impl AozoraTextError {
    /// The `errorCode` of the failure result; `None` for the error
    /// `importAozoraWork` throws.
    pub fn error_code(&self) -> Option<&'static str> {
        match self {
            Self::Unzip(_) | Self::NoTextEntry => Some("NO_TEXT_ENTRY"),
            Self::DecodeFailed => Some("DECODE_FAILED"),
            Self::EmptyText => Some("EMPTY_TEXT"),
            Self::InvalidCodePoint(_) => None,
        }
    }
}

/// The cleaned text of the largest `.txt` entry of `zip`, as UTF-16.
pub fn aozora_text_from_zip(zip: &[u8]) -> Result<Vec<u16>, AozoraTextError> {
    let bytes =
        largest_text_entry(zip).map_err(AozoraTextError::Unzip)?.ok_or(AozoraTextError::NoTextEntry)?;
    let decoded = decode_shift_jis(&bytes);
    let replacements = decoded.iter().filter(|&&unit| unit == REPLACEMENT_CHARACTER).count();
    if !decoded.is_empty() && replacements as f64 / decoded.len() as f64 > REPLACEMENT_RATIO_THRESHOLD {
        return Err(AozoraTextError::DecodeFailed);
    }
    let cleaned = clean_aozora_text(&decoded).map_err(AozoraTextError::InvalidCodePoint)?;
    if !has_content(&cleaned) {
        return Err(AozoraTextError::EmptyText);
    }
    Ok(cleaned)
}
