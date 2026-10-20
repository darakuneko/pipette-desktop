// SPDX-License-Identifier: GPL-2.0-or-later
//! SQL text of the cache's statements, recorded in `data/sql.rs`.
//!
//! The recorded file also holds statements no Rust code runs (the sync
//! export selects and the per-scope listers).
//!
//! The migration SQL is not in it and stays hand-written in schema.rs.

#![allow(dead_code)]

include!("../data/sql.rs");
