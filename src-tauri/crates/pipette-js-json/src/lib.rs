// SPDX-License-Identifier: GPL-2.0-or-later
//! `JSON.parse` and `JSON.stringify` with the semantics of JavaScript, for
//! files the Electron build reads and writes and the Tauri build must
//! read and write byte for byte the same:
//!
//! - numbers are f64: a literal is rounded to the nearest one (integers past
//!   2^53 lose precision, `-0` stays `-0` but is written `0`) and written as
//!   ECMAScript's Number::toString (`1e+21`, `1e-7`, `0.30000000000000004`);
//! - object keys follow JavaScript's own-property order: array indexes
//!   (`"0"` to `"4294967294"`) first in ascending order, then the other keys
//!   in the order they were first added; a duplicate key in a text keeps its
//!   first position and takes its last value;
//! - strings are JavaScript strings. A lone surrogate (only possible through
//!   a `\uXXXX` escape, as UTF-8 cannot carry one) is kept as a UTF-16 code
//!   unit, so it is written back as the same `\udxxx` escape `JSON.stringify`
//!   writes; [`JsString::to_string_lossy`] gives the text with U+FFFD for it.
//!
//! Where it differs from V8: nesting deeper than [`MAX_DEPTH`] fails to
//! parse, and parse errors have their own messages.

mod parse;
mod stringify;
mod value;

pub use parse::{MAX_DEPTH, ParseError, parse};
pub use stringify::{stringify, stringify_with_gap, write_number};
pub use value::{JsString, Object, Value};
