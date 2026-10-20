// SPDX-License-Identifier: GPL-2.0-or-later
//! The typing test text store, with the save options
//! the Aozora Bunko import and the confirmed overwrite use (a catalog
//! source, the current name kept, a tombstone brought back).

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::fs;
use std::path::PathBuf;

use common::{Harness, T0, id, ms};
use pipette_entry_store::Entry;
use pipette_js_json::{JsString, Object, Value};
use pipette_keyboard_stores::{
    TYPING_TEXT_MAX_FILE_BYTES, TYPING_TEXT_SYNC_UNIT, TypingTextError, TypingTextSave, TypingTextSource,
    TypingTextStore,
};

fn input(name: &str, text: &str) -> TypingTextSave {
    TypingTextSave::new(name, text)
}

fn save(h: &Harness, store: &TypingTextStore, name: &str, text: &str) -> Entry {
    store.save(&h.ctx, &input(name, text)).unwrap()
}

fn id_of(entry: &Entry) -> JsString {
    entry.id().unwrap().clone()
}

fn number(entry: &Entry, key: &str) -> f64 {
    match entry.get(key) {
        Some(Value::Number(n)) => *n,
        other => panic!("{key}: {other:?}"),
    }
}

fn romaji(entry: &Entry) -> Option<bool> {
    match entry.get("romajiCapable") {
        Some(Value::Bool(b)) => Some(*b),
        None => None,
        other => panic!("romajiCapable: {other:?}"),
    }
}

fn data_text(record: &Object) -> String {
    let data = record.get("data").unwrap().as_object().unwrap();
    data.get("text").unwrap().as_str().unwrap().to_owned()
}

fn meta_of(record: &Object) -> &Object {
    record.get("meta").unwrap().as_object().unwrap()
}

fn code(err: &TypingTextError) -> &'static str {
    err.code()
}

fn store_dir(h: &Harness) -> PathBuf {
    h.user_data().join("sync").join(TYPING_TEXT_SYNC_UNIT)
}

fn file(h: &Harness, name: &str, bytes: &[u8]) -> PathBuf {
    let path = h.user_data().join(name);
    fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn a_save_writes_the_text_and_the_meta_and_reports_the_unit() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    let saved = save(&h, &store, "My Novel", "the quick brown fox");
    assert_eq!(number(&saved, "wordCount"), 4.0);
    assert_eq!(number(&saved, "lineCount"), 1.0);
    assert_eq!(id_of(&saved), JsString::from(id(1).as_str()));
    assert_eq!(h.notified(), [TYPING_TEXT_SYNC_UNIT]);

    let metas = store.list(&h.ctx, false).unwrap();
    assert_eq!(metas.len(), 1);
    assert_eq!(metas[0].get("name").unwrap().as_str(), Some("My Novel"));
    assert!(store_dir(&h).join("index.json").is_file());
}

#[test]
fn a_save_refuses_empty_text_and_names_and_live_duplicates() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    assert_eq!(code(&store.save(&h.ctx, &input("Empty", "   \n\t  ")).unwrap_err()), "EMPTY_TEXT");
    assert_eq!(code(&store.save(&h.ctx, &input("   ", "hello world")).unwrap_err()), "INVALID_NAME");
    save(&h, &store, "Dup", "one two");
    let dup = store.save(&h.ctx, &input("dup", "three four")).unwrap_err();
    assert_eq!(
        (code(&dup), dup.to_string().as_str()),
        ("DUPLICATE_NAME", "A text with the same name already exists")
    );
    let long = store.save(&h.ctx, &input(&format!("{}😀", "a".repeat(99)), "x")).unwrap_err();
    assert_eq!(long.to_string(), "name must be at most 100 characters");
}

#[test]
fn a_save_with_an_id_overwrites_in_place() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    let first = save(&h, &store, "Doc", "a b c");
    let again = TypingTextSave { id: Some(id_of(&first)), ..input("Doc", "a b c d e") };
    store.save(&h.ctx, &again).unwrap();
    let metas = store.list(&h.ctx, false).unwrap();
    assert_eq!(metas.len(), 1);
    assert_eq!(number(&metas[0], "wordCount"), 5.0);
}

