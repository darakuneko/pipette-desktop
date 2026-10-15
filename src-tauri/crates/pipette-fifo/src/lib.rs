// SPDX-License-Identifier: GPL-2.0-or-later
//! A ticket lock: callers get the lock strictly in arrival order (std's
//! Mutex makes no fairness promise). The HID service sends requests in the
//! order they were issued with it; the entry stores run the writes of one
//! key in the order they asked.

use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

#[derive(Debug, Default)]
pub struct FifoLock {
    tickets: Mutex<Tickets>,
    turn: Condvar,
}

#[derive(Debug, Default)]
struct Tickets {
    next: u64,
    serving: u64,
}

/// Held while the caller runs; dropping it (also on a panic) serves the
/// next ticket.
pub struct FifoGuard<'a> {
    lock: &'a FifoLock,
}

/// [`FifoGuard`] that keeps the lock alive itself.
pub struct OwnedFifoGuard {
    lock: Arc<FifoLock>,
}

impl FifoLock {
    /// The counters only ever step forward, so a panic elsewhere never
    /// leaves them half-updated.
    fn tickets(&self) -> MutexGuard<'_, Tickets> {
        self.tickets.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn wait_turn(&self) {
        let mut tickets = self.tickets();
        let ticket = tickets.next;
        tickets.next += 1;
        while tickets.serving != ticket {
            tickets = self.turn.wait(tickets).unwrap_or_else(PoisonError::into_inner);
        }
    }

    fn release(&self) {
        self.tickets().serving += 1;
        self.turn.notify_all();
    }

    pub fn acquire(&self) -> FifoGuard<'_> {
        self.wait_turn();
        FifoGuard { lock: self }
    }

    pub fn acquire_owned(self: &Arc<Self>) -> OwnedFifoGuard {
        self.wait_turn();
        OwnedFifoGuard { lock: Arc::clone(self) }
    }

    /// How many tickets were handed out so far (holders, waiters and those
    /// already served), for tests that wait until a caller has queued.
    pub fn issued(&self) -> u64 {
        self.tickets().next
    }
}

impl Drop for FifoGuard<'_> {
    fn drop(&mut self) {
        self.lock.release();
    }
}

impl Drop for OwnedFifoGuard {
    fn drop(&mut self) {
        self.lock.release();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;

    fn wait_issued(lock: &FifoLock, count: u64) {
        let start = Instant::now();
        while lock.issued() < count {
            assert!(start.elapsed() < Duration::from_secs(5));
            thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn serves_callers_in_arrival_order() {
        let lock = Arc::new(FifoLock::default());
        let order = Arc::new(Mutex::new(Vec::new()));
        let (go, gate) = mpsc::channel::<()>();
        let mut handles = Vec::new();
        {
            let (lock, order) = (lock.clone(), order.clone());
            handles.push(thread::spawn(move || {
                let _held = lock.acquire();
                gate.recv_timeout(Duration::from_secs(5)).unwrap();
                order.lock().unwrap().push(0);
            }));
        }
        wait_issued(&lock, 1);
        for i in 1..4 {
            let (lock2, order) = (lock.clone(), order.clone());
            handles.push(thread::spawn(move || {
                let _held = lock2.acquire_owned();
                order.lock().unwrap().push(i);
            }));
            wait_issued(&lock, i + 1);
        }
        go.send(()).unwrap();
        handles.into_iter().for_each(|h| h.join().unwrap());
        assert_eq!(*order.lock().unwrap(), [0, 1, 2, 3]);
    }

    #[test]
    fn a_panic_while_held_releases_the_lock() {
        let lock = Arc::new(FifoLock::default());
        let held = lock.clone();
        assert!(
            thread::spawn(move || {
                let _guard = held.acquire_owned();
                panic!("boom");
            })
            .join()
            .is_err()
        );
        drop(lock.acquire());
        assert_eq!(lock.issued(), 2);
    }
}
