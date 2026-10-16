// SPDX-License-Identifier: GPL-2.0-or-later
//! Whether the SQLite cache can be trusted for this device
//! (`ensureCacheIsFresh`, src/main/typing-analytics/cache-rebuild.ts).
//!
//! The cache is rebuilt from the JSONL masters when `sync_state.json` is
//! missing, cannot be read or names another device, or when the caller
//! forces it (a schema migration dropped tables). The database file itself
//! is not looked at: deleting only the database leaves an empty cache that
//! is not rebuilt, as in the Electron build.

use std::path::Path;

use pipette_entry_store::Clock;

use crate::Error;
use crate::sync_state::{TypingSyncState, load_sync_state, save_sync_state};

/// What [`ensure_cache_is_fresh`] found and did.
#[derive(Clone, Debug, PartialEq)]
pub struct Freshness {
    pub rebuilt: bool,
    pub state: TypingSyncState,
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
    if let Some(state) = existing.filter(|state| !force && state.my_device_id.as_str() == Some(my_device_id))
    {
        return Ok(Freshness { rebuilt: false, state });
    }
    rebuild()?;
    let state =
        TypingSyncState { last_synced_at: clock.now_ms() as f64, ..TypingSyncState::empty(my_device_id) };
    save_sync_state(user_data, &state)?;
    Ok(Freshness { rebuilt: true, state })
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
        assert_eq!(first.state, TypingSyncState { last_synced_at: 42.0, ..TypingSyncState::empty("a") });
        let (again, ran) = ensure(dir.path(), "a", false);
        assert!(!ran && !again.rebuilt);
        assert_eq!(again.state, first.state);
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
