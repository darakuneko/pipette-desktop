// SPDX-License-Identifier: GPL-2.0-or-later
//! The typing analytics on Drive: the Analyze panel's sync of one keyboard, and
//! the Data modal's reads of other devices' days. They run on the process's one
//! unit sync, so they share its locks with the passes.
//!
//! An argument the handlers reject answers as they do (`false` or an empty
//! list) before anything runs: a uid or machine hash that is not a string,
//! or an empty one, and a day not shaped `YYYY-MM-DD`. A uid or hash that
//! is not one path segment (`/`, `\`, `.` or `..`) is rejected the same way,
//! since it names a directory under the keyboard. A failure of Drive or of
//! the password-check fails the read; the sync answers `false` instead.

use std::sync::Arc;

use pipette_entry_store::is_safe_path_segment;
use pipette_sync::analytics::{AnalyticsSync, AnalyticsSyncDeps};
use pipette_sync::dispatch::UnitSync;
use pipette_sync::execute::SyncExecutor;
use pipette_sync::preflight::Preflight;
use pipette_sync::typing_remote::RemoteTyping;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::command_error::CommandError;

type Arg = Option<serde_json::Value>;

/// Manages the Analyze sync and the reads. Needs the passes
/// ([`super::execute::manage`]) to be managed first: they share its unit
/// sync and its hooks.
pub fn manage<R: Runtime>(app: &AppHandle<R>) {
    let preflight = Arc::clone(app.state::<Arc<Preflight>>().inner());
    let units = Arc::clone(app.state::<Arc<UnitSync>>().inner());
    let hooks = Arc::clone(app.state::<Arc<SyncExecutor>>().hooks());
    let analytics = AnalyticsSync::new(AnalyticsSyncDeps {
        preflight: Arc::clone(&preflight),
        units: Arc::clone(&units),
        hooks,
    });
    app.manage(Arc::new(analytics));
    app.manage(Arc::new(RemoteTyping::new(preflight, units)));
}

/// A uid or machine hash the handlers take: a non-empty string of one path
/// segment.
fn segment(arg: &Arg) -> Option<&str> {
    arg.as_ref().and_then(serde_json::Value::as_str).filter(|value| is_safe_path_segment(value))
}

/// `^\d{4}-\d{2}-\d{2}$`, the check of the fetch handler.
fn utc_day(arg: &Arg) -> Option<&str> {
    let day = arg.as_ref().and_then(serde_json::Value::as_str)?;
    let bytes = day.as_bytes();
    let shaped = bytes.len() == 10
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| if i == 4 || i == 7 { *b == b'-' } else { b.is_ascii_digit() });
    shaped.then_some(day)
}

/// Syncs keyboard `uid`'s typing analytics; whether every unit synced.
#[tauri::command]
pub async fn sync_analytics_now(
    analytics: State<'_, Arc<AnalyticsSync>>,
    uid: Arg,
) -> Result<bool, CommandError> {
    let Some(uid) = segment(&uid) else { return Ok(false) };
    Ok(analytics.execute_analytics_sync(uid).await)
}

#[tauri::command]
pub async fn typing_analytics_list_remote_cloud_hashes(
    remote: State<'_, Arc<RemoteTyping>>,
    uid: Arg,
) -> Result<Vec<String>, CommandError> {
    let Some(uid) = segment(&uid) else { return Ok(Vec::new()) };
    Ok(remote.list_remote_typing_hashes(uid).await?)
}

#[tauri::command]
pub async fn typing_analytics_list_remote_cloud_days(
    remote: State<'_, Arc<RemoteTyping>>,
    uid: Arg,
    machine_hash: Arg,
) -> Result<Vec<String>, CommandError> {
    let (Some(uid), Some(hash)) = (segment(&uid), segment(&machine_hash)) else { return Ok(Vec::new()) };
    Ok(remote.list_remote_typing_days(uid, hash).await?)
}

#[tauri::command]
pub async fn typing_analytics_fetch_remote_day(
    remote: State<'_, Arc<RemoteTyping>>,
    uid: Arg,
    machine_hash: Arg,
    utc_day: Arg,
) -> Result<bool, CommandError> {
    let (Some(uid), Some(hash), Some(day)) = (segment(&uid), segment(&machine_hash), self::utc_day(&utc_day))
    else {
        return Ok(false);
    };
    Ok(remote.fetch_remote_typing_day(uid, hash, day).await?)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn takes_the_arguments_the_handlers_take() {
        assert_eq!(segment(&Some(json!("0xA1"))), Some("0xA1"));
        for rejected in
            [json!(""), json!(1), json!(null), json!("a/b"), json!("a\\b"), json!(".."), json!(".")]
        {
            assert_eq!(segment(&Some(rejected.clone())), None, "{rejected}");
        }
        assert_eq!(segment(&None), None);
        assert_eq!(utc_day(&Some(json!("2026-04-18"))), Some("2026-04-18"));
        // The shape only, as the handler checks it.
        assert_eq!(utc_day(&Some(json!("2026-99-99"))), Some("2026-99-99"));
        for rejected in
            [json!("2026-4-18"), json!("2026/04/18"), json!("2026-04-188"), json!(20260418), json!("")]
        {
            assert_eq!(utc_day(&Some(rejected.clone())), None, "{rejected}");
        }
    }
}
