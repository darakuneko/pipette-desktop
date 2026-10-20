// SPDX-License-Identifier: GPL-2.0-or-later
//! The time and the new ids the stores take, injected so the tests (and
//! the golden fixtures recorded with fake timers and UUID sequences) can
//! fix them.

/// The current time in milliseconds since the epoch (`Date.now()`).
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

/// The id of a new entry (`crypto.randomUUID()`).
pub trait IdGen: Send + Sync {
    fn new_id(&self) -> String;
}

/// The system clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        pipette_time::now_ms()
    }
}

/// Random version 4 UUIDs in the lowercase hyphenated form
/// `crypto.randomUUID()` gives.
#[derive(Clone, Copy, Debug, Default)]
pub struct RandomUuid;

impl IdGen for RandomUuid {
    fn new_id(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }
}

/// A clock that stays where it is set.
#[cfg(feature = "test-util")]
#[derive(Debug, Default)]
pub struct FixedClock(std::sync::atomic::AtomicI64);

#[cfg(feature = "test-util")]
impl FixedClock {
    pub fn new(now_ms: i64) -> Self {
        FixedClock(std::sync::atomic::AtomicI64::new(now_ms))
    }

    pub fn set(&self, now_ms: i64) {
        self.0.store(now_ms, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(feature = "test-util")]
impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

/// The given ids in order; panics when they run out, as a test that asks
/// for more ids than it planned is wrong.
#[cfg(feature = "test-util")]
#[derive(Debug, Default)]
pub struct SequenceIds(std::sync::Mutex<std::collections::VecDeque<String>>);

#[cfg(feature = "test-util")]
impl SequenceIds {
    pub fn new<I: IntoIterator<Item = S>, S: Into<String>>(ids: I) -> Self {
        SequenceIds(std::sync::Mutex::new(ids.into_iter().map(Into::into).collect()))
    }
}

#[cfg(feature = "test-util")]
impl IdGen for SequenceIds {
    #[allow(clippy::expect_used)] // see the type's doc
    fn new_id(&self) -> String {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .pop_front()
            .expect("SequenceIds ran out of ids")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_uuids_have_the_random_uuid_form() {
        let id = RandomUuid.new_id();
        assert_eq!(id.len(), 36);
        assert_eq!(id.as_bytes()[14], b'4');
        assert!(id.bytes().all(|b| b == b'-' || b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert_ne!(id, RandomUuid.new_id());
    }

    #[test]
    fn the_system_clock_is_after_2026() {
        assert!(SystemClock.now_ms() > 1_767_225_600_000);
    }
}
