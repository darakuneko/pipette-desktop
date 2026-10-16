// SPDX-License-Identifier: GPL-2.0-or-later
//! This device's typing day files on Drive (src/main/sync/
//! sync-typing-remote.ts): finding them in a listing, and reconciling them
//! with the local day files and the upload bookkeeping of
//! `sync_state.json` before an upload pass collects its units.

use std::collections::HashSet;
use std::io;
use std::path::Path;

use indexmap::{IndexMap, IndexSet};
use pipette_drive::DriveFile;
use pipette_drive::canonical::Listing;
use pipette_drive::client::DriveClient;
use pipette_entry_store::Clock;
use pipette_js_json::Value;
use pipette_sync_format::drive_names::sync_unit_from_file_name;
use pipette_typing_analytics::jsonl::{keyboards_root, list_device_days};
use pipette_typing_analytics::sync_state::{TypingSyncState, load_sync_state, save_sync_state};

use crate::units::parse_device_day_unit;

/// A typing day file on Drive: `live` is the copy sync reads, absent when
/// only trash files of the day's name are left.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoteDay<'a> {
    pub name: &'a str,
    pub live: Option<&'a DriveFile>,
}

/// UTC day → its file, in the order the listing first shows each day.
pub type RemoteDays<'a> = IndexMap<String, RemoteDay<'a>>;

/// `collectRemoteOwnHashDays`: the day files of `hash` in `listing`, by
/// keyboard uid, in the order the listing first shows each uid and day. A
/// name that is not a day unit is skipped. A day with several files of its
/// name maps to the copy every lookup by name uses; a day with only trash
/// files is listed without `live`.
pub fn collect_remote_own_hash_days<'a>(
    listing: &'a Listing,
    hash: &str,
) -> IndexMap<String, RemoteDays<'a>> {
    let mut per_uid: IndexMap<String, RemoteDays<'a>> = IndexMap::new();
    let mut add = |name: &'a str, live: Option<&'a DriveFile>| {
        let Some(unit) = sync_unit_from_file_name(name) else { return };
        let Some(day) = parse_device_day_unit(&unit).filter(|day| day.machine_hash == hash) else { return };
        let by_day = per_uid.entry(day.uid.to_owned()).or_default();
        // Setting a key that is there keeps its place (`Map.set`).
        if live.is_some() || !by_day.contains_key(day.utc_day) {
            by_day.insert(day.utc_day.to_owned(), RemoteDay { name, live });
        }
    };
    for file in listing.canonical_files() {
        add(&file.name, Some(file));
    }
    for name in listing.names_with_trash() {
        add(name, None);
    }
    per_uid
}

/// What [`reconcile_own_hash_typing_analytics`] left.
#[derive(Debug, Clone, PartialEq)]
pub struct Reconciled {
    pub state: TypingSyncState,
    /// The state changed, and Drive may have: the pass lists Drive again
    /// before it uploads.
    pub mutated: bool,
}

/// `{uid}|{hash}`, the key of a device's lists in `sync_state.json`.
fn pointer_key(uid: &str, hash: &str) -> String {
    format!("{uid}|{hash}")
}

/// The days `uploaded` lists under `key`. The record may be an array,
/// which the Electron build reads too: none of its keys holds a `|`, so it
/// lists nothing.
fn uploaded_days(uploaded: &Value, key: &str) -> IndexSet<String> {
    match uploaded.as_object().and_then(|record| record.get(key)) {
        Some(Value::Array(days)) => days.iter().filter_map(|day| day.as_str().map(str::to_owned)).collect(),
        _ => IndexSet::new(),
    }
}

/// `record[key] = value`. Set on an array, the value is a property that
/// `JSON.stringify` leaves out, so the array is kept as it is.
fn set(record: &mut Value, key: &str, value: Value) {
    if let Value::Object(record) = record {
        record.insert(key, value);
    }
}

/// `isReconcilePending`: no time is recorded for `key` (missing or null).
fn reconcile_pending(reconciled_at: &Value, key: &str) -> bool {
    matches!(reconciled_at.as_object().and_then(|record| record.get(key)), None | Some(Value::Null))
}

/// The keyboard directories under `sync/keyboards/`, in the byte order of
/// their names (libuv's scandir order); none when it cannot be read.
fn local_keyboard_uids(user_data: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(keyboards_root(user_data)) else { return Vec::new() };
    let mut uids: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    uids.sort();
    uids
}

