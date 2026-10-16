// SPDX-License-Identifier: GPL-2.0-or-later
//! The run log store, as specified by the TypeScript tests of
//! src/main/__tests__/typing-run-log-store.test.ts, with the size limits
//! at their bounds and the write serialization on top.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::path::PathBuf;
use std::sync::Arc;
use std::thread;

use common::{Harness, ms};
use pipette_entry_store::Entry;
use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::{
    MAX_RUN_LOG_BYTES, MAX_RUN_LOG_EVENTS, MAX_RUN_LOGS_PER_KEYBOARD, RunLogError, get_run_log,
    list_run_logs, save_run_log,
};

const UID: &str = "kb-1";

fn runs_dir(h: &Harness) -> PathBuf {
    h.user_data().join("sync/keyboards").join(UID).join("runs")
}

fn parse(text: &str) -> Value {
    pipette_js_json::parse(text).unwrap()
}

fn object(value: Value) -> Object {
    match value {
        Value::Object(object) => object,
        other => panic!("not an object: {other:?}"),
    }
}

/// A valid log of `run_id` with one word of two keystrokes, with the fields
/// of `extra` set over it.
fn log(run_id: &str, extra: &str) -> Value {
    let mut log = object(parse(&format!(
        r#"{{"runId":"{run_id}","uid":"{UID}","startedAt":"2026-01-01T00:00:00.000Z","durationMs":5000,"mode":"words","language":"english","words":[{{"index":0,"display":"hello","typed":"hello","correct":true,"keystrokes":[{{"pressMs":0,"releaseMs":80,"keycode":1,"row":0,"col":0,"expectedChar":"h","correct":true}},{{"pressMs":100,"releaseMs":180,"keycode":2,"row":0,"col":1,"expectedChar":"e","correct":true}}]}}]}}"#
    )));
    for (key, value) in object(parse(&format!("{{{extra}}}"))).iter() {
        log.insert(key.clone(), value.clone());
    }
    Value::Object(log)
}

fn save(h: &Harness, log: &Value) -> Result<Entry, RunLogError> {
    save_run_log(&h.ctx, UID, Some(log), true)
}

fn error(h: &Harness, log: &Value) -> String {
    save(h, log).unwrap_err().to_string()
}

fn text(entry: &Entry, key: &str) -> String {
    entry.get(key).unwrap().as_str().unwrap().to_owned()
}

fn ids(entries: &[Entry]) -> Vec<String> {
    entries.iter().map(|e| text(e, "id")).collect()
}

