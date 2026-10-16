// SPDX-License-Identifier: GPL-2.0-or-later
//! The Aozora Bunko import where it differs from the TypeScript handler,
//! which the recorded scenarios (ts_aozora_import_scenarios.rs) cannot
//! show: a body past the client's size limit, and an overrides file nested
//! too deeply to read.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::sync::Arc;

use common::{Harness, block_on};
use pipette_entry_store::{SystemClock, WriteLocks};
use pipette_keyboard_stores::{StoreContext, TypingTextStore};
use pipette_net::HttpError;
use pipette_typing_datasets::import_aozora_work;

const OVERRIDES: &str = "local/typing-test-dataset.json";

fn import(h: &Harness, work_id: &str) -> Result<String, String> {
    let ctx = StoreContext::new(
        h.user_data(),
        Arc::new(SystemClock),
        Arc::new(WriteLocks::new()),
        Arc::new(|_: &str| {}),
    );
    block_on(import_aozora_work(&h.store, &ctx, &TypingTextStore::default(), Some(work_id)))
        .map_err(|err| err.to_string())
}

#[test]
fn a_body_past_the_size_limit_is_a_size_mismatch() {
    let h = Harness::new();
    h.write(
        OVERRIDES,
        r#"{"aozora":{"version":"a1","downloadUrlBase":"https://h/cards","languages":[{"name":"w.zip","wordCount":1,"rightToLeft":false,"fileSize":10}]}}"#,
    );
    h.reply(Err(HttpError::TooLarge { limit: 67_108_864 }));
    assert_eq!(
        import(&h, "w.zip").unwrap(),
        r#"{"success":false,"errorCode":"SIZE_MISMATCH","error":"expected 10 bytes, got more than 67108864"}"#
    );
    assert_eq!(h.urls(), ["https://h/cards/w.zip"]);
    assert!(!h.user_data().join("sync").exists());
}

#[test]
fn an_overrides_file_nested_too_deeply_fails_the_import() {
    let h = Harness::new();
    h.write(OVERRIDES, &format!("{}{}", "[".repeat(10_000), "]".repeat(10_000)));
    let err = import(&h, "w.zip").unwrap_err();
    assert!(err.ends_with("nested too deeply to read"), "{err}");
    assert!(h.urls().is_empty());
}