#[test]
fn a_catalog_source_round_trips_and_a_file_import_has_none() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    let source =
        TypingTextSource { provider: "aozora".into(), work_id: "001257/files/59898_ruby_70679.zip".into() };
    let saved = store
        .save(&h.ctx, &TypingTextSave { source: Some(source), ..input("Catalog Work", "a b c") })
        .unwrap();
    let want = r#"{"provider":"aozora","workId":"001257/files/59898_ruby_70679.zip"}"#;
    assert_eq!(pipette_js_json::stringify(saved.get("source").unwrap()), want);
    let listed = store.list(&h.ctx, false).unwrap();
    assert_eq!(pipette_js_json::stringify(listed[0].get("source").unwrap()), want);

    save(&h, &store, "Plain", "a b c");
    assert_eq!(store.list(&h.ctx, false).unwrap()[1].get("source"), None);
}

#[test]
fn a_malformed_source_in_the_index_is_dropped() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    save(&h, &store, "Corrupt", "a b c");
    let path = store_dir(&h).join("index.json");
    for bad in [r#"{"provider":"aozora","workId":12345}"#, r#""aozora""#, "null", "[]"] {
        let text = fs::read_to_string(&path).unwrap();
        let mut index = pipette_js_json::parse(&text).unwrap();
        let Value::Object(root) = &mut index else { panic!() };
        let Some(Value::Array(entries)) = root.get("entries").cloned() else { panic!() };
        let Value::Object(mut entry) = entries[0].clone() else { panic!() };
        entry.insert("source", pipette_js_json::parse(bad).unwrap());
        root.insert("entries", Value::Array(vec![Value::Object(entry)]));
        fs::write(&path, pipette_js_json::stringify(&index)).unwrap();
        let metas = store.list(&h.ctx, false).unwrap();
        assert_eq!(metas.len(), 1, "{bad}");
        assert_eq!(metas[0].get("source"), None, "{bad}");
    }
}

#[test]
fn a_get_reads_the_stored_text_with_the_line_structure() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    let read = save(&h, &store, "Read", "  hello   world  ");
    assert_eq!(data_text(&store.get(&h.ctx, &id_of(&read)).unwrap()), "  hello world");
    let multi = save(&h, &store, "Multi", "the quick brown\nfox jumps\n\nover");
    assert_eq!(number(&multi, "wordCount"), 6.0);
    assert_eq!(data_text(&store.get(&h.ctx, &id_of(&multi)).unwrap()), "the quick brown\nfox jumps\nover");
    let missing = store.get(&h.ctx, &"nope".into()).unwrap_err();
    assert_eq!((code(&missing), missing.to_string().as_str()), ("NOT_FOUND", "Text not found"));
}

#[test]
fn a_body_filename_outside_the_directory_is_refused() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    h.write(
        "sync/typing-test-texts/index.json",
        r#"{"entries":[{"id":"evil-entry","name":"Evil","wordCount":1,"lineCount":1,"filename":"../../etc/passwd","savedAt":"2025-01-01T00:00:00.000Z","updatedAt":"2025-01-01T00:00:00.000Z"}]}"#,
    );
    let err = store.get(&h.ctx, &"evil-entry".into()).unwrap_err();
    assert_eq!((code(&err), err.to_string().as_str()), ("IO_ERROR", "Error: Invalid filename"));
    assert_eq!(romaji(&store.list(&h.ctx, false).unwrap()[0]), Some(false));
}

#[test]
fn a_rename_changes_the_name_the_get_shows_and_refuses_duplicates() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    let old = save(&h, &store, "Old", "x y z");
    let renamed = store.rename(&h.ctx, &id_of(&old), &"New".into()).unwrap();
    assert_eq!(renamed.get("name").unwrap().as_str(), Some("New"));
    let record = store.get(&h.ctx, &id_of(&old)).unwrap();
    let data = record.get("data").unwrap().as_object().unwrap();
    assert_eq!(data.get("name").unwrap().as_str(), Some("New"));

    save(&h, &store, "A", "a");
    let b = save(&h, &store, "B", "b");
    assert_eq!(code(&store.rename(&h.ctx, &id_of(&b), &"a".into()).unwrap_err()), "DUPLICATE_NAME");
    assert_eq!(code(&store.rename(&h.ctx, &"missing".into(), &"Z".into()).unwrap_err()), "NOT_FOUND");
}

