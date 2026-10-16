// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync of the pack stores (src/main/sync/pack-sync.ts and the stores'
//! sync and GC entry points), shared by the language and theme packs.
//!
//! A pack has two sync units: the roster (`{i18n|themes}/index`, every
//! pack's meta) and one body unit per pack (`…/packs/{id}`, the pack JSON).
//! The body group of a meta (`version`, and coverage and the like for the
//! language packs) always describes the local body file:
//! - The roster merge keeps a local entry's body group whatever the remote
//!   clocks say ([`BodyPolicy::LocalIfPresent`]). An entry this device has
//!   no live copy of takes the remote body fields for display with body
//!   clock 0, and its body unit is fetched on the next pass.
//! - A body bundle carries its own clock and body fields, read from the
//!   local meta under the store's lock. Applying one compares them with the
//!   local meta ([`compare_bodies`]) and, when the remote body wins, writes
//!   the file and the meta's body group in one locked step.
//!
//! Every function runs under the store's write lock, the key the store's
//! own writes take.
//!
//! [`BodyPolicy::LocalIfPresent`]: pipette_entry_store::BodyPolicy::LocalIfPresent
//! [`compare_bodies`]: pipette_entry_store::compare_bodies

mod body;
mod bundle;
mod gc;
mod index;

use pipette_entry_store::{EntryStore, body_fields_of};
use pipette_js_json::{Object, Value};

pub use body::ApplyPackBodyOutcome;
pub use gc::{GcCounts, run_pack_gc_after_pass};
pub use index::PackIndexMergeResult;

use crate::pack_store::PackStore;

/// Why a pack sync step failed.
#[derive(Debug, thiserror::Error)]
pub enum PackSyncError {
    /// A remote bundle or unit name the merge does not accept
    /// (`MalformedSyncBundleError`); the text carries only the unit name.
    #[error("malformed sync bundle index for {0}")]
    Malformed(String),
    /// A body arrived for an id the local roster does not know yet, and
    /// the roster has not been merged in this pass: the roster may still
    /// bring the meta (`PackMetaPendingError`).
    #[error("sync: no local meta yet for {0}")]
    MetaPending(String),
    #[error("{0}")]
    Pack(crate::PackError),
}

impl From<crate::PackError> for PackSyncError {
    fn from(err: crate::PackError) -> Self {
        Self::Pack(err)
    }
}

impl From<std::io::Error> for PackSyncError {
    fn from(err: std::io::Error) -> Self {
        Self::Pack(err.into())
    }
}

impl PackStore {
    /// The sync unit of the body of `id`.
    pub fn body_sync_unit(&self, id: &str) -> String {
        format!("{}/packs/{id}", self.dir)
    }

    /// The bundle `type` of the roster and of a body.
    fn bundle_types(&self) -> (&'static str, &'static str) {
        match self.entry_store {
            EntryStore::ThemePacks => ("theme-index", "theme-pack"),
            _ => ("i18n-index", "i18n-pack"),
        }
    }
}

/// The body group of `meta` without `filename` (fixed per id).
fn body_fields(store: EntryStore, meta: &Object) -> Object {
    body_fields_of(store.groups(), meta)
        .into_iter()
        .filter(|f| f.as_str() != Some("filename"))
        .filter_map(|f| {
            let value = meta.iter().find(|(k, _)| **k == f).map(|(_, v)| v.clone())?;
            Some((f, value))
        })
        .collect()
}

/// Whether `value` is an object to JavaScript's `typeof` and not `null`
/// (arrays included).
fn is_js_object(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_) | Value::Array(_)))
}

/// An object `m` whose `id` is a string (`isPackMetaCandidate`).
fn meta_candidate_id(meta: &Value) -> Option<&pipette_js_json::JsString> {
    match meta {
        Value::Object(o) => match o.get("id") {
            Some(Value::String(id)) => Some(id),
            _ => None,
        },
        _ => None,
    }
}
