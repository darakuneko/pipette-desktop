// SPDX-License-Identifier: GPL-2.0-or-later
//! Applying a remote body bundle to a pack (`applySyncedPackBody` of
//! src/main/sync/pack-sync.ts).

use std::cmp::Ordering;

use pipette_entry_store::{
    EPOCH_ISO, EntryGroup, body_fields_of, body_hash, clock_ms, compare_bodies, is_safe_pack_id, set_clock,
    valid_clock,
};
use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::StoreContext;

use super::{PackSyncError, body_fields};
use crate::pack_store::PackStore;

/// What applying a body bundle did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyPackBodyOutcome {
    /// The remote body won; the file and the meta were written.
    Applied,
    /// The local body wins, so Drive needs it.
    LocalWins,
    /// Both bodies are the same.
    Same,
    /// Nothing to apply: no body in the bundle, a body that never syncs,
    /// a tombstoned meta, or no meta after the roster was merged.
    Skipped,
}

/// The clock and fields a remote body bundle carries. A bundle written by
/// a v1 app has neither: its clock is the Drive file's `modifiedTime`, and
/// its only field is the pack's own `version`, so values that live only in
/// the index (coverage and the like) are dropped and computed again.
struct RemoteBody {
    clock: String,
    fields: Object,
    v1: bool,
}

fn remote_body(bundle: &Object, content: &str, remote_modified_time: &str) -> RemoteBody {
    if let Some(Value::Object(body)) = bundle.get("body")
        && let (Some(clock @ Value::String(_)), Some(Value::Object(fields))) =
            (body.get("clock"), body.get("fields"))
    {
        let clock = valid_clock(Some(clock)).unwrap_or_else(|| EPOCH_ISO.to_owned());
        return RemoteBody { clock, fields: fields.clone(), v1: false };
    }
    let mut fields = Object::new();
    if let Ok(Value::Object(pack)) = pipette_js_json::parse(content)
        && let Some(version @ Value::String(_)) = pack.get("version")
    {
        fields.insert("version", version.clone());
    }
    let clock = valid_clock(Some(&Value::from(remote_modified_time))).unwrap_or_else(|| EPOCH_ISO.to_owned());
    RemoteBody { clock, fields, v1: true }
}

impl PackStore {
    /// Applies a remote body bundle for `id` against the local meta, under
    /// the store's lock. `roster_merged` says whether the roster unit has
    /// been merged in this pass. Fails with [`PackSyncError::Malformed`]
    /// for an unsafe id and [`PackSyncError::MetaPending`] for a meta the
    /// unmerged roster may still bring.
    pub fn apply_synced_pack_body(
        &self,
        ctx: &StoreContext,
        id: &str,
        bundle: &Object,
        remote_modified_time: &str,
        roster_merged: bool,
    ) -> Result<ApplyPackBodyOutcome, PackSyncError> {
        if !is_safe_pack_id(id) {
            return Err(PackSyncError::Malformed(self.body_sync_unit(id)));
        }
        let content = match bundle.get("files") {
            Some(Value::Object(files)) => match files.get(&format!("{id}.json")) {
                Some(Value::String(content)) => content.to_string_lossy().into_owned(),
                _ => return Ok(ApplyPackBodyOutcome::Skipped),
            },
            _ => return Ok(ApplyPackBodyOutcome::Skipped),
        };
        if self.local_only_ids.contains(&id) {
            return Ok(ApplyPackBodyOutcome::Skipped);
        }

        self.with_lock(ctx, || {
            let mut index = self.read_index(ctx)?;
            let Some(at) = index.position(&id.into()) else {
                if roster_merged {
                    return Ok(ApplyPackBodyOutcome::Skipped);
                }
                return Err(PackSyncError::MetaPending(self.body_sync_unit(id)));
            };
            let local = index.metas[at].clone();
            if local.is_deleted() {
                return Ok(ApplyPackBodyOutcome::Skipped);
            }

            let mut remote = remote_body(bundle, &content, remote_modified_time);
            let local_content = self.read_body(ctx, &id.into()).ok();
            // A v1 bundle knows only `version`. With no local body yet (the
            // roster brought this meta) and the same version, the body
            // fields the roster brought (coverage and the like) describe
            // that body, so they stay. Different local bytes keep only
            // `version`: coverage is computed again.
            if remote.v1 && local_content.is_none() && remote.fields.get("version") == local.get("version") {
                remote.fields = body_fields(self.entry_store, local.as_object());
            }
            let def = self.entry_store.groups();
            let mut candidate = local.clone();
            for field in body_fields_of(def, local.as_object()) {
                if let Some(field) = field.as_str().filter(|f| *f != "filename") {
                    candidate.remove(field);
                }
            }
            for (key, value) in remote.fields.iter() {
                if let Some(key) = key.as_str().filter(|k| *k != "filename" && def.body.contains(k)) {
                    candidate.set(key, value.clone());
                }
            }
            set_clock(&mut candidate, EntryGroup::Body, &remote.clock);

            if let Some(local_content) = &local_content {
                // The same bytes from a v1 app, or under the same clock, keep
                // the local body group: a v1 bundle knows only `version`,
                // and taking it would drop the coverage and the like of
                // every pack on the first v2 pass.
                let same_bytes = body_hash(local_content) == body_hash(&content);
                let same_clock = clock_ms(local.clock(EntryGroup::Body))
                    == clock_ms(Some(&Value::from(remote.clock.as_str())));
                if same_bytes && (remote.v1 || same_clock) {
                    return Ok(ApplyPackBodyOutcome::Same);
                }
                let hashes = || (Some(body_hash(local_content)), Some(body_hash(&content)));
                match compare_bodies(self.entry_store, &local, &candidate, Some(&hashes)) {
                    Ordering::Greater => return Ok(ApplyPackBodyOutcome::LocalWins),
                    Ordering::Equal => return Ok(ApplyPackBodyOutcome::Same),
                    Ordering::Less => {}
                }
            }
            self.write_body(ctx, &id.into(), &content)?;
            index.metas[at] = candidate;
            self.write_index(ctx, &index)?;
            Ok(ApplyPackBodyOutcome::Applied)
        })
    }
}
