// SPDX-License-Identifier: GPL-2.0-or-later
//! Writes a userData tree with the Hub handlers of this crate against the
//! in-memory Hub, into `src-tauri/target/tmp/pipette-hub/rust_user_data/`:
//!
//! - `user-data/`: the tree, with what the handlers write to the stores:
//!   the Hub links of an uploaded key label, language pack and theme pack
//!   (post id, uploader, Hub time), a key label downloaded from the Hub and
//!   one refreshed from it, a theme pack unlinked by a delete, and a
//!   language pack the startup update replaced with the Hub's newer one;
//! - `answers.json`: what the stores answer on that tree, as the app's
//!   commands answer it (the handlers' JSON text), and the Hub's
//!   timestamps of the linked language packs at the end.
//!
//! `pnpm run verify:hub-rust-user-data` then reads a copy of the tree with
//! the real handlers of the Electron build, runs Electron's startup update
//! against those timestamps, and checks that the answers are the same,
//! byte for byte, and that nothing is downloaded or written.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use common::{Clock, block_on};
use pipette_entry_store::{FixedClock, WriteLocks};
use pipette_hub::fake::{CLOCK_START_MS, FAKE_HUB_BASE, FakeHub, PackKind as HubPackKind, RecordKind};
use pipette_hub::packs::{self, PackKind};
use pipette_hub::token::HubToken;
use pipette_hub::{HubHttp, HubRequesters, key_labels, startup_sync};
use pipette_js_json::{JsString, Object, Value, parse, stringify};
use pipette_keyboard_stores::{
    KeyLabelSave, StoreContext, get_key_label, key_label_response, list_key_labels, save_key_label,
};
use pipette_pack_stores::{PackResult, i18n_handlers, response_json, theme_handlers};

/// The store clock: the in-memory Hub's clock start, a minute on.
const STORE_NOW_MS: i64 = CLOCK_START_MS + 60_000;

fn out_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("pipette-hub").join("rust_user_data")
}

fn repo_file(path: &str) -> String {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    fs::read_to_string(root.join(path)).unwrap()
}

fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::Object(fields.into_iter().collect())
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.as_object().and_then(|object| object.get(key)).unwrap_or_else(|| panic!("no {key}"))
}

/// The id of the meta a pack handler answered.
fn id_of(answer: &PackResult<Option<Value>>) -> Value {
    match answer {
        Ok(Some(meta)) => field(meta, "id").clone(),
        other => panic!("{other:?}"),
    }
}

fn ok(answer: PackResult<Option<Value>>) {
    assert!(answer.is_ok(), "{answer:?}");
}

/// A handler's `{success: true, …}` answer as JSON text.
fn succeeded(answer: &str) -> Value {
    let value = parse(answer).unwrap();
    assert_eq!(field(&value, "success"), &Value::Bool(true), "{answer}");
    value
}

/// The list's answer, and each live pack's get by id.
fn pack_answers(list: PackResult<Option<Value>>, get: impl Fn(&Value) -> PackResult<Option<Value>>) -> Value {
    let Ok(Some(Value::Array(metas))) = &list else { panic!("{list:?}") };
    let mut gets = Object::new();
    for meta in metas {
        let id = field(meta, "id");
        gets.insert(id.as_str().unwrap(), response_json(get(id)).into());
    }
    object([("list", response_json(list).into()), ("gets", Value::Object(gets))])
}

fn key_label_answers(ctx: &StoreContext) -> Value {
    let live = list_key_labels(ctx, false).unwrap();
    let mut gets = Object::new();
    for entry in &live {
        let id = field(&Value::from(entry.clone()), "id").as_str().unwrap().to_owned();
        let record =
            get_key_label(ctx, &JsString::from(id.as_str())).map(|record| Some(Value::Object(record)));
        gets.insert(id, key_label_response(record).into());
    }
    let all = list_key_labels(ctx, true).unwrap();
    object([
        (
            "list",
            key_label_response(Ok(Some(Value::Array(live.into_iter().map(Value::from).collect())))).into(),
        ),
        (
            "listAll",
            key_label_response(Ok(Some(Value::Array(all.into_iter().map(Value::from).collect())))).into(),
        ),
        ("gets", Value::Object(gets)),
    ])
}

