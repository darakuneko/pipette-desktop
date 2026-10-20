// SPDX-License-Identifier: GPL-2.0-or-later
#![allow(clippy::unwrap_used)]

use std::sync::{Arc, Mutex};

use pipette_entry_store::{FixedClock, WriteLocks};
use pipette_js_json::{parse, stringify};
use pipette_pack_stores::theme::SaveThemeInput;
use pipette_pack_stores::theme_validate::THEME_COLOR_KEYS;
use pipette_pack_stores::{Field, i18n::SavePackInput};
use tempfile::TempDir;

use super::*;
use crate::fake::{FAKE_HUB_BASE, FakeHub, Fault, RecordKind};
use crate::http::{HubRequesters, SystemTiming};

const T0: i64 = 1_792_108_800_000;

struct Harness {
    _dir: TempDir,
    stores: StoreContext,
    notified: Arc<Mutex<Vec<String>>>,
    hub: Arc<FakeHub>,
    token: HubToken,
}

impl Harness {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let notified = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&notified);
        let stores = StoreContext::new(
            dir.path(),
            Arc::new(FixedClock::new(T0)),
            Arc::new(WriteLocks::new()),
            Arc::new(move |unit: &str| record.lock().unwrap().push(unit.to_owned())),
        );
        let hub = Arc::new(FakeHub::new());
        hub.set_user("alice@example.com", Some("Alice"), None);
        let http = HubHttp::new(FAKE_HUB_BASE, HubRequesters::single(hub.clone()), Arc::new(SystemTiming));
        let token = HubToken::new(http, Arc::new(|| Some("test:alice@example.com".to_owned())));
        Self { _dir: dir, stores, notified, hub, token }
    }

    fn http(&self) -> &HubHttp {
        self.token.http()
    }

    /// The meta of `id` in the index of `store` (`i18n` or `themes`).
    fn meta(&self, store: &str, id: &str) -> Value {
        let path = self.stores.user_data().join(format!("sync/{store}/index.json"));
        let index = parse(&std::fs::read_to_string(path).unwrap()).unwrap();
        let metas = match param(&index, "metas") {
            Some(Value::Array(metas)) => metas.clone(),
            _ => panic!("no metas"),
        };
        metas.into_iter().find(|meta| param(meta, "id").and_then(Value::as_str) == Some(id)).unwrap()
    }

    fn notified(&self) -> Vec<String> {
        std::mem::take(&mut *self.notified.lock().unwrap())
    }
}

