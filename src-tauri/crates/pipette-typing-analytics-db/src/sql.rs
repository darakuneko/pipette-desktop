// SPDX-License-Identifier: GPL-2.0-or-later
//! SQL text of the statements this crate shares with the TypeScript DB layer
//! (src/main/typing-analytics/db/). `data/sql.rs` is generated from the
//! strings the TypeScript code prepares
//! (scripts/analytics-db-fixtures/sql-source.ts, run by
//! `pnpm run generate:analytics-db-fixtures`); the generator is
//! deterministic, so a TypeScript edit shows up as a diff of that file when
//! the fixtures are regenerated.
//!
//! Statements no Rust code runs (the sync export selects and the per-scope
//! listers of sync-statements.ts, which the TypeScript side keeps without a
//! caller) are generated too, so an edit to any of them still shows.
//!
//! The migration SQL is not collected (the TypeScript side runs it inline
//! with `exec`) and stays hand-written in schema.rs.

#![allow(dead_code)]

include!("../data/sql.rs");