fn one_word(keystrokes: &str) -> String {
    format!(r#""words":[{{"index":0,"display":"x","typed":"x","correct":true,"keystrokes":[{keystrokes}]}}]"#)
}

#[test]
fn a_save_writes_the_index_and_the_body_and_reports_the_unit() {
    let h = Harness::new();
    let entry = save(&h, &log("run-1", "")).unwrap();
    assert_eq!(text(&entry, "id"), "run-1");
    assert_eq!(h.notified(), ["keyboards/kb-1/runs"]);

    let index = object(parse(&std::fs::read_to_string(runs_dir(&h).join("index.json")).unwrap()));
    assert_eq!(index.get("uid").unwrap().as_str(), Some(UID));
    let body = std::fs::read_to_string(runs_dir(&h).join(text(&entry, "filename"))).unwrap();
    assert_eq!(body, pipette_js_json::stringify(&log("run-1", "")));
}

#[test]
fn a_save_needs_the_recording_consent() {
    let h = Harness::new();
    let refused = save_run_log(&h.ctx, UID, Some(&log("run-1", "")), false).unwrap_err();
    assert_eq!(refused.to_string(), "Recording consent not accepted");
    assert!(!runs_dir(&h).exists());
}

#[test]
fn unsafe_ids_and_a_uid_other_than_the_keyboard_are_refused() {
    let h = Harness::new();
    let unsafe_uid = save_run_log(&h.ctx, "../evil", Some(&log("run-1", r#""uid":"../evil""#)), true);
    assert_eq!(unsafe_uid.unwrap_err().to_string(), "Invalid uid");
    assert_eq!(error(&h, &log("../../evil", "")), "Invalid runId");
    assert_eq!(error(&h, &log("run-1", r#""uid":"kb-2""#)), "uid mismatch");
    assert_eq!(error(&h, &parse(r#"{"runId":"run-1"}"#)), "uid mismatch");
    assert_eq!(save_run_log(&h.ctx, UID, None, true).unwrap_err().to_string(), "Malformed run log");
}

#[test]
fn keystroke_and_word_checks() {
    let h = Harness::new();
    let word_error = |keystrokes: &str| error(&h, &log("k", &one_word(keystrokes)));
    // A time that looks absolute, and a release before its press.
    assert_eq!(word_error(r#"{"pressMs":1760000000000,"keycode":1,"row":0,"col":0}"#), "Invalid word entry");
    assert_eq!(
        word_error(r#"{"pressMs":500,"releaseMs":100,"keycode":1,"row":0,"col":0}"#),
        "Invalid word entry"
    );
    // NaN and Infinity arrive as null.
    assert_eq!(error(&h, &log("k", r#""durationMs":null"#)), "Invalid durationMs");
    let index = |value: &str| {
        format!(r#""words":[{{"index":{value},"display":"x","typed":"x","correct":true,"keystrokes":[]}}]"#)
    };
    assert_eq!(error(&h, &log("k", &index("null"))), "Invalid word entry");
    assert_eq!(error(&h, &log("k", &index("1.5"))), "Invalid word entry");
    let partial =
        r#""words":[{"index":0,"display":"x","typed":"x","correct":true,"partial":"yes","keystrokes":[]}]"#;
    assert_eq!(error(&h, &log("k", partial)), "Invalid word entry");
    assert_eq!(error(&h, &log("k", r#""romajiInput":"yes""#)), "Invalid romajiInput");
    for field in ["typedChar", "mistakeKey"] {
        let not_string = format!(r#"{{"pressMs":0,"keycode":1,"row":0,"col":0,"{field}":42}}"#);
        assert_eq!(word_error(&not_string), "Invalid word entry");
        let long = format!(r#"{{"pressMs":0,"keycode":1,"row":0,"col":0,"{field}":"{}"}}"#, "x".repeat(1000));
        assert_eq!(word_error(&long), "Invalid word entry");
    }
}

#[test]
fn optional_fields_are_kept_as_sent() {
    let h = Harness::new();
    let partial = r#""words":[{"index":0,"display":"hello","typed":"hello","correct":true,"keystrokes":[]},{"index":1,"display":"world","typed":"wo","correct":false,"partial":true,"keystrokes":[{"pressMs":0,"keycode":1,"row":0,"col":0,"typedChar":"x","mistakeKey":"h"}]}],"romajiInput":true"#;
    save(&h, &log("run-1", partial)).unwrap();
    let saved = object(get_run_log(&h.ctx, UID, "run-1").unwrap());
    assert_eq!(
        pipette_js_json::stringify(&Value::Object(saved)),
        pipette_js_json::stringify(&log("run-1", partial))
    );
}

#[test]
fn the_keystroke_and_size_limits_are_inclusive() {
    let h = Harness::new();
    let keys = |n: usize| one_word(&vec![r#"{"pressMs":0,"keycode":1,"row":0,"col":0}"#; n].join(","));
    assert!(save(&h, &log("at-cap", &keys(MAX_RUN_LOG_EVENTS))).is_ok());
    assert_eq!(error(&h, &log("over-cap", &keys(MAX_RUN_LOG_EVENTS + 1))), "Too many keystrokes");

    let size = pipette_js_json::stringify(&log("big", r#""note":"""#)).len();
    let padded =
        |extra: usize| log("big", &format!(r#""note":"{}""#, "x".repeat(MAX_RUN_LOG_BYTES - size + extra)));
    assert!(save(&h, &padded(0)).is_ok());
    assert_eq!(error(&h, &padded(1)), "Run log too large");
}

#[test]
fn saving_a_run_again_leaves_one_entry_and_one_body() {
    let h = Harness::new();
    h.clock.set(ms("2026-01-01T00:00:00.000Z"));
    let first = save(&h, &log("run-dup", "")).unwrap();
    assert_eq!(text(&first, "filename"), "2026-01-01T00-00-00.000Z_run-dup.json");
    h.clock.set(ms("2026-01-01T00:00:05.000Z"));
    let second = save(&h, &log("run-dup", r#""durationMs":6000"#)).unwrap();
    assert_ne!(text(&first, "filename"), text(&second, "filename"));
    // A re-save moves created and body.
    let clocks = second.get("clocks").unwrap().as_object().unwrap();
    assert_eq!(clocks.get("created").unwrap().as_str(), Some("2026-01-01T00:00:05.000Z"));
    assert_eq!(clocks.get("body").unwrap().as_str(), Some("2026-01-01T00:00:05.000Z"));

    let listed = list_run_logs(&h.ctx, UID).unwrap();
    assert_eq!(ids(&listed), ["run-dup"]);
    assert!(!runs_dir(&h).join(text(&first, "filename")).exists());
    assert!(runs_dir(&h).join(text(&second, "filename")).exists());
}

#[test]
fn a_body_no_entry_names_is_removed_by_the_next_save() {
    let h = Harness::new();
    h.write("sync/keyboards/kb-1/runs/2020-01-01T00-00-00.000Z_orphan-run.json", r#"{"runId":"orphan-run"}"#);
    let entry = save(&h, &log("run-1", "")).unwrap();
    assert!(!runs_dir(&h).join("2020-01-01T00-00-00.000Z_orphan-run.json").exists());
    assert!(runs_dir(&h).join(text(&entry, "filename")).exists());
}

#[test]
fn a_legacy_body_name_moves_to_an_id_carrying_one_on_the_next_save() {
    let h = Harness::new();
    h.write("sync/keyboards/kb-1/runs/legacy.json", r#"{"runId":"old"}"#);
    h.write(
        "sync/keyboards/kb-1/runs/index.json",
        r#"{"uid":"kb-1","entries":[{"id":"old","startedAt":"2025-01-01T00:00:00.000Z","filename":"legacy.json","savedAt":"2025-01-01T00:00:00.000Z"}]}"#,
    );
    save(&h, &log("run-1", "")).unwrap();
    let listed = list_run_logs(&h.ctx, UID).unwrap();
    let old = listed.iter().find(|e| text(e, "id") == "old").unwrap();
    assert_eq!(text(old, "filename"), "legacy_old.json");
    assert!(!runs_dir(&h).join("legacy.json").exists());
    assert_eq!(std::fs::read_to_string(runs_dir(&h).join("legacy_old.json")).unwrap(), r#"{"runId":"old"}"#);
}

#[test]
fn line_breaks_must_be_ascending_integers_before_the_last_word() {
    let h = Harness::new();
    let four_words = |breaks: &str| {
        let words: Vec<String> = (0..4)
            .map(|i| {
                format!(r#"{{"index":{i},"display":"w{i}","typed":"w{i}","correct":true,"keystrokes":[]}}"#)
            })
            .collect();
        log("run-1", &format!(r#""words":[{}],"lineBreaks":{breaks}"#, words.join(",")))
    };
    for bad in [r#""nope""#, "[1.5]", "[2,1]", "[1,1]", "[4]", "[-1]", "[3]"] {
        assert_eq!(error(&h, &four_words(bad)), "Invalid lineBreaks", "{bad}");
    }
    for good in ["[1,2]", "[]", "[2]"] {
        save(&h, &four_words(good)).unwrap();
        let fetched = object(get_run_log(&h.ctx, UID, "run-1").unwrap());
        assert_eq!(pipette_js_json::stringify(fetched.get("lineBreaks").unwrap()), good);
    }
    save(&h, &log("run-1", "")).unwrap();
    assert!(object(get_run_log(&h.ctx, UID, "run-1").unwrap()).get("lineBreaks").is_none());
}

#[test]
fn the_list_puts_the_latest_save_first_and_a_get_reads_the_body() {
    let h = Harness::new();
    save(&h, &log("run-1", r#""startedAt":"2026-01-01T00:00:00.000Z""#)).unwrap();
    save(&h, &log("run-2", r#""startedAt":"2026-01-02T00:00:00.000Z""#)).unwrap();
    assert_eq!(ids(&list_run_logs(&h.ctx, UID).unwrap()), ["run-2", "run-1"]);
    let fetched = object(get_run_log(&h.ctx, UID, "run-1").unwrap());
    assert_eq!(fetched.get("runId").unwrap().as_str(), Some("run-1"));
    assert_eq!(get_run_log(&h.ctx, UID, "no-such-run").unwrap_err().to_string(), "Not found");
}

#[test]
fn the_51st_run_tombstones_and_removes_the_one_that_started_first() {
    let h = Harness::new();
    for i in 0..=MAX_RUN_LOGS_PER_KEYBOARD {
        let started = format!(r#""startedAt":"2026-01-01T00:00:{:02}.000Z""#, i);
        save(&h, &log(&format!("run-{i}"), &started)).unwrap();
    }
    let listed = list_run_logs(&h.ctx, UID).unwrap();
    assert_eq!(listed.len(), MAX_RUN_LOGS_PER_KEYBOARD);
    assert!(!ids(&listed).contains(&"run-0".to_owned()));
    assert!(ids(&listed).contains(&format!("run-{MAX_RUN_LOGS_PER_KEYBOARD}")));

    let index = object(parse(&std::fs::read_to_string(runs_dir(&h).join("index.json")).unwrap()));
    let Some(Value::Array(entries)) = index.get("entries") else { panic!() };
    let evicted = entries
        .iter()
        .map(|e| e.as_object().unwrap())
        .find(|e| e.get("id").unwrap().as_str() == Some("run-0"))
        .unwrap();
    let deleted = ms(evicted.get("deletedAt").unwrap().as_str().unwrap());
    let created =
        ms(evicted.get("clocks").unwrap().as_object().unwrap().get("created").unwrap().as_str().unwrap());
    assert!(deleted >= created);
    assert!(!runs_dir(&h).join(evicted.get("filename").unwrap().as_str().unwrap()).exists());
}

#[test]
fn concurrent_saves_of_one_keyboard_never_lose_a_run() {
    let h = Arc::new(Harness::new());
    let workers: Vec<_> = (0..8)
        .map(|i| {
            let h = Arc::clone(&h);
            thread::spawn(move || save(&h, &log(&format!("run-{i}"), "")).unwrap())
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(list_run_logs(&h.ctx, UID).unwrap().len(), 8);
    let bodies = std::fs::read_dir(runs_dir(&h)).unwrap().count();
    assert_eq!(bodies, 9, "eight bodies and the index");
}
