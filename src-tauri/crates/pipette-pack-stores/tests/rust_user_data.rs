// SPDX-License-Identifier: GPL-2.0-or-later
//! Writes a userData tree with the language and theme pack stores of this
//! crate and the pending state of pipette-sync-pending, the way the app
//! does (every change goes to the pending store), into
//! `src-tauri/target/tmp/pipette-pack-stores/rust_user_data/`:
//!
//! - `user-data/`: the tree;
//! - `answers.json`: what the stores answer on that tree, as the app's
//!   commands answer it (the handlers' `{success, …}` JSON text).
//!
//! `pnpm run verify:pack-store-rust-user-data` then reads a copy of the
//! tree with the real handlers of the Electron build and compares their
//! answers with these, byte for byte.

#![allow(clippy::unwrap_used, clippy::panic)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pipette_entry_store::{SystemClock, WriteLocks};
use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::StoreContext;
use pipette_pack_stores::{PackResult, i18n_handlers, response_json, theme_handlers};
use pipette_sync_pending::{PendingStore, Scheduler};

/// Drops the delayed writes: the test writes the pending state once, at
/// the end, as the quit sequence does.
struct NoDelayedWrites;

impl Scheduler for NoDelayedWrites {
    fn schedule(&self, _delay: Duration, _task: Box<dyn FnOnce() + Send>) {}
}

fn out_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("pipette-pack-stores").join("rust_user_data")
}

fn repo_file(path: &str) -> String {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    fs::read_to_string(root.join(path)).unwrap()
}

fn parse(text: &str) -> Value {
    pipette_js_json::parse(text).unwrap()
}

/// The id of the meta a handler answered.
fn id_of(answer: &PackResult<Option<Value>>) -> Value {
    match answer {
        Ok(Some(Value::Object(meta))) => meta.get("id").unwrap().clone(),
        other => panic!("{other:?}"),
    }
}

fn ok(answer: PackResult<Option<Value>>) {
    assert!(answer.is_ok(), "{answer:?}");
}

/// The list's answer, and each live pack's get by id.
fn answers_of(list: PackResult<Option<Value>>, get: impl Fn(&Value) -> PackResult<Option<Value>>) -> Value {
    let Ok(Some(Value::Array(metas))) = &list else { panic!("{list:?}") };
    let mut gets = Object::new();
    for meta in metas {
        let id = meta.as_object().unwrap().get("id").unwrap();
        gets.insert(id.as_str().unwrap(), response_json(get(id)).into());
    }
    let mut answer = Object::new();
    answer.insert("list", response_json(list).into());
    answer.insert("gets", Value::Object(gets));
    Value::Object(answer)
}

