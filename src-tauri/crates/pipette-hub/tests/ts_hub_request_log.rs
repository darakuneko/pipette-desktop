// SPDX-License-Identifier: GPL-2.0-or-later
//! The recorded request of each Hub API call, against the Rust endpoints
//! and bodies (tests/fixtures/ts_hub_request_log.json): method, path, the sorted query, the
//! headers (without `User-Agent` / `Accept` and the boundary), the JSON
//! text, and the whole multipart body with the boundary written
//! `{boundary}`; and the result read from the recorded answer.
//!
//! The bodies are built here from the call's recorded arguments with the
//! crate's builders.

#![allow(clippy::unwrap_used)]

mod common;

use common::{array, block_on, field, fixture, get, number, reply, scripted};
use pipette_hub::key_labels::{KeyLabelInput, build_body};
use pipette_hub::multipart::{
    KeymapFiles, UploadFile, analytics_post_body, feature_post_body, i18n_boundary, keymap_post_body,
    pack_body, post_boundary, theme_boundary,
};
use pipette_hub::packs::{i18n_export_file, theme_pack_file};
use pipette_hub::{Endpoint, ListQuery, ReadMode, RequestBody, node_base64_decode};
use pipette_js_json::{Object, Value, stringify};

/// The recording's clock.
const RECORDED_NOW_MS: f64 = 1_792_108_800_000.0;

fn file_arg(v: &Value) -> UploadFile {
    UploadFile {
        name: common::text(field(v, "name")).to_owned(),
        data: node_base64_decode(common::text(field(v, "base64"))),
    }
}

fn keymap_files(v: &Value) -> KeymapFiles {
    KeymapFiles {
        vil: file_arg(get(v, "vil").unwrap()),
        pipette: file_arg(get(v, "pipette").unwrap()),
        c: file_arg(get(v, "c").unwrap()),
        pdf: file_arg(get(v, "pdf").unwrap()),
        thumbnail: file_arg(get(v, "thumbnail").unwrap()),
    }
}

fn opt_num(v: Option<&Value>) -> Option<f64> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => Some(*n),
        Some(Value::Object(o)) if o.contains_key("$u") => None,
        Some(other) => panic!("number: {}", stringify(other)),
    }
}

fn list_query(v: &Value) -> ListQuery<'_> {
    ListQuery {
        q: get(v, "q").and_then(Value::as_str),
        name: get(v, "name").and_then(Value::as_str),
        page: opt_num(get(v, "page")),
        per_page: opt_num(get(v, "perPage")),
    }
}

fn obj(fields: Vec<(&str, Value)>) -> Value {
    let mut o = Object::new();
    for (k, v) in fields {
        o.insert(k, v);
    }
    Value::Object(o)
}

/// The recorded key label input for `key_labels::build_body`.
fn key_label_body(input: &Value) -> String {
    let given = |key: &str| get(input, key).filter(|value| get(value, "$u").is_none()).cloned();
    build_body(&KeyLabelInput {
        name: given("name"),
        map: given("map"),
        composite_labels: given("compositeLabels"),
        keymap_applicable: given("keymapApplicable").is_some_and(|value| value.is_truthy()),
    })
}

const NORM: &str = "{boundary}";

