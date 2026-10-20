// SPDX-License-Identifier: GPL-2.0-or-later
//! Recorded golden envelopes from a random `encrypt` of the 0.4 build
//! (`tests/fixtures/ts_random_envelopes.json`). They decrypt here, and a wrong
//! password or another sync unit does not open them. The right password's key
//! is derived once per envelope; the wrong password goes through the full
//! `decrypt`.

// Test helpers outside #[test] functions unwrap fixture data too.
#![allow(clippy::unwrap_used)]

mod common;

use common::{fixture, str_of};
use pipette_sync_format::crypto::decrypt_with_key;
use pipette_sync_format::{CryptoError, Envelope, decrypt};

fn check(name: &str) {
    let all = fixture("ts_random_envelopes.json");
    let case = all.as_array().unwrap().iter().find(|c| c["name"] == name).unwrap();
    let envelope: Envelope = serde_json::from_value(case["envelope"].clone()).unwrap();
    let password = str_of(case, "password");
    let wrong_password = format!("{password}!");
    // The wrong password's derivation runs beside the right one's.
    std::thread::scope(|scope| {
        let wrong = scope.spawn(|| decrypt(&envelope, &wrong_password));

        let key = common::key(password, &envelope.salt);
        assert_eq!(decrypt_with_key(&envelope, &key).unwrap(), str_of(case, "plaintext"));
        let retargeted = Envelope { sync_unit: format!("{}/other", envelope.sync_unit), ..envelope.clone() };
        assert_eq!(decrypt_with_key(&retargeted, &key), Err(CryptoError::Authentication));

        assert_eq!(wrong.join().unwrap(), Err(CryptoError::Authentication));
    });
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
