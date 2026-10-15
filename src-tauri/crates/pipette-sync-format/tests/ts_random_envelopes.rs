// SPDX-License-Identifier: GPL-2.0-or-later
//! TypeScript → Rust: envelopes from the real random `encrypt`
//! (`tests/fixtures/ts_random_envelopes.json`, new bytes on every generator
//! run). Rust decrypts them, and a wrong password or another sync unit does
//! not open them.

// Test helpers outside #[test] functions unwrap fixture data too.
#![allow(clippy::unwrap_used)]

mod common;

use common::{fixture, str_of};
use pipette_sync_format::{CryptoError, Envelope, decrypt};

fn check(name: &str) {
    let all = fixture("ts_random_envelopes.json");
    let case = all.as_array().unwrap().iter().find(|c| c["name"] == name).unwrap();
    let envelope: Envelope = serde_json::from_value(case["envelope"].clone()).unwrap();
    let password = str_of(case, "password");
    assert_eq!(decrypt(&envelope, password).unwrap(), str_of(case, "plaintext"));

    let wrong_password = format!("{password}!");
    assert_eq!(decrypt(&envelope, &wrong_password), Err(CryptoError::Authentication));
    let retargeted = Envelope { sync_unit: format!("{}/other", envelope.sync_unit), ..envelope };
    assert_eq!(decrypt(&retargeted, password), Err(CryptoError::Authentication));
}

#[test]
fn favorite_ascii() {
    check("favorite-ascii");
}

#[test]
fn snapshot_unicode() {
    check("snapshot-unicode");
}

#[test]
fn empty_plaintext_empty_password() {
    check("empty-plaintext-empty-password");
}

#[test]
fn typing_day_jsonl() {
    check("typing-day-jsonl");
}

#[test]
fn password_check() {
    check("password-check");
}
