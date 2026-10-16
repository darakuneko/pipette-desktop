// SPDX-License-Identifier: GPL-2.0-or-later
//! Writes a userData tree with the language store of this crate and an
//! Aozora Bunko import, into
//! `src-tauri/target/tmp/pipette-typing-datasets/rust_user_data/`:
//!
//! - `user-data/`: the tree: the Hub overrides of the three providers
//!   (`local/typing-test-dataset.json`), the downloaded word lists (one
//!   moved from the legacy flat directory) and the imported work in the
//!   typing test texts;
//! - `replies.json`: the Hub's answers by URL, with a newer tatoeba
//!   version than its override so that one update check finds an update;
//! - `answers.json`: what the store answers on that tree, as the app's
//!   commands answer it (JSON text).
//!
//! `pnpm run verify:typing-dataset-rust-user-data` then reads a copy of the
//! tree with the real handlers of the Electron build and compares their
//! answers with these, byte for byte.

#![allow(clippy::unwrap_used, clippy::panic)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use pipette_entry_store::{SystemClock, WriteLocks};
use pipette_js_json::{JsString, Object, Value};
use pipette_keyboard_stores::{StoreContext, TypingTextStore, typing_text_response};
use pipette_net::{Http, HttpError, HttpResponse};
use pipette_typing_datasets::{LanguageStore, import_aozora_work};

const HUB: &str = "https://pipette-hub-worker.keymaps.workers.dev";
const BASE: &str = "https://hub.example/languages";
const CARDS: &str = "https://hub.example/aozora/cards";
const WORK: &str = "000001/files/1_ruby_1.zip";

fn out_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("pipette-typing-datasets").join("rust_user_data")
}

fn write(path: &Path, content: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}

/// The zip of a work and its manifest entry, from the first imported work
/// of the recorded Aozora Bunko scenarios.
fn recorded_work() -> (Vec<u8>, Value) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_aozora_import_scenarios.json");
    let scenarios = pipette_js_json::parse(&fs::read_to_string(path).unwrap()).unwrap();
    let scenario = &items(&scenarios)[0];
    let get = |value: &Value, key: &str| value.as_object().unwrap().get(key).unwrap().clone();
    let overrides = get(&get(scenario, "tree"), "local/typing-test-dataset.json");
    let overrides = pipette_js_json::parse(overrides.as_str().unwrap()).unwrap();
    let entry = items(&get(&get(&overrides, "aozora"), "languages"))[0].clone();
    assert_eq!(get(&entry, "name").as_str(), Some(WORK));
    let steps = get(scenario, "steps");
    let step = &items(&steps)[0];
    assert_eq!(get(step, "workId").as_str(), Some(WORK));
    let replies = get(step, "replies");
    let reply = &items(&replies)[0];
    (hex_bytes(get(reply, "hex").as_str().unwrap()), entry)
}

fn word_list(name: &str, words: &[&str]) -> String {
    let words: Vec<String> = words.iter().map(|w| format!("\"{w}\"")).collect();
    format!("{{\"name\":\"{name}\",\"words\":[{}]}}", words.join(","))
}