/// (endpoint, jwt, body) the function sends for `args`.
fn call<'a>(
    fn_name: &str,
    a: &'a [Value],
) -> Option<(Endpoint<'a>, Option<&'a str>, RequestBody, Option<&'static str>)> {
    let s = |i: usize| a.get(i).and_then(Value::as_str);
    let jwt = s(0);
    let exp = |i: usize| opt_num(a.get(i));
    let kf = |i: usize| keymap_files(&a[i]);
    let json = |v: Value| RequestBody::Json(stringify(&v));
    Some(match fn_name {
        "hub-client.authenticateWithHub" => {
            let mut fields = vec![("id_token", a[0].clone())];
            if let Some(name) = s(1).filter(|n| !n.is_empty()) {
                fields.push(("display_name", Value::from(name)));
            }
            (Endpoint::AuthToken, None, json(obj(fields)), None)
        }
        "hub-client.fetchAuthMe" => (Endpoint::AuthMe, jwt, RequestBody::None, None),
        "hub-client.patchAuthMe" => {
            (Endpoint::PatchAuthMe, jwt, json(obj(vec![("display_name", a[1].clone())])), None)
        }
        "hub-client.fetchMyPosts" => {
            let p = a.get(1);
            (
                Endpoint::MyPosts {
                    page: p.and_then(|p| opt_num(get(p, "page"))),
                    per_page: p.and_then(|p| opt_num(get(p, "per_page"))),
                },
                jwt,
                RequestBody::None,
                None,
            )
        }
        "hub-client.fetchMyPostsByKeyboard" => {
            (Endpoint::MyKeyboardPosts { keyboard_name: s(1).unwrap() }, jwt, RequestBody::None, None)
        }
        "hub-client.patchPostOnHub" => (
            Endpoint::PatchPost { post_id: s(1).unwrap() },
            jwt,
            json(obj(vec![("title", get(&a[2], "title").unwrap().clone())])),
            None,
        ),
        "hub-client.deletePostFromHub" => {
            (Endpoint::DeletePost { post_id: s(1).unwrap() }, jwt, RequestBody::None, None)
        }
        "hub-client.uploadPostToHub" => (
            Endpoint::UploadPost,
            jwt,
            RequestBody::Multipart(keymap_post_body(NORM.into(), s(1).unwrap(), s(2).unwrap(), &kf(3), None)),
            Some("----PipetteBoundary"),
        ),
        "hub-client.updatePostOnHub" => (
            Endpoint::UpdatePost { post_id: s(1).unwrap() },
            jwt,
            RequestBody::Multipart(keymap_post_body(NORM.into(), s(2).unwrap(), s(3).unwrap(), &kf(4), None)),
            Some("----PipetteBoundary"),
        ),
        "hub-client.uploadPrivatePostToHub" => (
            Endpoint::UploadPrivatePost,
            jwt,
            RequestBody::Multipart(keymap_post_body(
                NORM.into(),
                s(1).unwrap(),
                s(2).unwrap(),
                &kf(3),
                exp(4),
            )),
            Some("----PipetteBoundary"),
        ),
        "hub-client.deletePrivatePostFromHub" => (
            Endpoint::DeletePrivatePost { kind: s(1).unwrap(), id: s(2).unwrap() },
            jwt,
            RequestBody::None,
            None,
        ),
        "hub-client.uploadFeaturePostToHub" => (
            Endpoint::UploadFeaturePost,
            jwt,
            RequestBody::Multipart(feature_post_body(
                NORM.into(),
                s(1).unwrap(),
                s(2).unwrap(),
                &file_arg(&a[3]),
                None,
            )),
            Some("----PipetteBoundary"),
        ),
        "hub-client.updateFeaturePostOnHub" => (
            Endpoint::UpdateFeaturePost { post_id: s(1).unwrap() },
            jwt,
            RequestBody::Multipart(feature_post_body(
                NORM.into(),
                s(2).unwrap(),
                s(3).unwrap(),
                &file_arg(&a[4]),
                None,
            )),
            Some("----PipetteBoundary"),
        ),
        "hub-client.uploadPrivateFeaturePostToHub" => (
            Endpoint::UploadPrivateFeaturePost,
            jwt,
            RequestBody::Multipart(feature_post_body(
                NORM.into(),
                s(1).unwrap(),
                s(2).unwrap(),
                &file_arg(&a[3]),
                exp(4),
            )),
            Some("----PipetteBoundary"),
        ),
        "hub-client.uploadAnalyticsPostToHub" => (
            Endpoint::UploadAnalyticsPost,
            jwt,
            RequestBody::Multipart(analytics_post_body(
                NORM.into(),
                s(1).unwrap(),
                &file_arg(&a[2]),
                &file_arg(&a[3]),
                None,
            )),
            Some("----PipetteBoundary"),
        ),
        "hub-client.updateAnalyticsPostOnHub" => (
            Endpoint::UpdateAnalyticsPost { post_id: s(1).unwrap() },
            jwt,
            RequestBody::Multipart(analytics_post_body(
                NORM.into(),
                s(2).unwrap(),
                &file_arg(&a[3]),
                &file_arg(&a[4]),
                None,
            )),
            Some("----PipetteBoundary"),
        ),
        "hub-client.uploadPrivateAnalyticsPostToHub" => (
            Endpoint::UploadPrivateAnalyticsPost,
            jwt,
            RequestBody::Multipart(analytics_post_body(
                NORM.into(),
                s(1).unwrap(),
                &file_arg(&a[2]),
                &file_arg(&a[3]),
                exp(4),
            )),
            Some("----PipetteBoundary"),
        ),
        "hub-i18n.fetchI18nPostList" => {
            (Endpoint::I18nList(list_query(&a[0])), None, RequestBody::None, None)
        }
        "hub-i18n.downloadI18nPostBody" => {
            (Endpoint::I18nDownload { post_id: s(0).unwrap() }, None, RequestBody::None, None)
        }
        "hub-i18n.fetchI18nPackTimestamps" => {
            (Endpoint::I18nTimestamps, None, json(obj(vec![("ids", a[0].clone())])), None)
        }
        "hub-i18n.uploadI18nPostToHub" | "hub-i18n.updateI18nPostOnHub" => {
            let (id, pack) =
                if fn_name.ends_with("uploadI18nPostToHub") { (None, &a[1]) } else { (s(1), &a[2]) };
            let file = i18n_export_file(Some(pack), RECORDED_NOW_MS);
            let endpoint = match id {
                None => Endpoint::I18nUpload,
                Some(id) => Endpoint::I18nUpdate { post_id: id },
            };
            (
                endpoint,
                jwt,
                RequestBody::Multipart(pack_body(NORM.into(), &file)),
                Some("----PipetteI18nBoundary"),
            )
        }
        "hub-i18n.deleteI18nPostFromHub" => {
            (Endpoint::I18nDelete { post_id: s(1).unwrap() }, jwt, RequestBody::None, None)
        }
        "hub-theme.fetchThemePostList" => {
            (Endpoint::ThemeList(list_query(&a[0])), None, RequestBody::None, None)
        }
        "hub-theme.downloadThemePostBody" => {
            (Endpoint::ThemeDownload { post_id: s(0).unwrap() }, None, RequestBody::None, None)
        }
        "hub-theme.fetchThemePackTimestamps" => {
            (Endpoint::ThemeTimestamps, None, json(obj(vec![("ids", a[0].clone())])), None)
        }
        "hub-theme.uploadThemePostToHub" | "hub-theme.updateThemePostOnHub" => {
            let (id, pack) =
                if fn_name.ends_with("uploadThemePostToHub") { (None, &a[1]) } else { (s(1), &a[2]) };
            let file = theme_pack_file(pack);
            let endpoint = match id {
                None => Endpoint::ThemeUpload,
                Some(id) => Endpoint::ThemeUpdate { post_id: id },
            };
            (
                endpoint,
                jwt,
                RequestBody::Multipart(pack_body(NORM.into(), &file)),
                Some("----PipetteThemeBoundary"),
            )
        }
        "hub-theme.deleteThemePostFromHub" => {
            (Endpoint::ThemeDelete { post_id: s(1).unwrap() }, jwt, RequestBody::None, None)
        }
        "hub-key-labels.fetchKeyLabelList" => {
            (Endpoint::KeyLabelList(list_query(&a[0])), None, RequestBody::None, None)
        }
        "hub-key-labels.fetchKeyLabelDetail" => {
            (Endpoint::KeyLabelDetail { post_id: s(0).unwrap() }, None, RequestBody::None, None)
        }
        "hub-key-labels.fetchKeyLabelTimestamps" => {
            (Endpoint::KeyLabelTimestamps, None, json(obj(vec![("ids", a[0].clone())])), None)
        }
        "hub-key-labels.downloadKeyLabel" => {
            (Endpoint::KeyLabelDownload { post_id: s(0).unwrap() }, None, RequestBody::None, None)
        }
        "hub-key-labels.uploadKeyLabel" => {
            (Endpoint::KeyLabelUpload, jwt, RequestBody::Json(key_label_body(&a[1])), None)
        }
        "hub-key-labels.updateKeyLabel" => (
            Endpoint::KeyLabelUpdate { post_id: s(1).unwrap() },
            jwt,
            RequestBody::Json(key_label_body(&a[2])),
            None,
        ),
        "hub-key-labels.deleteKeyLabel" => {
            (Endpoint::KeyLabelDelete { post_id: s(1).unwrap() }, jwt, RequestBody::None, None)
        }
        _ => return None,
    })
}

