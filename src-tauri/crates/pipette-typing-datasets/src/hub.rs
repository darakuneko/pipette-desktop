// SPDX-License-Identifier: GPL-2.0-or-later
//! The Hub's typing-test dataset API (`/api/typing-test/datasets`),
//! anonymous and read-only: src/main/hub/hub-typing-dataset.ts. Both
//! fetchers answer `None` on any network, status or shape error, so the
//! callers fall back to what they have.

use pipette_js_json::{JsString, Object, Value};
use pipette_net::{HttpClient, encode_uri_component};

use crate::dataset::has_dataset_shape;
use crate::text::decode_utf8;

fn dataset_route(hub_base: &str, provider: &str) -> String {
    format!("{hub_base}/api/typing-test/datasets/{}", encode_uri_component(provider))
}

/// `res.json()` of a successful response, read as the `{ok, data}` envelope
/// of the Hub API: its `data` when `ok` is truthy.
async fn fetch_data(http: &dyn HttpClient, url: &str) -> Option<Value> {
    let response = http.get_bytes(url).await.ok()?;
    if !response.ok() {
        return None;
    }
    let Value::Object(mut body) = pipette_js_json::parse(&decode_utf8(&response.body)).ok()? else {
        return None;
    };
    if !body.get("ok").is_some_and(Value::is_truthy) {
        return None;
    }
    body.remove("data")
}

/// `fetchTypingDatasetVersion`: the Hub's current version of the provider's
/// dataset.
pub async fn fetch_dataset_version(
    http: &dyn HttpClient,
    hub_base: &str,
    provider: &str,
) -> Option<JsString> {
    let url = format!("{}/version", dataset_route(hub_base, provider));
    match fetch_data(http, &url).await? {
        Value::Object(mut data) => match data.remove("version") {
            Some(Value::String(version)) => Some(version),
            _ => None,
        },
        _ => None,
    }
}

/// `fetchTypingDataset`: the provider's full dataset, checked, as the
/// object the overrides file stores for it: `provider`, `version`,
/// `downloadUrlBase`, `model` (only when the Hub sent one) and `languages`
/// (its entries as sent), in that order.
pub async fn fetch_dataset(http: &dyn HttpClient, hub_base: &str, provider: &str) -> Option<Object> {
    let Value::Object(data) = fetch_data(http, &dataset_route(hub_base, provider)).await? else {
        return None;
    };
    let same_provider = matches!(data.get("provider"), Some(Value::String(p)) if p == provider);
    if !same_provider || !has_dataset_shape(&data) {
        return None;
    }
    let mut fresh = Object::new();
    for key in ["provider", "version", "downloadUrlBase", "model", "languages"] {
        if let Some(value) = data.get(key) {
            fresh.insert(key, value.clone());
        }
    }
    Some(fresh)
}

#[cfg(test)]
mod tests {
    use pipette_net::{HttpError, HttpResponse};

    use super::*;

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(future)
    }

    fn answering(status: u16, body: &'static str) -> impl HttpClient {
        move |_: &str| Ok(HttpResponse { status, body: body.as_bytes().to_vec() })
    }

    #[test]
    fn the_version_is_a_string_in_an_ok_envelope() {
        let version =
            |status, body| block_on(fetch_dataset_version(&answering(status, body), "https://h", "p"));
        assert_eq!(
            version(200, r#"{"ok":true,"data":{"provider":"p","version":"abc"}}"#),
            Some("abc".into())
        );
        assert_eq!(version(200, "\u{feff}{\"ok\":1,\"data\":{\"version\":\"bom\"}}"), Some("bom".into()));
        assert_eq!(version(404, r#"{"ok":true,"data":{"version":"abc"}}"#), None);
        assert_eq!(version(200, r#"{"ok":false,"data":{"version":"abc"}}"#), None);
        assert_eq!(version(200, r#"{"ok":true,"data":{"version":1}}"#), None);
        assert_eq!(version(200, r#"{"ok":true,"data":null}"#), None);
        assert_eq!(version(200, r#"{"ok":true}"#), None);
        assert_eq!(version(200, "null"), None);
        assert_eq!(version(200, "not json"), None);
        let offline = |_: &str| Err::<HttpResponse, _>(HttpError::Network("offline".into()));
        assert_eq!(block_on(fetch_dataset_version(&offline, "https://h", "p")), None);
    }

    #[test]
    fn asks_the_provider_routes_of_the_hub() {
        let urls = std::sync::Mutex::new(Vec::new());
        let client = |url: &str| {
            urls.lock().unwrap().push(url.to_owned());
            Ok(HttpResponse { status: 500, body: Vec::new() })
        };
        block_on(fetch_dataset_version(&client, "https://h", "a b"));
        block_on(fetch_dataset(&client, "https://h", "monkeytype"));
        assert_eq!(
            *urls.lock().unwrap(),
            [
                "https://h/api/typing-test/datasets/a%20b/version",
                "https://h/api/typing-test/datasets/monkeytype"
            ]
        );
    }

    #[test]
    fn a_dataset_is_rebuilt_in_the_stored_key_order() {
        let body = r#"{"ok":true,"data":{"languages":[{"fileSize":1,"name":"x","wordCount":1,"rightToLeft":false,"z":0}],
            "extra":1,"downloadUrlBase":"https://d","version":"v","provider":"p"}}"#;
        let fresh = block_on(fetch_dataset(&answering(200, body), "https://h", "p")).unwrap();
        assert_eq!(
            pipette_js_json::stringify(&Value::Object(fresh)),
            r#"{"provider":"p","version":"v","downloadUrlBase":"https://d","languages":[{"fileSize":1,"name":"x","wordCount":1,"rightToLeft":false,"z":0}]}"#
        );
        let body = r#"{"ok":true,"data":{"model":"catalog","languages":[],"downloadUrlBase":"https://d","version":"v","provider":"p"}}"#;
        let fresh = block_on(fetch_dataset(&answering(200, body), "https://h", "p")).unwrap();
        assert_eq!(
            pipette_js_json::stringify(&Value::Object(fresh)),
            r#"{"provider":"p","version":"v","downloadUrlBase":"https://d","model":"catalog","languages":[]}"#
        );
    }

    #[test]
    fn a_dataset_that_fails_a_check_is_none() {
        for data in [
            r#"{"provider":"q","version":"v","downloadUrlBase":"https://d","languages":[]}"#,
            r#"{"version":"v","downloadUrlBase":"https://d","languages":[]}"#,
            r#"{"provider":"p","version":1,"downloadUrlBase":"https://d","languages":[]}"#,
            r#"{"provider":"p","version":"v","downloadUrlBase":"http://d","languages":[]}"#,
            r#"{"provider":"p","version":"v","languages":[]}"#,
            r#"{"provider":"p","version":"v","downloadUrlBase":"https://d","model":"bogus","languages":[]}"#,
            r#"{"provider":"p","version":"v","downloadUrlBase":"https://d","model":null,"languages":[]}"#,
            r#"{"provider":"p","version":"v","downloadUrlBase":"https://d","languages":{}}"#,
            r#"{"provider":"p","version":"v","downloadUrlBase":"https://d","languages":[{"name":"x"}]}"#,
            "[]",
            "null",
        ] {
            let body: &'static str = Box::leak(format!(r#"{{"ok":true,"data":{data}}}"#).into_boxed_str());
            assert!(block_on(fetch_dataset(&answering(200, body), "https://h", "p")).is_none(), "{data}");
        }
    }
}
