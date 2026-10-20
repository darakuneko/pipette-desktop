// SPDX-License-Identifier: GPL-2.0-or-later
//! Per-key write serialization of the stores. Each store does a
//! read-modify-write of its files from independent callers; running the
//! tasks of one key one at a time, in the order they asked, makes every
//! read-merge-write atomic against the others, while different keys still
//! run in parallel. The keys are the keyboard
//! uid (snapshots and settings), `favorites/{type}`, the sync unit of the
//! cross-keyboard stores, and [`META_LOCK_KEY`].
//!
//! Lock order: a task that needs several keys takes the uid-like keys first
//! and [`META_LOCK_KEY`] last (a snapshot save updates the keyboard names
//! while it holds the uid), so two tasks can never wait on each other.
//! [`WriteLocks::with_write_locks`] takes its keys in that order. A lock is
//! not reentrant: taking a key the same thread holds would wait forever.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use pipette_fifo::{FifoLock, OwnedFifoGuard};

/// The key of the keyboard-names store (`sync/meta/keyboard-names.json`),
/// always taken after every other key.
pub const META_LOCK_KEY: &str = "meta/keyboard-names";

/// A FIFO lock per key, served in the order the tasks asked. A key's lock
/// goes once no task holds or waits for it, so the map stays bounded by the
/// keys in use.
#[derive(Debug, Default)]
pub struct WriteLocks {
    queues: Mutex<BTreeMap<String, Arc<FifoLock>>>,
}

/// Held while a task runs; releasing it serves the next task of the key,
/// also when the task panics.
struct Held<'a> {
    locks: &'a WriteLocks,
    key: String,
    guard: Option<OwnedFifoGuard>,
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        drop(self.guard.take());
        let mut queues = self.locks.queues();
        // Every task that holds or waits for the key has a clone, taken
        // under the map's mutex: only the map's own reference left means
        // the key is idle.
        if queues.get(&self.key).is_some_and(|lock| Arc::strong_count(lock) == 1) {
            queues.remove(&self.key);
        }
    }
}

impl WriteLocks {
    pub const fn new() -> Self {
        WriteLocks { queues: Mutex::new(BTreeMap::new()) }
    }

