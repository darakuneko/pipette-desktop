// SPDX-License-Identifier: GPL-2.0-or-later
//! The commands of the shim's Data modal members of the typing analytics
//! (src/tauri-shim/api/typing-analytics-data.ts): the Local tab's delete of
//! days and Delete All, the Sync tab's delete of another device's data, the
//! export and the import (crates/pipette-typing-analytics, data_ops.rs).
//!
//! The deletes and the import answer `{ success, error? }`: a rejected argument fails
//! with `Invalid uid`, `Invalid device` or `Invalid dates`, and each runs
//! holding the sync lock as a reset, waiting up to 30 seconds for a running
//! sync pass or flush before it fails with `sync.deleteBusy` or
//! `sync.importBusy`. A delete takes the time of the click as its cutoff,
//! so what is typed during the wait stays. The deletes hold their keyboard;
//! the import holds every keyboard, as its rebuild re-reads every day file.
//! The file dialogs are shown without the lock. The export is not wrapped:
//! a failure fails the command.

use std::collections::HashSet;
use std::sync::Arc;

use pipette_entry_store::is_safe_key;
use pipette_js_json::{Object, Value};
use pipette_sync::typing_remote::RemoteTyping;
use pipette_typing_analytics::device_delete::DeviceDays;
use pipette_typing_analytics::import_export::{CloudHasFile, ImportResult, export_typing_data_for_keyboard};
use pipette_typing_analytics::jsonl::paths::is_utc_day;
use pipette_typing_analytics::reset_lock::{DELETE_BUSY_MESSAGE, IMPORT_BUSY_MESSAGE};
use pipette_typing_analytics::{DataOps, DeleteScope, ResetKeyboards, SyncRuntime};
use serde_json::json;
use tauri::State;
use tauri::ipc::Response;

use crate::command_error::CommandError;
use crate::dialog::{DialogKind, DialogRequest, Dialogs, FileFilter};

type Arg = Option<serde_json::Value>;

/// `{ success: false, error }` of a check or an operation.
struct Failed(String);

impl<E: std::fmt::Display> From<E> for Failed {
    fn from(err: E) -> Self {
        Self(err.to_string())
    }
}

/// `{ success: true }` or `{ success: false, error }`.
fn envelope(outcome: Result<(), Failed>) -> serde_json::Value {
    match outcome {
        Ok(()) => json!({ "success": true }),
        Err(Failed(error)) => json!({ "success": false, "error": error }),
    }
}

/// A string of word characters and `-` (a uid, a machine hash), or
/// `Invalid <what>`.
fn safe_key_arg<'a>(arg: &'a Arg, what: &'static str) -> Result<&'a str, Failed> {
    arg.as_ref()
        .and_then(serde_json::Value::as_str)
        .filter(|key| is_safe_key(key))
        .ok_or_else(|| Failed(format!("Invalid {what}")))
}

fn uid_arg(uid: &Arg) -> Result<&str, Failed> {
    safe_key_arg(uid, "uid")
}

/// `validDays`: an array of `YYYY-MM-DD` days of the calendar.
fn days_arg(dates: &Arg) -> Result<Vec<String>, Failed> {
    let days: Option<Vec<String>> = match dates {
        Some(serde_json::Value::Array(items)) => {
            items.iter().map(|day| day.as_str().filter(|day| is_utc_day(day)).map(str::to_owned)).collect()
        }
        _ => None,
    };
    days.ok_or(Failed("Invalid dates".into()))
}

fn one_keyboard(uid: &str) -> ResetKeyboards {
    ResetKeyboards::Uids(vec![uid.to_owned()])
}

/// Runs `work` holding the sync lock as a reset of `keyboards`.
async fn locked<T>(
    runtime: &SyncRuntime,
    keyboards: ResetKeyboards,
    busy: &'static str,
    work: impl std::future::Future<Output = Result<T, pipette_typing_analytics::Error>>,
) -> Result<T, Failed> {
    Ok(runtime.with_reset_lock_when_free(&keyboards, busy, work).await??)
}

