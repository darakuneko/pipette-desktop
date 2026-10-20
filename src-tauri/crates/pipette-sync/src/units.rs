// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync unit names and what they say: which store a unit belongs to, the
//! store lock that guards its files, and the shapes the passes treat apart.

use pipette_entry_store::EntryStore;
use pipette_keyboard_stores::{KEY_LABEL_SYNC_UNIT, KEYBOARD_META_SYNC_UNIT, TYPING_TEXT_SYNC_UNIT};
use pipette_pack_stores::PackStore;
use pipette_pack_stores::i18n::I18N_PACKS;
use pipette_pack_stores::theme::THEME_PACKS;
use pipette_typing_analytics::jsonl::is_utc_day;

/// A day file unit: `keyboards/{uid}/devices/{machineHash}/days/{utcDay}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeviceDayUnit<'a> {
    pub uid: &'a str,
    pub machine_hash: &'a str,
    pub utc_day: &'a str,
}

/// A deleted-ranges unit: `keyboards/{uid}/devices/{machineHash}/deleted-ranges`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeletedRangesUnit<'a> {
    pub uid: &'a str,
    pub machine_hash: &'a str,
}

/// The day file unit `unit` names, when its day is a real UTC day.
pub fn parse_device_day_unit(unit: &str) -> Option<DeviceDayUnit<'_>> {
    let parts: Vec<&str> = unit.split('/').collect();
    let [kb, uid, devices, hash, days, day] = parts.as_slice() else { return None };
    (*kb == "keyboards"
        && *devices == "devices"
        && *days == "days"
        && !uid.is_empty()
        && !hash.is_empty()
        && is_utc_day(day))
    .then_some(DeviceDayUnit { uid, machine_hash: hash, utc_day: day })
}

/// The deleted-ranges unit `unit` names.
pub fn parse_deleted_ranges_unit(unit: &str) -> Option<DeletedRangesUnit<'_>> {
    let parts: Vec<&str> = unit.split('/').collect();
    let [kb, uid, devices, hash, last] = parts.as_slice() else { return None };
    (*kb == "keyboards"
        && *devices == "devices"
        && *last == "deleted-ranges"
        && !uid.is_empty()
        && !hash.is_empty())
    .then_some(DeletedRangesUnit { uid, machine_hash: hash })
}

/// A typing-analytics day file unit. The connect-time sync and the
/// 3-minute polling skip these; the Analyze panel syncs them on demand.
pub fn is_analytics_sync_unit(unit: &str) -> bool {
    parse_device_day_unit(unit).is_some()
}

/// A device's deleted-ranges unit. Not an analytics unit: one small file
/// per device, so it rides every trigger.
pub fn is_typing_deleted_ranges_sync_unit(unit: &str) -> bool {
    parse_deleted_ranges_unit(unit).is_some()
}

/// A keyboard's run-log unit (`keyboards/{uid}/runs`), skipped by the
/// connect-time sync and the polling like the analytics units.
pub fn is_run_log_sync_unit(unit: &str) -> bool {
    let parts: Vec<&str> = unit.split('/').collect();
    matches!(parts.as_slice(), ["keyboards", uid, "runs"] if !uid.is_empty())
}

/// The entry store an index-based unit belongs to; `None` for any other
/// unit (settings, packs, keyboard names, analytics).
pub fn entry_store_for_sync_unit(unit: &str) -> Option<EntryStore> {
    if unit == KEY_LABEL_SYNC_UNIT {
        return Some(EntryStore::KeyLabels);
    }
    if unit == TYPING_TEXT_SYNC_UNIT {
        return Some(EntryStore::TypingTestTexts);
    }
    match unit.split('/').collect::<Vec<_>>().as_slice() {
        ["favorites", _] => Some(EntryStore::Favorites),
        ["keyboards", _, "snapshots"] => Some(EntryStore::Snapshots),
        ["keyboards", _, "analyze_filters"] => Some(EntryStore::AnalyzeFilters),
        ["keyboards", _, "runs"] => Some(EntryStore::RunLogs),
        _ => None,
    }
}

