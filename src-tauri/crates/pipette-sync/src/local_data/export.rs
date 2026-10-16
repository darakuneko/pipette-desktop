// SPDX-License-Identifier: GPL-2.0-or-later
//! The export file of the `EXPORT_LOCAL_DATA` handler of
//! src/main/sync/sync-ipc.ts: the favorites, snapshots and settings
//! bundles of every unit with local data, as
//! `{version: 1, exportedAt, snapshots, favorites, settings}` written by
//! `JSON.stringify(…, null, 2)`. Each category maps the bundle's key (a
//! keyboard uid, a favorite type) to the bundle's `{index, files}`. The
//! typing analytics, the keyboard names, the packs, the key labels, the
//! typing-test texts, the Analyze filters and the run logs are not part
//! of the file; the run logs never leave the device this way.

use std::convert::Infallible;

use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::StoreContext;
use pipette_time::iso_8601_millis;

use crate::bundle::{BundleError, bundle_sync_unit, collect_all_sync_units};

/// The export categories, in the file's order, and the bundle type each
/// one holds.
const CATEGORIES: [(&str, &str); 3] =
    [("snapshots", "layout"), ("favorites", "favorite"), ("settings", "settings")];

/// Whether `unit` bundles as one of the exported types. The other units
/// are skipped before they are bundled, so a typing day or a deleted-ranges
/// file is never read for an export.
fn is_exported_unit(unit: &str) -> bool {
    matches!(
        unit.split('/').collect::<Vec<_>>().as_slice(),
        ["favorites", _] | ["keyboards", _, "settings" | "snapshots"]
    )
}

/// The categories of the export, read from the local files in the order a
/// pass collects the units: `{snapshots, favorites, settings}`.
pub fn collect_export_categories(ctx: &StoreContext) -> Result<Object, BundleError> {
    let mut by_category: [Object; 3] = Default::default();
    // No machine hash and no keyboards with typing data: no day units.
    let units = collect_all_sync_units::<Infallible>(ctx, Ok((String::new(), Vec::new())));
    for unit in units.iter().filter(|unit| is_exported_unit(unit)) {
        let Some(bundle) = bundle_sync_unit(ctx, unit)? else { continue };
        let kind = bundle.get("type").and_then(Value::as_str);
        let Some(at) = CATEGORIES.iter().position(|(_, ty)| Some(*ty) == kind) else { continue };
        let entry: Object = ["index", "files"]
            .into_iter()
            .map(|field| (field, bundle.get(field).cloned().unwrap_or(Value::Null)))
            .collect();
        by_category[at].insert(pipette_js_json::js_string(bundle.get("key")), Value::Object(entry));
    }
    Ok(CATEGORIES
        .iter()
        .zip(by_category)
        .map(|((name, _), bundles)| (*name, Value::Object(bundles)))
        .collect())
}

/// The text of the export file: `categories` exported at `exported_at_ms`.
pub fn export_text(categories: Object, exported_at_ms: i64) -> String {
    let mut file = Object::new();
    file.insert("version", 1.0.into());
    file.insert("exportedAt", iso_8601_millis(exported_at_ms).into());
    for (key, value) in categories.iter() {
        file.insert(key.clone(), value.clone());
    }
    pipette_js_json::stringify_with_gap(&Value::Object(file), "  ")
}

/// The file name the save dialog offers: `pipette-data-{YYYY-MM-DD}.json`,
/// the UTC day of `now_ms`.
pub fn export_default_filename(now_ms: i64) -> String {
    let iso = iso_8601_millis(now_ms);
    format!("pipette-data-{}.json", iso.get(..10).unwrap_or(&iso))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_only_favorites_snapshots_and_settings() {
        for unit in ["favorites/macro", "keyboards/kb/settings", "keyboards/kb/snapshots"] {
            assert!(is_exported_unit(unit), "{unit}");
        }
        for unit in [
            "keyboards/kb/runs",
            "keyboards/kb/analyze_filters",
            "meta/keyboard-names",
            "key-labels",
            "i18n/index",
            "keyboards/kb/devices/h/deleted-ranges",
        ] {
            assert!(!is_exported_unit(unit), "{unit}");
        }
        assert_eq!(export_default_filename(1_792_108_800_000), "pipette-data-2026-10-16.json");
    }
}
