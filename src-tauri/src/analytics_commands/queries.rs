// SPDX-License-Identifier: GPL-2.0-or-later
//! The commands of the shim's typing analytics members that read the cache
//! directly (src/tauri-shim/api/typing-analytics.ts): the keyboards with
//! data and their daily summaries, for every device, this device, or one
//! device.
//!
//! Each waits for the analytics' initialization and answers the handler's
//! array as JSON text written by `pipette_js_json`. Arguments the handler
//! rejects answer an empty array, as the handler does; a filter list that
//! is not a list is no filter.

use std::sync::Arc;

use pipette_typing_analytics::TypingAnalytics;
use pipette_typing_analytics::queries::scope_filters;
use pipette_typing_analytics_db::{ScopeFilters, ToJs};
use serde_json::Value;
use tauri::State;
use tauri::ipc::Response;

use crate::command_error::CommandError;

/// The string elements of a filter list the renderer sent.
fn strings(list: Option<&Value>) -> impl Iterator<Item = &str> {
    list.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str)
}

fn filters(
    app_scopes: Option<Value>,
    typing_test_scopes: Option<Value>,
    run_id_scopes: Option<Value>,
) -> ScopeFilters {
    scope_filters(
        strings(app_scopes.as_ref()),
        strings(typing_test_scopes.as_ref()),
        strings(run_id_scopes.as_ref()),
    )
}

fn json(value: &impl ToJs) -> Response {
    Response::new(pipette_js_json::stringify(&value.to_js()))
}

/// The answer to arguments the handler rejects.
fn empty() -> Response {
    Response::new("[]".to_owned())
}

/// The devices of a keyboard a read covers.
enum Devices {
    All,
    Own,
    One(String),
}

async fn daily_summaries(
    analytics: &Arc<TypingAnalytics>,
    uid: String,
    devices: Devices,
    filters: ScopeFilters,
) -> Result<Response, CommandError> {
    let ready = analytics.ready().await?;
    let hash = match devices {
        Devices::All => None,
        Devices::Own => Some(ready.machine_hash.clone()),
        Devices::One(hash) => Some(hash),
    };
    let rows = ready.db.call(move |db| db.daily_summaries(&uid, hash.as_deref(), &filters)).await??;
    Ok(json(&rows))
}

#[tauri::command]
pub async fn typing_analytics_list_keyboards(
    analytics: State<'_, Arc<TypingAnalytics>>,
) -> Result<Response, CommandError> {
    let ready = analytics.ready().await?;
    Ok(json(&ready.db.call(|db| db.keyboards_with_typing_data()).await??))
}

#[tauri::command]
pub async fn typing_analytics_list_items(
    analytics: State<'_, Arc<TypingAnalytics>>,
    uid: String,
    app_scopes: Option<Value>,
    typing_test_scopes: Option<Value>,
    run_id_scopes: Option<Value>,
) -> Result<Response, CommandError> {
    if uid.is_empty() {
        return Ok(empty());
    }
    let filters = filters(app_scopes, typing_test_scopes, run_id_scopes);
    daily_summaries(&analytics, uid, Devices::All, filters).await
}

#[tauri::command]
pub async fn typing_analytics_list_items_local(
    analytics: State<'_, Arc<TypingAnalytics>>,
    uid: String,
    app_scopes: Option<Value>,
    typing_test_scopes: Option<Value>,
    run_id_scopes: Option<Value>,
) -> Result<Response, CommandError> {
    if uid.is_empty() {
        return Ok(empty());
    }
    let filters = filters(app_scopes, typing_test_scopes, run_id_scopes);
    daily_summaries(&analytics, uid, Devices::Own, filters).await
}

