// SPDX-License-Identifier: GPL-2.0-or-later
#![allow(clippy::unwrap_used)]

use std::sync::{Arc, Mutex};

use pipette_entry_store::{FixedClock, WriteLocks};
use pipette_js_json::parse;
use pipette_keyboard_stores::list_key_labels;

use super::*;
use crate::fake::{FakeHub, Fault};
use crate::http::{HubRequesters, SystemTiming};

struct Setup {
    hub: Arc<FakeHub>,
    token: HubToken,
    stores: StoreContext,
    notified: Arc<Mutex<Vec<String>>>,
    _dir: tempfile::TempDir,
}

/// A store in a temporary userData and a Hub token on the in-memory Hub,
/// signed in as alice, whose display name is Alice.
fn setup() -> Setup {
    let hub = Arc::new(FakeHub::new());
    hub.set_user("alice@example.com", Some("Alice"), None);
    let http = HubHttp::new("http://127.0.0.1:9", HubRequesters::single(hub.clone()), Arc::new(SystemTiming));
    let token = HubToken::new(http, Arc::new(|| Some("test:alice@example.com".to_owned())));
    let dir = tempfile::tempdir().unwrap();
    let notified = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&notified);
    let stores = StoreContext::new(
        dir.path(),
        Arc::new(FixedClock::new(1_792_108_800_000)),
        Arc::new(WriteLocks::new()),
        Arc::new(move |unit: &str| record.lock().unwrap().push(unit.to_owned())),
    );
    Setup { hub, token, stores, notified, _dir: dir }
}

fn json(text: &str) -> Value {
    parse(text).unwrap()
}

fn answer(text: &str) -> Object {
    json(text).as_object().unwrap().clone()
}

fn get<'a>(object: &'a Object, path: &[&str]) -> &'a Value {
    let mut value = object.get(path[0]).unwrap_or_else(|| {
        panic!("no {} in {}", path[0], pipette_js_json::stringify(&Value::Object(object.clone())))
    });
    for key in &path[1..] {
        value = value.as_object().unwrap().get(key).unwrap_or_else(|| panic!("no {key}"));
    }
    value
}

fn text<'a>(object: &'a Object, path: &[&str]) -> &'a str {
    get(object, path).as_str().unwrap()
}

/// Saves a local label with no Hub link.
fn local_label(stores: &StoreContext, id: &str, name: &str, map: &str) {
    let save = KeyLabelSave {
        id: Some(id.into()),
        name: name.into(),
        uploader_name: None,
        map: json(map),
        composite_labels: None,
        keymap_applicable: false,
        hub_post_id: None,
        hub_updated_at: None,
        keep_current_name: false,
    };
    save_key_label(stores, &save).unwrap();
}

fn meta(stores: &StoreContext, id: &str) -> Object {
    let entries = list_key_labels(stores, true).unwrap();
    let entry = entries.into_iter().find(|entry| entry.id().is_some_and(|found| *found == *id)).unwrap();
    Value::from(entry).as_object().unwrap().clone()
}