#[test]
fn each_request_matches_the_golden() {
    let f = fixture("ts_hub_request_log.json");
    let base = get(&f, "hubBase").unwrap().as_str().unwrap().to_owned();
    let now = number(get(&f, "nowMs").unwrap()).unwrap();
    assert_eq!(now, RECORDED_NOW_MS);
    let mut failures = Vec::new();
    let mut unmapped = Vec::new();
    for c in array(get(&f, "calls").unwrap()) {
        let fn_name = get(c, "fn").unwrap().as_str().unwrap().to_owned();
        let args = array(get(c, "args").unwrap());
        let Some((endpoint, jwt, body, boundary_prefix)) = call(&fn_name, args) else {
            unmapped.push(fn_name);
            continue;
        };
        let reader = get(c, "reader").unwrap().as_str().unwrap();
        let expected_reader = match endpoint.read_mode() {
            ReadMode::Strict { typed_not_found: true } => "strict",
            ReadMode::Strict { typed_not_found: false } => "strict-key-labels",
            ReadMode::Lenient => "lenient",
            ReadMode::RawDownload => "download",
        };
        if reader != expected_reader {
            failures.push(format!("{fn_name}: reader {expected_reader} expected {reader}"));
        }
        // Send through a scripted requester answering the recorded answer.
        let answer = get(c, "answer").unwrap();
        let status = number(get(answer, "status").unwrap()).unwrap() as u16;
        let answer_body = stringify(get(answer, "json").unwrap());
        let client = scripted(&base, now, vec![reply(status, None, &answer_body)]);
        let http = &client.http;
        let script = &client.seen;
        let outcome = block_on(http.send(&endpoint, jwt, body));
        let expected_data = get(c, "data").unwrap();
        match &outcome {
            Ok(data) => {
                let actual = data.clone().unwrap_or(Value::Null);
                // A recorded `data: null` is a resolved `undefined`, `None` here.
                let exp =
                    if matches!(expected_data, Value::Null) { Value::Null } else { expected_data.clone() };
                if stringify(&actual) != stringify(&exp) {
                    failures.push(format!(
                        "{fn_name}: data {} expected {}",
                        stringify(&actual),
                        stringify(&exp)
                    ));
                }
            }
            Err(e) => failures.push(format!("{fn_name}: send failed: {e}")),
        }
        let seen = script.lock().unwrap();
        let sent = &seen[0];
        let expected_requests = array(get(c, "requests").unwrap());
        if expected_requests.len() != 1 {
            failures.push(format!("{fn_name}: {} expected requests", expected_requests.len()));
        }
        let er = &expected_requests[0];
        // method
        if sent.method.as_str() != get(er, "method").unwrap().as_str().unwrap() {
            failures.push(format!("{fn_name}: method {}", sent.method.as_str()));
        }
        // path + query
        let after_base =
            sent.url.strip_prefix(&base).unwrap_or_else(|| panic!("{fn_name}: url {} not on base", sent.url));
        let (path, query) = after_base.split_once('?').map_or((after_base, ""), |(p, q)| (p, q));
        if path != get(er, "path").unwrap().as_str().unwrap() {
            failures.push(format!(
                "{fn_name}: path {path} expected {}",
                get(er, "path").unwrap().as_str().unwrap()
            ));
        }
        let mut pairs: Vec<(String, String)> =
            form_urlencoded::parse(query.as_bytes()).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        pairs.sort();
        let exp_pairs: Vec<(String, String)> = array(get(er, "query").unwrap())
            .iter()
            .map(|p| {
                let p = array(p);
                (p[0].as_str().unwrap().to_owned(), p[1].as_str().unwrap().to_owned())
            })
            .collect();
        if pairs != exp_pairs {
            failures.push(format!("{fn_name}: query {pairs:?} expected {exp_pairs:?}"));
        }
        // headers (lower-cased; boundary stripped)
        let mut headers: Vec<(String, String)> = sent
            .headers
            .iter()
            .map(|(k, v)| {
                let v = v.split("; boundary=").next().unwrap().to_owned();
                (k.to_ascii_lowercase(), v)
            })
            .collect();
        headers.sort();
        let mut exp_headers: Vec<(String, String)> = get(er, "headers")
            .unwrap()
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.to_string_lossy().into_owned(), v.as_str().unwrap().to_owned()))
            .collect();
        exp_headers.sort();
        if headers != exp_headers {
            failures.push(format!("{fn_name}: headers {headers:?} expected {exp_headers:?}"));
        }
        // body
        match get(er, "body") {
            None => {
                if sent.body.is_some() {
                    failures.push(format!("{fn_name}: unexpected body"));
                }
            }
            Some(eb) => {
                if let Some(text) = get(eb, "text") {
                    let actual = String::from_utf8(sent.body.clone().unwrap()).unwrap();
                    if actual != text.as_str().unwrap() {
                        failures
                            .push(format!("{fn_name}: body {actual} expected {}", text.as_str().unwrap()));
                    }
                } else if let Some(mp) = get(eb, "multipart") {
                    let exp_boundary = get(mp, "boundary").unwrap().as_str().unwrap();
                    let prefix = boundary_prefix.unwrap();
                    if exp_boundary != format!("{prefix}{{now}}") {
                        failures.push(format!("{fn_name}: boundary {exp_boundary} expected prefix {prefix}"));
                    }
                    // The boundary the crate makes from the clock.
                    let made = match prefix {
                        "----PipetteBoundary" => post_boundary(now as i64),
                        "----PipetteI18nBoundary" => i18n_boundary(now as i64),
                        _ => theme_boundary(now as i64),
                    };
                    if made != format!("{prefix}{}", now as i64) {
                        failures.push(format!("{fn_name}: made boundary {made}"));
                    }
                    let normalized = node_base64_decode(get(mp, "normalized").unwrap().as_str().unwrap());
                    let actual = sent.body.clone().unwrap();
                    if actual != normalized {
                        let a = String::from_utf8_lossy(&actual);
                        let e = String::from_utf8_lossy(&normalized);
                        failures.push(format!(
                            "{fn_name}: multipart differs\n--- actual\n{a}\n--- expected\n{e}"
                        ));
                    }
                } else {
                    failures.push(format!("{fn_name}: unhandled expected body {}", stringify(eb)));
                }
            }
        }
    }
    assert!(unmapped.is_empty(), "no endpoint for {unmapped:?}");
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
    assert_eq!(array(get(&f, "calls").unwrap()).len(), 49);
}
