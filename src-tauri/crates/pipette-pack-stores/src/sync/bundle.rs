// SPDX-License-Identifier: GPL-2.0-or-later
//! The bundles of a pack store's sync units, as the objects whose
//! `JSON.stringify` text is uploaded.

use std::fs;
use std::io;

use pipette_entry_store::is_safe_pack_id;
use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::StoreContext;

use super::{PackSyncError, body_fields, is_js_object, meta_candidate_id};
use crate::pack_store::PackStore;

/// The index file as stored: missing, unreadable or without a `metas`
/// array (corrupt), or holding metas some of which v1 wrote (no `clocks`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RawPackIndex {
    Missing,
    Corrupt,
    Ok { has_v1: bool },
}

impl PackStore {
    pub(super) fn read_raw_index(&self, ctx: &StoreContext) -> RawPackIndex {
        let bytes = match fs::read(self.index_path(ctx)) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return RawPackIndex::Missing,
            Err(_) => return RawPackIndex::Corrupt,
        };
        let Ok(Value::Object(root)) = pipette_js_json::parse(&String::from_utf8_lossy(&bytes)) else {
            return RawPackIndex::Corrupt;
        };
        let Some(Value::Array(metas)) = root.get("metas") else { return RawPackIndex::Corrupt };
        let has_v1 = metas.iter().any(|m| {
            meta_candidate_id(m).is_some() && !is_js_object(m.as_object().and_then(|o| o.get("clocks")))
        });
        RawPackIndex::Ok { has_v1 }
    }

    /// The roster bundle: every meta as a v2 entry, read under the store's
    /// lock. `None` when the index is missing or unreadable. Sending the
    /// normalized metas (not the file as stored) is what lets two devices
    /// holding the same v1 packs converge: both send the same clocks.
    pub fn bundle_pack_index(&self, ctx: &StoreContext) -> Result<Option<Object>, PackSyncError> {
        self.with_lock(ctx, || {
            if !matches!(self.read_raw_index(ctx), RawPackIndex::Ok { .. }) {
                return Ok(None);
            }
            let index = self.read_index(ctx)?;
            let kind = self.bundle_types().0;
            let mut bundle = Object::new();
            bundle.insert("type", kind.into());
            bundle.insert("key", kind.into());
            bundle.insert("index", Value::Object(index.to_object()));
            bundle.insert("files", Value::Object(Object::new()));
            Ok(Some(bundle))
        })
    }

    /// The body bundle of `id`: the pack JSON plus the body clock and body
    /// fields of its live local meta. `None` when the id has no live meta,
    /// no body file, or never syncs its body.
    pub fn bundle_pack_body(&self, ctx: &StoreContext, id: &str) -> Result<Option<Object>, PackSyncError> {
        if !is_safe_pack_id(id) || self.local_only_ids.contains(&id) {
            return Ok(None);
        }
        self.with_lock(ctx, || {
            let index = self.read_index(ctx)?;
            let Some(meta) = index.find(&id.into()).filter(|meta| !meta.is_deleted()) else {
                return Ok(None);
            };
            let Ok(content) = self.read_body(ctx, &id.into()) else { return Ok(None) };
            let mut metas = Object::new();
            metas.insert("metas", Value::Array(Vec::new()));
            let mut files = Object::new();
            files.insert(format!("{id}.json"), content.into());
            let mut body = Object::new();
            body.insert(
                "clock",
                meta.clock(pipette_entry_store::EntryGroup::Body).cloned().unwrap_or(Value::Null),
            );
            body.insert("fields", Value::Object(body_fields(self.entry_store, meta.as_object())));
            let mut bundle = Object::new();
            bundle.insert("type", self.bundle_types().1.into());
            bundle.insert("key", id.into());
            bundle.insert("index", Value::Object(metas));
            bundle.insert("files", Value::Object(files));
            bundle.insert("body", Value::Object(body));
            Ok(Some(bundle))
        })
    }
}
