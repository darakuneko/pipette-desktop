// SPDX-License-Identifier: GPL-2.0-or-later
//! The locks a sync of one unit holds across its awaits (the `sync:` key, and
//! the `upload:` key around an upload). The store locks
//! (`pipette_entry_store::WriteLocks`) are held only around a read or a write
//! of the files; these are held while a task downloads, merges and uploads.
//! Tasks of one key run one at a time in the order they asked; different keys
//! run in parallel. A key is not reentrant: a task that takes the key it
//! already holds waits forever.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use crate::units::is_typing_deleted_ranges_sync_unit;

/// The key a whole sync of `unit` holds: only a device's deleted-ranges unit
/// has one. Without it, a sync that bundled the file before its upload could
/// overwrite Drive after another sync of the same unit merged newer entries
/// from Drive into the file and found nothing to upload, leaving Drive without
/// entries this device holds.
pub fn unit_sync_lock_key(unit: &str) -> Option<String> {
    is_typing_deleted_ranges_sync_unit(unit).then(|| format!("sync:{unit}"))
}

/// A FIFO lock per key. A key's lock goes once no task holds or waits for
/// it, so the map stays bounded by the keys in use.
#[derive(Debug, Default)]
pub struct UnitLocks {
    locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

/// Held while a task runs; releasing it serves the next task of the key,
/// also when the task's future is dropped before it finished.
struct Held<'a> {
    locks: &'a UnitLocks,
    key: String,
    lock: Arc<AsyncMutex<()>>,
    guard: Option<OwnedMutexGuard<()>>,
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        drop(self.guard.take());
        let mut locks = self.locks.map();
        // Every task that holds or waits for the key has a clone, taken
        // under the map's mutex: the map's and this one left means idle.
        if Arc::strong_count(&self.lock) == 2 {
            locks.remove(&self.key);
        }
    }
}

impl UnitLocks {
    pub fn new() -> Self {
        Self::default()
    }

    fn map(&self) -> MutexGuard<'_, HashMap<String, Arc<AsyncMutex<()>>>> {
        self.locks.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `task` after every task that asked for `key` before it has
    /// finished.
    pub async fn with_lock<T>(&self, key: &str, task: impl Future<Output = T>) -> T {
        let lock = self.map().entry(key.to_owned()).or_default().clone();
        let mut held = Held { locks: self, key: key.to_owned(), lock: lock.clone(), guard: None };
        held.guard = Some(lock.lock_owned().await);
        let out = task.await;
        drop(held);
        out
    }

    /// Runs `task` holding `unit`'s [`unit_sync_lock_key`], or at once for
    /// a unit without one.
    pub async fn with_unit_sync_lock<T>(&self, unit: &str, task: impl Future<Output = T>) -> T {
        match unit_sync_lock_key(unit) {
            Some(key) => self.with_lock(&key, task).await,
            None => task.await,
        }
    }

    /// How many keys are held or waited for.
    #[cfg(test)]
    fn keys_in_use(&self) -> usize {
        self.map().len()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::sync::{Mutex as AsyncMutex, oneshot};

    use super::*;

    const RANGES: &str = "keyboards/kb1/devices/h/deleted-ranges";

    #[test]
    fn only_a_deleted_ranges_unit_has_a_sync_lock() {
        assert_eq!(
            unit_sync_lock_key(RANGES).as_deref(),
            Some("sync:keyboards/kb1/devices/h/deleted-ranges")
        );
        assert_eq!(unit_sync_lock_key("keyboards/kb1/devices/h/days/2026-10-14"), None);
        assert_eq!(unit_sync_lock_key("favorites/macro"), None);
    }

    #[tokio::test]
    async fn tasks_of_one_unit_run_in_the_order_they_asked() {
        let locks = Arc::new(UnitLocks::new());
        let order = Arc::new(AsyncMutex::new(Vec::new()));
        let (release, released) = oneshot::channel::<()>();
        let (started, first_started) = oneshot::channel::<()>();
        let first = {
            let (locks, order) = (locks.clone(), order.clone());
            tokio::spawn(async move {
                locks
                    .with_unit_sync_lock(RANGES, async {
                        started.send(()).unwrap();
                        released.await.unwrap();
                        order.lock().await.push("first");
                    })
                    .await;
            })
        };
        first_started.await.unwrap();
        let second = {
            let (locks, order) = (locks.clone(), order.clone());
            tokio::spawn(async move {
                locks.with_unit_sync_lock(RANGES, async { order.lock().await.push("second") }).await;
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(order.lock().await.is_empty());
        release.send(()).unwrap();
        first.await.unwrap();
        second.await.unwrap();
        assert_eq!(*order.lock().await, ["first", "second"]);
        assert_eq!(locks.keys_in_use(), 0);
    }

    #[tokio::test]
    async fn other_units_do_not_wait() {
        let locks = Arc::new(UnitLocks::new());
        let (release, released) = oneshot::channel::<()>();
        let (started, held) = oneshot::channel::<()>();
        let holder = {
            let locks = locks.clone();
            tokio::spawn(async move {
                locks
                    .with_unit_sync_lock(RANGES, async {
                        started.send(()).unwrap();
                        released.await.unwrap();
                    })
                    .await;
            })
        };
        held.await.unwrap();
        let other = locks.with_unit_sync_lock("keyboards/kb1/devices/other/deleted-ranges", async { 1 });
        assert_eq!(tokio::time::timeout(Duration::from_secs(5), other).await.unwrap(), 1);
        let day = locks.with_unit_sync_lock("keyboards/kb1/devices/h/days/2026-10-14", async { 2 });
        assert_eq!(tokio::time::timeout(Duration::from_secs(5), day).await.unwrap(), 2);
        release.send(()).unwrap();
        holder.await.unwrap();
    }

    #[tokio::test]
    async fn a_dropped_task_releases_its_key() {
        let locks = UnitLocks::new();
        let pending = locks.with_lock("k", std::future::pending::<()>());
        assert!(tokio::time::timeout(Duration::from_millis(10), pending).await.is_err());
        assert_eq!(locks.keys_in_use(), 0);
        assert_eq!(locks.with_lock("k", async { 3 }).await, 3);
    }
}