    /// The map; a panic elsewhere never leaves it half-updated (every
    /// update is one insert or removal).
    fn queues(&self) -> MutexGuard<'_, BTreeMap<String, Arc<FifoLock>>> {
        self.queues.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn acquire(&self, key: &str) -> Held<'_> {
        let lock = Arc::clone(self.queues().entry(key.to_owned()).or_default());
        let guard = lock.acquire_owned();
        Held { locks: self, key: key.to_owned(), guard: Some(guard) }
    }

    /// Runs `task` after every task that asked for `key` before it has
    /// finished (or panicked: one failed write never stalls the key).
    pub fn with_write_lock<T>(&self, key: &str, task: impl FnOnce() -> T) -> T {
        let _held = self.acquire(key);
        task()
    }

    /// Runs `task` holding every key of `keys` for its whole span (not
    /// released between keys): a multi-key operation needs every key it
    /// touches locked from its first read to its last write. The keys are
    /// deduplicated (a repeated key would wait on itself) and taken in one
    /// fixed order whatever order they came in, so two callers sharing
    /// keys never wait on each other: by UTF-16 code units (JavaScript's
    /// `sort`), with [`META_LOCK_KEY`] last.
    pub fn with_write_locks<T>(&self, keys: &[&str], task: impl FnOnce() -> T) -> T {
        let mut ordered: Vec<(bool, Vec<u16>, &str)> =
            keys.iter().map(|&key| (key == META_LOCK_KEY, key.encode_utf16().collect(), key)).collect();
        ordered.sort();
        ordered.dedup();
        let mut held = Vec::with_capacity(ordered.len());
        for (_, _, key) in ordered {
            held.push(self.acquire(key));
        }
        let out = task();
        while let Some(lock) = held.pop() {
            drop(lock);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;

    const TIMEOUT: Duration = Duration::from_secs(5);

    fn tickets(locks: &WriteLocks, key: &str) -> u64 {
        locks.queues().get(key).map_or(0, |lock| lock.issued())
    }

    /// Starts `task` on a thread and returns once it holds or waits for
    /// `key`, so the order of the calls is the order of the tickets.
    fn spawn_queued<T: Send + 'static>(
        locks: &WriteLocks,
        key: &str,
        task: impl FnOnce() -> T + Send + 'static,
    ) -> thread::JoinHandle<T> {
        let before = tickets(locks, key);
        let handle = thread::spawn(task);
        let start = Instant::now();
        while tickets(locks, key) == before {
            assert!(start.elapsed() < TIMEOUT, "the task never asked for {key}");
            thread::sleep(Duration::from_millis(1));
        }
        handle
    }

    #[test]
    fn serializes_tasks_for_the_same_key_in_queue_order() {
        let locks = Arc::new(WriteLocks::new());
        let order = Arc::new(Mutex::new(Vec::new()));
        let (go, gate) = mpsc::channel::<()>();
        let mut handles = vec![{
            let (locks, order) = (locks.clone(), order.clone());
            spawn_queued(&locks.clone(), "uid", move || {
                locks.with_write_lock("uid", || {
                    gate.recv_timeout(TIMEOUT).unwrap();
                    order.lock().unwrap().push(0);
                })
            })
        }];
        for i in 1..4 {
            let (locks, order) = (locks.clone(), order.clone());
            handles.push(spawn_queued(&locks.clone(), "uid", move || {
                locks.with_write_lock("uid", || order.lock().unwrap().push(i))
            }));
        }
        go.send(()).unwrap();
        handles.into_iter().for_each(|h| h.join().unwrap());
        assert_eq!(*order.lock().unwrap(), [0, 1, 2, 3]);
        assert!(locks.queues().is_empty());
    }

    #[test]
    fn a_failed_task_does_not_stall_the_key() {
        let locks = Arc::new(WriteLocks::new());
        let failing = {
            let locks = locks.clone();
            thread::spawn(move || locks.with_write_lock("uid", || panic!("boom")))
        };
        assert!(failing.join().is_err());
        assert_eq!(locks.with_write_lock("uid", || "ok"), "ok");
        assert!(locks.queues().is_empty());
    }

    #[test]
    fn different_keys_run_in_parallel() {
        let locks = Arc::new(WriteLocks::new());
        let (tx, rx) = mpsc::channel();
        let holder = {
            let locks = locks.clone();
            spawn_queued(&locks.clone(), "a", move || {
                locks.with_write_lock("a", || rx.recv_timeout(TIMEOUT).unwrap())
            })
        };
        // "b" runs while "a" is held, and lets the "a" task finish.
        locks.with_write_lock("b", || tx.send(()).unwrap());
        holder.join().unwrap();
    }

    #[test]
    fn a_repeated_key_is_locked_once() {
        let locks = WriteLocks::new();
        let mut calls = 0;
        locks.with_write_locks(&["a", "a", "a"], || calls += 1);
        assert_eq!(calls, 1);
        assert_eq!(locks.with_write_locks(&[], || "done"), "done");
        assert!(locks.queues().is_empty());
    }

    #[test]
    fn overlapping_callers_take_shared_keys_in_one_order_and_hold_them_for_the_whole_task() {
        let locks = Arc::new(WriteLocks::new());
        let order = Arc::new(Mutex::new(Vec::new()));
        let (go, gate) = mpsc::channel::<()>();
        let first = {
            let (locks, order) = (locks.clone(), order.clone());
            spawn_queued(&locks.clone(), "b", move || {
                locks.with_write_locks(&["b", "a"], || {
                    order.lock().unwrap().push("A-start");
                    gate.recv_timeout(TIMEOUT).unwrap();
                    order.lock().unwrap().push("A-end");
                })
            })
        };
        // Given in the other order, B still asks for "a" first.
        let second = {
            let (locks, order) = (locks.clone(), order.clone());
            spawn_queued(&locks.clone(), "a", move || {
                locks.with_write_locks(&["a", "b"], || order.lock().unwrap().push("B"))
            })
        };
        let single = {
            let (locks, order) = (locks.clone(), order.clone());
            spawn_queued(&locks.clone(), "b", move || {
                locks.with_write_lock("b", || order.lock().unwrap().push("single-b"))
            })
        };
        go.send(()).unwrap();
        for handle in [first, second, single] {
            handle.join().unwrap();
        }
        // Neither ran inside A's task. B got "a" after A and then queued on
        // "b" behind the single-key task, which asked for "b" first.
        assert_eq!(*order.lock().unwrap(), ["A-start", "A-end", "single-b", "B"]);
        assert!(locks.queues().is_empty());
    }

    #[test]
    fn the_meta_key_is_taken_after_every_other_key() {
        let locks = Arc::new(WriteLocks::new());
        let (go, gate) = mpsc::channel::<()>();
        let (done, finished) = mpsc::channel();
        // A snapshot save: the uid, then the meta key while holding it.
        let nested = {
            let (locks, done) = (locks.clone(), done.clone());
            spawn_queued(&locks.clone(), "~uid", move || {
                locks.with_write_lock("~uid", || {
                    gate.recv_timeout(TIMEOUT).unwrap();
                    locks.with_write_lock(META_LOCK_KEY, || done.send("nested").unwrap());
                })
            })
        };
        // "~" sorts after "m", yet the meta key is taken last, so this task
        // waits for "~uid" without holding the meta key the save needs next.
        let multi = {
            let locks = locks.clone();
            spawn_queued(&locks.clone(), "~uid", move || {
                locks.with_write_locks(&[META_LOCK_KEY, "~uid"], || done.send("multi").unwrap())
            })
        };
        assert_eq!(tickets(&locks, META_LOCK_KEY), 0);
        go.send(()).unwrap();
        assert_eq!(finished.recv_timeout(TIMEOUT), Ok("nested"));
        assert_eq!(finished.recv_timeout(TIMEOUT), Ok("multi"));
        nested.join().unwrap();
        multi.join().unwrap();
    }
}
