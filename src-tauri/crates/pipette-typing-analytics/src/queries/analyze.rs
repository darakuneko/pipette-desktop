// SPDX-License-Identifier: GPL-2.0-or-later
//! The Analyze and Data modal handlers (typing-analytics-ipc-analyze.ts
//! and the `ListItems` handler of typing-analytics-service.ts): the reads
//! of the [`Family`] in their three device forms, the typing-view heatmap,
//! the device list and the local day files.

use std::path::Path;

use pipette_js_json::{Object, Value};
use pipette_typing_analytics_db::{PeakRecords, ToJs};

use super::{Args, Context, Devices, Family, empty_list, floor_minute, js};
use crate::bigram_aggregate::js_number;
use crate::jsonl::paths::list_device_days;

/// The answer to arguments a handler of `family` rejects.
fn rejected(family: Family) -> Value {
    match family {
        Family::PeakRecords => PeakRecords {
            peak_wpm: None,
            lowest_wpm: None,
            peak_keystrokes_per_min: None,
            peak_keystrokes_per_day: None,
            longest_session: None,
        }
        .to_js(),
        _ => empty_list(),
    }
}

/// A [`Family`] read: `(uid[, machineHash][, sinceMs, untilMs][, appScopes,
/// typingTestScopes, runIdScopes])`. The daily and interval summaries take
/// no window, the sessions and interval summaries no filters.
pub(super) fn family(
    family: Family,
    devices: Devices,
    args: Args<'_>,
    cx: &Context<'_>,
) -> Result<Value, crate::Error> {
    let Some(uid) = args.text(0) else { return Ok(rejected(family)) };
    let (hash, rest) = match devices {
        Devices::All => (None, 1),
        Devices::Own => (Some(cx.own_hash), 1),
        Devices::ForHash => match args.text(1) {
            Some(hash) => (Some(hash), 2),
            None => return Ok(rejected(family)),
        },
    };
    let db = cx.db;
    // The window and the filters after it, for the families that take them.
    let since = args.since(rest);
    let until = args.until(rest + 1, since);
    let filters = args.filters(rest + 2);
    Ok(match family {
        Family::Items => js(db.daily_summaries(uid, hash, &args.filters(rest))?),
        Family::IntervalItems => js(db.interval_summaries(uid, hash)?),
        Family::ActivityGrid => js(db.activity_grid(uid, hash, since, until, &filters)?),
        Family::LayerUsage => js(db.layer_usage(uid, hash, since, until, &filters)?),
        Family::MatrixCells => js(db.matrix_cells(uid, hash, since, until, &filters)?),
        Family::MatrixCellsByDay => js(db.matrix_cells_by_day(uid, hash, since, until, &filters)?),
        Family::MinuteStats => js(db.minute_stats_in_range(uid, hash, since, until, &filters)?),
        Family::Sessions => js(db.sessions_in_range(uid, hash, since, until)?),
        Family::BksMinute => js(db.backspace_minutes(uid, hash, since, until, &filters)?),
        Family::PeakRecords => db.peak_records(uid, hash, since, until, &filters)?.to_js(),
    })
}

/// `GetMatrixHeatmap(uid, layer, sinceMs)`: this device's counts per
/// `"row,col"` of one layer from the minute of `sinceMs` on.
///
/// The Electron handler also adds the minute still being recorded; this
/// build answers the flushed minutes only.
pub(super) fn matrix_heatmap(args: Args<'_>, cx: &Context<'_>) -> Result<Value, crate::Error> {
    let empty = || Value::Object(Object::new());
    let Some(uid) = args.text(0) else { return Ok(empty()) };
    let Some(layer) = args.finite(1).filter(|&l| l >= 0.0) else { return Ok(empty()) };
    let Some(since) = args.finite(2) else { return Ok(empty()) };
    let cells = cx.db.matrix_counts_since(uid, cx.own_hash, layer, floor_minute(since))?;
    Ok(heatmap(&cells))
}

/// `TypingHeatmapByCell`: `{ total, tap, hold }` per `"row,col"`.
pub(super) fn heatmap(cells: &[pipette_typing_analytics_db::MatrixCounts]) -> Value {
    let mut out = Object::new();
    for cell in cells {
        let counts: Object = [
            ("total", Value::Number(cell.total)),
            ("tap", Value::Number(cell.tap)),
            ("hold", Value::Number(cell.hold)),
        ]
        .into_iter()
        .collect();
        out.insert(format!("{},{}", js_number(cell.row), js_number(cell.col)), counts.into());
    }
    out.into()
}

/// `ListDeviceInfos(uid)`: this device with its OS, and the other devices
/// with data for `uid`; null for a rejected uid.
pub(super) fn device_infos(args: Args<'_>, cx: &Context<'_>) -> Result<Value, crate::Error> {
    let Some(uid) = args.text(0) else { return Ok(Value::Null) };
    let remotes = cx.db.remote_device_infos(uid, cx.own_hash)?;
    let own: Object = [
        ("machineHash", Value::from(cx.own_hash)),
        ("osPlatform", Value::from(cx.os_platform)),
        ("osRelease", Value::from(cx.os_release)),
    ]
    .into_iter()
    .collect();
    Ok([("own", own.into()), ("remotes", remotes.to_js())].into_iter().collect::<Object>().into())
}

/// `ListLocalDeviceDays(uid, machineHash)`: the UTC days of the day files
/// in userData for one device; none for a rejected argument. Reads only
/// the files, not the cache.
pub fn local_device_days(user_data: &Path, uid: &Value, machine_hash: &Value) -> Value {
    let args = [uid.clone(), machine_hash.clone()];
    let args = Args(&args);
    match (args.text(0), args.text(1)) {
        (Some(uid), Some(hash)) => {
            Value::Array(list_device_days(user_data, uid, hash).into_iter().map(Value::from).collect())
        }
        _ => empty_list(),
    }
}
