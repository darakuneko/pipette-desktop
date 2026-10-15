// SPDX-License-Identifier: GPL-2.0-or-later
//! Rust → TypeScript: writes envelopes made by this crate to
//! `src-tauri/target/tmp/pipette-sync-format/rust_envelopes/`, one file per
//! case, for `pnpm run verify:sync-format-rust-vectors`, which opens them
//! with the real TypeScript `decrypt`. The pinned case also lets the
//! verifier compare the JSON text with the real TypeScript `encrypt` given
//! the same salt, IV and clock.

// Test helpers outside #[test] functions unwrap fixture data too.
#![allow(clippy::unwrap_used)]

mod common;

use pipette_sync_format::crypto::{encrypt_with_key, key_for};
use pipette_sync_format::password_check::{PASSWORD_CHECK_PAYLOAD, encrypt_password_check};
use pipette_sync_format::{Envelope, encrypt};
use serde_json::{Value, json};

fn write_case(name: &str, password: &str, plaintext: &str, envelope: &Envelope, pinned: Value) {
    let dir = common::shared_tmp_dir().join("rust_envelopes");
    std::fs::create_dir_all(&dir).unwrap();
    let record = json!({
        "name": name,
        "password": password,
        "plaintext": plaintext,
        // The envelope as the exact text Drive would hold.
        "json": serde_json::to_string(envelope).unwrap(),
        "pinned": pinned,
    });
    let text = serde_json::to_string_pretty(&record).unwrap() + "\n";
    std::fs::write(dir.join(format!("{name}.json")), text).unwrap();
}

fn random_case(name: &str, password: &str, sync_unit: &str, plaintext: &str) {
    let envelope = encrypt(plaintext, password, sync_unit).unwrap();
    assert_eq!(envelope.sync_unit, sync_unit);
    write_case(name, password, plaintext, &envelope, Value::Null);
}

#[test]
fn favorite_ascii() {
    random_case(
        "favorite-ascii",
        "hunter2",
        "favorites/macro",
        r#"{"type":"favorite","key":"macro","files":{}}"#,
    );
}

#[test]
fn snapshot_unicode() {
    random_case(
        "snapshot-unicode",
        "鍵🔐 cafe\u{301}\t",
        "keyboards/0xFEED/snapshots",
        "{\n  \"note\": \"日本語 ✓ 😀\\r\\n\"\n}",
    );
}

#[test]
fn empty_plaintext_empty_password() {
    random_case("empty-plaintext-empty-password", "", "key-labels", "");
}

#[test]
fn typing_day_jsonl() {
    let jsonl = (0..40).map(|i| format!(r#"{{"i":{i},"k":"KC_A"}}"#)).collect::<Vec<_>>().join("\n");
    let plaintext = serde_json::to_string(&json!({ "files": { "data.jsonl": jsonl } })).unwrap();
    random_case("typing-day-jsonl", "p@ss", "keyboards/0x1/devices/abc/days/2026-10-15", &plaintext);
}

#[test]
fn password_check() {
    let envelope = encrypt_password_check("correct horse battery staple").unwrap();
    write_case(
        "password-check",
        "correct horse battery staple",
        PASSWORD_CHECK_PAYLOAD,
        &envelope,
        Value::Null,
    );
}

#[test]
fn pinned_salt_iv_and_clock() {
    let salt: [u8; 16] = std::array::from_fn(|i| u8::try_from(i * 7 + 3).unwrap());
    let iv: [u8; 12] = std::array::from_fn(|i| u8::try_from(0xF0 - i).unwrap());
    let updated_at = "2026-10-15T09:08:07.006Z";
    let plaintext = r#"{"type":"settings","files":{"pipette_settings.json":"{}"}}"#;
    let key = key_for("pinned password", &salt);
    let envelope =
        encrypt_with_key(plaintext, &key, "keyboards/0x1234/settings", &salt, &iv, updated_at).unwrap();
    let pinned = json!({ "saltHex": hex::encode(salt), "ivHex": hex::encode(iv), "updatedAt": updated_at });
    write_case("pinned-salt-iv-and-clock", "pinned password", plaintext, &envelope, pinned);
}
