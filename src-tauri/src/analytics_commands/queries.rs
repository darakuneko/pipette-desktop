// SPDX-License-Identifier: GPL-2.0-or-later
//! The commands of the shim's typing analytics members that read the cache
//! for the Analyze view and the Data modal (src/tauri-shim/api/
//! typing-analytics.ts): the keyboards with data, and the reads that come
//! for every device, this device (`…Local`) or one device (`…ForHash`),
//! the typing-view heatmap (with the minutes being recorded), the device
//! list and the local day files.
//!
//! Each command takes its handler's arguments as the JSON values the
//! renderer sent and answers the handler's value as JSON text written by
//! `pipette_js_json` (crates/pipette-typing-analytics, queries/): an
//! argument of the wrong type gets the handler's answer for it, never a
//! failed command, and gets it without waiting for the cache. Every other
//! read but the day file listing waits for the analytics' initialization
//! and runs on the database thread.

use std::sync::Arc;

use pipette_js_json::Value;
use pipette_typing_analytics::identity::{os_platform, os_release};
use pipette_typing_analytics::queries::{Context, Devices, Family, Query, local_device_days};
use pipette_typing_analytics::{Recorder, TypingAnalytics};
use tauri::State;
use tauri::ipc::Response;

use crate::command_error::CommandError;

type Arg = Option<serde_json::Value>;

/// The handler's arguments in order; an absent one is undefined, which
/// every check treats as null does.
pub(super) fn js_args<const N: usize>(args: [Arg; N]) -> Vec<Value> {
    args.into_iter()
        .map(|arg| {
            arg.and_then(|value| pipette_js_json::parse(&value.to_string()).ok()).unwrap_or(Value::Null)
        })
        .collect()
}

/// `query`'s answer to `args`: the handler's answer to rejected arguments
/// without waiting for the analytics (the arguments are checked before the
/// cache is touched), and any other on the database thread.
pub(super) async fn answer(
    analytics: &Arc<TypingAnalytics>,
    query: Query,
    args: Vec<Value>,
) -> Result<Response, CommandError> {
    answer_with(analytics, query, args, None).await
}

/// [`answer`] adding what `recorder` holds of the minutes not written yet,
/// read in the same database job as the cache.
async fn answer_with(
    analytics: &Arc<TypingAnalytics>,
    query: Query,
    args: Vec<Value>,
    recorder: Option<Arc<Recorder>>,
) -> Result<Response, CommandError> {
    if let Some(rejected) = query.rejection(&args) {
        return Ok(Response::new(pipette_js_json::stringify(&rejected)));
    }
    let ready = analytics.ready().await?;
    let user_data = analytics.user_data().to_path_buf();
    let own_hash = ready.machine_hash.clone();
    let text = ready
        .db
        .call(move |db| {
            let release = os_release();
            let cx = Context {
                db,
                user_data: &user_data,
                own_hash: &own_hash,
                os_platform: os_platform(),
                os_release: &release,
                recorder: recorder.as_deref(),
            };
            query.answer(&args, &cx)
        })
        .await??;
    Ok(Response::new(text))
}

/// A command per member of a [`Family`]: the plain and `…Local` forms take
/// `$args`, the `…ForHash` form `machine_hash` after the uid. Each takes the
/// handler's arguments one by one, as the shim names them.
macro_rules! family_commands {
    ($family:ident: $all:ident, $local:ident, $for_hash:ident ($($arg:ident),*)) => {
        #[tauri::command]
        pub async fn $all(analytics: State<'_, Arc<TypingAnalytics>>, uid: Arg, $($arg: Arg),*) -> Result<Response, CommandError> {
            answer(&analytics, Query::Analyze(Family::$family, Devices::All), js_args([uid, $($arg),*])).await
        }

        #[tauri::command]
        pub async fn $local(analytics: State<'_, Arc<TypingAnalytics>>, uid: Arg, $($arg: Arg),*) -> Result<Response, CommandError> {
            answer(&analytics, Query::Analyze(Family::$family, Devices::Own), js_args([uid, $($arg),*])).await
        }

        #[tauri::command]
        #[allow(clippy::too_many_arguments)]
        pub async fn $for_hash(
            analytics: State<'_, Arc<TypingAnalytics>>,
            uid: Arg,
            machine_hash: Arg,
            $($arg: Arg),*
        ) -> Result<Response, CommandError> {
            answer(&analytics, Query::Analyze(Family::$family, Devices::ForHash), js_args([uid, machine_hash, $($arg),*])).await
        }
    };
}

family_commands!(Items: typing_analytics_list_items, typing_analytics_list_items_local, typing_analytics_list_items_for_hash
    (app_scopes, typing_test_scopes, run_id_scopes));