/// The key of the store lock that guards a unit's local files: the
/// keyboard uid for a per-keyboard unit, `favorites/{type}` for favorites,
/// otherwise the unit itself (key labels, typing-test texts, a device's
/// deleted ranges). The stores take the same key for their own writes, so
/// a local save, a merge and a bundle never interleave.
pub fn store_lock_key(unit: &str) -> String {
    match unit.split('/').collect::<Vec<_>>().as_slice() {
        ["keyboards", uid, _] => (*uid).to_owned(),
        ["favorites", ty] => format!("favorites/{ty}"),
        _ => unit.to_owned(),
    }
}

/// Whether `unit` is the keyboard names.
pub fn is_keyboard_meta_unit(unit: &str) -> bool {
    unit == KEYBOARD_META_SYNC_UNIT
}

/// The pack store whose roster `unit` is (`i18n/index`, `themes/index`).
pub fn pack_index_store(unit: &str) -> Option<&'static PackStore> {
    [&I18N_PACKS, &THEME_PACKS].into_iter().find(|store| store.index_unit() == unit)
}

/// The pack store and pack id of a body unit (`i18n/packs/{id}`,
/// `themes/packs/{id}`) with a non-empty id.
pub fn parse_pack_body_unit(unit: &str) -> Option<(&'static PackStore, &str)> {
    if let Some(id) = unit.strip_prefix("themes/packs/") {
        return (!id.is_empty()).then_some((&THEME_PACKS, id));
    }
    let id = unit.strip_prefix("i18n/packs/")?;
    (!id.is_empty()).then_some((&I18N_PACKS, id))
}

/// Puts the pack roster units of `items` before the others: a pass runs the
/// first group to the end before it starts the second, so a body unit is
/// applied against a roster already merged in the same pass.
pub fn pack_index_units_first<T>(items: Vec<T>, unit_of: impl Fn(&T) -> &str) -> (Vec<T>, Vec<T>) {
    items.into_iter().partition(|item| pack_index_store(unit_of(item)).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_units_need_a_real_day() {
        let unit = "keyboards/kb/devices/h/days/2026-02-28";
        assert_eq!(
            parse_device_day_unit(unit),
            Some(DeviceDayUnit { uid: "kb", machine_hash: "h", utc_day: "2026-02-28" })
        );
        assert!(!is_analytics_sync_unit("keyboards/kb/devices/h/days/2026-02-29"));
        assert!(!is_analytics_sync_unit("keyboards//devices/h/days/2026-02-28"));
        assert!(is_typing_deleted_ranges_sync_unit("keyboards/kb/devices/h/deleted-ranges"));
        assert!(!is_typing_deleted_ranges_sync_unit("keyboards/kb/devices//deleted-ranges"));
    }

    #[test]
    fn units_map_to_their_stores_and_locks() {
        assert!(is_run_log_sync_unit("keyboards/kb/runs"));
        assert!(!is_run_log_sync_unit("keyboards//runs"));
        assert_eq!(entry_store_for_sync_unit("favorites/macro"), Some(EntryStore::Favorites));
        assert_eq!(entry_store_for_sync_unit("keyboards/kb/settings"), None);
        assert_eq!(store_lock_key("keyboards/kb/snapshots"), "kb");
        assert_eq!(store_lock_key("favorites/macro"), "favorites/macro");
        assert_eq!(
            store_lock_key("keyboards/kb/devices/h/deleted-ranges"),
            "keyboards/kb/devices/h/deleted-ranges"
        );
        assert_eq!(parse_pack_body_unit("themes/packs/a").map(|(s, id)| (s.dir, id)), Some(("themes", "a")));
        assert_eq!(parse_pack_body_unit("i18n/packs/"), None);
        let (first, rest) = pack_index_units_first(vec!["i18n/packs/a", "themes/index", "i18n/index"], |u| u);
        assert_eq!((first, rest), (vec!["themes/index", "i18n/index"], vec!["i18n/packs/a"]));
    }
}
