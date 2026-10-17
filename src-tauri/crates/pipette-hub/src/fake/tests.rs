// SPDX-License-Identifier: GPL-2.0-or-later
//! What the conformance cases do not cover: the request log, the records
//! made directly, and the injected faults' order.

use pipette_js_json::{Value, parse, stringify};
use pipette_net::{HttpReply, HttpRequest, HttpRequester, Method};

use super::*;

fn send(hub: &FakeHub, method: Method, target: &str, auth: Option<&str>, json: Option<&str>) -> HttpReply {
    let mut headers = Vec::new();
    if let Some(jwt) = auth {
        headers.push(("Authorization".to_owned(), format!("Bearer {jwt}")));
    }
    if json.is_some() {
        headers.push(("Content-Type".to_owned(), "application/json".to_owned()));
    }
    let request = HttpRequest {
        method,
        url: format!("{FAKE_HUB_BASE}{target}"),
        headers,
        body: json.map(|text| text.as_bytes().to_vec()),
    };
    let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
    runtime.block_on(hub.request(request)).unwrap()
}

fn data(reply: &HttpReply) -> Value {
    let body = parse(std::str::from_utf8(&reply.body).unwrap()).unwrap();
    body.as_object().and_then(|object| object.get("data")).cloned().unwrap_or(Value::Null)
}

fn field(value: &Value, key: &str) -> String {
    value
        .as_object()
        .and_then(|object| object.get(key))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

#[test]
fn logs_each_request_with_its_route_and_account() {
    let hub = FakeHub::new();
    let token =
        send(&hub, Method::Post, "/api/auth/token", None, Some(r#"{"id_token":"test:a@example.com"}"#));
    let jwt = field(&data(&token), "token");
    send(&hub, Method::Get, "/api/files/me?page=2", Some(&jwt), None);
    send(&hub, Method::Get, "/api/nowhere", None, None);
    let log = hub.requests();
    assert_eq!(log.len(), 3);
    assert_eq!((log[0].op, log[0].account.as_deref()), (Some("auth.token"), None));
    assert_eq!((log[1].op, log[1].account.as_deref()), (Some("files.me"), Some("a@example.com")));
    assert_eq!(log[1].query, [("page".to_owned(), "2".to_owned())]);
    assert_eq!(log[1].header("authorization"), Some(format!("Bearer {jwt}").as_str()));
    assert_eq!(log[2].op, None);
    hub.clear_requests();
    assert!(hub.requests().is_empty());
}

#[test]
fn records_made_directly_are_served() {
    let hub = FakeHub::new();
    let post = hub.seed_post("b@example.com", "From elsewhere", Some("KB"), None);
    assert_eq!(field(&post, "uploader_name"), "b");
    let export =
        parse(r#"{"version":1,"kind":"i18n","exportedAt":"x","pack":{"name":"P","version":"1.0.0"}}"#)
            .unwrap();
    let pack = hub.seed_pack(PackKind::I18n, "b@example.com", &export, None);
    let id = field(&pack, "id");
    let before = field(&pack, "updated_at");
    let after = hub.touch(RecordKind::I18n, &id, None).unwrap();
    assert!(after > before);
    assert_eq!(hub.touch(RecordKind::Theme, &id, None), None);
    let download = send(&hub, Method::Get, &format!("/api/i18n-packs/{id}/download"), None, None);
    assert_eq!(parse(std::str::from_utf8(&download.body).unwrap()).unwrap(), export);
    hub.reset();
    assert_eq!(send(&hub, Method::Get, &format!("/api/i18n-packs/{id}"), None, None).status, 404);
}

#[test]
fn faults_apply_in_order_and_only_to_their_route() {
    let hub = FakeHub::new();
    hub.inject(Fault::new(500, 1).only("keyLabels.list"));
    hub.inject(Fault::new(429, 1).retry_after("1"));
    let first = send(&hub, Method::Get, "/api/i18n-packs", None, None);
    assert_eq!((first.status, first.retry_after.as_deref()), (429, Some("1")));
    assert_eq!(stringify(&parse(std::str::from_utf8(&first.body).unwrap()).unwrap()), fault_body(429));
    assert_eq!(send(&hub, Method::Get, "/api/key-labels", None, None).status, 500);
    assert_eq!(send(&hub, Method::Get, "/api/key-labels", None, None).status, 200);
    // An unknown path is no route, so a fault does not answer it.
    hub.inject(Fault::new(500, 1));
    assert_eq!(send(&hub, Method::Get, "/api/nowhere", None, None).status, 404);
    assert_eq!(send(&hub, Method::Get, "/api/theme-packs", None, None).status, 500);
}
