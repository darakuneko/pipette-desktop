// SPDX-License-Identifier: GPL-2.0-or-later
//! The Data modal's reads of Drive (pipette_sync::scan): the scan and one
//! unit's bundle. The envelope is the plaintext itself, except that a file
//! holding `bad` does not open.

#![allow(clippy::unwrap_used, clippy::panic)]

mod preflight_harness;
mod reset_harness;

use std::sync::atomic::Ordering;

use pipette_sync::codec::{CodecFuture, EnvelopeCodec};
use pipette_sync::scan::{SyncDataScanResult, UndecryptableFile, fetch_remote_bundle, scan_remote_data};
use reset_harness::{PASSWORD, World, write};

const OWN: &str = "own-hash";

struct TestCodec;

impl EnvelopeCodec for TestCodec {
    fn seal(&self, plaintext: String, _: zeroize::Zeroizing<String>, _: String) -> CodecFuture {
        Box::pin(std::future::ready(Ok(plaintext)))
    }

    fn open(&self, content: Vec<u8>, _: zeroize::Zeroizing<String>) -> CodecFuture {
        let text = String::from_utf8_lossy(&content).into_owned();
        Box::pin(std::future::ready(if text == "bad" { Err("bad password".into()) } else { Ok(text) }))
    }
}

async fn world() -> World {
    let w = World::new(|root| {
        write(
            root,
            "sync/meta/keyboard-names.json",
            r#"{"type":"keyboard-meta","version":1,"entries":[{"uid":"uid1","deviceName":"One"},{"uid":"uid2","deviceName":"Two","deletedAt":"x"}]}"#,
        );
    });
    w.drive.seed_password_check(PASSWORD).await;
    w
}

#[tokio::test]
async fn categorizes_keyboards_favorites_and_undecryptable_files() {
    let w = world().await;
    for name in [
        "keyboards_uid1_settings.enc",
        "keyboards_uid1_snapshots.enc",
        "keyboards_uid2_settings.enc",
        "favorites_tapDance.enc",
    ] {
        w.drive.seed(name, "ok").await;
    }
    let bad = w.drive.seed("favorites_macro.enc", "bad").await;
    w.add_trash("favorites_combo.enc", 1000).await;

    let result = scan_remote_data(&w.preflight, &TestCodec, &w.ctx, Some(OWN)).await.unwrap();

    assert_eq!(result.keyboards, ["uid1", "uid2"]);
    assert_eq!(result.keyboard_names, vec![("uid1".to_owned(), "One".into())]);
    assert_eq!(result.favorites, ["tapDance", "macro"]);
    assert_eq!(
        result.undecryptable,
        vec![UndecryptableFile {
            file_id: bad.id,
            file_name: "favorites_macro.enc".into(),
            sync_unit: Some("favorites/macro".into())
        }]
    );
}

#[tokio::test]
async fn lists_the_keyboards_with_another_devices_typing_days_with_their_names() {
    let w = world().await;
    for name in [
        "keyboards_uid2_devices_hash-b_days_2026-10-14.enc",
        "keyboards_uid1_devices_hash-a_days_2026-10-14.enc",
        "keyboards_uid1_devices_hash-b_days_2026-10-15.enc",
        // This device's day and another device's deleted ranges alone do not count.
        "keyboards_uid3_devices_own-hash_days_2026-10-14.enc",
        "keyboards_uid4_devices_hash-a_deleted-ranges.enc",
    ] {
        w.drive.seed(name, "ok").await;
    }
    w.add_trash("keyboards_uid5_devices_hash-a_days_2026-10-14.enc", 1000).await;

    let result = scan_remote_data(&w.preflight, &TestCodec, &w.ctx, Some(OWN)).await.unwrap();
    assert_eq!(result.typing_keyboards, ["uid1", "uid2"]);
    assert_eq!(result.keyboard_names, vec![("uid1".to_owned(), "One".into())]);

    // Without this device's hash no keyboard is claimed.
    let result = scan_remote_data(&w.preflight, &TestCodec, &w.ctx, None).await.unwrap();
    assert!(result.typing_keyboards.is_empty());
}

#[tokio::test]
async fn reports_packs_and_the_global_units() {
    let w = world().await;
    for name in ["i18n_index.enc", "themes_packs_pack-a.enc", "key-labels.enc", "typing-test-texts.enc"] {
        w.drive.seed(name, "ok").await;
    }

    let result = scan_remote_data(&w.preflight, &TestCodec, &w.ctx, Some(OWN)).await.unwrap();

    assert!(result.i18n_packs.is_empty() && result.has_i18n_data);
    assert_eq!(result.theme_packs, ["pack-a"]);
    assert!(result.has_themes_data && result.key_labels && result.typing_test_texts);
    assert!(result.undecryptable.is_empty(), "the password-check is not a data file");
}

#[tokio::test]
async fn is_empty_without_credentials() {
    let w = world().await;
    w.drive.seed("favorites_macro.enc", "ok").await;
    w.sign_in.0.store(false, Ordering::SeqCst);

    let result = scan_remote_data(&w.preflight, &TestCodec, &w.ctx, Some(OWN)).await.unwrap();

    assert_eq!(result, SyncDataScanResult::default());
    assert!(fetch_remote_bundle(&w.preflight, &TestCodec, "favorites/macro").await.unwrap().is_none());
}

#[tokio::test]
async fn is_refused_while_the_password_change_lock_is_listed_downloading_nothing() {
    let w = world().await;
    w.drive.seed("password-change-lock.json", "{}").await;
    w.drive.seed("favorites_macro.enc", "ok").await;
    w.drive.take_events();

    let refusal = scan_remote_data(&w.preflight, &TestCodec, &w.ctx, Some(OWN)).await.unwrap_err();

    assert_eq!(refusal.to_string(), "sync.passwordChange.blockedByOtherDevice");
    assert!(!w.drive.take_events().iter().any(|event| event.starts_with("download:")));
}

#[tokio::test]
async fn fetches_the_chosen_copy_of_a_unit() {
    let w = world().await;
    w.drive.seed("favorites_macro.enc", r#"{"type":"favorite","old":true}"#).await;
    w.drive.seed("favorites_macro.enc", r#"{"type":"favorite","key":"macro"}"#).await;
    w.drive.seed("favorites_combo.enc", "bad").await;
    w.drive.seed("favorites_tapDance.enc", "not json").await;

    let fetch = |unit: &'static str| fetch_remote_bundle(&w.preflight, &TestCodec, unit);
    assert_eq!(
        fetch("favorites/macro").await.unwrap().as_deref(),
        Some(r#"{"type":"favorite","key":"macro"}"#)
    );
    assert_eq!(fetch("favorites/combo").await.unwrap(), None);
    assert_eq!(fetch("favorites/tapDance").await.unwrap(), None);
    assert_eq!(fetch("favorites/missing").await.unwrap(), None);
}
