// SPDX-License-Identifier: GPL-2.0-or-later
//! The wall clock handed to the virtual device and the delay between
//! retries. Production uses the system clock and a real sleep; tests replace
//! both through the `test-util` constructors.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;
type Sleeper = Arc<dyn Fn(Duration) + Send + Sync>;

#[derive(Clone)]
pub struct Timing {
    pub(crate) now_ms: Clock,
    pub(crate) sleep: Sleeper,
}

impl Timing {
    pub(crate) fn system() -> Self {
        Self {
            now_ms: Arc::new(|| {
                SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
            }),
            sleep: Arc::new(std::thread::sleep),
        }
    }

    /// `now_ms` replaces the wall clock (ms) and `sleep` the retry delay.
    #[cfg(any(test, feature = "test-util"))]
    pub fn new(
        now_ms: impl Fn() -> u64 + Send + Sync + 'static,
        sleep: impl Fn(Duration) + Send + Sync + 'static,
    ) -> Self {
        Self { now_ms: Arc::new(now_ms), sleep: Arc::new(sleep) }
    }
}
