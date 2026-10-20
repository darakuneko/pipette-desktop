// SPDX-License-Identifier: GPL-2.0-or-later
//! The language store's behaviour, with the dataset sync, the body size
//! limit of the HTTP client and concurrent updates.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use common::{HUB, Harness, block_on};
use pipette_js_json::Value;
use pipette_net::{Http, HttpError, HttpResponse};
use pipette_typing_datasets::{DEFAULT_PROVIDER, LanguageStore, provider_default};

const LANG: &str = "local/downloads/languages";
const OVERRIDES: &str = "local/typing-test-dataset.json";
const HUB_VERSION: &str = "newcommit0000000000000000000000000000000";
const BASE: &str = "https://hub.example/languages";

fn bundled_version() -> String {
    provider_default(DEFAULT_PROVIDER).unwrap().get("version").and_then(Value::as_str).unwrap().to_owned()
}

fn manifest_size(name: &str) -> usize {
    let Some(Value::Array(entries)) = provider_default(DEFAULT_PROVIDER).unwrap().get("languages") else {
        panic!()
    };
    let entry =
        entries.iter().filter_map(Value::as_object).find(|e| e.get("name").unwrap().as_str() == Some(name));
    match entry.unwrap().get("fileSize") {
        Some(Value::Number(size)) => *size as usize,
        _ => panic!(),
    }
}

fn padded(text: &str, size: usize) -> String {
    format!("{text}{}", " ".repeat(size - text.len()))
}