family_commands!(IntervalItems: typing_analytics_list_interval_items, typing_analytics_list_interval_items_local,
    typing_analytics_list_interval_items_for_hash ());
family_commands!(ActivityGrid: typing_analytics_list_activity_grid, typing_analytics_list_activity_grid_local,
    typing_analytics_list_activity_grid_for_hash (since_ms, until_ms, app_scopes, typing_test_scopes, run_id_scopes));
family_commands!(LayerUsage: typing_analytics_list_layer_usage, typing_analytics_list_layer_usage_local,
    typing_analytics_list_layer_usage_for_hash (since_ms, until_ms, app_scopes, typing_test_scopes, run_id_scopes));
family_commands!(MatrixCells: typing_analytics_list_matrix_cells, typing_analytics_list_matrix_cells_local,
    typing_analytics_list_matrix_cells_for_hash (since_ms, until_ms, app_scopes, typing_test_scopes, run_id_scopes));
family_commands!(MatrixCellsByDay: typing_analytics_list_matrix_cells_by_day, typing_analytics_list_matrix_cells_by_day_local,
    typing_analytics_list_matrix_cells_by_day_for_hash (since_ms, until_ms, app_scopes, typing_test_scopes, run_id_scopes));
family_commands!(MinuteStats: typing_analytics_list_minute_stats, typing_analytics_list_minute_stats_local,
    typing_analytics_list_minute_stats_for_hash (since_ms, until_ms, app_scopes, typing_test_scopes, run_id_scopes));
family_commands!(Sessions: typing_analytics_list_sessions, typing_analytics_list_sessions_local,
    typing_analytics_list_sessions_for_hash (since_ms, until_ms));
family_commands!(BksMinute: typing_analytics_list_bks_minute, typing_analytics_list_bks_minute_local,
    typing_analytics_list_bks_minute_for_hash (since_ms, until_ms, app_scopes, typing_test_scopes, run_id_scopes));
family_commands!(PeakRecords: typing_analytics_get_peak_records, typing_analytics_get_peak_records_local,
    typing_analytics_get_peak_records_for_hash (since_ms, until_ms, app_scopes, typing_test_scopes, run_id_scopes));

#[tauri::command]
pub async fn typing_analytics_list_keyboards(
    analytics: State<'_, Arc<TypingAnalytics>>,
) -> Result<Response, CommandError> {
    answer(&analytics, Query::ListKeyboards, Vec::new()).await
}

/// The cache's counts and the recorder's of the minutes not written yet.
#[tauri::command]
pub async fn typing_analytics_get_matrix_heatmap(
    analytics: State<'_, Arc<TypingAnalytics>>,
    recorder: State<'_, Arc<Recorder>>,
    uid: Arg,
    layer: Arg,
    since_ms: Arg,
) -> Result<Response, CommandError> {
    let args = js_args([uid, layer, since_ms]);
    answer_with(&analytics, Query::GetMatrixHeatmap, args, Some(recorder.inner().clone())).await
}

#[tauri::command]
pub async fn typing_analytics_list_device_infos(
    analytics: State<'_, Arc<TypingAnalytics>>,
    uid: Arg,
) -> Result<Response, CommandError> {
    answer(&analytics, Query::ListDeviceInfos, js_args([uid])).await
}

