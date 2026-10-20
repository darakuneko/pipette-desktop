// SPDX-License-Identifier: GPL-2.0-or-later
//! The merges of the pack units: a roster (`i18n/index`, `themes/index`) merges
//! per entry; a body (`…/packs/{id}`) is compared on the body clock it carries.
//! The stores do the reads and writes under their own locks; this layer
//! reports.

use std::collections::HashSet;
use std::sync::{Mutex, PoisonError};

use pipette_js_json::{Object, Value};
use pipette_pack_stores::PackStore;
use pipette_pack_stores::sync::ApplyPackBodyOutcome;
use pipette_sync_format::drive_names::drive_file_name;

use super::{MergeEnv, MergeError, PackKind, opt_prop, prop};
use crate::units::pack_index_store;

/// The pack rosters merged with Drive in this process: a body unit whose meta
/// is missing waits for its roster only while the roster has not been merged.
#[derive(Debug, Default)]
pub struct PackRosters(Mutex<HashSet<String>>);

impl PackRosters {
    /// Records that `unit`, when it is a roster, is in step with Drive;
    /// called after a unit's merge or upload.
    pub fn mark_synced(&self, unit: &str) {
        if pack_index_store(unit).is_some() {
            self.0.lock().unwrap_or_else(PoisonError::into_inner).insert(unit.to_owned());
        }
    }

    pub fn is_synced(&self, index_unit: &str) -> bool {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).contains(index_unit)
    }
}

fn kind_of(store: &PackStore) -> PackKind {
    if store.dir == "themes" { PackKind::Theme } else { PackKind::I18n }
}

/// Merges a remote roster. A pack whose meta now shows a body this device does
/// not hold gets its body unit's handled revision forgotten, so the next pass
/// downloads that body even when Drive did not change it. A `metas` that is not
/// an array at all is malformed rather than an empty roster.
pub(super) fn merge_pack_index(
    env: &MergeEnv<'_>,
    store: &PackStore,
    unit: &str,
    bundle: &Value,
) -> Result<bool, MergeError> {
    let Some(Value::Array(metas)) = opt_prop(prop(bundle, "index")?, "metas") else {
        return Err(MergeError::Malformed(unit.to_owned()));
    };
    let result = store.merge_synced_pack_index(env.ctx, metas);
    if !result.applied {
        return Err(MergeError::Other(format!("sync: failed to persist merged {unit} index")));
    }
    for id in &result.body_fetch_ids {
        env.remote.forget(&drive_file_name(&store.body_sync_unit(&id.to_string_lossy())));
    }
    env.events.pack_changed(kind_of(store));
    Ok(result.remote_needs_update)
}

/// Merges a remote body. A remote win writes the file and the meta's body group
/// together and reports the roster unit, so Drive gets the new body fields too.
pub(super) fn merge_pack_body(
    env: &MergeEnv<'_>,
    store: &PackStore,
    id: &str,
    bundle: &Value,
    remote_modified_time: &str,
) -> Result<bool, MergeError> {
    let empty = Object::new();
    let bundle = match bundle {
        Value::Object(o) => o,
        // `bundle.files` of `null` throws after the id check.
        Value::Null if pipette_entry_store::is_safe_pack_id(id) => {
            return Err(MergeError::Type("Cannot read properties of null (reading 'files')".into()));
        }
        _ => &empty,
    };
    let index_unit = store.index_unit();
    let outcome = store.apply_synced_pack_body(
        env.ctx,
        id,
        bundle,
        remote_modified_time,
        env.rosters.is_synced(&index_unit),
    )?;
    match outcome {
        ApplyPackBodyOutcome::Applied => {
            env.ctx.notify(&index_unit);
            env.events.pack_changed(kind_of(store));
            Ok(false)
        }
        ApplyPackBodyOutcome::LocalWins => Ok(true),
        ApplyPackBodyOutcome::Same | ApplyPackBodyOutcome::Skipped => Ok(false),
    }
}