#[test]
fn a_delete_leaves_a_tombstone_and_frees_the_name() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    let gone = save(&h, &store, "Gone", "bye");
    store.delete(&h.ctx, &id_of(&gone)).unwrap();
    assert!(store.list(&h.ctx, false).unwrap().is_empty());
    let all = store.list(&h.ctx, true).unwrap();
    assert_eq!(all.len(), 1);
    assert!(all[0].is_deleted());
    save(&h, &store, "gone", "two");
    assert_eq!(code(&store.delete(&h.ctx, &"missing".into()).unwrap_err()), "NOT_FOUND");
}

#[test]
fn an_import_names_the_text_after_the_file() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    let poem = file(&h, "poem.txt", b"roses are red");
    let saved = store.import_file(&h.ctx, &poem).unwrap();
    assert_eq!(saved.get("name").unwrap().as_str(), Some("poem"));
    assert_eq!(number(&saved, "wordCount"), 3.0);
    let dotfile = file(&h, ".bashrc", b"x");
    assert_eq!(
        store.import_file(&h.ctx, &dotfile).unwrap().get("name").unwrap().as_str(),
        Some("Imported text")
    );
    let dotted = file(&h, " a.b.c ", b"y");
    assert_eq!(store.import_file(&h.ctx, &dotted).unwrap().get("name").unwrap().as_str(), Some("a.b"));
}

#[test]
fn an_import_refuses_files_that_are_not_utf8_or_too_large() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    let sjis = file(&h, "sjis.txt", &[0x82, 0xa0, 0x82, 0xa2]);
    let err = store.import_file(&h.ctx, &sjis).unwrap_err();
    assert_eq!((code(&err), err.to_string().as_str()), ("NOT_UTF8", "File must be UTF-8 encoded"));
    let size = usize::try_from(TYPING_TEXT_MAX_FILE_BYTES).unwrap();
    let big = file(&h, "big.txt", &vec![b'a'; size + 1]);
    let err = store.import_file(&h.ctx, &big).unwrap_err();
    assert_eq!((code(&err), err.to_string().as_str()), ("TOO_LARGE", "File exceeds the size limit"));
    let limit = file(&h, "limit.txt", &b"ab ".repeat(size / 3 + 1)[..size]);
    assert_eq!(number(&store.import_file(&h.ctx, &limit).unwrap(), "wordCount"), 5000.0);
    let missing = store.import_file(&h.ctx, &h.user_data().join("missing.txt")).unwrap_err();
    assert_eq!(code(&missing), "IO_ERROR");
    assert!(missing.to_string().starts_with("Error: "));
}

#[test]
fn an_import_strips_a_byte_order_mark() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    let bom = file(&h, "bom.txt", "\u{feff}hello world".as_bytes());
    let saved = store.import_file(&h.ctx, &bom).unwrap();
    assert_eq!(number(&saved, "wordCount"), 2.0);
    assert_eq!(data_text(&store.get(&h.ctx, &id_of(&saved)).unwrap()), "hello world");
}

#[test]
fn an_import_over_a_live_name_waits_for_the_confirmation() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    let doc = file(&h, "doc.txt", b"one two");
    let first = store.import_file(&h.ctx, &doc).unwrap();
    fs::write(&doc, "one two three four").unwrap();
    let held = store.import_file(&h.ctx, &doc).unwrap_err();
    assert_eq!((code(&held), held.to_string().as_str()), ("DUPLICATE_NAME", "doc"));
    assert_eq!(number(&store.list(&h.ctx, false).unwrap()[0], "wordCount"), 2.0);

    // A rename made while the prompt is open stays.
    store.rename(&h.ctx, &id_of(&first), &"Renamed".into()).unwrap();
    let confirmed = store.confirm_import(&h.ctx).unwrap();
    assert_eq!(id_of(&confirmed), id_of(&first));
    assert_eq!(confirmed.get("name").unwrap().as_str(), Some("Renamed"));
    let metas = store.list(&h.ctx, false).unwrap();
    assert_eq!(metas.len(), 1);
    assert_eq!(number(&metas[0], "wordCount"), 4.0);

    let none = store.confirm_import(&h.ctx).unwrap_err();
    assert_eq!((code(&none), none.to_string().as_str()), ("NOT_FOUND", "No pending import to confirm"));
}