#[test]
fn the_body_leaves_out_what_is_not_given_and_always_sends_the_keymap_mark() {
    let mut input = KeyLabelInput {
        name: Some(Value::from("Eucalyn")),
        map: Some(json(r#"{"KC_B":"B","1":"one"}"#)),
        ..KeyLabelInput::default()
    };
    assert_eq!(
        build_body(&input),
        r#"{"name":"Eucalyn","map":{"1":"one","KC_B":"B"},"keymap_applicable":false}"#
    );
    input.composite_labels = Some(Value::Null);
    input.keymap_applicable = true;
    assert_eq!(
        build_body(&input),
        r#"{"name":"Eucalyn","map":{"1":"one","KC_B":"B"},"composite_labels":null,"keymap_applicable":true}"#
    );
    assert_eq!(build_body(&KeyLabelInput::default()), r#"{"keymap_applicable":false}"#);
}

#[tokio::test]
async fn a_label_goes_up_comes_back_and_is_unlinked() {
    let s = setup();
    local_label(&s.stores, "local-1", "Mine", r#"{"KC_A":"あ"}"#);

    // Upload: linked with the post's uploader and Hub time.
    let up = answer(&upload(&s.token, &s.stores, Some(&Value::from("local-1"))).await);
    assert_eq!(get(&up, &["success"]), &Value::Bool(true), "{up:?}");
    let post_id = text(&up, &["data", "hubPostId"]).to_owned();
    assert_eq!(text(&up, &["data", "uploaderName"]), "Alice");
    let uploaded_at = text(&up, &["data", "hubUpdatedAt"]).to_owned();
    assert_eq!(s.notified.lock().unwrap().last().map(String::as_str), Some("key-labels"));

    // The list and the detail show it; the timestamps name it once.
    let listed = answer(&list(s.token.http(), Some(&json(r#"{"q":" min "}"#))).await);
    let Value::Array(items) = get(&listed, &["data", "items"]) else { panic!("items") };
    assert_eq!(items.len(), 1);
    let shown = answer(&detail(s.token.http(), Some(&Value::from(post_id.as_str()))).await);
    assert_eq!(text(&shown, &["data", "name"]), "Mine");
    let ids = Value::Array(vec![Value::from(post_id.as_str()), Value::from(post_id.as_str())]);
    let stamps = answer(&timestamps(s.token.http(), Some(&ids)).await);
    assert_eq!(get(&stamps, &["data", "items"]).clone(), {
        let item: Object =
            [("id", Value::from(post_id.as_str())), ("updated_at", Value::from(uploaded_at.as_str()))]
                .into_iter()
                .collect();
        Value::Array(vec![Value::Object(item)])
    });

    // Update keeps the uploader and takes the new Hub time.
    s.hub.set_user("alice@example.com", Some("Renamed"), None);
    let updated = answer(&update(&s.token, &s.stores, Some(&Value::from("local-1"))).await);
    assert_eq!(text(&updated, &["data", "uploaderName"]), "Alice");
    assert_eq!(text(&updated, &["data", "hubPostId"]), post_id);

    // Delete removes the post and unlinks the label, which stays.
    let deleted = delete(&s.token, &s.stores, Some(&Value::from("local-1"))).await;
    assert_eq!(deleted, r#"{"success":true}"#);
    let unlinked = meta(&s.stores, "local-1");
    assert!(unlinked.get("hubPostId").is_none() && unlinked.get("hubUpdatedAt").is_none());
    assert!(unlinked.get("deletedAt").is_none());
    let gone = detail(s.token.http(), Some(&Value::from(post_id.as_str()))).await;
    assert!(
        gone.starts_with(
            r#"{"success":false,"errorCode":"IO_ERROR","error":"Hub key-label fetch failed: 404 "#
        ),
        "{gone}"
    );
    let again = delete(&s.token, &s.stores, Some(&Value::from("local-1"))).await;
    assert_eq!(again, r#"{"success":false,"errorCode":"NOT_FOUND","error":"Entry has no hub post"}"#);
}

#[tokio::test]
async fn a_download_takes_the_post_id_and_a_sync_keeps_the_local_name() {
    let s = setup();
    let seeded = s.hub.seed_key_label(
        "bob@example.com",
        "Eucalyn",
        json(r#"{"KC_A":"A"}"#),
        Some(json(r#"{"LSFT(KC_1)":"!"}"#)),
        true,
        Some("2026-10-01 00:00:00.000Z"),
    );
    let post_id = seeded.as_object().unwrap().get("id").unwrap().as_str().unwrap().to_owned();
    let down = answer(&download(s.token.http(), &s.stores, Some(&Value::from(post_id.as_str()))).await);
    assert_eq!(text(&down, &["data", "id"]), post_id);
    assert_eq!(text(&down, &["data", "hubPostId"]), post_id);
    assert_eq!(text(&down, &["data", "uploaderName"]), "bob");
    assert_eq!(text(&down, &["data", "hubUpdatedAt"]), "2026-10-01 00:00:00.000Z");

    // Renamed here, changed on the Hub: the sync takes the Hub's map and
    // time and keeps the local name.
    pipette_keyboard_stores::rename_key_label(&s.stores, &post_id.as_str().into(), &"Local name".into())
        .unwrap();
    s.hub.touch(crate::fake::RecordKind::KeyLabel, &post_id, Some("2026-10-09 00:00:00.000Z"));
    let synced = answer(&sync(s.token.http(), &s.stores, Some(&Value::from(post_id.as_str()))).await);
    assert_eq!(text(&synced, &["data", "name"]), "Local name");
    assert_eq!(text(&synced, &["data", "hubUpdatedAt"]), "2026-10-09 00:00:00.000Z");

    // A detail that fails keeps the cached uploader and Hub time.
    s.hub.inject(Fault { only: Some("keyLabels.get".to_owned()), ..Fault::new(500, 1) });
    let kept = answer(&sync(s.token.http(), &s.stores, Some(&Value::from(post_id.as_str()))).await);
    assert_eq!(text(&kept, &["data", "uploaderName"]), "bob");
    assert_eq!(text(&kept, &["data", "hubUpdatedAt"]), "2026-10-09 00:00:00.000Z");

    let bad = download(s.token.http(), &s.stores, Some(&Value::from("a/b"))).await;
    assert_eq!(bad, r#"{"success":false,"errorCode":"NOT_FOUND","error":"Invalid hub post id"}"#);
}

#[tokio::test]
async fn a_name_the_hub_has_is_a_duplicate() {
    let s = setup();
    s.hub.seed_key_label("bob@example.com", "Taken", json("{}"), None, false, None);
    local_label(&s.stores, "local-1", "Taken", "{}");
    let refused = upload(&s.token, &s.stores, Some(&Value::from("local-1"))).await;
    assert_eq!(refused, r#"{"success":false,"errorCode":"DUPLICATE_NAME","error":"KEY_LABEL_DUPLICATE"}"#);
    assert!(meta(&s.stores, "local-1").get("hubPostId").is_none());
    let missing = upload(&s.token, &s.stores, Some(&Value::from("nope"))).await;
    assert_eq!(missing, r#"{"success":false,"errorCode":"NOT_FOUND","error":"Key label not found"}"#);
    let invalid = upload(&s.token, &s.stores, Some(&Value::from(5.0))).await;
    assert_eq!(invalid, r#"{"success":false,"errorCode":"NOT_FOUND","error":"Invalid id"}"#);
}

#[tokio::test]
async fn the_timestamps_go_100_ids_to_a_request_in_the_order_given() {
    let s = setup();
    let ids: Vec<Value> = (0..250).map(|n| Value::from(format!("id-{n}"))).collect();
    let none = timestamps(s.token.http(), Some(&Value::Array(ids))).await;
    assert_eq!(none, r#"{"success":true,"data":{"items":[]}}"#);
    let sent: Vec<usize> = s
        .hub
        .requests()
        .iter()
        .map(|request| parse(&String::from_utf8(request.body.clone().unwrap()).unwrap()).unwrap())
        .map(|body| match body.as_object().unwrap().get("ids").unwrap() {
            Value::Array(ids) => ids.len(),
            _ => panic!("ids"),
        })
        .collect();
    let mut sizes = sent.clone();
    sizes.sort_unstable();
    assert_eq!(sizes, [50, 100, 100]);

    let empty = timestamps(s.token.http(), Some(&Value::Array(Vec::new()))).await;
    assert_eq!(empty, r#"{"success":true,"data":{"items":[]}}"#);
    let invalid = timestamps(s.token.http(), Some(&json(r#"["ok","bad id"]"#))).await;
    assert!(invalid.contains("ids must be an array of valid hub post ids"));
}

#[tokio::test]
async fn the_list_asks_for_page_1_of_20_unless_told() {
    let s = setup();
    for params in [None, Some(json(r#"{"page":"3","perPage":true,"q":""}"#)), Some(json(r#"[1]"#))] {
        s.hub.clear_requests();
        let listed = answer(&list(s.token.http(), params.as_ref()).await);
        assert_eq!(get(&listed, &["success"]), &Value::Bool(true));
        let query = s.hub.requests()[0].query.clone();
        let expected = match params.as_ref().and_then(Value::as_object) {
            Some(_) => vec![("page".to_owned(), "3".to_owned()), ("per_page".to_owned(), "1".to_owned())],
            None => vec![("page".to_owned(), "1".to_owned()), ("per_page".to_owned(), "20".to_owned())],
        };
        assert_eq!(query, expected);
    }
    let odd = list(s.token.http(), Some(&json(r#"{"q":5}"#))).await;
    assert_eq!(odd, r#"{"success":false,"errorCode":"IO_ERROR","error":"query.q.trim is not a function"}"#);
}

#[tokio::test]
async fn a_rate_limited_download_is_not_retried() {
    let s = setup();
    let seeded = s.hub.seed_key_label("bob@example.com", "Eucalyn", json("{}"), None, false, None);
    let post_id = seeded.as_object().unwrap().get("id").unwrap().as_str().unwrap().to_owned();
    s.hub.inject(Fault {
        retry_after: Some("1".to_owned()),
        only: Some("keyLabels.download".to_owned()),
        ..Fault::new(429, 1)
    });
    let limited = answer(&download(s.token.http(), &s.stores, Some(&Value::from(post_id.as_str()))).await);
    assert!(text(&limited, &["error"]).starts_with("Hub key-label download failed: 429 "), "{limited:?}");
    assert_eq!(text(&limited, &["errorCode"]), "IO_ERROR");
    assert_eq!(s.hub.requests().len(), 1);
}

#[tokio::test]
async fn a_stale_jwt_is_replaced_and_a_deactivated_account_is_reported() {
    let s = setup();
    local_label(&s.stores, "local-1", "Mine", "{}");
    let up = answer(&upload(&s.token, &s.stores, Some(&Value::from("local-1"))).await);
    assert_eq!(get(&up, &["success"]), &Value::Bool(true));
    s.hub.revoke_tokens();
    s.hub.clear_requests();
    let updated = answer(&update(&s.token, &s.stores, Some(&Value::from("local-1"))).await);
    assert_eq!(get(&updated, &["success"]), &Value::Bool(true), "{updated:?}");
    let tokens = s.hub.requests().iter().filter(|request| request.path == "/api/auth/token").count();
    assert_eq!(tokens, 1);

    s.hub.set_user("alice@example.com", Some("Alice"), Some(false));
    let refused = delete(&s.token, &s.stores, Some(&Value::from("local-1"))).await;
    assert_eq!(refused, r#"{"success":false,"errorCode":"IO_ERROR","error":"ACCOUNT_DEACTIVATED"}"#);
    assert!(meta(&s.stores, "local-1").get("hubPostId").is_some());
}