#[tauri::command]
pub async fn typing_analytics_delete_items(
    ops: State<'_, Arc<DataOps>>,
    runtime: State<'_, SyncRuntime>,
    uid: Arg,
    dates: Arg,
) -> Result<serde_json::Value, CommandError> {
    let cutoff = ops.analytics().now_ms();
    let outcome = async {
        let uid = uid_arg(&uid)?;
        let days = days_arg(&dates)?;
        if days.is_empty() {
            return Ok(());
        }
        let keyboards = one_keyboard(uid);
        locked(&runtime, keyboards, DELETE_BUSY_MESSAGE, ops.delete_local_days(uid, &days, cutoff)).await?;
        Ok(())
    };
    Ok(envelope(outcome.await))
}

#[tauri::command]
pub async fn typing_analytics_delete_all(
    ops: State<'_, Arc<DataOps>>,
    runtime: State<'_, SyncRuntime>,
    uid: Arg,
) -> Result<serde_json::Value, CommandError> {
    let cutoff = ops.analytics().now_ms();
    let outcome = async {
        let uid = uid_arg(&uid)?;
        let keyboards = one_keyboard(uid);
        let delete = ops.delete_all_for_keyboard(uid, cutoff, DeleteScope::Own);
        locked(&runtime, keyboards, DELETE_BUSY_MESSAGE, delete).await?;
        Ok(())
    };
    Ok(envelope(outcome.await))
}

/// `dates` are local calendar days, or `'all'`.
#[tauri::command]
pub async fn typing_analytics_delete_device_data(
    ops: State<'_, Arc<DataOps>>,
    runtime: State<'_, SyncRuntime>,
    uid: Arg,
    machine_hash: Arg,
    dates: Arg,
) -> Result<serde_json::Value, CommandError> {
    let cutoff = ops.analytics().now_ms();
    let outcome = async {
        let uid = uid_arg(&uid)?;
        let hash = safe_key_arg(&machine_hash, "device")?;
        let days = match &dates {
            Some(serde_json::Value::String(all)) if all == "all" => DeviceDays::All,
            _ => DeviceDays::Local(days_arg(&dates)?),
        };
        if days == DeviceDays::Local(Vec::new()) {
            return Ok(());
        }
        let keyboards = one_keyboard(uid);
        let delete = ops.delete_device_data(uid, hash, days, cutoff);
        locked(&runtime, keyboards, DELETE_BUSY_MESSAGE, delete).await?;
        Ok(())
    };
    Ok(envelope(outcome.await))
}

/// Shows `request` on a blocking-task thread.
async fn show(
    dialogs: &State<'_, Dialogs>,
    request: DialogRequest,
) -> Result<Vec<std::path::PathBuf>, CommandError> {
    let dialogs = dialogs.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || match request.kind {
        DialogKind::OpenMany => dialogs.show_many(request),
        _ => dialogs.show(request).into_iter().collect(),
    })
    .await?)
}

/// `{ written, cancelled }`: this device's days `dates` of `uid` copied
/// into a folder the user picks. An argument the handler rejects, an empty
/// list (no dialog then) or a cancelled dialog answer `cancelled`. A uid
/// that is not a safe key is rejected like an empty one, so a `../` uid
/// cannot point the day listing outside the keyboard directory.
#[tauri::command]
pub async fn typing_analytics_export(
    ops: State<'_, Arc<DataOps>>,
    dialogs: State<'_, Dialogs>,
    uid: Arg,
    dates: Arg,
) -> Result<serde_json::Value, CommandError> {
    let cancelled = json!({ "written": 0, "cancelled": true });
    let Ok(uid) = uid_arg(&uid) else { return Ok(cancelled) };
    let days: Option<HashSet<String>> = match &dates {
        Some(serde_json::Value::Array(items)) if !items.is_empty() => {
            items.iter().map(|day| day.as_str().map(str::to_owned)).collect()
        }
        _ => None,
    };
    let Some(days) = days else { return Ok(cancelled) };
    let request = DialogRequest {
        kind: DialogKind::OpenFolder,
        title: "Export typing data".to_owned(),
        filters: Vec::new(),
    };
    let Some(destination) = show(&dialogs, request).await?.into_iter().next() else { return Ok(cancelled) };
    let analytics = ops.analytics().clone();
    let uid = uid.to_owned();
    let written = tauri::async_runtime::spawn_blocking(move || -> Result<u64, CommandError> {
        let hash = analytics.machine_hash()?;
        Ok(export_typing_data_for_keyboard(analytics.user_data(), &uid, &hash, &destination, &days)?)
    })
    .await??;
    Ok(json!({ "written": written, "cancelled": false }))
}