fn language(name: &str, file_size: usize) -> String {
    format!(r#"{{"name":"{name}","wordCount":3,"rightToLeft":false,"fileSize":{file_size},"extra":"kept"}}"#)
}

fn envelope(data: &str) -> Vec<u8> {
    format!(r#"{{"ok":true,"data":{data}}}"#).into_bytes()
}

fn items(value: &Value) -> &[Value] {
    match value {
        Value::Array(items) => items,
        other => panic!("{other:?}"),
    }
}

fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
}

#[test]
fn writes_a_user_data_tree_for_the_typescript_handlers() {
    let out = out_dir();
    let _ = fs::remove_dir_all(&out);
    let user_data = out.join("user-data");
    fs::create_dir_all(&user_data).unwrap();

    let legacy = word_list("dutch", &["een", "twee", "drie"]);
    let german = word_list("german", &["eins", "zwei", "drei"]);
    let kana = word_list("japanese", &["ねこ", "いぬ", "とり"]);
    let (zip, work) = recorded_work();
    let datasets = [
        (
            "monkeytype",
            format!(
                r#"{{"provider":"monkeytype","version":"m-2","downloadUrlBase":"{BASE}/monkeytype","model":"pack","languages":[{},{},{}]}}"#,
                language("english", 1),
                language("german", german.len()),
                language("dutch", legacy.len()),
            ),
        ),
        (
            "tatoeba",
            format!(
                r#"{{"provider":"tatoeba","version":"t-2","downloadUrlBase":"{BASE}/tatoeba","languages":[{}]}}"#,
                language("japanese", kana.len()),
            ),
        ),
        (
            "aozora",
            format!(
                r#"{{"provider":"aozora","version":"a-2","downloadUrlBase":"{CARDS}","model":"catalog","languages":[{}]}}"#,
                pipette_js_json::stringify(&work),
            ),
        ),
    ];
    let mut replies: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for (provider, dataset) in &datasets {
        let route = format!("{HUB}/api/typing-test/datasets/{provider}");
        let version = pipette_js_json::parse(dataset).unwrap();
        let version = version.as_object().unwrap().get("version").unwrap().clone();
        let version =
            format!(r#"{{"provider":"{provider}","version":{}}}"#, pipette_js_json::stringify(&version));
        replies.insert(format!("{route}/version"), envelope(&version));
        replies.insert(route, envelope(dataset));
    }
    replies.insert(format!("{BASE}/monkeytype/german.json"), german.into_bytes());
    replies.insert(format!("{BASE}/tatoeba/japanese.json"), kana.into_bytes());
    replies.insert(format!("{CARDS}/{WORK}"), zip);

    let http = |replies: &BTreeMap<String, Vec<u8>>| {
        let replies = replies.clone();
        Http::new(move |url: &str| match replies.get(url) {
            Some(body) => Ok(HttpResponse { status: 200, body: body.clone() }),
            None => Err(HttpError::Network(format!("no reply recorded for {url}"))),
        })
    };
    let store = LanguageStore::new(&user_data, http(&replies), || HUB.to_owned());
    let ctx = StoreContext::new(
        &user_data,
        Arc::new(SystemClock),
        Arc::new(WriteLocks::new()),
        Arc::new(|_: &str| {}),
    );
    let texts = TypingTextStore::default();

    block_on(async {
        for (provider, _) in &datasets {
            let update = store.update(Some(provider)).await.unwrap();
            assert!(update.changed, "{provider}");
        }
        store.download("german", Some("monkeytype")).await.unwrap();
        store.download("japanese", Some("tatoeba")).await.unwrap();
        let imported = import_aozora_work(&store, &ctx, &texts, Some(WORK)).await.unwrap();
        assert!(imported.starts_with(r#"{"success":true"#), "{imported}");
    });

    // A word list downloaded by a build before the provider directories,
    // which the store of a new process moves to monkeytype/ when it
    // starts.
    let legacy_path = user_data.join("local/downloads/languages/dutch.json");
    write(&legacy_path, legacy.as_bytes());

    // The Hub has moved on to a newer tatoeba version since the update,
    // so only that provider has an update available.
    replies.insert(
        format!("{HUB}/api/typing-test/datasets/tatoeba/version"),
        envelope(r#"{"provider":"tatoeba","version":"t-3"}"#),
    );

    // What the store answers on the finished tree, from a new process.
    let store = LanguageStore::new(&user_data, http(&replies), || HUB.to_owned());
    let mut answers = Object::new();
    block_on(async {
        store.migrated().await;
        assert!(!legacy_path.exists());
        let mut checks = Object::new();
        for (provider, _) in &datasets {
            let check = store.check(Some(provider)).await.unwrap();
            assert_eq!(check.update_available, *provider == "tatoeba", "{provider}");
            checks.insert(*provider, check.update_available.into());
        }
        answers.insert("checks", Value::Object(checks));
        let mut lists = Object::new();
        for provider in ["monkeytype", "tatoeba", "aozora"] {
            let list = store.list(Some(provider)).await.unwrap();
            lists.insert(provider, pipette_js_json::stringify(&Value::Array(list)).into());
        }
        answers.insert("lists", Value::Object(lists));
        let mut gets = Object::new();
        for (provider, name) in [
            ("monkeytype", "german"),
            ("monkeytype", "dutch"),
            ("tatoeba", "japanese"),
            ("monkeytype", "english"),
        ] {
            let text = store.get(name, Some(provider)).await.unwrap().unwrap_or_else(|| "null".to_owned());
            gets.insert(format!("{provider}/{name}"), text.into());
        }
        answers.insert("gets", Value::Object(gets));
    });

    let texts = TypingTextStore::default();
    let live = texts.list(&ctx, false).unwrap();
    let mut text_gets = Object::new();
    for entry in &live {
        let id =
            Value::from(entry.clone()).as_object().unwrap().get("id").unwrap().as_str().unwrap().to_owned();
        let record = texts.get(&ctx, &JsString::from(id.as_str())).map(|record| Some(Value::Object(record)));
        text_gets.insert(id, typing_text_response(record).into());
    }
    let mut typing_texts = Object::new();
    typing_texts.insert(
        "list",
        typing_text_response(Ok(Some(Value::Array(live.into_iter().map(Value::from).collect())))).into(),
    );
    typing_texts.insert("gets", Value::Object(text_gets));
    answers.insert("typingTexts", Value::Object(typing_texts));

    // The Hub's answers, as hex, for the update checks of the handlers.
    let mut recorded = Object::new();
    for (url, body) in &replies {
        let hex: String = body.iter().map(|b| format!("{b:02x}")).collect();
        recorded.insert(url.as_str(), hex.into());
    }
    write(&out.join("replies.json"), pipette_js_json::stringify(&Value::Object(recorded)).as_bytes());
    write(&out.join("answers.json"), pipette_js_json::stringify(&Value::Object(answers)).as_bytes());
}
