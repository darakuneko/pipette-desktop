// SPDX-License-Identifier: GPL-2.0-or-later
//! The text rules of the Typing Test texts, with JavaScript's string
//! semantics, for the text store and the Aozora Bunko import:
//!
//! - strings are UTF-16 code units (`&[u16]`), lone surrogates included, so
//!   lengths and `String.fromCodePoint` behave as in JavaScript;
//! - whitespace is JavaScript's `\s` / `trim()` (U+FEFF included, U+0085
//!   not), and a line ends at `\n`, `\r`, U+2028 or U+2029 wherever
//!   JavaScript's `^` / `$` with `/m` or `.` would end it;
//! - Shift_JIS and the zip container decode as Chromium's `TextDecoder`
//!   and fflate decode them.
//!
//! The recorded golden fixtures check the results unit for unit.

mod aozora_clean;
mod aozora_text;
mod import_text;
mod kana;
mod shift_jis;
mod units;
mod zip;

pub use aozora_clean::{InvalidCodePoint, clean_aozora_text};
pub use aozora_text::{AozoraTextError, aozora_text_from_zip};
pub use import_text::{
    MAX_WORDS, NormalizedFileImportText, ParsedFileImportText, normalize_file_import_text,
    parse_file_import_text,
};
pub use kana::is_kana_only_text;
pub use shift_jis::decode_shift_jis;
pub use zip::{MAX_UNPACKED_BYTES, ZipError, largest_text_entry};