/// Deletes every copy and every trash file of `day`'s name, so nothing is
/// left to be picked up or renamed back. A failed delete is logged and the
/// pass goes on.
async fn delete_all_copies(drive: &DriveClient, listing: &Listing, day: &RemoteDay<'_>, failure: &str) {
    let ids: Vec<String> =
        listing.files_named_with_trash(day.name).into_iter().map(|f| f.id.clone()).collect();
    let outcome = drive.delete_files_by_id(&ids).await;
    if outcome.failed > 0 {
        log::warn!("{failure}: {}", outcome.first_error.unwrap_or_default());
    }
}

/// `reconcileOwnHashTypingAnalytics`: reconciles this device's day files
/// on Drive with the local ones and `sync_state.json` before the upload
/// pass collects its units. For each keyboard in the uploaded record, on
/// Drive or with a local directory:
///
/// - rule 2: a day `uploaded` lists that is not local was removed here
///   (Local delete) → its files on Drive are deleted too;
/// - rule 3: a day `uploaded` lists without a live copy on Drive was
///   removed there (a reset, another device) → it leaves `uploaded` and the
///   local file stays, so the upload pass sends it again. Another device
///   never removes this device's data by deleting its files; it adds
///   deleted ranges instead;
/// - orphans: while `reconciled_at` has no time for the keyboard (after a
///   rebuild or a fresh install), a day on Drive that is neither local nor
///   in `uploaded` is a leftover and is deleted; the time is then recorded,
///   so this runs once.
///
/// A delete removes every copy and trash file of the day's name. Rule 2
/// and the orphans also see a day that only has trash files; rule 3 needs
/// a live copy, so such a day is uploaded again. The state is saved (with
/// `last_synced_at`) only when it changed; a failed save is the error,
/// after any deletes on Drive.
pub async fn reconcile_own_hash_typing_analytics(
    drive: &DriveClient,
    listing: &Listing,
    user_data: &Path,
    own_hash: &str,
    clock: &dyn Clock,
) -> io::Result<Reconciled> {
    let mut state = load_sync_state(user_data).unwrap_or_else(|| TypingSyncState::empty(own_hash));
    let mut remote = collect_remote_own_hash_days(listing, own_hash);

    let mut candidates: IndexSet<String> = IndexSet::new();
    if let Some(record) = state.uploaded.as_object() {
        for key in record.keys() {
            let key = key.to_string_lossy();
            if let [uid, hash] = key.split('|').collect::<Vec<_>>().as_slice()
                && *hash == own_hash
            {
                candidates.insert((*uid).to_owned());
            }
        }
    }
    candidates.extend(remote.keys().cloned());
    candidates.extend(local_keyboard_uids(user_data));

    let mut mutated = false;
    for uid in &candidates {
        let key = pointer_key(uid, own_hash);
        let local: HashSet<String> = list_device_days(user_data, uid, own_hash).into_iter().collect();
        let mut uploaded = uploaded_days(&state.uploaded, &key);
        let mut cloud = remote.shift_remove(uid).unwrap_or_default();

        // Rule 2: uploaded but not local — delete from Drive.
        for day in uploaded.clone() {
            if local.contains(&day) {
                continue;
            }
            if let Some(file) = cloud.shift_remove(&day) {
                delete_all_copies(
                    drive,
                    listing,
                    &file,
                    &format!("typing-analytics cloud delete failed for {uid} {day}"),
                )
                .await;
            }
            uploaded.shift_remove(&day);
            mutated = true;
        }

        // Rule 3: uploaded but no live copy on Drive — forget the upload.
        for day in uploaded.clone() {
            if cloud.get(&day).is_some_and(|file| file.live.is_some()) {
                continue;
            }
            uploaded.shift_remove(&day);
            mutated = true;
        }

        if reconcile_pending(&state.reconciled_at, &key) {
            for (day, file) in cloud {
                if local.contains(&day) || uploaded.contains(&day) {
                    continue;
                }
                delete_all_copies(
                    drive,
                    listing,
                    &file,
                    &format!("typing-analytics orphan delete failed for {uid} {day}"),
                )
                .await;
            }
            set(&mut state.reconciled_at, &key, Value::Number(clock.now_ms() as f64));
            mutated = true;
        }

        // Sorted, so the file's diff stays stable.
        let mut days: Vec<String> = uploaded.into_iter().collect();
        days.sort();
        set(&mut state.uploaded, &key, Value::Array(days.into_iter().map(Value::from).collect()));
    }

    if mutated {
        state.last_synced_at = clock.now_ms() as f64;
        save_sync_state(user_data, &state)?;
    }
    Ok(Reconciled { state, mutated })
}
