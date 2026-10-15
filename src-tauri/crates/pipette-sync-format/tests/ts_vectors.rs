// SPDX-License-Identifier: GPL-2.0-or-later
//! TypeScript → Rust: the deterministic vectors of
//! `tests/fixtures/ts_vectors.json`, produced by the real TypeScript
//! functions. Each envelope case is its own test so the 600,000-iteration
//! key derivations run in parallel.

// Test helpers outside #[test] functions unwrap fixture data too.
#![allow(clippy::unwrap_used)]

mod common;

use common::{fixture, hex_array, str_of};
use pipette_sync_format::crypto::encrypt_with;
use pipette_sync_format::drive_names::{
    KEYBOARD_META_SYNC_UNIT, PASSWORD_CHANGE_LOCK_FILE, SYNC_FORMAT_FILE_PREFIX, drive_file_name,
    drive_filename_prefix, is_data_file_name, parse_sync_format_file_name, sync_format_file_name,
    sync_unit_from_file_name,
};
use pipette_sync_format::password_check::{
    PASSWORD_CHECK_PAYLOAD, PASSWORD_CHECK_UNIT, password_check_matches,
};
use pipette_sync_format::{Envelope, content_hash, decrypt, machine_hash};
use serde_json::Value;

fn vectors() -> Value {
    fixture("ts_vectors.json")
}

fn envelope_case(name: &str) -> Value {
    vectors()["envelopes"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap().clone()
}

/// Rust encrypts the same inputs to the identical JSON text, and decrypts
/// the TypeScript envelope.
fn check_envelope_case(name: &str) {
    let case = envelope_case(name);
    let password = str_of(&case, "password");
    let plaintext = str_of(&case, "plaintext");
    let envelope: Envelope = serde_json::from_value(case["envelope"].clone()).unwrap();

    let ours = encrypt_with(
        plaintext,
        password,
        str_of(&case, "syncUnit"),
        &hex_array(str_of(&case, "saltHex")),
        &hex_array(str_of(&case, "ivHex")),
        &envelope.updated_at,
    )
    .unwrap();
    assert_eq!(serde_json::to_string(&ours).unwrap(), str_of(&case, "json"));
    assert_eq!(decrypt(&envelope, password).unwrap(), plaintext);
}

#[test]
fn envelope_favorite_ascii() {
    check_envelope_case("favorite-ascii");
}

#[test]
fn envelope_snapshot_unicode() {
    check_envelope_case("snapshot-unicode");
}

#[test]
fn envelope_empty_plaintext_empty_password() {
    check_envelope_case("empty-plaintext-empty-password");
}

#[test]
fn envelope_typing_day_jsonl() {
    check_envelope_case("typing-day-jsonl");
}

#[test]
fn envelope_password_check() {
    check_envelope_case("password-check");
}

#[test]
fn password_check_opens_only_with_its_password() {
    let case = envelope_case("password-check");
    let envelope: Envelope = serde_json::from_value(case["envelope"].clone()).unwrap();
    assert_eq!(envelope.sync_unit, PASSWORD_CHECK_UNIT);
    assert!(password_check_matches(&envelope, str_of(&case, "password")));
    assert!(!password_check_matches(&envelope, "not the password"));
}

/// Same inputs, same failure, same message as the TypeScript `decrypt`.
fn check_rejection(name: &str) {
    let all = vectors();
    let case = all["rejections"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap();
    let envelope: Envelope = serde_json::from_value(case["envelope"].clone()).unwrap();
    let error = decrypt(&envelope, str_of(case, "password")).unwrap_err();
    assert_eq!(error.to_string(), str_of(case, "message"));
}

#[test]
fn rejects_wrong_password() {
    check_rejection("wrong-password");
}

#[test]
fn rejects_other_sync_unit() {
    check_rejection("other-sync-unit");
}

#[test]
fn rejects_other_version() {
    check_rejection("other-version");
}

#[test]
fn rejects_flipped_ciphertext_bit() {
    check_rejection("flipped-ciphertext-bit");
}

#[test]
fn rejects_too_short_ciphertext() {
    check_rejection("ciphertext-too-short");
}

#[test]
fn constants_match() {
    let constants = &vectors()["constants"];
    assert_eq!(str_of(constants, "passwordCheckUnit"), PASSWORD_CHECK_UNIT);
    assert_eq!(str_of(constants, "passwordCheckPayload"), PASSWORD_CHECK_PAYLOAD);
    assert_eq!(str_of(constants, "passwordChangeLockFile"), PASSWORD_CHANGE_LOCK_FILE);
    assert_eq!(str_of(constants, "syncFormatFilePrefix"), SYNC_FORMAT_FILE_PREFIX);
    assert_eq!(str_of(constants, "keyboardMetaSyncUnit"), KEYBOARD_META_SYNC_UNIT);
}

#[test]
fn drive_file_names_match() {
    let all = vectors();
    for case in all["driveFileName"].as_array().unwrap() {
        assert_eq!(drive_file_name(str_of(case, "syncUnit")), str_of(case, "fileName"), "{case}");
    }
    for case in all["driveFilenamePrefix"].as_array().unwrap() {
        assert_eq!(drive_filename_prefix(str_of(case, "prefix")), str_of(case, "fileNamePrefix"), "{case}");
    }
    for case in all["syncFormatFileName"].as_array().unwrap() {
        assert_eq!(sync_format_file_name(case["version"].as_u64().unwrap()), str_of(case, "fileName"));
    }
}

#[test]
fn file_name_parsing_matches() {
    let all = vectors();
    let cases = all["fileNames"].as_array().unwrap();
    assert!(cases.len() > 40);
    for case in cases {
        let name = str_of(case, "fileName");
        assert_eq!(sync_unit_from_file_name(name).as_deref(), case["syncUnit"].as_str(), "{case}");
        assert_eq!(is_data_file_name(name), case["isDataFileName"].as_bool().unwrap(), "{case}");
        assert_eq!(parse_sync_format_file_name(name), case["syncFormatVersion"].as_u64(), "{case}");
    }
}

#[test]
fn machine_hashes_match() {
    for case in vectors()["machineHashes"].as_array().unwrap() {
        let ours = machine_hash(str_of(case, "machineId"), str_of(case, "installationId"));
        assert_eq!(ours, str_of(case, "machineHash"), "{case}");
    }
}

#[test]
fn content_hashes_match() {
    for case in vectors()["contentHashes"].as_array().unwrap() {
        assert_eq!(content_hash(str_of(case, "text")), str_of(case, "hash"), "{case}");
    }
}
