// SPDX-License-Identifier: GPL-2.0-or-later
//! A ticket lock: callers get the lock strictly in arrival order, so HID
//! requests are sent in the order they were issued (std's Mutex makes no
//! fairness promise).

use std::sync::{Condvar, Mutex, PoisonError};

#[derive(Default)]
pub struct FifoLock {
    tickets: Mutex<Tickets>,
    turn: Condvar,
}

#[derive(Default)]
struct Tickets {
    next: u64,
    serving: u64,
}

pub struct FifoGuard<'a> {
    lock: &'a FifoLock,
}

impl FifoLock {
    pub fn acquire(&self) -> FifoGuard<'_> {
        let mut tickets = self.tickets.lock().unwrap_or_else(PoisonError::into_inner);
        let ticket = tickets.next;
        tickets.next += 1;
        while tickets.serving != ticket {
            tickets = self.turn.wait(tickets).unwrap_or_else(PoisonError::into_inner);
        }
        FifoGuard { lock: self }
    }
}

impl Drop for FifoGuard<'_> {
    fn drop(&mut self) {
        let mut tickets = self.lock.tickets.lock().unwrap_or_else(PoisonError::into_inner);
        tickets.serving += 1;
        self.lock.turn.notify_all();
    }
}
