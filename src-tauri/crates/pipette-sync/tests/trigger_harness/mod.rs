// SPDX-License-Identifier: GPL-2.0-or-later
//! Waiting in the trigger tests, whose clock is paused: the passes a timer
//! starts are waited for in real time, so the clock moves only when a test
//! moves it.

#![allow(clippy::unwrap_used, clippy::panic, dead_code)]

use std::time::Duration;

use crate::execute_harness::World;

/// Lets the tasks a timer woke run, then waits until nothing holds the
/// sync lock. The clock does not move meanwhile: the wait is in real time.
pub async fn until_idle(world: &World) {
    let_run().await;
    until(|| !world.runtime().is_syncing()).await;
}

/// Lets the tasks that are ready run a few steps.
pub async fn let_run() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

/// Moves the clock on by `by` and the millisecond a timer's deadline is
/// rounded up to, and lets the tasks the timers woke start.
pub async fn tick(by: Duration) {
    tokio::time::advance(by + Duration::from_millis(1)).await;
    let_run().await;
}

/// [`tick`], then waits for the pass a timer started.
pub async fn advance(world: &World, by: Duration) {
    tick(by).await;
    until_idle(world).await;
}

/// Waits until a request is held at the gate.
pub async fn until_held(world: &World) {
    until(|| world.drive.held() > 0).await;
}

/// Waits in real time until `done`, letting the other tasks run.
pub async fn until(done: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    while !done() {
        assert!(std::time::Instant::now() < deadline, "still waiting");
        tokio::task::yield_now().await;
        std::thread::sleep(Duration::from_millis(1));
    }
}