#[test]
fn an_import_without_a_collision_drops_the_held_one() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    let doc = file(&h, "doc.txt", b"one two");
    store.import_file(&h.ctx, &doc).unwrap();
    assert_eq!(code(&store.import_file(&h.ctx, &doc).unwrap_err()), "DUPLICATE_NAME");
    store.import_file(&h.ctx, &file(&h, "other.txt", b"x")).unwrap();
    assert_eq!(code(&store.confirm_import(&h.ctx).unwrap_err()), "NOT_FOUND");
}

#[test]
fn a_confirmed_import_over_a_deleted_text_brings_it_back() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    let doc = file(&h, "doc.txt", b"one two");
    let first = store.import_file(&h.ctx, &doc).unwrap();
    assert_eq!(code(&store.import_file(&h.ctx, &doc).unwrap_err()), "DUPLICATE_NAME");
    store.delete(&h.ctx, &id_of(&first)).unwrap();
    let back = store.confirm_import(&h.ctx).unwrap();
    assert_eq!(id_of(&back), id_of(&first));
    assert!(!back.is_deleted());
    assert_eq!(back.get("name").unwrap().as_str(), Some("doc"));
}

#[test]
fn romaji_capable_follows_the_content_and_is_never_stored() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    let kana = save(&h, &store, "Kana", "こんにちは せかい");
    assert_eq!(romaji(&store.list(&h.ctx, false).unwrap()[0]), Some(true));
    assert_eq!(romaji(&store.list(&h.ctx, true).unwrap()[0]), Some(true));
    save(&h, &store, "Mixed", "hello 世界");
    assert_eq!(romaji(&store.list(&h.ctx, false).unwrap()[1]), Some(false));
    let record = store.get(&h.ctx, &id_of(&kana)).unwrap();
    assert_eq!(meta_of(&record).get("romajiCapable"), Some(&Value::Bool(true)));

    store.rename(&h.ctx, &id_of(&kana), &"Renamed".into()).unwrap();
    let index = fs::read_to_string(store_dir(&h).join("index.json")).unwrap();
    assert!(!index.contains("romajiCapable"));
    for entry in fs::read_dir(store_dir(&h)).unwrap() {
        assert!(!fs::read_to_string(entry.unwrap().path()).unwrap().contains("romajiCapable"));
    }

    h.clock.set(ms(T0) + 1);
    let changed = TypingTextSave { id: Some(id_of(&kana)), ..input("Renamed", "kanji 漢字") };
    store.save(&h.ctx, &changed).unwrap();
    assert_eq!(romaji(&store.list(&h.ctx, false).unwrap()[0]), Some(false));
}

#[test]
fn romaji_capable_is_cached_by_the_body_filename() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    let kana = save(&h, &store, "Kana", "かな");
    let filename = kana.filename().unwrap().as_str().unwrap().to_owned();
    // The body changes behind the store's back under the same name: the
    // cached answer stands.
    fs::write(store_dir(&h).join(&filename), r#"{"name":"Kana","text":"latin"}"#).unwrap();
    assert_eq!(romaji(&store.list(&h.ctx, false).unwrap()[0]), Some(true));
    // A new store reads the body.
    let fresh = TypingTextStore::default();
    assert_eq!(romaji(&fresh.list(&h.ctx, false).unwrap()[0]), Some(false));
}

#[test]
fn two_saves_at_once_both_land() {
    let (h, store) = (Harness::new(), TypingTextStore::default());
    std::thread::scope(|scope| {
        let a = scope.spawn(|| store.save(&h.ctx, &input("Alpha", "one two")).unwrap());
        let b = scope.spawn(|| store.save(&h.ctx, &input("Beta", "three four")).unwrap());
        a.join().unwrap();
        b.join().unwrap();
    });
    let names: Vec<String> = store
        .list(&h.ctx, false)
        .unwrap()
        .iter()
        .map(|e| e.get("name").unwrap().as_str().unwrap().to_owned())
        .collect();
    assert!(names.contains(&"Alpha".to_owned()) && names.contains(&"Beta".to_owned()), "{names:?}");
}
