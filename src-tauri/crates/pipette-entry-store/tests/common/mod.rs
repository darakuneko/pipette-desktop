// SPDX-License-Identifier: GPL-2.0-or-later
//! Helpers shared by the spec tests.

#![allow(dead_code, clippy::unwrap_used)]

use pipette_entry_store::{Entry, EntryGroup, EntryStore, normalize_entry};
use pipette_js_json::{Object, Value, parse, stringify};

/// 2026-01-01T00:00:00.000Z plus `s` seconds, in ms.
pub fn ms(s: i64) -> i64 {
    1_767_225_600_000 + s * 1000
}

/// [`ms`] as `toISOString` writes it.
pub fn t(s: i64) -> String {
    pipette_time::iso_8601_millis(ms(s))
}

pub fn obj(text: &str) -> Object {
    match parse(text).unwrap() {
        Value::Object(object) => object,
        other => panic!("not an object: {other:?}"),
    }
}

pub fn json(value: impl Into<Value>) -> String {
    stringify(&value.into())
}

pub fn clocks(entry: &Entry) -> String {
    json(entry.clocks().unwrap().clone())
}

pub fn clock(entry: &Entry, group: EntryGroup) -> String {
    entry.clock(group).and_then(Value::as_str).unwrap().to_owned()
}

pub fn text(entry: &Entry, key: &str) -> Option<String> {
    entry.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// `{"k":v,…}` for the given key / JSON-text pairs.
pub fn fields(pairs: &[(&str, &str)]) -> String {
    let body: Vec<String> = pairs.iter().map(|(k, v)| format!("{k:?}:{v}")).collect();
    format!("{{{}}}", body.join(","))
}

pub fn q(s: &str) -> String {
    format!("{s:?}")
}

const HUB_PRIVATE: &str = r#"{"id":"p","url":"/p?token=x","expiresAt":null}"#;

/// One meta per store with every optional field set.
pub fn full(store: EntryStore) -> Object {
    let (t0, t1, t2) = (q(&t(0)), q(&t(1)), q(&t(2)));
    let text = match store {
        EntryStore::Favorites => fields(&[
            ("id", "\"f\""),
            ("label", "\"L\""),
            ("savedAt", &t1),
            ("filename", "\"f.json\""),
            ("updatedAt", &t2),
            ("hubPostId", "\"h\""),
            ("hubPrivate", HUB_PRIVATE),
        ]),
        EntryStore::Snapshots => fields(&[
            ("id", "\"s\""),
            ("label", "\"L\""),
            ("filename", "\"s.pipette\""),
            ("savedAt", &t1),
            ("updatedAt", &t2),
            ("hubPostId", "\"h\""),
            ("hubPrivate", HUB_PRIVATE),
            ("vilVersion", "2"),
        ]),
        EntryStore::AnalyzeFilters => fields(&[
            ("id", "\"a\""),
            ("label", "\"L\""),
            ("summary", "\"x\""),
            ("filename", "\"a.json\""),
            ("savedAt", &t1),
            ("updatedAt", &t2),
            ("hubPostId", "\"h\""),
            ("hubPrivate", HUB_PRIVATE),
        ]),
        EntryStore::KeyLabels => fields(&[
            ("id", "\"k\""),
            ("name", "\"N\""),
            ("uploaderName", "\"u\""),
            ("hubPostId", "\"h\""),
            ("hubUpdatedAt", &t0),
            ("filename", "\"k.json\""),
            ("savedAt", &t1),
            ("updatedAt", &t2),
        ]),
        EntryStore::TypingTestTexts => fields(&[
            ("id", "\"t\""),
            ("name", "\"N\""),
            ("wordCount", "3"),
            ("lineCount", "1"),
            ("filename", "\"t.json\""),
            ("savedAt", &t1),
            ("updatedAt", &t2),
            ("source", r#"{"provider":"p","workId":"w"}"#),
        ]),
        EntryStore::I18nPacks => fields(&[
            ("id", "\"i\""),
            ("filename", "\"i.json\""),
            ("name", "\"N\""),
            ("version", "\"1.0.0\""),
            ("enabled", "true"),
            ("hubPostId", "\"h\""),
            ("hubUpdatedAt", &t0),
            ("uploaderName", "\"u\""),
            ("savedAt", &t1),
            ("updatedAt", &t2),
            ("appVersionAtImport", "\"1\""),
            ("matchedBaseVersion", "\"1\""),
            ("coverage", r#"{"totalKeys":2,"coveredKeys":1}"#),
            ("dangerousKeyCount", "0"),
        ]),
        EntryStore::ThemePacks => fields(&[
            ("id", "\"th\""),
            ("filename", "\"th.json\""),
            ("name", "\"N\""),
            ("version", "\"1\""),
            ("hubPostId", "\"h\""),
            ("hubUpdatedAt", &t0),
            ("uploaderName", "\"u\""),
            ("savedAt", &t1),
            ("updatedAt", &t2),
        ]),
        EntryStore::RunLogs => fields(&[
            ("id", "\"r\""),
            ("startedAt", &t0),
            ("filename", "\"r.jsonl\""),
            ("savedAt", &t1),
            ("updatedAt", &t2),
        ]),
    };
    obj(&text)
}

/// `object` with `key` set to the value of the JSON text `value`.
pub fn with(mut object: Object, key: &str, value: &str) -> Object {
    object.insert(key, parse(value).unwrap());
    object
}

pub fn without(mut object: Object, key: &str) -> Object {
    object.remove(key);
    object
}

pub fn normalized(store: EntryStore, object: &Object) -> Entry {
    normalize_entry(store, object)
}
