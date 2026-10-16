// SPDX-License-Identifier: GPL-2.0-or-later
//! The merge of a downloaded day file of another device
//! (`mergeDeviceDayBundle` of src/main/sync/sync-merge-dispatch.ts): the
//! file replaces the local copy under that device's directory, and every
//! row in it is replayed into the cache with that device's deleted ranges
//! hidden in the same transaction. A day is replayed whole; the cache's
//! last-writer-wins merge makes a replay of rows it already has a no-op.

use pipette_entry_store::is_safe_path_segment;
use pipette_js_json::Value;
use pipette_typing_analytics::deleted_ranges::{clip_to_utc_day, read_deleted_ranges_lenient};
use pipette_typing_analytics::jsonl::{device_day_dir, device_day_jsonl_path};
use pipette_typing_analytics::replay_day_hiding_deleted_ranges;
use pipette_typing_analytics_db::DayRows;

use super::settings::written_bytes;
use super::{AnalyticsEnv, MergeError, blocking, other, prop};
use crate::units::DeviceDayUnit;

/// The day file's text as `readRows` reads it: none when it cannot be read.
fn read_text(path: &std::path::Path) -> Option<String> {
    std::fs::read(path).ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// Writes `bundle`'s `data.jsonl` as the local copy of `day` and replays
/// its rows into the cache, then stamps `last_synced_at` in
/// `sync_state.json`. Nothing happens for this device's own hash: its days
/// are append-only logs only it writes, uploaded in place and never
/// merged. A bundle without the file, or with a falsy one, changes
/// nothing; a uid or hash that is not one safe path segment is refused as
/// malformed.
pub async fn merge_device_day_bundle(
    env: &AnalyticsEnv<'_>,
    bundle: &Value,
    day: DeviceDayUnit<'_>,
    own_hash: &str,
) -> Result<(), MergeError> {
    if !is_safe_path_segment(day.uid) || !is_safe_path_segment(day.machine_hash) {
        return Err(MergeError::Malformed(format!(
            "keyboards/{}/devices/{}/days/{}",
            day.uid, day.machine_hash, day.utc_day
        )));
    }
    if day.machine_hash == own_hash {
        return Ok(());
    }
    let Some(files) = prop(bundle, "files")? else {
        return Err(MergeError::Type("Cannot read properties of undefined (reading 'data.jsonl')".into()));
    };
    let Some(data) = prop(files, "data.jsonl")?.filter(|data| data.is_truthy()) else { return Ok(()) };

    // `fs.writeFile` of what the bundle holds: a string as its UTF-8. A
    // value it refuses fails after the directory is made.
    let bytes = match data {
        Value::String(text) => Ok(text.to_string_lossy().into_owned().into_bytes()),
        other => written_bytes(other),
    };
    let analytics = env.ops.analytics().clone();
    let (uid, hash, utc_day) = (day.uid.to_owned(), day.machine_hash.to_owned(), day.utc_day.to_owned());
    let rows = {
        let (analytics, uid, hash, utc_day) = (analytics.clone(), uid.clone(), hash.clone(), utc_day.clone());
        blocking(move || {
            let user_data = analytics.user_data();
            std::fs::create_dir_all(device_day_dir(user_data, &uid, &hash))?;
            let path = device_day_jsonl_path(user_data, &uid, &hash, &utc_day);
            pipette_fs::write_file_atomic(&path, &bytes?)?;
            Ok(DayRows::parse(&read_text(&path).unwrap_or_default()))
        })
        .await?
    };
    if !rows.is_empty() {
        let ready = analytics.ready().await.map_err(other)?;
        let (replayed, own) = (analytics.clone(), own_hash.to_owned());
        ready
            .db
            .call(move |db| {
                // The ranges are read right before the transaction that
                // uses them; an unreadable ranges file hides nothing.
                let hidden = || {
                    let ranges: Vec<_> = read_deleted_ranges_lenient(replayed.user_data(), &uid, &hash)
                        .into_iter()
                        .map(|entry| entry.range)
                        .collect();
                    clip_to_utc_day(&ranges, &utc_day).unwrap_or_default()
                };
                let clock = replayed.clock().as_ref();
                replay_day_hiding_deleted_ranges(db, &rows, &uid, &hash, &own, clock, hidden)
            })
            .await
            .map_err(other)?
            .map_err(other)?;
    }

    // Through the lock the upload's bookkeeping takes, so the two never
    // write over each other.
    let (now, own) = (analytics.now_ms(), own_hash.to_owned());
    blocking(move || {
        Ok(analytics.update_sync_state(&own, |state| {
            state.last_synced_at = now as f64;
            true
        })?)
    })
    .await
}
