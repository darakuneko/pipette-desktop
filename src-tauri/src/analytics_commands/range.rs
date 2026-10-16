// SPDX-License-Identifier: GPL-2.0-or-later
//! The commands of the shim's typing analytics range members
//! (src/tauri-shim/api/typing-analytics-range.ts): the Monitor App lists,
//! the key heatmap, the bigram ranking, the rollover trend, the keypress
//! durations and the Layout Comparison, each over a window and a device
//! scope (crates/pipette-typing-analytics, queries/range.rs).
//!
//! As the commands of [`super::queries`], each takes its handler's
//! arguments as sent and answers the handler's value as JSON text. The
//! Layout Comparison options arrive as the text of
//! `JSON.stringify(options)`: the order of a layout map's keys decides
//! which keycode types a character two keycodes type, and a JSON value
//! here loses that order. Text that is not JSON fails the command.

use std::sync::Arc;

use pipette_js_json::Value;
use pipette_typing_analytics::TypingAnalytics;
use pipette_typing_analytics::queries::Query;
use tauri::State;
use tauri::ipc::Response;

use super::queries::{answer, js_args};
use crate::command_error::CommandError;

type Arg = Option<serde_json::Value>;

/// A command per Monitor App list: `(uid, sinceMs, untilMs, scope)`.
macro_rules! app_range_commands {
    ($($name:ident => $query:ident,)+) => {$(
        #[tauri::command]
        pub async fn $name(
            analytics: State<'_, Arc<TypingAnalytics>>,
            uid: Arg,
            since_ms: Arg,
            until_ms: Arg,
            scope: Arg,
        ) -> Result<Response, CommandError> {
            answer(&analytics, Query::$query, js_args([uid, since_ms, until_ms, scope])).await
        }
    )+};
}

app_range_commands! {
    typing_analytics_list_apps_for_range => ListAppsForRange,
    typing_analytics_list_typing_tests_for_range => ListTypingTestsForRange,
    typing_analytics_get_app_usage_for_range => GetAppUsageForRange,
    typing_analytics_get_wpm_by_app_for_range => GetWpmByAppForRange,
}