#[test]
fn writes_a_user_data_tree_for_the_typescript_handlers() {
    let out = out_dir();
    let _ = fs::remove_dir_all(&out);
    let user_data = out.join("user-data");
    fs::create_dir_all(&user_data).unwrap();

    let pending = PendingStore::restore(&user_data, Arc::new(NoDelayedWrites), Box::new(|_| {}));
    let notified = Arc::new(Mutex::new(Vec::<String>::new()));
    let ctx = {
        let pending = pending.clone();
        let notified = Arc::clone(&notified);
        StoreContext::new(
            &user_data,
            Arc::new(SystemClock),
            Arc::new(WriteLocks::new()),
            Arc::new(move |unit: &str| {
                notified.lock().unwrap().push(unit.to_owned());
                pending.notify_change(unit);
            }),
        )
    };

    // Language packs: English from the first list, two sample packs
    // imported with their coverage, a hand-made one with non-ASCII keys,
    // a rename, enabling, a Hub link, a reorder and a delete.
    ok(i18n_handlers::list(&ctx));
    let coverage = parse(
        r#"{"enabled":true,"appVersionAtImport":"1.2.3","matchedBaseVersion":"0.9.0",
            "coverage":{"totalKeys":10,"coveredKeys":9},"dangerousKeyCount":0}"#,
    );
    let japanese = parse(&repo_file("sample-packs/i18n/i18n-packs-Japanese.json"));
    let japanese_id = id_of(&i18n_handlers::import_apply(&ctx, Some(&japanese), Some(&coverage)));
    let gal = parse(&repo_file("sample-packs/i18n/i18n-packs-Japanese_-_ギャル.json"));
    let gal_id = id_of(&i18n_handlers::import_apply(&ctx, Some(&gal), None));
    let custom = parse(
        r#"{"name":"  Custom 😀  ","version":" 2.0.0 ","10":"ten","2":"two","common":{"save":"保存","-0":-0}}"#,
    );
    let custom_id = id_of(&i18n_handlers::import_apply(&ctx, Some(&custom), Some(&coverage)));
    ok(i18n_handlers::rename(&ctx, Some(&gal_id), Some(&"ギャル 改".into())));
    ok(i18n_handlers::set_enabled(&ctx, Some(&gal_id), Some(&false.into())));
    ok(i18n_handlers::set_hub_post_id(
        &ctx,
        Some(&japanese_id),
        Some(&"hub-ja".into()),
        Some(&" uploader ".into()),
        Some(&"2026-05-01T00:00:00.000Z".into()),
    ));
    ok(i18n_handlers::reorder(
        &ctx,
        Some(&Value::Array(vec![custom_id.clone(), "builtin-english".into(), japanese_id])),
    ));
    let gone = parse(r#"{"name":"Gone","version":"1.0.0"}"#);
    let gone_id = id_of(&i18n_handlers::import_apply(&ctx, Some(&gone), None));
    ok(i18n_handlers::delete(&ctx, Some(&gone_id)));

    // Theme packs: two sample themes, a rename, a Hub link, a reorder and a
    // delete.
    let mocha = parse(&repo_file("sample-packs/themes/catppuccin-mocha.json"));
    let mocha_id = id_of(&theme_handlers::import_apply(&ctx, Some(&mocha), None).0);
    let latte = parse(&repo_file("sample-packs/themes/catppuccin-latte.json"));
    let options = parse(
        r#"{"hubPostId":"hub-latte","uploaderName":"someone","hubUpdatedAt":"2026-06-01T00:00:00.000Z"}"#,
    );
    let latte_id = id_of(&theme_handlers::import_apply(&ctx, Some(&latte), Some(&options)).0);
    ok(theme_handlers::rename(&ctx, Some(&mocha_id), Some(&"モカ 😀".into())).0);
    ok(theme_handlers::set_hub_post_id(&ctx, Some(&mocha_id), Some(&"hub-mocha".into()), None, None).0);
    ok(theme_handlers::reorder(&ctx, Some(&Value::Array(vec![latte_id, mocha_id]))).0);
    let gruvbox = parse(&repo_file("sample-packs/themes/gruvbox-dark.json"));
    let gruvbox_id = id_of(&theme_handlers::import_apply(&ctx, Some(&gruvbox), None).0);
    ok(theme_handlers::delete(&ctx, Some(&gruvbox_id)).0);

    // What the stores answer on the finished tree.
    let mut answers = Object::new();
    answers.insert("i18n", answers_of(i18n_handlers::list(&ctx), |id| i18n_handlers::get(&ctx, Some(id))));
    answers
        .insert("themes", answers_of(theme_handlers::list(&ctx), |id| theme_handlers::get(&ctx, Some(id))));
    let mut has_name = Object::new();
    has_name.insert(
        "i18n",
        response_json(i18n_handlers::has_name(&ctx, Some(&" custom 😀 ".into()), None)).into(),
    );
    has_name.insert(
        "themes",
        response_json(theme_handlers::has_name(&ctx, Some(&"モカ 😀".into()), None)).into(),
    );
    answers.insert("hasName", Value::Object(has_name));

    pending.persist_now();
    let mut units: Vec<String> = Vec::new();
    for unit in notified.lock().unwrap().iter() {
        if !units.contains(unit) {
            units.push(unit.clone());
        }
    }
    answers.insert("pendingUnits", Value::Array(units.into_iter().map(Value::from).collect()));
    fs::write(out.join("answers.json"), pipette_js_json::stringify(&Value::Object(answers))).unwrap();
}