#[tauri::command]
pub async fn typing_analytics_list_items_for_hash(
    analytics: State<'_, Arc<TypingAnalytics>>,
    uid: String,
    machine_hash: String,
    app_scopes: Option<Value>,
    typing_test_scopes: Option<Value>,
    run_id_scopes: Option<Value>,
) -> Result<Response, CommandError> {
    if uid.is_empty() || machine_hash.is_empty() {
        return Ok(empty());
    }
    let filters = filters(app_scopes, typing_test_scopes, run_id_scopes);
    daily_summaries(&analytics, uid, Devices::One(machine_hash), filters).await
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tauri::Manager;
    use tauri::async_runtime::block_on;
    use tauri::ipc::{InvokeResponseBody, IpcResponse};
    use tempfile::TempDir;

    use super::*;
    use crate::analytics_commands::{manage_with_machine_id, mark_cache_fresh};

    fn text(response: Result<Response, CommandError>) -> String {
        match response.unwrap().body().unwrap() {
            InvokeResponseBody::Json(text) => text,
            InvokeResponseBody::Raw(_) => panic!("not JSON"),
        }
    }

    /// `text` with the value of each `"date"` (the local day, which depends
    /// on the time zone the test runs in) replaced by `D`.
    fn without_dates(text: &str) -> String {
        let mut out = String::new();
        let mut rest = text;
        while let Some(at) = rest.find(r#""date":""#) {
            let value = at + r#""date":""#.len();
            out.push_str(&rest[..value]);
            out.push('D');
            rest = &rest[value + rest[value..].find('"').unwrap()..];
        }
        out + rest
    }

    /// A day of two devices of `0xA1`: this device typed 5 keys in a Code
    /// minute, the other 2.5 in an untagged one.
    fn app_with_a_day(user_data: &TempDir) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        mark_cache_fresh(user_data.path(), "machine");
        manage_with_machine_id(app.handle(), user_data.path(), "machine");
        let analytics = app.state::<Arc<TypingAnalytics>>().inner().clone();
        let ready = block_on(analytics.ready()).unwrap();
        let scope = |id: &str, hash: &str| {
            json!({ "id": id, "kind": "scope", "updated_at": 1, "payload": {
                "id": id, "machineHash": hash, "osPlatform": "linux", "osRelease": "6.8.0", "osArch": "x64",
                "keyboardUid": "0xA1", "keyboardVendorId": 1, "keyboardProductId": 2, "keyboardProductName": "K",
            } })
        };
        let stats = |scope: &str, keystrokes: f64, app_name: Option<&str>| {
            json!({ "id": "m", "kind": "minute-stats", "updated_at": 1, "payload": {
                "scopeId": scope, "minuteTs": 1_700_000_040_000_i64, "keystrokes": keystrokes, "activeMs": 1000,
                "intervalAvgMs": null, "intervalMinMs": null, "intervalP25Ms": null, "intervalP50Ms": null,
                "intervalP75Ms": null, "intervalMaxMs": null, "appName": app_name,
            } })
        };
        let lines = [
            scope("own", &ready.machine_hash),
            scope("other", "hash-other"),
            stats("own", 5.0, Some("Code")),
            stats("other", 2.5, None),
        ];
        let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
        ready.db.call_blocking(move |db| db.apply_day_jsonl(&text)).unwrap().unwrap();
        app
    }

    #[test]
    fn answer_the_handlers_json_for_every_device_this_device_or_one() {
        let user_data = TempDir::new().unwrap();
        let app = app_with_a_day(&user_data);
        let state = || app.state::<Arc<TypingAnalytics>>();
        assert_eq!(
            text(block_on(typing_analytics_list_keyboards(state()))),
            r#"[{"uid":"0xA1","productName":"K","vendorId":1,"productId":2}]"#
        );
        let day = |keystrokes: &str, active: &str| {
            format!(r#"[{{"date":"D","keystrokes":{keystrokes},"activeMs":{active}}}]"#)
        };
        let all = block_on(typing_analytics_list_items(state(), "0xA1".into(), None, None, None));
        assert_eq!(without_dates(&text(all)), day("7.5", "2000"));
        let own = block_on(typing_analytics_list_items_local(state(), "0xA1".into(), None, None, None));
        assert_eq!(without_dates(&text(own)), day("5", "1000"));
        let other = block_on(typing_analytics_list_items_for_hash(
            state(),
            "0xA1".into(),
            "hash-other".into(),
            None,
            None,
            None,
        ));
        assert_eq!(without_dates(&text(other)), day("2.5", "1000"));
        let code = block_on(typing_analytics_list_items(
            state(),
            "0xA1".into(),
            Some(json!([" Code ", 7, ""])),
            Some(json!("not a list")),
            None,
        ));
        assert_eq!(without_dates(&text(code)), day("5", "1000"));
    }

    #[test]
    fn rejected_arguments_answer_an_empty_list() {
        let user_data = TempDir::new().unwrap();
        let app = app_with_a_day(&user_data);
        let state = || app.state::<Arc<TypingAnalytics>>();
        assert_eq!(
            text(block_on(typing_analytics_list_items(state(), String::new(), None, None, None))),
            "[]"
        );
        assert_eq!(
            text(block_on(typing_analytics_list_items_local(state(), String::new(), None, None, None))),
            "[]"
        );
        let no_hash = block_on(typing_analytics_list_items_for_hash(
            state(),
            "0xA1".into(),
            String::new(),
            None,
            None,
            None,
        ));
        assert_eq!(text(no_hash), "[]");
    }
}
