// SPDX-License-Identifier: GPL-2.0-or-later
//! Shared helpers for the cross-implementation tests.

#![allow(dead_code, clippy::unwrap_used)]

use serde_json::Value;
use std::path::PathBuf;

/// Vectors written by `pnpm run generate:sync-format-fixtures`.
pub fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap()
}

/// Files shared with the TypeScript side through Cargo's per-target temp
/// directory (`src-tauri/target/tmp`): never committed.
pub fn shared_tmp_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("pipette-sync-format")
}

pub fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_else(|| panic!("{key} is not a string in {value}"))
}

pub fn hex_array<const N: usize>(hex: &str) -> [u8; N] {
    assert_eq!(hex.len(), N * 2, "{hex}");
    std::array::from_fn(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap())
}