fn text_of(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

fn field_text(value: &Value, key: &str) -> Option<String> {
    text_of(param(value, key))
}

fn ja() -> Value {
    parse(r#"{"name":"Japanese","version":"1.2.0","common":{"save":"保存"},"z":"last","a":"first"}"#).unwrap()
}

fn nord(name: &str) -> Value {
    let colors: Object = THEME_COLOR_KEYS.iter().map(|key| (*key, Value::from("#2e3440"))).collect();
    let pack: Object = [
        ("name", Value::from(name)),
        ("version", Value::from("1.0.0")),
        ("colorScheme", Value::from("dark")),
        ("colors", Value::Object(colors)),
    ]
    .into_iter()
    .collect();
    Value::Object(pack)
}

fn params(entry_id: &str, pack: Value, post_id: Option<&str>) -> Value {
    let mut params: Object = [("entryId", Value::from(entry_id)), ("pack", pack)].into_iter().collect();
    if let Some(post_id) = post_id {
        params.insert("postId", Value::from(post_id));
    }
    Value::Object(params)
}

#[tokio::test]
async fn a_language_pack_goes_up_is_listed_downloaded_updated_and_deleted() {
    let h = Harness::new();
    let input = SavePackInput { id: Some("pack-ja".into()), pack: Some(ja()), ..SavePackInput::default() };
    i18n::save_pack(&h.stores, input).unwrap();
    h.notified();

    let uploaded = upload(&h.token, &h.stores, PackKind::I18n, Some(&params("pack-ja", ja(), None))).await;
    let post_id = field_text(&uploaded, "postId").unwrap_or_else(|| panic!("{}", stringify(&uploaded)));
    let meta = h.meta("i18n", "pack-ja");
    assert_eq!(field_text(&meta, "hubPostId").as_deref(), Some(post_id.as_str()));
    assert_eq!(field_text(&meta, "uploaderName").as_deref(), Some("Alice"));
    let first_time = field_text(&meta, "hubUpdatedAt").unwrap();
    assert_eq!(h.notified(), ["i18n/index"]);

    let listed =
        list(h.http(), PackKind::I18n, Some(&parse(r#"{"q":" Japan ","perPage":5}"#).unwrap())).await;
    let items = param(param(&listed, "data").unwrap(), "items").unwrap();
    let Value::Array(items) = items else { panic!() };
    assert_eq!(field_text(&items[0], "uploaderName").as_deref(), Some("Alice"));
    assert_eq!(field_text(&items[0], "updatedAt").as_deref(), Some(first_time.as_str()));

    // The export keeps the pack's key order.
    let downloaded = download(h.http(), PackKind::I18n, Some(&Value::from(post_id.as_str()))).await;
    let pack = param(param(&downloaded, "data").unwrap(), "pack").unwrap();
    assert_eq!(stringify(pack), stringify(&ja()));

    let later = h.hub.touch(RecordKind::I18n, &post_id, None).unwrap();
    let stamps =
        timestamps(h.http(), PackKind::I18n, Some(&parse(&format!(r#"["{post_id}","x"]"#)).unwrap())).await;
    assert!(stringify(&stamps).contains(&later), "{}", stringify(&stamps));

    let updated =
        update(&h.token, &h.stores, PackKind::I18n, Some(&params("pack-ja", ja(), Some(&post_id)))).await;
    assert_eq!(field_text(&updated, "postId").as_deref(), Some(post_id.as_str()));
    let meta = h.meta("i18n", "pack-ja");
    assert_ne!(field_text(&meta, "hubUpdatedAt"), Some(first_time));
    assert_eq!(field_text(&meta, "uploaderName").as_deref(), Some("Alice"));

    let deleted = delete(
        &h.token,
        &h.stores,
        PackKind::I18n,
        Some(&Value::from(post_id.as_str())),
        Some(&Value::from("pack-ja")),
    )
    .await;
    assert_eq!(stringify(&deleted), r#"{"success":true}"#);
    let meta = h.meta("i18n", "pack-ja");
    assert_eq!(param(&meta, "hubPostId"), None);
    assert_eq!(param(&meta, "hubUpdatedAt"), None);
    let gone = download(h.http(), PackKind::I18n, Some(&Value::from(post_id.as_str()))).await;
    assert!(field_text(&gone, "error").unwrap().starts_with("Hub i18n download failed: 404 "));
}

#[tokio::test]
async fn a_theme_pack_goes_up_is_downloaded_and_deleted() {
    let h = Harness::new();
    let input = SaveThemeInput {
        id: Some("theme-nord".into()),
        pack: Some(nord("Nord")),
        ..SaveThemeInput::default()
    };
    theme::save_pack(&h.stores, input).unwrap();
    h.notified();

    let uploaded =
        upload(&h.token, &h.stores, PackKind::Theme, Some(&params("theme-nord", nord("Nord"), None))).await;
    let post_id = field_text(&uploaded, "postId").unwrap();
    let meta = h.meta("themes", "theme-nord");
    assert_eq!(field_text(&meta, "hubPostId").as_deref(), Some(post_id.as_str()));
    assert_eq!(field_text(&meta, "uploaderName").as_deref(), Some("Alice"));
    assert_eq!(h.notified(), ["themes/index"]);

    let downloaded = download(h.http(), PackKind::Theme, Some(&Value::from(post_id.as_str()))).await;
    assert_eq!(stringify(param(&downloaded, "data").unwrap()), stringify(&nord("Nord")));

    // The update of someone else's pack is refused; nothing is linked.
    let other = h.hub.seed_pack(crate::fake::PackKind::Theme, "bob@example.com", &nord("Other"), None);
    let other_id = field_text(&other, "id").unwrap();
    let refused = update(
        &h.token,
        &h.stores,
        PackKind::Theme,
        Some(&params("theme-nord", nord("Nord"), Some(&other_id))),
    )
    .await;
    assert_eq!(
        field_text(&refused, "error").as_deref(),
        Some("ACCOUNT_DEACTIVATED"),
        "{}",
        stringify(&refused)
    );
    assert!(h.notified().is_empty());

    let deleted =
        delete(&h.token, &h.stores, PackKind::Theme, Some(&Value::from(post_id.as_str())), None).await;
    assert_eq!(stringify(&deleted), r#"{"success":true}"#);
    // Without a local pack id the link stays.
    assert_eq!(field_text(&h.meta("themes", "theme-nord"), "hubPostId").as_deref(), Some(post_id.as_str()));
}

#[tokio::test]
async fn a_theme_upload_without_a_pack_fails_after_the_token() {
    let h = Harness::new();
    let answer =
        upload(&h.token, &h.stores, PackKind::Theme, Some(&parse(r#"{"entryId":"x"}"#).unwrap())).await;
    assert_eq!(field_text(&answer, "error").as_deref(), Some(NO_THEME_PACK));
    let paths: Vec<String> = h.hub.requests().into_iter().map(|request| request.path).collect();
    assert_eq!(paths, ["/api/auth/token"]);
}

#[tokio::test]
async fn timestamps_ask_for_each_id_once_in_batches_of_100() {
    let h = Harness::new();
    let mut ids: Vec<Value> = (0..150).map(|i| Value::from(format!("id-{i}"))).collect();
    let seeded =
        h.hub.seed_pack(crate::fake::PackKind::I18n, "alice@example.com", &parse("{}").unwrap(), None);
    let seeded_id = field_text(&seeded, "id").unwrap();
    ids.push(Value::from("id-3"));
    ids.insert(0, Value::from(seeded_id.as_str()));
    h.hub.clear_requests();
    let answer = timestamps(h.http(), PackKind::I18n, Some(&Value::Array(ids))).await;
    assert_eq!(h.hub.requests().len(), 2);
    let items = param(param(&answer, "data").unwrap(), "items").unwrap();
    let Value::Array(items) = items else { panic!("{}", stringify(&answer)) };
    assert_eq!(items.len(), 1);
    assert_eq!(field_text(&items[0], "id"), Some(seeded_id));

    let empty = timestamps(h.http(), PackKind::Theme, Some(&parse("[]").unwrap())).await;
    assert_eq!(stringify(&empty), r#"{"success":true,"data":{"items":[]}}"#);
    for bad in ["[1]", r#""a""#, "null"] {
        let answer = timestamps(h.http(), PackKind::Theme, Some(&parse(bad).unwrap())).await;
        assert_eq!(field_text(&answer, "error").as_deref(), Some("ids must be an array of strings"));
    }
    assert_eq!(h.hub.requests().len(), 2);
}

#[tokio::test]
async fn a_failed_batch_fails_the_timestamps() {
    let h = Harness::new();
    h.hub.inject(Fault::new(500, 1).only("i18n.timestamps"));
    let answer = timestamps(h.http(), PackKind::I18n, Some(&parse(r#"["a"]"#).unwrap())).await;
    assert!(field_text(&answer, "error").unwrap().starts_with("Hub i18n timestamps fetch failed: 500 "));
}

#[tokio::test]
async fn a_failed_lookup_after_the_upload_keeps_the_cached_fields() {
    let h = Harness::new();
    let input = SavePackInput {
        id: Some("pack-ja".into()),
        pack: Some(ja()),
        uploader_name: Field::Set("Me".into()),
        ..SavePackInput::default()
    };
    i18n::save_pack(&h.stores, input).unwrap();
    h.hub.inject(Fault::new(500, 1).only("i18n.list"));
    let uploaded = upload(&h.token, &h.stores, PackKind::I18n, Some(&params("pack-ja", ja(), None))).await;
    let post_id = field_text(&uploaded, "postId").unwrap();
    let meta = h.meta("i18n", "pack-ja");
    assert_eq!(field_text(&meta, "hubPostId"), Some(post_id));
    assert_eq!(field_text(&meta, "uploaderName").as_deref(), Some("Me"));
    assert_eq!(param(&meta, "hubUpdatedAt"), None);
}

#[tokio::test(start_paused = true)]
async fn the_hub_failures_read_as_the_theme_client_reads_them() {
    let h = Harness::new();
    // A short 429 is waited out once; a second one is the error.
    h.hub.inject(Fault::new(429, 1).retry_after("1").only("theme.list"));
    let listed = list(h.http(), PackKind::Theme, None).await;
    assert_eq!(param(&listed, "success"), Some(&Value::Bool(true)), "{}", stringify(&listed));
    h.hub.inject(Fault::new(429, 2).retry_after("1").only("theme.list"));
    let limited = list(h.http(), PackKind::Theme, None).await;
    assert!(field_text(&limited, "error").unwrap().starts_with("Hub theme list failed: 429 "));
    // An envelope with `ok: false` fails with its error.
    h.hub.inject(Fault::new(200, 1).body(r#"{"ok":false,"error":"nope"}"#).only("theme.list"));
    let refused = list(h.http(), PackKind::Theme, None).await;
    assert_eq!(field_text(&refused, "error").as_deref(), Some("Hub theme list failed: nope"));
    // A 409 of an update is the update's own error, not a sentinel.
    let other = h.hub.seed_pack(crate::fake::PackKind::Theme, "alice@example.com", &nord("Mine"), None);
    let id = field_text(&other, "id").unwrap();
    h.hub.inject(Fault::new(409, 1).only("theme.update"));
    let conflict =
        update(&h.token, &h.stores, PackKind::Theme, Some(&params("t", nord("Mine"), Some(&id)))).await;
    assert!(field_text(&conflict, "error").unwrap().starts_with("Hub theme update failed: 409 "));
}

#[test]
fn the_input_checks_answer_without_a_request() {
    let h = Harness::new();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
    runtime.block_on(async {
        for bad in [None, Some(Value::Null), Some(Value::from("params")), Some(Value::from(5.0))] {
            let answer = upload(&h.token, &h.stores, PackKind::I18n, bad.as_ref()).await;
            assert_eq!(stringify(&answer), r#"{"success":false,"error":"Invalid params"}"#);
            let answer = update(&h.token, &h.stores, PackKind::Theme, bad.as_ref()).await;
            assert_eq!(stringify(&answer), r#"{"success":false,"error":"Invalid params"}"#);
        }
        for bad in ["{}", r#"{"postId":""}"#, r#"{"postId":"a b"}"#, r#"{"postId":{}}"#] {
            let answer = update(&h.token, &h.stores, PackKind::I18n, Some(&parse(bad).unwrap())).await;
            assert_eq!(stringify(&answer), r#"{"success":false,"error":"Invalid post ID"}"#, "{bad}");
        }
        for bad in [Value::from(5.0), Value::from("a/b"), Value::from("")] {
            let answer = download(h.http(), PackKind::I18n, Some(&bad)).await;
            assert_eq!(stringify(&answer), r#"{"success":false,"error":"Invalid post ID"}"#);
            let answer = delete(&h.token, &h.stores, PackKind::Theme, Some(&bad), None).await;
            assert_eq!(stringify(&answer), r#"{"success":false,"error":"Invalid post ID"}"#);
        }
    });
    assert!(h.hub.requests().is_empty());
}

#[test]
fn a_post_id_that_is_not_a_string_is_coerced_as_recorded() {
    assert_eq!(valid_post_id(Some(&Value::from(5.0))).as_deref(), Some("5"));
    assert_eq!(valid_post_id(Some(&Value::Bool(true))).as_deref(), Some("true"));
    assert_eq!(valid_post_id(Some(&Value::from(0.0))), None);
    assert_eq!(valid_post_id(Some(&parse(r#"["ab"]"#).unwrap())).as_deref(), Some("ab"));
}

#[test]
fn the_list_maps_the_fields_and_reports_a_bad_shape() {
    let raw = parse(
        r#"{"items":[{"id":"a","name":"N","version":"1.0.0","uploaded_by":null,"created_at":"c","extra":1}],"total":1,"page":2,"per_page":3}"#,
    )
    .unwrap();
    assert_eq!(
        stringify(&list_answer(Some(raw)).unwrap()),
        r#"{"items":[{"id":"a","name":"N","version":"1.0.0","uploadedBy":null,"uploaderName":null,"createdAt":"c"}],"total":1,"page":2,"perPage":3}"#
    );
    for (raw, error) in [
        (None, "Cannot read properties of undefined (reading 'items')"),
        (Some("null"), "Cannot read properties of null (reading 'items')"),
        (Some("{}"), "Cannot read properties of undefined (reading 'map')"),
        (Some(r#"{"items":5}"#), "raw.items.map is not a function"),
        (Some(r#"{"items":[null]}"#), "Cannot read properties of null (reading 'id')"),
    ] {
        let raw = raw.map(|text| parse(text).unwrap());
        assert_eq!(list_answer(raw).unwrap_err(), *error);
    }
}

#[test]
fn the_export_envelope_is_checked_before_the_pack() {
    let check = |text: &str| validate_i18n_export(Some(&parse(text).unwrap()));
    assert!(
        check(r#"{"version":1,"kind":"i18n","exportedAt":"","pack":{"name":"P","version":"1.0.0","a":"b"}}"#)
            .ok()
    );
    let reason = |text: &str| check(text).reason.unwrap().to_string_lossy().into_owned();
    assert_eq!(
        reason(
            r#"{"version":1,"kind":"i18n","exportedAt":"x","pack":{"name":"P","version":"1.0.0","a":{"constructor":"c"}}}"#
        ),
        "invalid pack body"
    );
    assert_eq!(reason(r#"{"version":[1,null],"kind":"i18n"}"#), "unsupported version: 1,");
    assert_eq!(reason(r#"{"version":1,"kind":{}}"#), "unexpected kind: [object Object]");
    assert_eq!(validate_i18n_export(None).reason.unwrap(), *"export must be an object");
}

#[test]
fn the_export_time_is_written_as_to_iso_string() {
    assert_eq!(iso_string(T0 as f64), "2026-10-16T00:00:00.000Z");
    assert_eq!(iso_string(0.0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_string(951_825_599_999.0), "2000-02-29T11:59:59.999Z");
    let file = i18n_export_file(None, 0.0);
    assert_eq!(
        String::from_utf8(file.data).unwrap(),
        r#"{"version":1,"kind":"i18n","exportedAt":"1970-01-01T00:00:00.000Z"}"#
    );
}
