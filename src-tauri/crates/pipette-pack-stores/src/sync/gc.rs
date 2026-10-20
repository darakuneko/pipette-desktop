// SPDX-License-Identifier: GPL-2.0-or-later
//! The garbage collection a sync pass runs on the pack stores it touched:
//! drop the
//! tombstones past their 30 days, then remove the body files no meta names.
//!
//! It runs once per whole download pass, never from the merge of one unit:
//! the roster and the body units merge in parallel, so a sweep after one of
//! them could remove the body of a pack whose meta has not landed yet. For
//! the same reason the sweep is skipped when any unit of the store failed
//! in the pass; the purge only removes metas already past their TTL, so it
//! still runs.

use std::fs;

use pipette_entry_store::TOMBSTONE_TTL_MS;
use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::StoreContext;
use pipette_time::date_value_ms;

use super::PackSyncError;
use crate::i18n::I18N_PACKS;
use crate::pack_store::PackStore;
use crate::theme::THEME_PACKS;

/// What one store's GC removed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GcCounts {
    pub purged: usize,
    pub swept: usize,
}

/// Runs the GC of every pack store a download pass attempted to merge a
/// unit of. A store whose unit failed in the pass skips the sweep. Never
/// fails: a failure is logged by store name only.
pub fn run_pack_gc_after_pass(ctx: &StoreContext, attempted: &[String], failed: &[String]) {
    let touches = |units: &[String], prefix: &str| units.iter().any(|u| u.starts_with(prefix));
    for (store, label) in [(&I18N_PACKS, "i18n"), (&THEME_PACKS, "theme")] {
        let prefix = format!("{}/", store.dir);
        if !touches(attempted, &prefix) {
            continue;
        }
        if let Err(err) = store.run_gc_under_lock(ctx, touches(failed, &prefix)) {
            log::warn!("pack-gc: {label} sweep failed: {err}");
        }
    }
}

/// Temp files of an atomic write of a `.json` target
/// (`<name>.json.<pid>.<hex>.tmp`) and the plain `<name>.json.tmp`.
fn is_temp_file(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".tmp") else { return false };
    if stem.ends_with(".json") {
        return true;
    }
    let mut parts = stem.rsplitn(3, '.');
    let (Some(hex), Some(pid), Some(head)) = (parts.next(), parts.next(), parts.next()) else { return false };
    !hex.is_empty()
        && hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && !pid.is_empty()
        && pid.bytes().all(|b| b.is_ascii_digit())
        && head.ends_with(".json")
}

impl PackStore {
    /// The index for the GC: `None` when it cannot be trusted as the whole
    /// roster (unreadable, or missing while body files exist); an empty one
    /// for a store that never saved anything.
    fn read_index_for_gc(&self, ctx: &StoreContext) -> Option<Object> {
        let Ok(bytes) = fs::read(self.index_path(ctx)) else {
            let has_bodies = fs::read_dir(self.packs_dir(ctx))
                .map(|dir| dir.flatten().any(|e| e.file_name().to_string_lossy().ends_with(".json")))
                .unwrap_or(false);
            if has_bodies {
                return None;
            }
            let mut empty = Object::new();
            empty.insert("metas", Value::Array(Vec::new()));
            return Some(empty);
        };
        match pipette_js_json::parse(&String::from_utf8_lossy(&bytes)) {
            Ok(Value::Object(root)) if matches!(root.get("metas"), Some(Value::Array(_))) => Some(root),
            _ => None,
        }
    }

    /// Purges the expired tombstones and sweeps the orphan body files under
    /// one hold of the store's lock. A purge writes the index (as read,
    /// without the purged metas) and reports the roster.
    pub fn run_gc_under_lock(&self, ctx: &StoreContext, skip_sweep: bool) -> Result<GcCounts, PackSyncError> {
        self.with_lock(ctx, || {
            let Some(mut index) = self.read_index_for_gc(ctx) else {
                log::warn!(
                    "pack-gc: skipped {} sweep — index missing/unreadable while pack bodies exist",
                    self.index_unit()
                );
                return Ok(GcCounts::default());
            };
            let Some(Value::Array(metas)) = index.get("metas").cloned() else {
                return Ok(GcCounts::default());
            };
            #[allow(clippy::cast_precision_loss)]
            let cutoff = (ctx.now_ms() - TOMBSTONE_TTL_MS) as f64;
            let mut kept = Vec::with_capacity(metas.len());
            let mut purged = 0;
            for meta in metas {
                let deleted_at = match &meta {
                    Value::Null => {
                        return Err(PackSyncError::Pack(crate::PackError::io(
                            "TypeError: Cannot read properties of null (reading 'deletedAt')",
                        )));
                    }
                    Value::Object(o) => o.get("deletedAt"),
                    _ => None,
                };
                let expired = deleted_at
                    .filter(|d| d.is_truthy())
                    .and_then(date_value_ms)
                    .is_some_and(|deleted| deleted < cutoff);
                if !expired {
                    kept.push(meta);
                    continue;
                }
                purged += 1;
                // Best effort: the meta goes whatever happens to its body.
                if let Some(Value::String(id)) = meta.as_object().and_then(|o| o.get("id"))
                    && let Some(path) = self.pack_path(ctx, id)
                {
                    let _ = fs::remove_file(path);
                }
            }
            if purged > 0 {
                index.insert("metas", Value::Array(kept.clone()));
                fs::create_dir_all(self.store_dir(ctx))?;
                let text = pipette_js_json::stringify_with_gap(&Value::Object(index), "  ");
                pipette_fs::write_file_atomic(&self.index_path(ctx), text.as_bytes())?;
                self.notify_index_change(ctx);
            }
            if skip_sweep {
                log::warn!("pack-gc: skipped {} sweep — a sync unit failed this pass", self.index_unit());
                return Ok(GcCounts { purged, swept: 0 });
            }
            let known: Vec<String> = kept
                .iter()
                .map(|m| {
                    format!("{}.json", pipette_js_json::js_string(m.as_object().and_then(|o| o.get("id"))))
                })
                .collect();
            Ok(GcCounts { purged, swept: self.sweep_orphan_files(ctx, &known) })
        })
    }

    /// Removes every `.json` file in the packs directory no name in `known`
    /// matches, and every leftover temp file of an atomic write. Best
    /// effort; returns how many went.
    fn sweep_orphan_files(&self, ctx: &StoreContext, known: &[String]) -> usize {
        let Ok(dir) = fs::read_dir(self.packs_dir(ctx)) else { return 0 };
        let mut removed = 0;
        for item in dir.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            let orphan = is_temp_file(&name) || (name.ends_with(".json") && !known.contains(&name));
            if orphan && fs::remove_file(item.path()).is_ok() {
                removed += 1;
            }
        }
        removed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_files_match_the_temp_name_pattern() {
        for name in ["a.json.tmp", "a.json.123.abc0.tmp", ".json.1.f.tmp", "x.json.json.9.0.tmp"] {
            assert!(is_temp_file(name), "{name}");
        }
        for name in
            ["a.json", "a.tmp", "a.json.12.ABC.tmp", "a.json..abc.tmp", "a.json.1..tmp", "a.jsonx.1.a.tmp"]
        {
            assert!(!is_temp_file(name), "{name}");
        }
    }
}