fn ok_json(data: &str) -> String {
    format!(r#"{{"ok":true,"data":{data}}}"#)
}

fn names(entries: &[Value]) -> Vec<String> {
    entries.iter().map(|e| e.as_object().unwrap().get("name").unwrap().as_str().unwrap().to_owned()).collect()
}

fn status_of(entries: &[Value], name: &str) -> String {
    let entry =
        entries.iter().filter_map(Value::as_object).find(|e| e.get("name").unwrap().as_str() == Some(name));
    entry.unwrap().get("status").unwrap().as_str().unwrap().to_owned()
}

#[test]
fn lists_the_manifest_with_bundled_downloaded_and_missing_languages() {
    let h = Harness::new();
    h.write(&format!("{LANG}/monkeytype/german.json"), r#"{"name":"german","words":["hallo"]}"#);
    let list = block_on(h.store.list(None)).unwrap();
    assert_eq!(status_of(&list, "english"), "bundled");
    assert_eq!(status_of(&list, "german"), "downloaded");
    assert_eq!(status_of(&list, "french"), "not-downloaded");
    // Hub-only providers list nothing until an override arrives.
    assert!(block_on(h.store.list(Some("tatoeba"))).unwrap().is_empty());
    assert!(block_on(h.store.list(Some("aozora"))).unwrap().is_empty());
}

#[test]
fn gets_a_downloaded_word_list_and_nothing_else() {
    let h = Harness::new();
    let data = r#"{"name":"test_lang","words":["hello","world"],"rightToLeft":false}"#;
    h.write(&format!("{LANG}/monkeytype/test_lang.json"), data);
    h.write(&format!("{LANG}/monkeytype/bad.json"), "not json");
    h.write(&format!("{LANG}/monkeytype/nowords.json"), r#"{"name":"nowords"}"#);
    let get = |name: &str| block_on(h.store.get(name, None)).unwrap();
    assert_eq!(get("test_lang").as_deref(), Some(data));
    for name in ["english", "nonexistent", "../etc/passwd", "foo/bar", "bad", "nowords", ""] {
        assert_eq!(get(name), None, "{name}");
    }
}

#[test]
fn downloads_from_the_pinned_url_when_the_size_matches() {
    let h = Harness::new();
    let size = manifest_size("german");
    h.ok(&padded(r#"{"name":"german","words":["a","b","c"]}"#, size));
    block_on(h.store.download("german", None)).unwrap();
    let url = &h.urls()[0];
    assert!(url.contains(&bundled_version()), "{url}");
    assert!(url.ends_with("/german.json"));
    assert!(h.read(&format!("{LANG}/monkeytype/german.json")).is_some());
}

#[test]
fn a_download_fails_without_writing() {
    let h = Harness::new();
    let size = manifest_size("german");
    let download = |name: &str| block_on(h.store.download(name, None));

    h.ok(&padded(r#"{"name":"german","words":["a"]}"#, size * 2));
    assert!(download("german").unwrap_err().contains("size mismatch"));
    h.reply(Ok(HttpResponse { status: 404, body: Vec::new() }));
    assert_eq!(download("german").unwrap_err(), "HTTP 404");
    h.ok(&padded(r#"{"name":"bad"}"#, size));
    assert_eq!(download("german").unwrap_err(), "Invalid language data");
    // Past the client's body limit: a size mismatch.
    h.reply(Err(HttpError::TooLarge { limit: 64 }));
    assert_eq!(
        download("german").unwrap_err(),
        format!("Integrity check failed: size mismatch (expected {size}, got more than 64)")
    );
    h.reply(Err(HttpError::Timeout));
    assert_eq!(download("german").unwrap_err(), "the request timed out");
    assert_eq!(h.read(&format!("{LANG}/monkeytype/german.json")), None);

    // No request for these.
    let asked = h.urls().len();
    assert_eq!(download("english").unwrap_err(), "Language is bundled");
    assert_eq!(download("../etc/passwd").unwrap_err(), "Invalid language name");
    assert_eq!(download("not_in_manifest").unwrap_err(), "Unknown language");
    assert_eq!(h.urls().len(), asked);
}

#[test]
fn deletes_a_downloaded_word_list() {
    let h = Harness::new();
    h.write(&format!("{LANG}/monkeytype/test.json"), "{}");
    assert!(block_on(h.store.delete("english", None)).is_err());
    block_on(h.store.delete("test", None)).unwrap();
    assert_eq!(h.read(&format!("{LANG}/monkeytype/test.json")), None);
    assert!(block_on(h.store.delete("nonexistent", None)).unwrap_err().starts_with("Error: "));
}

#[test]
fn an_unknown_provider_is_the_default_one_for_the_word_lists() {
    let h = Harness::new();
    h.write(&format!("{LANG}/monkeytype/test_lang.json"), r#"{"name":"test_lang","words":["x"]}"#);
    h.write("local/downloads/victim.json", "{}");
    assert!(block_on(h.store.get("test_lang", Some("../../"))).unwrap().is_some());
    block_on(h.store.delete("victim", Some("../.."))).unwrap_err();
    assert!(h.read("local/downloads/victim.json").is_some());
}

#[test]
fn moves_flat_legacy_downloads_before_answering() {
    let h = Harness::new();
    h.write(&format!("{LANG}/german.json"), r#"{"name":"german","words":["hallo"]}"#);
    let list = block_on(h.store.list(Some("monkeytype"))).unwrap();
    assert_eq!(status_of(&list, "german"), "downloaded");
    assert!(h.read(&format!("{LANG}/monkeytype/german.json")).is_some());
    assert_eq!(h.read(&format!("{LANG}/german.json")), None);
}

#[test]
fn a_check_is_kept_for_the_session_unless_the_hub_fails() {
    let h = Harness::new();
    h.reply(Err(HttpError::Network("offline".into())));
    assert!(!block_on(h.store.check(None)).unwrap().update_available);
    h.ok(&ok_json(&format!(r#"{{"provider":"monkeytype","version":"{HUB_VERSION}"}}"#)));
    let check = block_on(h.store.check(Some("monkeytype"))).unwrap();
    assert_eq!((check.provider.as_str(), check.update_available), ("monkeytype", true));
    // Kept: no second request.
    assert!(block_on(h.store.check(Some(""))).unwrap().update_available);
    assert_eq!(h.urls(), vec![format!("{HUB}/api/typing-test/datasets/monkeytype/version"); 2]);
}

#[test]
fn an_update_writes_the_override_and_clears_the_downloads() {
    let mut h = Harness::new();
    h.write(&format!("{LANG}/monkeytype/german.json"), "{}");
    h.ok(&ok_json(&format!(r#"{{"provider":"monkeytype","version":"{HUB_VERSION}"}}"#)));
    let fresh = format!(
        r#"{{"provider":"monkeytype","version":"{HUB_VERSION}","downloadUrlBase":"{BASE}","languages":[{{"name":"spanish","wordCount":500,"rightToLeft":false,"fileSize":4}}]}}"#
    );
    h.ok(&ok_json(&fresh));
    let update = block_on(h.store.update(None)).unwrap();
    assert!(update.changed);
    assert_eq!(*update.to_version.as_ref().unwrap(), *HUB_VERSION);
    assert_eq!(h.read(OVERRIDES).unwrap(), format!(r#"{{"monkeytype":{fresh}}}"#));
    assert_eq!(h.read(&format!("{LANG}/monkeytype/german.json")), None);
    // Applied, so no update is pending this session.
    assert!(!block_on(h.store.check(None)).unwrap().update_available);

    // The override is in effect, after a restart too.
    h.restart();
    assert_eq!(names(&block_on(h.store.list(None)).unwrap()), ["spanish"]);
    h.ok("xxxx");
    block_on(h.store.download("spanish", None)).unwrap_err();
    assert_eq!(h.urls().last().unwrap(), &format!("{BASE}/spanish.json"));
}

#[test]
fn an_unknown_provider_without_an_override_cannot_be_checked() {
    let h = Harness::new();
    assert_eq!(
        block_on(h.store.check(Some("nope"))).unwrap_err().to_string(),
        "Unknown typing-test provider: nope"
    );
    assert!(block_on(h.store.update(Some("nope"))).is_err());
    assert!(h.urls().is_empty());
}

#[test]
fn concurrent_updates_of_two_providers_keep_both() {
    let dir = tempfile::TempDir::new().unwrap();
    // Answers by URL, so the two updates can ask in any order.
    let http = Http::new(|url: &str| {
        let (provider, version_route) = match url.strip_prefix(&format!("{HUB}/api/typing-test/datasets/")) {
            Some(rest) => match rest.strip_suffix("/version") {
                Some(provider) => (provider.to_owned(), true),
                None => (rest.to_owned(), false),
            },
            None => panic!("unexpected {url}"),
        };
        let data = if version_route {
            format!(r#"{{"provider":"{provider}","version":"v"}}"#)
        } else {
            format!(r#"{{"provider":"{provider}","version":"v","downloadUrlBase":"{BASE}","languages":[]}}"#)
        };
        Ok(HttpResponse { status: 200, body: ok_json(&data).into_bytes() })
    });
    let store = LanguageStore::new(dir.path(), http, || HUB.to_owned());
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).build().unwrap();
    let (tatoeba, aozora) = (store.clone(), store.clone());
    let (a, b) = runtime.block_on(async move {
        let a = tokio::spawn(async move { tatoeba.update(Some("tatoeba")).await });
        let b = tokio::spawn(async move { aozora.update(Some("aozora")).await });
        (a.await.unwrap(), b.await.unwrap())
    });
    assert!(a.unwrap().changed && b.unwrap().changed);
    let written = std::fs::read_to_string(dir.path().join(OVERRIDES)).unwrap();
    let written = pipette_js_json::parse(&written).unwrap();
    let written = written.as_object().unwrap();
    assert!(written.contains_key("tatoeba") && written.contains_key("aozora"), "{written:?}");
}