/// `{ success, result?, cancelled?, error? }` as JSON text (a rejected
/// file's name keeps its characters).
fn import_answer(outcome: Result<(ImportResult, bool), Failed>) -> Response {
    let answer: Object = match outcome {
        Ok((result, cancelled)) => [
            ("success", Value::Bool(true)),
            ("result", result.to_js()),
            ("cancelled", Value::Bool(cancelled)),
        ]
        .into_iter()
        .collect(),
        Err(Failed(error)) => {
            [("success", Value::Bool(false)), ("error", Value::from(error))].into_iter().collect()
        }
    };
    Response::new(pipette_js_json::stringify(&answer.into()))
}

/// The cloud check of the import: whether Drive holds the data file of an
/// export file's name (`<unit>.jsonl` there, `<unit>.enc` on Drive). `None`
/// when Drive is not consulted (signed out, no usable password, the guard
/// blocks), so a file matches a local day file only.
fn cloud_has_file(names: Option<HashSet<String>>) -> Option<CloudHasFile> {
    let names = names?;
    Some(Arc::new(move |name: &str| {
        let drive_name =
            name.strip_suffix(".jsonl").map_or_else(|| name.to_owned(), |unit| format!("{unit}.enc"));
        names.contains(&drive_name)
    }))
}

/// Imports the day files the user picks. Drive is listed once for the
/// whole batch, holding the lock, so a file whose day this device has
/// uploaded and removed locally is still accepted; a failed listing fails
/// the import.
#[tauri::command]
pub async fn typing_analytics_import(
    ops: State<'_, Arc<DataOps>>,
    runtime: State<'_, SyncRuntime>,
    dialogs: State<'_, Dialogs>,
    remote: State<'_, Arc<RemoteTyping>>,
) -> Result<Response, CommandError> {
    let request = DialogRequest {
        kind: DialogKind::OpenMany,
        title: "Import typing data".to_owned(),
        filters: vec![FileFilter::new("Typing data", &["jsonl"])],
    };
    let paths = show(&dialogs, request).await?;
    if paths.is_empty() {
        return Ok(import_answer(Ok((ImportResult::default(), true))));
    }
    let import = async {
        let names = remote.remote_data_file_names().await?;
        Ok::<_, Failed>(ops.inner().import_typing_files(paths, cloud_has_file(names)).await?)
    };
    let outcome =
        match runtime.with_reset_lock_when_free(&ResetKeyboards::All, IMPORT_BUSY_MESSAGE, import).await {
            Ok(imported) => imported,
            Err(busy) => Err(busy.into()),
        };
    Ok(import_answer(outcome.map(|result| (result, false))))
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use pipette_sync_pending::PendingStore;
    use tauri::Manager;
    use tauri::async_runtime::block_on;
    use tauri::ipc::{InvokeResponseBody, IpcResponse};
    use tempfile::TempDir;

    use super::*;
    use crate::analytics_commands::{manage_with_machine_id, mark_cache_fresh};

    const UID: &str = "0xA1";
    const DAY: &str = "2026-04-14";

    fn app(user_data: &Path, answers: Vec<Vec<PathBuf>>) -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        crate::store_commands::sync_pending::manage_without_delayed_writes(app.handle(), user_data);
        crate::store_commands::keyboard_data::manage(app.handle(), user_data);
        let answers = Mutex::new(answers);
        app.manage(Dialogs::new(move |_: DialogRequest| {
            let mut answers = answers.lock().unwrap();
            assert!(!answers.is_empty(), "an unexpected dialog");
            answers.remove(0)
        }));
        crate::sync_commands::manage_for_tests(app.handle(), user_data);
        mark_cache_fresh(user_data, "machine");
        manage_with_machine_id(app.handle(), user_data, "machine");
        crate::sync_commands::preflight::manage_for_tests(app.handle());
        crate::sync_commands::execute::manage(app.handle());
        crate::sync_commands::analytics_remote::manage(app.handle());
        app
    }

    fn hash(app: &tauri::App<tauri::test::MockRuntime>) -> String {
        app.state::<Arc<DataOps>>().analytics().machine_hash().unwrap()
    }

    /// One minute of this device on `DAY`.
    fn seed_day(user_data: &Path, hash: &str) -> PathBuf {
        let path = user_data.join(format!("sync/keyboards/{UID}/devices/{hash}/{DAY}.jsonl"));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            format!(
                "{}\n{}\n",
                format_args!(
                    r#"{{"id":"s","kind":"scope","updated_at":1,"payload":{{"id":"sc","machineHash":"{hash}","osPlatform":"linux","osRelease":"6.8.0","osArch":"x64","keyboardUid":"{UID}","keyboardVendorId":1,"keyboardProductId":2,"keyboardProductName":"K"}}}}"#
                ),
                r#"{"id":"m","kind":"minute-stats","updated_at":1,"payload":{"scopeId":"sc","minuteTs":1776124800000,"keystrokes":3,"activeMs":1,"intervalAvgMs":null,"intervalMinMs":null,"intervalP25Ms":null,"intervalP50Ms":null,"intervalP75Ms":null,"intervalMaxMs":null}}"#,
            ),
        )
        .unwrap();
        path
    }

    fn text(response: Response) -> String {
        match response.body().unwrap() {
            InvokeResponseBody::Json(text) => text,
            InvokeResponseBody::Raw(bytes) => String::from_utf8(bytes).unwrap(),
        }
    }

    #[test]
    fn rejected_arguments_answer_the_handlers_errors() {
        let user_data = TempDir::new().unwrap();
        let app = app(user_data.path(), Vec::new());
        let (ops, runtime) = (|| app.state::<Arc<DataOps>>(), || app.state::<SyncRuntime>());
        let failed = |error: &str| json!({ "success": false, "error": error });
        let items = |uid: Arg, dates: Arg| {
            block_on(typing_analytics_delete_items(ops(), runtime(), uid, dates)).unwrap()
        };
        assert_eq!(items(Some(json!("a/b")), Some(json!([DAY]))), failed("Invalid uid"));
        assert_eq!(items(None, Some(json!([DAY]))), failed("Invalid uid"));
        assert_eq!(items(Some(json!(UID)), Some(json!(["2026-02-30"]))), failed("Invalid dates"));
        assert_eq!(items(Some(json!(UID)), Some(json!(DAY))), failed("Invalid dates"));
        assert_eq!(items(Some(json!(UID)), Some(json!([]))), json!({ "success": true }));
        assert_eq!(
            block_on(typing_analytics_delete_all(ops(), runtime(), Some(json!("")))).unwrap(),
            failed("Invalid uid")
        );
        let device = |hash: Arg, dates: Arg| {
            block_on(typing_analytics_delete_device_data(ops(), runtime(), Some(json!(UID)), hash, dates))
                .unwrap()
        };
        assert_eq!(device(Some(json!("h.x")), Some(json!("all"))), failed("Invalid device"));
        assert_eq!(device(Some(json!("h")), Some(json!("some"))), failed("Invalid dates"));
        assert_eq!(device(Some(json!("h")), Some(json!([]))), json!({ "success": true }));
        assert_eq!(
            device(Some(json!(hash(&app))), Some(json!("all"))),
            failed("sync.ownDeviceDeleteFromLocal")
        );
        assert!(!app.state::<PendingStore>().has_pending_changes());
    }

    #[test]
    fn delete_all_removes_the_day_files_and_records_the_range_for_the_other_devices() {
        let user_data = TempDir::new().unwrap();
        let app = app(user_data.path(), Vec::new());
        let hash = hash(&app);
        let day = seed_day(user_data.path(), &hash);
        let answer =
            block_on(typing_analytics_delete_all(app.state(), app.state(), Some(json!(UID)))).unwrap();
        assert_eq!(answer, json!({ "success": true }));
        assert!(!day.exists());
        let ranges = day.with_file_name("deleted-ranges.json");
        assert!(std::fs::read_to_string(ranges).unwrap().contains("\"entries\""));
        assert!(day.with_file_name("deleted-ranges-applied.json").exists());
        assert!(app.state::<PendingStore>().has_pending_changes());
        assert!(!app.state::<SyncRuntime>().is_syncing());
    }

    #[test]
    fn delete_device_data_hides_another_devices_days() {
        let user_data = TempDir::new().unwrap();
        let app = app(user_data.path(), Vec::new());
        seed_day(user_data.path(), "remote");
        let answer = block_on(typing_analytics_delete_device_data(
            app.state(),
            app.state(),
            Some(json!(UID)),
            Some(json!("remote")),
            Some(json!("all")),
        ))
        .unwrap();
        assert_eq!(answer, json!({ "success": true }));
        let ranges =
            user_data.path().join(format!("sync/keyboards/{UID}/devices/remote/deleted-ranges.json"));
        assert!(ranges.exists());
        assert!(app.state::<PendingStore>().has_pending_changes());
    }

    #[test]
    fn export_asks_for_a_folder_only_for_days_to_write() {
        let user_data = TempDir::new().unwrap();
        let out = user_data.path().join("out");
        let app = app(user_data.path(), vec![Vec::new(), vec![out.clone()]]);
        seed_day(user_data.path(), &hash(&app));
        let export = |uid: Arg, dates: Arg| {
            block_on(typing_analytics_export(app.state(), app.state(), uid, dates)).unwrap()
        };
        let cancelled = json!({ "written": 0, "cancelled": true });
        assert_eq!(export(Some(json!(UID)), Some(json!([]))), cancelled);
        assert_eq!(export(Some(json!("")), Some(json!([DAY]))), cancelled);
        assert_eq!(export(Some(json!(UID)), Some(json!([DAY, 1]))), cancelled);
        assert_eq!(export(Some(json!(UID)), Some(json!([DAY]))), cancelled);
        assert_eq!(export(Some(json!(UID)), Some(json!([DAY]))), json!({ "written": 1, "cancelled": false }));
        assert_eq!(std::fs::read_dir(out).unwrap().count(), 1);
    }

    #[test]
    fn export_rejects_a_uid_outside_the_keyboard_directory() {
        let user_data = TempDir::new().unwrap();
        let out = user_data.path().join("out");
        let app = app(user_data.path(), vec![vec![out.clone()]]);
        let hash = hash(&app);
        let outside = user_data.path().join(format!("sync/x/devices/{hash}/{DAY}.jsonl"));
        std::fs::create_dir_all(outside.parent().unwrap()).unwrap();
        std::fs::copy(seed_day(user_data.path(), &hash), &outside).unwrap();
        let answer = block_on(typing_analytics_export(
            app.state(),
            app.state(),
            Some(json!("../x")),
            Some(json!([DAY])),
        ))
        .unwrap();
        assert_eq!(answer, json!({ "written": 0, "cancelled": true }));
        assert!(!out.exists());
    }

    #[test]
    fn import_replaces_a_day_file_and_answers_a_cancel() {
        let user_data = TempDir::new().unwrap();
        let incoming = user_data.path().join("in");
        std::fs::create_dir_all(&incoming).unwrap();
        let app = app(user_data.path(), Vec::new());
        let hash = hash(&app);
        let day = seed_day(user_data.path(), &hash);
        let file = incoming.join(format!("keyboards_{UID}_devices_{hash}_days_{DAY}.jsonl"));
        std::fs::copy(&day, &file).unwrap();
        let notes = incoming.join("notes.txt");
        drop(app);

        let app = self::app(user_data.path(), vec![Vec::new(), vec![file, notes]]);
        let import = || {
            text(
                block_on(typing_analytics_import(app.state(), app.state(), app.state(), app.state()))
                    .unwrap(),
            )
        };
        assert_eq!(import(), r#"{"success":true,"result":{"imported":0,"rejections":[]},"cancelled":true}"#);
        assert_eq!(
            import(),
            r#"{"success":true,"result":{"imported":1,"rejections":[{"fileName":"notes.txt","reason":"invalid-filename"}]},"cancelled":false}"#
        );
    }

    #[test]
    fn checks_an_export_name_against_the_drive_names() {
        assert!(cloud_has_file(None).is_none());
        let names: HashSet<String> = ["keyboards_k_devices_h_days_2026-04-14.enc".to_owned()].into();
        let has = cloud_has_file(Some(names)).unwrap();
        assert!(has("keyboards_k_devices_h_days_2026-04-14.jsonl"));
        assert!(!has("keyboards_k_devices_h_days_2026-04-15.jsonl"));
        // A name without the suffix is looked up as it is.
        assert!(!has("keyboards_k_devices_h_days_2026-04-14"));
    }
}
