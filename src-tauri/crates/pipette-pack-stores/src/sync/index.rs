// SPDX-License-Identifier: GPL-2.0-or-later
//! The merge of a remote roster into the local one.

use std::collections::HashMap;

use pipette_entry_store::{
    BodyPolicy, Entry, EntryGroup, MergeOptions, canonical_json, clock_ms, group_values, is_safe_pack_id,
    merge_entries, normalize_entry,
};
use pipette_js_json::{JsString, Value};
use pipette_keyboard_stores::StoreContext;

use super::bundle::RawPackIndex;
use super::meta_candidate_id;
use crate::pack_store::{PackIndex, PackStore};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PackIndexMergeResult {
    /// False only when the index could not be read or written.
    pub applied: bool,
    pub remote_needs_update: bool,
    /// Ids whose meta now shows a body this device does not hold yet, in
    /// the order of the merged roster.
    pub body_fetch_ids: Vec<JsString>,
}

impl PackStore {
    /// Merges a remote roster into the local one and writes it. A remote
    /// meta that is not an object with a safe pack id is dropped (and
    /// logged by count only); kept metas get `filename` derived from the
    /// id. An index that exists but cannot be read is not overwritten.
    pub fn merge_synced_pack_index(
        &self,
        ctx: &StoreContext,
        remote_metas: &[Value],
    ) -> PackIndexMergeResult {
        self.with_lock(ctx, || self.merge_index_locked(ctx, remote_metas).unwrap_or_default())
    }

    fn merge_index_locked(&self, ctx: &StoreContext, remote_metas: &[Value]) -> Option<PackIndexMergeResult> {
        let raw = self.read_raw_index(ctx);
        if raw == RawPackIndex::Corrupt {
            return None;
        }
        let local = self.read_index(ctx).ok()?;
        let remote: Vec<Entry> = remote_metas
            .iter()
            .filter_map(|m| {
                let id = meta_candidate_id(m)?;
                if !id.as_str().is_some_and(is_safe_pack_id) {
                    return None;
                }
                let mut meta = Entry::from_object(m.as_object()?.clone());
                meta.set("filename", Value::String(self.filename_of(id)));
                Some(meta)
            })
            .collect();
        if remote.len() < remote_metas.len() {
            log::warn!(
                "sync: dropped {} unsafe remote meta id(s) for {}",
                remote_metas.len() - remote.len(),
                self.index_unit()
            );
        }
        let mut options = MergeOptions::new(BodyPolicy::LocalIfPresent, ctx.now_ms());
        options.preserve_local_order = true;
        let result = merge_entries(self.entry_store, &local.metas, &remote, &options);
        // v1 metas are written in their v2 form once, so their body clock no
        // longer depends on reading the file's mtime.
        if result.local_needs_write || raw == (RawPackIndex::Ok { has_v1: true }) {
            let mut merged = local.clone();
            merged.metas = result.entries.clone();
            self.write_index(ctx, &merged).ok()?;
        }
        let body_fetch_ids = result
            .by_id
            .iter()
            .filter(|(id, o)| o.body_fetch_needed && !self.is_local_only(id))
            .map(|(id, _)| id.clone())
            .collect();
        Some(PackIndexMergeResult {
            applied: true,
            remote_needs_update: result.remote_needs_update || self.body_ahead_of_remote(&local, &remote),
            body_fetch_ids,
        })
    }

    /// Whether a live local meta holds a newer body than Drive's roster
    /// shows for it (other body fields under a later body clock). The
    /// roster merge leaves the body group out of its own comparison, so
    /// this is what sends the body fields a body unit applied here, or a
    /// local save, back to the roster on Drive.
    fn body_ahead_of_remote(&self, local: &PackIndex, remote: &[Entry]) -> bool {
        let def = self.entry_store.groups();
        let by_id: HashMap<&JsString, &Entry> = remote.iter().filter_map(|m| Some((m.id()?, m))).collect();
        let body = |e: &Entry| {
            canonical_json(Some(&Value::Object(group_values(def, e.as_object(), EntryGroup::Body))))
        };
        local.metas.iter().any(|l| {
            let Some(raw) = l.id().and_then(|id| by_id.get(id)) else { return false };
            if l.is_deleted() {
                return false;
            }
            let r = normalize_entry(self.entry_store, raw.as_object());
            clock_ms(l.clock(EntryGroup::Body)) > clock_ms(r.clock(EntryGroup::Body)) && body(l) != body(&r)
        })
    }
}
