// SPDX-License-Identifier: GPL-2.0-or-later
//! The favorite reads, checks and posts, on the in-memory Hub.

#![allow(clippy::unwrap_used)]

use std::path::Path;
use std::sync::Arc;

use pipette_js_json::{Value, parse, stringify};
use pipette_net::Method;

use super::*;
use crate::fake::{FAKE_HUB_BASE, FAKE_HUB_BOUNDARY, FakeHub, Fault};
use crate::http::{HubHttp, HubRequesters, SystemTiming};
use crate::token::{HUB_ERROR_ACCOUNT_DEACTIVATED, HubToken};

fn value(text: &str) -> Value {
    parse(text).unwrap()
}

fn write(dir: &Path, path: &str, text: &str) {
    let path = dir.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

/// A sync directory with a tap dance favorite store whose index is
/// `entries`, and the bodies `bodies` (file name, text).
fn store(entries: &str, bodies: &[(&str, &str)]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    write(
        dir.path(),
        "favorites/tapDance/index.json",
        &format!(r#"{{"type":"tapDance","entries":{entries}}}"#),
    );
    for (name, text) in bodies {
        write(dir.path(), &format!("favorites/tapDance/{name}"), text);
    }
    dir
}

const BODY: &str = r#"{"type":"tapDance","data":{"onTap":4}}"#;

fn read(dir: &Path, entry_id: &str) -> Result<String, String> {
    read_entry(dir, Some(&Value::from("tapDance")), Some(&Value::from(entry_id)))
        .map(|entry| stringify(&entry))
}

#[test]
fn reads_the_first_live_entry_as_the_index_has_it() {
    let dir = store(
        r#"[{"id":"a","filename":"gone.json","deletedAt":"2026-01-01"},
            {"id":"a","filename":"a.json","label":5,"extra":1,"deletedAt":""},
            {"id":"a","filename":"b.json"}]"#,
        &[("a.json", BODY)],
    );
    // The label is kept as it is, a missing save time stays missing, and an
    // empty `deletedAt` is not deleted.
    assert_eq!(
        read(dir.path(), "a").unwrap(),
        format!(r#"{{"label":5,"body":{}}}"#, stringify(&Value::from(BODY)))
    );
    let entry = read_entry(dir.path(), Some(&Value::from("tapDance")), Some(&Value::from("a"))).unwrap();
    assert_eq!(entry_answer(Ok(entry)).as_object().unwrap().get("success"), Some(&Value::Bool(true)));
}

#[test]
fn an_entry_that_cannot_be_posted_has_the_ts_message() {
    let dir = store(
        r#"[{"id":"del","filename":"a.json","deletedAt":"x"},
            {"id":"up","filename":"../a.json"},
            {"id":"dot","filename":".."},
            {"id":"obj","filename":{}},
            {"id":"num","filename":12},
            {"id":"none"},
            {"id":"empty","filename":"empty.json"},
            {"id":"nodata","filename":"nodata.json"},
            {"id":"other","filename":"other.json"},
            {"id":"null","filename":"null.json"},
            {"id":"missing","filename":"missing.json"}]"#,
        &[
            ("a.json", BODY),
            ("empty.json", r#"{"type":"tapDance","data":null}"#),
            ("nodata.json", r#"[1]"#),
            ("other.json", r#"{"type":"macro","data":[]}"#),
            ("null.json", "null"),
        ],
    );
    let dir = dir.path();
    for (id, error) in [
        ("nope", "Entry not found"),
        ("del", "Entry not found"),
        ("up", "Invalid filename"),
        ("dot", "Invalid filename"),
        ("obj", "Invalid filename"),
        ("num", "The \"path\" argument must be of type string. Received type number (12)"),
        ("none", "The \"path\" argument must be of type string. Received undefined"),
        ("empty", "Entry data is empty"),
        ("nodata", "Entry data is empty"),
        ("other", "Entry type mismatch"),
        ("null", "Cannot read properties of null (reading 'data')"),
    ] {
        assert_eq!(read(dir, id).unwrap_err(), error, "{id}");
    }
    let missing = read(dir, "missing").unwrap_err();
    assert!(missing.starts_with("ENOENT: no such file or directory, open '"), "{missing}");
    assert_eq!(
        read_entry(dir, Some(&Value::from("nope")), Some(&Value::from("a"))).unwrap_err(),
        "Invalid favorite type"
    );
    assert_eq!(read_entry(dir, None, None).unwrap_err(), "Invalid favorite type");
}

#[test]
fn an_index_of_another_shape_fails_as_the_ts_reads_it() {
    for (index, error) in [
        ("null", "Cannot read properties of null (reading 'entries')"),
        ("5", "Cannot read properties of undefined (reading 'find')"),
        ("[]", "index.entries.find is not a function"),
        ("{}", "Cannot read properties of undefined (reading 'find')"),
        (r#"{"entries":null}"#, "Cannot read properties of null (reading 'find')"),
        (r#"{"entries":{}}"#, "index.entries.find is not a function"),
        (r#"{"entries":[null]}"#, "Cannot read properties of null (reading 'id')"),
        (r#"{"entries":[1,"a"]}"#, "Entry not found"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "favorites/tapDance/index.json", index);
        assert_eq!(read(dir.path(), "a").unwrap_err(), error, "{index}");
    }
    let empty = tempfile::tempdir().unwrap();
    assert!(read(empty.path(), "a").unwrap_err().starts_with("ENOENT: "));
}

fn params(text: &str) -> Value {
    value(text)
}

fn checked(text: &str) -> Result<FavoritePost, String> {
    check_post(Some(&params(text))).map_err(|err| err.message)
}

#[test]
fn checks_the_type_then_the_protocol_then_the_title() {
    assert_eq!(
        checked(r#"{"type":"nope","vialProtocol":-1,"title":""}"#).unwrap_err(),
        "Invalid favorite type"
    );
    assert_eq!(
        checked(r#"{"type":"macro","vialProtocol":-1,"title":""}"#).unwrap_err(),
        "Invalid vialProtocol"
    );
    assert_eq!(checked(r#"{"type":"macro","vialProtocol":1.5}"#).unwrap_err(), "Invalid vialProtocol");
    assert_eq!(checked(r#"{"type":"macro","vialProtocol":"6"}"#).unwrap_err(), "Invalid vialProtocol");
    assert_eq!(checked(r#"{"type":"macro","vialProtocol":6}"#).unwrap_err(), "Title must not be empty");
    assert_eq!(
        checked(r#"{"type":"macro","vialProtocol":6,"title":" "}"#).unwrap_err(),
        "Title must not be empty"
    );
    let long = format!(r#"{{"type":"macro","vialProtocol":6,"title":"{}"}}"#, "x".repeat(201));
    assert_eq!(checked(&long).unwrap_err(), "Title too long");
    for (ty, post_type) in FAVORITE_TYPES {
        let post = checked(&format!(r#"{{"type":"{ty}","vialProtocol":0,"title":" T "}}"#)).unwrap();
        assert_eq!(post, FavoritePost { title: "T".to_owned(), post_type });
    }
    assert_eq!(check_post(None).unwrap_err().message, "Cannot read properties of undefined (reading 'type')");
}

#[test]
fn the_post_id_is_checked_as_a_string() {
    let id = |text: &str| check_post_id(Some(&params(text))).map_err(|err| err.message);
    assert_eq!(id(r#"{"postId":"a_b-1"}"#).unwrap(), "a_b-1");
    assert_eq!(id(r#"{"postId":12}"#).unwrap(), "12");
    for bad in [r#"{"postId":"bad id"}"#, r#"{"postId":""}"#, r#"{"postId":0}"#, r#"{}"#, r#"{"postId":{}}"#]
    {
        assert_eq!(id(bad).unwrap_err(), "Invalid post ID", "{bad}");
    }
}

fn on_fake_hub() -> (HubToken, Arc<FakeHub>) {
    let hub = Arc::new(FakeHub::new());
    let http = HubHttp::new(FAKE_HUB_BASE, HubRequesters::single(hub.clone()), Arc::new(SystemTiming));
    (HubToken::new(http, Arc::new(|| Some("test:alice@example.com".to_owned()))), hub)
}

const EXPORT: &str = r#"{"app":"pipette","version":3,"scope":"fav","exportedAt":"2026-01-01T00:00:00.000Z","vial_protocol":6,"categories":{"td":[]}}"#;
const UPLOAD: &str = r#"{"type":"tapDance","entryId":"e","title":"Line\r\nbreak","vialProtocol":6}"#;

fn posts(hub: &FakeHub) -> Vec<crate::fake::LoggedRequest> {
    hub.requests().into_iter().filter(|request| request.path != "/api/auth/token").collect()
}

/// The multipart body of `request` with its boundary as `{b}`.
fn multipart_text(request: &crate::fake::LoggedRequest) -> String {
    let content_type = request.header("Content-Type").unwrap();
    let boundary = content_type.strip_prefix("multipart/form-data; boundary=").unwrap();
    assert!(boundary.starts_with("----PipetteBoundary"), "{boundary}");
    String::from_utf8(request.body.clone().unwrap()).unwrap().replace(boundary, "{b}")
}

#[tokio::test]
async fn uploads_the_title_the_post_type_and_the_json_file() {
    let (token, hub) = on_fake_hub();
    let answer = stringify(&upload(&token, Some(&params(UPLOAD)), EXPORT).await);
    assert!(answer.starts_with(r#"{"success":true,"postId":""#), "{answer}");
    let sent = posts(&hub);
    assert_eq!(sent.len(), 1);
    assert_eq!((sent[0].method, sent[0].path.as_str()), (Method::Post, "/api/files"));
    assert!(sent[0].header("Authorization").unwrap().starts_with("Bearer "));
    assert_eq!(
        multipart_text(&sent[0]),
        format!(
            "--{{b}}\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\nLine break\r\n\
             --{{b}}\r\nContent-Disposition: form-data; name=\"post_type\"\r\n\r\ntd\r\n\
             --{{b}}\r\nContent-Disposition: form-data; name=\"json\"; filename=\"td.json\"\r\nContent-Type: application/json\r\n\r\n{EXPORT}\r\n\
             --{{b}}--\r\n"
        )
    );
    // The in-memory Hub's clock starts where its boundary says.
    assert!(FAKE_HUB_BOUNDARY.starts_with("----PipetteBoundary"));
}

#[tokio::test]
async fn updates_at_the_encoded_post_id_and_uploads_privately_with_the_expiry() {
    let (token, hub) = on_fake_hub();
    let created = upload(&token, Some(&params(UPLOAD)), EXPORT).await;
    let post_id = created.as_object().unwrap().get("postId").unwrap().as_str().unwrap().to_owned();
    let update_params =
        format!(r#"{{"type":"tapDance","entryId":"e","title":"T","vialProtocol":6,"postId":"{post_id}"}}"#);
    let updated = stringify(&update(&token, Some(&params(&update_params)), EXPORT).await);
    assert_eq!(updated, format!(r#"{{"success":true,"postId":"{post_id}"}}"#));
    assert_eq!(posts(&hub).last().unwrap().method, Method::Put);
    assert_eq!(posts(&hub).last().unwrap().path, format!("/api/files/{post_id}"));

    let bad = r#"{"type":"tapDance","entryId":"e","title":"T","vialProtocol":6,"postId":"a b"}"#;
    assert_eq!(
        stringify(&update(&token, Some(&params(bad)), EXPORT).await),
        r#"{"success":false,"error":"Invalid post ID"}"#
    );

    let private = r#"{"type":"tapDance","entryId":"e","title":"T","vialProtocol":6,"expiresInDays":7}"#;
    let answer = upload_private(&token, Some(&params(private)), EXPORT).await;
    let answer = answer.as_object().unwrap();
    assert_eq!(answer.get("success"), Some(&Value::Bool(true)));
    let keys: Vec<String> = answer.keys().map(|key| key.to_string_lossy().into_owned()).collect();
    assert_eq!(keys, ["success", "id", "url", "expiresAt"]);
    let sent = posts(&hub);
    let last = sent.last().unwrap();
    assert_eq!(last.path, "/api/private/files");
    assert!(multipart_text(last).ends_with("name=\"expires_in_days\"\r\n\r\n7\r\n--{b}--\r\n"));

    let no_expiry = r#"{"type":"tapDance","entryId":"e","title":"T","vialProtocol":6,"expiresInDays":null}"#;
    upload_private(&token, Some(&params(no_expiry)), EXPORT).await;
    assert!(!multipart_text(posts(&hub).last().unwrap()).contains("expires_in_days"));
}

#[tokio::test]
async fn the_hub_failures_are_the_ts_messages() {
    let (token, hub) = on_fake_hub();
    let error =
        |answer: Value| answer.as_object().unwrap().get("error").unwrap().as_str().unwrap().to_owned();

    let only = || Some("files.create".to_owned());
    hub.inject(Fault {
        body: Some(r#"{"ok":false,"error":"Taken"}"#.to_owned()),
        only: only(),
        ..Fault::new(409, 1)
    });
    assert_eq!(
        error(upload(&token, Some(&params(UPLOAD)), EXPORT).await),
        r#"Hub feature upload failed: 409 {"ok":false,"error":"Taken"}"#
    );
    hub.inject(Fault { only: only(), ..Fault::new(403, 1) });
    assert_eq!(error(upload(&token, Some(&params(UPLOAD)), EXPORT).await), HUB_ERROR_ACCOUNT_DEACTIVATED);
    hub.inject(Fault { body: Some("oops".to_owned()), only: only(), ..Fault::new(500, 1) });
    assert_eq!(
        error(upload(&token, Some(&params(UPLOAD)), EXPORT).await),
        "Hub feature upload failed: 500 oops"
    );

    // A JWT the Hub no longer knows is replaced once.
    hub.revoke_tokens();
    let answer = stringify(&upload(&token, Some(&params(UPLOAD)), EXPORT).await);
    assert!(answer.starts_with(r#"{"success":true"#), "{answer}");
}

#[test]
fn an_answer_without_data_fails_as_the_ts_reads_it() {
    let failed = |data: Option<Value>| stringify(&post_id_answer(Ok(data)));
    assert_eq!(
        failed(None),
        r#"{"success":false,"error":"Cannot read properties of undefined (reading 'id')"}"#
    );
    assert_eq!(
        failed(Some(Value::Null)),
        r#"{"success":false,"error":"Cannot read properties of null (reading 'id')"}"#
    );
    assert_eq!(failed(Some(value(r#""text""#))), r#"{"success":true}"#);
    assert_eq!(
        stringify(&private_answer(Ok(Some(value(r#"{"url":"/p","id":"x","expires_at":null}"#))))),
        r#"{"success":true,"id":"x","url":"/p","expiresAt":null}"#
    );
}

#[test]
fn the_hub_vial_protocol_check() {
    for (input, ok) in [
        (Some(value("0")), true),
        (Some(value("-0")), true),
        (Some(value("9007199254740992")), true),
        (Some(value("-1")), false),
        (Some(value("1.5")), false),
        (Some(Value::Number(f64::NAN)), false),
        (Some(Value::Number(f64::INFINITY)), false),
        (Some(value(r#""6""#)), false),
        (Some(Value::Null), false),
        (None, false),
    ] {
        assert_eq!(is_valid_hub_vial_protocol(input.as_ref()), ok, "{input:?}");
    }
}