#[tauri::command]
pub async fn typing_analytics_list_typing_test_runs_for_range(
    analytics: State<'_, Arc<TypingAnalytics>>,
    uid: Arg,
    since_ms: Arg,
    until_ms: Arg,
    scope: Arg,
    typing_test_scopes: Arg,
) -> Result<Response, CommandError> {
    let args = js_args([uid, since_ms, until_ms, scope, typing_test_scopes]);
    answer(&analytics, Query::ListTypingTestRunsForRange, args).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn typing_analytics_get_matrix_heatmap_for_range(
    analytics: State<'_, Arc<TypingAnalytics>>,
    uid: Arg,
    layer: Arg,
    since_ms: Arg,
    until_ms: Arg,
    scope: Arg,
    app_scopes: Arg,
    typing_test_scopes: Arg,
    run_id_scopes: Arg,
) -> Result<Response, CommandError> {
    let args =
        js_args([uid, layer, since_ms, until_ms, scope, app_scopes, typing_test_scopes, run_id_scopes]);
    answer(&analytics, Query::GetMatrixHeatmapForRange, args).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn typing_analytics_get_bigram_aggregate_for_range(
    analytics: State<'_, Arc<TypingAnalytics>>,
    uid: Arg,
    since_ms: Arg,
    until_ms: Arg,
    view: Arg,
    scope: Arg,
    options: Arg,
    app_scopes: Arg,
    typing_test_scopes: Arg,
    run_id_scopes: Arg,
) -> Result<Response, CommandError> {
    let args = js_args([
        uid,
        since_ms,
        until_ms,
        view,
        scope,
        options,
        app_scopes,
        typing_test_scopes,
        run_id_scopes,
    ]);
    answer(&analytics, Query::GetBigramAggregateForRange, args).await
}

/// `ListRolloverMinutes` and `ListDurationCells`: `(uid, scope, sinceMs,
/// untilMs, …filters)`.
macro_rules! scoped_commands {
    ($($name:ident => $query:ident,)+) => {$(
        #[tauri::command]
        #[allow(clippy::too_many_arguments)]
        pub async fn $name(
            analytics: State<'_, Arc<TypingAnalytics>>,
            uid: Arg,
            scope: Arg,
            since_ms: Arg,
            until_ms: Arg,
            app_scopes: Arg,
            typing_test_scopes: Arg,
            run_id_scopes: Arg,
        ) -> Result<Response, CommandError> {
            let args = js_args([uid, scope, since_ms, until_ms, app_scopes, typing_test_scopes, run_id_scopes]);
            answer(&analytics, Query::$query, args).await
        }
    )+};
}

scoped_commands! {
    typing_analytics_list_rollover_minutes => ListRolloverMinutes,
    typing_analytics_list_duration_cells => ListDurationCells,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn typing_analytics_get_layout_comparison_for_range(
    analytics: State<'_, Arc<TypingAnalytics>>,
    uid: Arg,
    since_ms: Arg,
    until_ms: Arg,
    scope: Arg,
    options: Option<String>,
    app_scopes: Arg,
    typing_test_scopes: Arg,
    run_id_scopes: Arg,
) -> Result<Response, CommandError> {
    let options = options.as_deref().map(pipette_js_json::parse).transpose()?.unwrap_or(Value::Null);
    let mut args =
        js_args([uid, since_ms, until_ms, scope, None, app_scopes, typing_test_scopes, run_id_scopes]);
    args[4] = options;
    answer(&analytics, Query::GetLayoutComparisonForRange, args).await
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

    fn app(user_data: &TempDir) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        mark_cache_fresh(user_data.path(), "machine");
        manage_with_machine_id(app.handle(), user_data.path(), "machine");
        app
    }

    #[test]
    fn answer_the_handlers_values_on_an_empty_cache() {
        let user_data = TempDir::new().unwrap();
        let app = app(&user_data);
        let state = || app.state::<Arc<TypingAnalytics>>();
        let (uid, since, until) = (|| Some(json!("0xA1")), || Some(json!(0)), || Some(json!(60_000)));
        let apps = block_on(typing_analytics_list_apps_for_range(
            state(),
            uid(),
            since(),
            until(),
            Some(json!("all")),
        ));
        assert_eq!(text(apps), "[]");
        let bigrams = block_on(typing_analytics_get_bigram_aggregate_for_range(
            state(),
            uid(),
            since(),
            until(),
            Some(json!("slow")),
            Some(json!({ "kind": "hash", "machineHash": "h" })),
            None,
            None,
            None,
            None,
        ));
        assert_eq!(
            text(bigrams),
            r#"{"view":"slow","entries":[],"truncated":false,"observedRolloverRatio":null}"#
        );
        let durations = block_on(typing_analytics_list_duration_cells(
            state(),
            uid(),
            Some(json!("own")),
            since(),
            until(),
            None,
            None,
            None,
        ));
        assert_eq!(text(durations), "[]");
    }

    #[test]
    fn rejected_arguments_get_the_handlers_answers_without_the_cache() {
        let user_data = TempDir::new().unwrap();
        // No sync state: the cache needs a rebuild, which this build
        // cannot do, so every wait for the analytics fails.
        let app = tauri::test::mock_app();
        manage_with_machine_id(app.handle(), user_data.path(), "machine");
        let state = || app.state::<Arc<TypingAnalytics>>();
        let (uid, since, until) = (|| Some(json!("0xA1")), || Some(json!(0)), || Some(json!(60_000)));
        let apps = |until_ms: Arg| {
            block_on(typing_analytics_list_apps_for_range(
                state(),
                uid(),
                since(),
                until_ms,
                Some(json!("all")),
            ))
        };
        assert_eq!(text(apps(Some(json!(0)))), "[]");
        assert!(apps(until()).is_err());
        let bigrams = |view: &str, scope: &str| {
            block_on(typing_analytics_get_bigram_aggregate_for_range(
                state(),
                uid(),
                since(),
                until(),
                Some(json!(view)),
                Some(json!(scope)),
                None,
                None,
                None,
                None,
            ))
        };
        assert_eq!(
            text(bigrams("other", "own")),
            r#"{"view":"top","entries":[],"truncated":false,"observedRolloverRatio":null}"#
        );
        assert_eq!(
            text(bigrams("slow", "nobody")),
            r#"{"view":"slow","entries":[],"truncated":false,"observedRolloverRatio":null}"#
        );
        assert!(bigrams("slow", "own").is_err());
        let heatmap = |layer: Arg| {
            block_on(typing_analytics_get_matrix_heatmap_for_range(
                state(),
                uid(),
                layer,
                since(),
                until(),
                Some(json!("own")),
                None,
                None,
                None,
            ))
        };
        assert_eq!(text(heatmap(None)), "{}");
        assert!(heatmap(Some(json!(0))).is_err());
        let rollover = |scope: Arg| {
            block_on(typing_analytics_list_rollover_minutes(
                state(),
                uid(),
                scope,
                since(),
                until(),
                None,
                None,
                None,
            ))
        };
        assert_eq!(text(rollover(None)), "[]");
        assert!(rollover(Some(json!("all"))).is_err());
        let compare = |options: &str| {
            block_on(typing_analytics_get_layout_comparison_for_range(
                state(),
                uid(),
                since(),
                until(),
                Some(json!("own")),
                Some(options.to_owned()),
                None,
                None,
                None,
            ))
        };
        assert_eq!(text(compare("null")), "null");
        assert!(compare(r#"{"source":{"id":"q","map":{}},"targets":[],"metrics":[]}"#).is_err());
    }

    #[test]
    fn layout_comparison_options_arrive_as_json_text() {
        let user_data = TempDir::new().unwrap();
        let app = app(&user_data);
        let state = || app.state::<Arc<TypingAnalytics>>();
        let compare = |options: Option<&str>| {
            block_on(typing_analytics_get_layout_comparison_for_range(
                state(),
                Some(json!("0xA1")),
                Some(json!(0)),
                Some(json!(60_000)),
                Some(json!("own")),
                options.map(str::to_owned),
                None,
                None,
                None,
            ))
        };
        // No keymap snapshot of this device: null.
        assert_eq!(
            text(compare(Some(r#"{"source":{"id":"q","map":{}},"targets":[],"metrics":[]}"#))),
            "null"
        );
        assert_eq!(text(compare(None)), "null");
        assert!(compare(Some("{")).is_err());
    }
}
