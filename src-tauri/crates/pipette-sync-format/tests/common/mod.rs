// SPDX-License-Identifier: GPL-2.0-or-later
//! Shared helpers for the golden vector tests.

#![allow(dead_code, clippy::unwrap_used)]

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use pipette_sync_format::crypto::{KEY_LENGTH, key_for};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

/// A recorded golden vector file.
pub fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap()
}

pub fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_else(|| panic!("{key} is not a string in {value}"))
}

pub fn hex_array<const N: usize>(text: &str) -> [u8; N] {
    let mut out = [0u8; N];
    hex::decode_to_slice(text, &mut out).unwrap_or_else(|e| panic!("{text}: {e}"));
    out
}

/// One key derivation, shared by every test that needs the same key.
type KeySlot = Arc<OnceLock<[u8; KEY_LENGTH]>>;

/// The envelope key for `password` and the Base64 `salt` of an envelope,
/// derived once per pair for the whole test binary. Tests running in
/// parallel on the same pair wait for the one derivation.
pub fn key(password: &str, salt_base64: &str) -> [u8; KEY_LENGTH] {
    static KEYS: Mutex<BTreeMap<(String, String), KeySlot>> = Mutex::new(BTreeMap::new());
    let slot = KEYS.lock().unwrap().entry((password.to_owned(), salt_base64.to_owned())).or_default().clone();
    *slot.get_or_init(|| key_for(password, &STANDARD.decode(salt_base64).unwrap()))
}