#[test]
fn writes_a_user_data_tree_for_the_typescript_handlers() {
    let out = out_dir();
    let _ = fs::remove_dir_all(&out);
    let user_data = out.join("user-data");
    fs::create_dir_all(&user_data).unwrap();
    fs::create_dir_all(user_data.join("local")).unwrap();
    fs::write(user_data.join("local/installation-id"), "00000000-0000-4000-8000-00000000f1f0").unwrap();

    let notified = Arc::new(Mutex::new(Vec::<String>::new()));
    let record = Arc::clone(&notified);
    let ctx = StoreContext::new(
        &user_data,
        Arc::new(FixedClock::new(STORE_NOW_MS)),
        Arc::new(WriteLocks::new()),
        Arc::new(move |unit: &str| record.lock().unwrap().push(unit.to_owned())),
    );
    let hub = Arc::new(FakeHub::new());
    hub.set_user("alice@example.com", Some("Alice"), None);
    let clock = Arc::new(Clock { now: CLOCK_START_MS as f64, slept: Mutex::new(Vec::new()) });
    let http = HubHttp::new(FAKE_HUB_BASE, HubRequesters::single(hub.clone()), clock);
    let token = HubToken::new(http, Arc::new(|| Some("test:alice@example.com".to_owned())));
    let http = token.http();

    block_on(async {
        // Key labels: one uploaded (linked with its uploader and Hub time),
        // one downloaded from another account's post (saved under the
        // post's id), then refreshed from the post after the Hub moved it
        // on.
        let local = save_key_label(
            &ctx,
            &KeyLabelSave {
                id: None,
                name: JsString::from("Dvorak 😀"),
                uploader_name: None,
                map: parse(r#"{"KC_Q":"'","KC_W":",","KC_E":"."}"#).unwrap(),
                composite_labels: Some(parse(r#"{"KC_1":"1 !"}"#).unwrap()),
                keymap_applicable: true,
                hub_post_id: None,
                hub_updated_at: None,
                keep_current_name: false,
            },
        )
        .unwrap();
        let local_id = Value::String(local.id().unwrap().clone());
        succeeded(&key_labels::upload(&token, &ctx, Some(&local_id)).await);

        let remote = hub.seed_key_label(
            "bob@example.com",
            "Colemak",
            parse(r#"{"KC_E":"F","KC_R":"P"}"#).unwrap(),
            None,
            false,
            Some("2026-01-01 00:00:05.000Z"),
        );
        let remote_id = field(&remote, "id").clone();
        succeeded(&key_labels::download(http, &ctx, Some(&remote_id)).await);
        hub.touch(RecordKind::KeyLabel, remote_id.as_str().unwrap(), Some("2026-01-02 00:00:00.000Z"))
            .unwrap();
        succeeded(&key_labels::sync(http, &ctx, Some(&remote_id)).await);

        // Language packs: one uploaded; another linked to an older version
        // of another account's post, which the startup update replaces
        // with the Hub's.
        ok(i18n_handlers::list(&ctx));
        let mine = parse(r#"{"name":"Hub 日本語","version":"1.0.0","common":{"save":"保存"}}"#).unwrap();
        let mine_id = id_of(&i18n_handlers::import_apply(&ctx, Some(&mine), None));
        let params = object([("pack", mine), ("entryId", mine_id)]);
        let answer = packs::upload(&token, &ctx, PackKind::I18n, Some(&params)).await;
        assert_eq!(field(&answer, "success"), &Value::Bool(true), "{}", stringify(&answer));

        let theirs = parse(
            r#"{"version":1,"kind":"i18n","exportedAt":"2026-01-01T00:00:00.000Z",
                "pack":{"name":"Français","version":"2.0.0","common":{"save":"Enregistrer","cancel":"Annuler"}}}"#,
        )
        .unwrap();
        let post =
            hub.seed_pack(HubPackKind::I18n, "bob@example.com", &theirs, Some("2026-01-01 00:00:07.000Z"));
        let post_id = field(&post, "id").clone();
        let older = parse(r#"{"name":"Français","version":"1.0.0","common":{"save":"Sauver"}}"#).unwrap();
        let older_id = id_of(&i18n_handlers::import_apply(&ctx, Some(&older), None));
        ok(i18n_handlers::set_hub_post_id(
            &ctx,
            Some(&older_id),
            Some(&post_id),
            Some(&"bob".into()),
            Some(&"2026-01-01 00:00:07.000Z".into()),
        ));
        hub.touch(RecordKind::I18n, post_id.as_str().unwrap(), Some("2026-01-03 00:00:00.000Z")).unwrap();
        let outcome = startup_sync::run(http, &ctx, &|| false).await;
        assert!(outcome.changed(), "{:?}", outcome.report());

        // Theme packs: one uploaded and linked, one uploaded then deleted
        // from the Hub (unlinked).
        let mocha = parse(&repo_file("sample-packs/themes/catppuccin-mocha.json")).unwrap();
        let mocha_id = id_of(&theme_handlers::import_apply(&ctx, Some(&mocha), None).0);
        let params = object([("pack", mocha), ("entryId", mocha_id)]);
        let answer = packs::upload(&token, &ctx, PackKind::Theme, Some(&params)).await;
        assert_eq!(field(&answer, "success"), &Value::Bool(true), "{}", stringify(&answer));
        let latte = parse(&repo_file("sample-packs/themes/catppuccin-latte.json")).unwrap();
        let latte_id = id_of(&theme_handlers::import_apply(&ctx, Some(&latte), None).0);
        let params = object([("pack", latte), ("entryId", latte_id.clone())]);
        let answer = packs::upload(&token, &ctx, PackKind::Theme, Some(&params)).await;
        let latte_post = field(&answer, "postId").clone();
        let answer = packs::delete(&token, &ctx, PackKind::Theme, Some(&latte_post), Some(&latte_id)).await;
        assert_eq!(field(&answer, "success"), &Value::Bool(true), "{}", stringify(&answer));
    });

    // What the stores answer on the finished tree, and the Hub's times of
    // the linked language packs.
    let mut linked = Vec::new();
    let Ok(Some(Value::Array(metas))) = i18n_handlers::list(&ctx) else { panic!() };
    for meta in &metas {
        if let Some(post) = meta.as_object().unwrap().get("hubPostId").filter(|post| post.is_truthy()) {
            linked.push(post.clone());
        }
    }
    assert_eq!(linked.len(), 2);
    let timestamps = block_on(packs::timestamps(http, PackKind::I18n, Some(&Value::Array(linked))));
    let mut answers = Object::new();
    answers.insert("keyLabels", key_label_answers(&ctx));
    answers.insert("i18n", pack_answers(i18n_handlers::list(&ctx), |id| i18n_handlers::get(&ctx, Some(id))));
    answers
        .insert("themes", pack_answers(theme_handlers::list(&ctx), |id| theme_handlers::get(&ctx, Some(id))));
    answers.insert("i18nHubTimestamps", field(&timestamps, "data").clone());
    fs::write(out.join("answers.json"), stringify(&Value::Object(answers))).unwrap();
    assert!(!notified.lock().unwrap().is_empty());
}
