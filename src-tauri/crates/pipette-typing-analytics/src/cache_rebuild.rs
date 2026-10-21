// SPDX-License-Identifier: GPL-2.0-or-later
//! Rebuilding the SQLite cache from the JSONL masters, and deciding whether
//! it can be trusted for this device.
//!
//! The cache is rebuilt when `sync_state.json` is missing, cannot be read
//! or names another device, or when the caller forces it (a schema
//! migration dropped tables, an import replaced day files). The database
//! file itself is not looked at: deleting only the database leaves an
//! empty cache that is not rebuilt.
//!
//! A rebuild empties the data tables and replays every day file, one
//! database job per file: the files of other devices with their deleted
//! ranges hidden (deleted_ranges_cache.rs), the ranges read inside that
//! file's job. Between the jobs the queries and the flush run.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;
use std::sync::Arc;

use pipette_entry_store::Clock;
use pipette_typing_analytics_db::{ApplyRowsResult, DayRows};

use crate::Error;
use crate::db_actor::DbActor;
use crate::deleted_ranges::{clip_to_utc_day, read_deleted_ranges_lenient};
use crate::deleted_ranges_cache::replay_day_hiding_deleted_ranges;
use crate::jsonl::paths::list_all_device_day_jsonl_files;
use crate::service::RebuildCache;
use crate::sync_state::{TypingSyncState, load_sync_state, save_sync_state};

/// What a rebuild applied (`CacheRebuildResult`): the rows per kind, and
/// the day files that held rows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CacheRebuildResult {
    pub rows: ApplyRowsResult,
    pub jsonl_files_read: u64,
}

impl CacheRebuildResult {
    fn add(&mut self, applied: ApplyRowsResult) {
        let rows = &mut self.rows;
        rows.scopes += applied.scopes;
        rows.char_minutes += applied.char_minutes;
        rows.matrix_minutes += applied.matrix_minutes;
        rows.minute_stats += applied.minute_stats;
        rows.sessions += applied.sessions;
        rows.bigram_minutes += applied.bigram_minutes;
        rows.trigram_minutes += applied.trigram_minutes;
        self.jsonl_files_read += 1;
    }
}

/// The text of a day file: a file that cannot be
/// opened has none (`None`), an error while reading an opened one fails.
fn read_day_text(path: &Path) -> io::Result<Option<String>> {
    let Ok(mut file) = File::open(path) else { return Ok(None) };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// Empties the data tables of the cache and
/// replays every day file of every keyboard and device, the files of a
/// hash other than `own_hash` with that hash's deleted ranges hidden at
/// the clock's time. A file without rows is skipped without reading its
/// ranges. Blocks; must not run on an async task.
pub fn rebuild_cache_from_master_files(
    db: &DbActor,
    user_data: &Path,
    own_hash: &str,
    clock: &Arc<dyn Clock>,
) -> Result<CacheRebuildResult, Error> {
    db.call_blocking(|db| db.truncate_cache())??;
    let mut result = CacheRebuildResult::default();
    for day in list_all_device_day_jsonl_files(user_data) {
        let Some(text) = read_day_text(&day.path)? else { continue };
        let (user_data, own_hash, clock) = (user_data.to_path_buf(), own_hash.to_owned(), clock.clone());
        let applied = db.call_blocking(move |db| {
            let rows = DayRows::parse(&text);
            if rows.is_empty() {
                return Ok(None);
            }
            let hidden = || {
                let ranges: Vec<_> = read_deleted_ranges_lenient(&user_data, &day.uid, &day.machine_hash)
                    .into_iter()
                    .map(|entry| entry.range)
                    .collect();
                // The listing only yields valid days.
                clip_to_utc_day(&ranges, &day.utc_day).unwrap_or_default()
            };
            replay_day_hiding_deleted_ranges(
                db,
                &rows,
                &day.uid,
                &day.machine_hash,
                &own_hash,
                clock.as_ref(),
                hidden,
            )
            .map(Some)
        })??;
        if let Some(applied) = applied {
            result.add(applied);
        }
    }
    Ok(result)
}

/// The rebuild the app runs: [`rebuild_cache_from_master_files`] at the
/// time of `clock`.
pub fn rebuild_from_master_files(clock: Arc<dyn Clock>) -> RebuildCache {
    Arc::new(move |db, user_data, own_hash| {
        rebuild_cache_from_master_files(db, user_data, own_hash, &clock).map(drop)
    })
}

/// What [`ensure_cache_is_fresh`] found and did.
#[derive(Clone, Debug, PartialEq)]
pub struct Freshness {
    pub rebuilt: bool,
}

/// Rebuilds the cache with `rebuild` when it cannot be trusted for
/// `my_device_id`, then saves an empty state for the device with the time
/// the rebuild finished as `last_synced_at`. A failed rebuild or save is
/// returned; the state is then not saved, so the next call rebuilds again.
pub fn ensure_cache_is_fresh(
    user_data: &Path,
    my_device_id: &str,
    force: bool,
    clock: &dyn Clock,
    rebuild: impl FnOnce() -> Result<(), Error>,
) -> Result<Freshness, Error> {
    let existing = load_sync_state(user_data);
    if existing.is_some_and(|state| !force && state.my_device_id.as_str() == Some(my_device_id)) {
        return Ok(Freshness { rebuilt: false });
    }
    rebuild()?;
    let state =
        TypingSyncState { last_synced_at: clock.now_ms() as f64, ..TypingSyncState::empty(my_device_id) };
    save_sync_state(user_data, &state)?;
    Ok(Freshness { rebuilt: true })
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use pipette_entry_store::FixedClock;

    use super::*;
    use crate::sync_state::sync_state_path;

    fn ensure(dir: &Path, device: &str, force: bool) -> (Freshness, bool) {
        let ran = Cell::new(false);
        let freshness = ensure_cache_is_fresh(dir, device, force, &FixedClock::new(42), || {
            ran.set(true);
            Ok(())
        })
        .unwrap();
        (freshness, ran.get())
    }

    #[test]
    fn rebuilds_once_per_device_and_when_forced() {
        let dir = tempfile::tempdir().unwrap();
        let (first, ran) = ensure(dir.path(), "a", false);
        assert!(ran && first.rebuilt);
        let saved = TypingSyncState { last_synced_at: 42.0, ..TypingSyncState::empty("a") };
        assert_eq!(load_sync_state(dir.path()), Some(saved.clone()));
        let (again, ran) = ensure(dir.path(), "a", false);
        assert!(!ran && !again.rebuilt);
        assert_eq!(load_sync_state(dir.path()), Some(saved));
        assert!(ensure(dir.path(), "b", false).1);
        assert!(ensure(dir.path(), "b", true).1);
    }

    #[test]
    fn a_failed_rebuild_saves_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let result = ensure_cache_is_fresh(dir.path(), "a", false, &FixedClock::new(1), || {
            Err(Error::CacheRebuild("no".into()))
        });
        assert!(matches!(result, Err(Error::CacheRebuild(_))));
        assert!(!sync_state_path(dir.path()).exists());
    }
}