/// Lists the day files on disk, so it does not wait for the cache.
#[tauri::command]
pub async fn typing_analytics_list_local_device_days(
    analytics: State<'_, Arc<TypingAnalytics>>,
    uid: Arg,
    machine_hash: Arg,
) -> Result<Response, CommandError> {
    let args = js_args([uid, machine_hash]);
    let analytics = analytics.inner().clone();
    let value = tauri::async_runtime::spawn_blocking(move || {
        local_device_days(analytics.user_data(), &args[0], &args[1])
    })
    .await?;
    Ok(Response::new(pipette_js_json::stringify(&value)))
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
        let uid = || Some(json!("0xA1"));
        let all = block_on(typing_analytics_list_items(state(), uid(), None, None, None));
        assert_eq!(without_dates(&text(all)), day("7.5", "2000"));
        let own = block_on(typing_analytics_list_items_local(state(), uid(), None, None, None));
        assert_eq!(without_dates(&text(own)), day("5", "1000"));
        let other = block_on(typing_analytics_list_items_for_hash(
            state(),
            uid(),
            Some(json!("hash-other")),
            None,
            None,
            None,
        ));
        assert_eq!(without_dates(&text(other)), day("2.5", "1000"));
        let code = block_on(typing_analytics_list_items(
            state(),
            uid(),
            Some(json!([" Code ", 7, ""])),
            Some(json!("not a list")),
            None,
        ));
        assert_eq!(without_dates(&text(code)), day("5", "1000"));
        let infos = text(block_on(typing_analytics_list_device_infos(state(), uid())));
        assert!(infos.ends_with(
            r#""remotes":[{"machineHash":"hash-other","osPlatform":"linux","osRelease":"6.8.0"}]}"#
        ));
    }

    #[test]
    fn rejected_arguments_get_the_handlers_answers() {
        let user_data = TempDir::new().unwrap();
        let app = app_with_a_day(&user_data);
        let state = || app.state::<Arc<TypingAnalytics>>();
        assert_eq!(
            text(block_on(typing_analytics_list_items(state(), Some(json!("")), None, None, None))),
            "[]"
        );
        assert_eq!(
            text(block_on(typing_analytics_list_items_local(state(), Some(json!(5)), None, None, None))),
            "[]"
        );
        let no_hash = block_on(typing_analytics_list_items_for_hash(
            state(),
            Some(json!("0xA1")),
            None,
            None,
            None,
            None,
        ));
        assert_eq!(text(no_hash), "[]");
        let peaks = block_on(typing_analytics_get_peak_records(state(), None, None, None, None, None, None));
        assert_eq!(
            text(peaks),
            r#"{"peakWpm":null,"lowestWpm":null,"peakKeystrokesPerMin":null,"peakKeystrokesPerDay":null,"longestSession":null}"#
        );
        assert_eq!(
            text(block_on(typing_analytics_get_matrix_heatmap(
                state(),
                app.state(),
                Some(json!("0xA1")),
                None,
                None
            ))),
            "{}"
        );
        assert_eq!(text(block_on(typing_analytics_list_device_infos(state(), None))), "null");
    }

    /// The analytics of a cache that cannot be opened (a directory where
    /// the database would be), so every wait for them fails.
    fn app_without_a_cache(user_data: &TempDir) -> tauri::App<tauri::test::MockRuntime> {
        std::fs::create_dir_all(user_data.path().join("local/typing-analytics.db")).unwrap();
        let app = tauri::test::mock_app();
        manage_with_machine_id(app.handle(), user_data.path(), "machine");
        app
    }

    #[test]
    fn rejected_arguments_get_the_handlers_answers_without_the_cache() {
        let user_data = TempDir::new().unwrap();
        let app = app_without_a_cache(&user_data);
        let state = || app.state::<Arc<TypingAnalytics>>();
        let uid = || Some(json!("0xA1"));
        assert_eq!(
            text(block_on(typing_analytics_list_items(state(), Some(json!("")), None, None, None))),
            "[]"
        );
        let no_hash =
            block_on(typing_analytics_list_sessions_for_hash(state(), uid(), Some(json!("")), None, None));
        assert_eq!(text(no_hash), "[]");
        let peaks =
            block_on(typing_analytics_get_peak_records_local(state(), None, None, None, None, None, None));
        assert!(text(peaks).starts_with(r#"{"peakWpm":null"#));
        let heatmap = block_on(typing_analytics_get_matrix_heatmap(
            state(),
            app.state(),
            uid(),
            Some(json!(-1)),
            Some(json!(0)),
        ));
        assert_eq!(text(heatmap), "{}");
        assert_eq!(text(block_on(typing_analytics_list_device_infos(state(), Some(json!(1))))), "null");

        assert!(block_on(typing_analytics_list_items(state(), uid(), None, None, None)).is_err());
        assert!(
            block_on(typing_analytics_get_matrix_heatmap(
                state(),
                app.state(),
                uid(),
                Some(json!(0)),
                Some(json!(0))
            ))
            .is_err()
        );
        assert!(block_on(typing_analytics_list_device_infos(state(), uid())).is_err());
        assert!(block_on(typing_analytics_list_keyboards(state())).is_err());
    }

    #[test]
    fn lists_the_local_day_files_without_the_cache() {
        let user_data = TempDir::new().unwrap();
        let days = user_data.path().join("sync/keyboards/0xA1/devices/h");
        std::fs::create_dir_all(&days).unwrap();
        std::fs::write(days.join("2026-10-15.jsonl"), "").unwrap();
        let app = tauri::test::mock_app();
        manage_with_machine_id(app.handle(), user_data.path(), "machine");
        let state = || app.state::<Arc<TypingAnalytics>>();
        let listed =
            block_on(typing_analytics_list_local_device_days(state(), Some(json!("0xA1")), Some(json!("h"))));
        assert_eq!(text(listed), r#"["2026-10-15"]"#);
        let rejected = block_on(typing_analytics_list_local_device_days(state(), Some(json!("0xA1")), None));
        assert_eq!(text(rejected), "[]");
    }
}
