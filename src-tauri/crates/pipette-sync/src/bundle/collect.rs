// SPDX-License-Identifier: GPL-2.0-or-later
//! The units a full pass sends (`collectAllSyncUnits` and
//! `collectAnalyticsSyncUnitsForUid` of src/main/sync/sync-bundle.ts).

use std::fmt::Display;
use std::path::Path;

use pipette_js_json::Value;
use pipette_keyboard_stores::{
    FavoriteType, KEY_LABEL_SYNC_UNIT, KEYBOARD_META_SYNC_UNIT, StoreContext, TYPING_TEXT_SYNC_UNIT,
};
use pipette_pack_stores::i18n::BUILTIN_ENGLISH_PACK_ID;
use pipette_typing_analytics::jsonl::{list_deleted_ranges_hashes, list_device_days};
use pipette_typing_analytics::sync_units::{
    typing_analytics_device_day_sync_unit, typing_deleted_ranges_sync_unit,
};

fn exists(path: &Path) -> bool {
    path.try_exists().unwrap_or(false)
}

/// The directories under `dir` (not following links), by the bytes of
/// their names as Node's `readdir` lists them; names that are not UTF-8
/// in their lossy form.
fn subdirectories(dir: &Path) -> Vec<String> {
    let Ok(listing) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut names: Vec<String> = listing
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// The deleted-ranges unit of every hash of `uid` that has a local file:
/// every hash, not only this device's, since any device may add ranges to
/// another device's file.
fn deleted_ranges_units(user_data: &Path, uid: &str) -> Vec<String> {
    list_deleted_ranges_hashes(user_data, uid)
        .iter()
        .map(|hash| typing_deleted_ranges_sync_unit(uid, hash))
        .collect()
}

/// The roster unit and one body unit per meta (tombstones included, so the
/// delete reaches the other devices until it expires) of the pack store in
/// `dir`, skipping `local_only`.
fn pack_units(sync_dir: &Path, dir: &str, local_only: Option<&str>, units: &mut Vec<String>) {
    let Ok(bytes) = std::fs::read(sync_dir.join(dir).join("index.json")) else { return };
    let Ok(Value::Object(index)) = pipette_js_json::parse(&String::from_utf8_lossy(&bytes)) else { return };
    let Some(Value::Array(metas)) = index.get("metas") else { return };
    units.push(format!("{dir}/index"));
    for meta in metas {
        let is_local_only = matches!(meta.as_object().and_then(|o| o.get("id")), Some(Value::String(id)) if id.as_str() == local_only);
        if is_local_only {
            continue;
        }
        // Reading a property of `null` throws and ends the store's listing.
        if *meta == Value::Null {
            return;
        }
        let id = pipette_js_json::js_string(meta.as_object().and_then(|o| o.get("id")));
        units.push(format!("{dir}/packs/{id}"));
    }
}

/// Every unit with local data, in the order a pass sends them: favorites,
/// keyboard names, key labels, typing-test texts, the packs, then per
/// keyboard its settings, snapshots, analyze filters, run logs and
/// deleted ranges, then this device's typing-analytics days.
/// `own_typing` is this device's machine hash and the keyboards it has
/// typing data for; when it cannot be had the days are left out and
/// logged.
pub fn collect_all_sync_units<E: Display>(
    ctx: &StoreContext,
    own_typing: Result<(String, Vec<String>), E>,
) -> Vec<String> {
    let user_data = ctx.user_data();
    let sync_dir = ctx.sync_dir();
    let mut units: Vec<String> = FavoriteType::ALL.iter().map(|ty| ty.sync_unit()).collect();
    if exists(&sync_dir.join("meta").join("keyboard-names.json")) {
        units.push(KEYBOARD_META_SYNC_UNIT.to_owned());
    }
    for unit in [KEY_LABEL_SYNC_UNIT, TYPING_TEXT_SYNC_UNIT] {
        if exists(&sync_dir.join(unit).join("index.json")) {
            units.push(unit.to_owned());
        }
    }
    pack_units(&sync_dir, "i18n", Some(BUILTIN_ENGLISH_PACK_ID), &mut units);
    pack_units(&sync_dir, "themes", None, &mut units);

    let keyboards = sync_dir.join("keyboards");
    for uid in subdirectories(&keyboards) {
        let dir = keyboards.join(&uid);
        if exists(&dir.join("pipette_settings.json")) {
            units.push(format!("keyboards/{uid}/settings"));
        }
        for name in ["snapshots", "analyze_filters", "runs"] {
            if exists(&dir.join(name).join("index.json")) {
                units.push(format!("keyboards/{uid}/{name}"));
            }
        }
        units.extend(deleted_ranges_units(user_data, &uid));
    }

    // This device's days only: another device's files are uploaded by it.
    match own_typing {
        Ok((machine_hash, uids)) => {
            for uid in uids {
                for day in list_device_days(user_data, &uid, &machine_hash) {
                    units.push(typing_analytics_device_day_sync_unit(&uid, &machine_hash, &day));
                }
            }
        }
        Err(err) => log::warn!("typing-analytics sync-unit scan failed: {err}"),
    }
    units
}

/// This device's day units and every hash's deleted-ranges unit of one
/// keyboard, for the Analyze panel's sync. `machine_hash` is this device's
/// hash; when it cannot be had the days are left out and logged.
pub fn collect_analytics_sync_units_for_uid<E: Display>(
    ctx: &StoreContext,
    uid: &str,
    machine_hash: Result<String, E>,
) -> Vec<String> {
    let user_data = ctx.user_data();
    let mut units = Vec::new();
    match machine_hash {
        Ok(hash) => {
            for day in list_device_days(user_data, uid, &hash) {
                units.push(typing_analytics_device_day_sync_unit(uid, &hash, &day));
            }
        }
        Err(err) => log::warn!("typing-analytics per-uid scan failed for {uid}: {err}"),
    }
    units.extend(deleted_ranges_units(user_data, uid));
    units
}
