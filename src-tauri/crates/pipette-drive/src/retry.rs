// SPDX-License-Identifier: GPL-2.0-or-later
//! The retries around each Drive attempt: up to 5 attempts; between them
//! 1 s doubled each time plus up to 1 s of jitter, or the `Retry-After` of
//! the answer (at most 30 s). Rate limits (429, and a 403 whose reason is a
//! rate limit) are retried always, since Drive refuses those before doing
//! any work; 5xx answers and requests that got no answer only when the
//! operation is safe to send again (`retry_transient`), which a create is
//! not. No attempt starts, and no wait goes on, once the app is quitting.
//!
//! The clock, the jitter, the waits and the quit come from a [`RetryEnv`]
//! so the tests can fix them.

use std::future::Future;
use std::hash::{BuildHasher, RandomState};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::DriveError;

const MAX_ATTEMPTS: u32 = 5;
const BASE_DELAY_MS: f64 = 1000.0;
/// The upper bound of the random extra wait added to each backoff step, as
/// in Google's exponential-backoff guidance.
const JITTER_MS: f64 = 1000.0;
/// A pass holds the sync lock while it waits, so a long pause the server
/// asks for would block every other sync; the next pass retries anyway.
const MAX_RETRY_AFTER_MS: f64 = 30_000.0;
const QUIT_CHECK_INTERVAL: Duration = Duration::from_millis(250);

const RATE_LIMIT_REASONS: [&str; 2] = ["rateLimitExceeded", "userRateLimitExceeded"];

pub type SleepFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

/// What the retries read from the world.
pub trait RetryEnv: Send + Sync {
    /// Whether the app is quitting (`syncRuntime.isQuitting`).
    fn is_quitting(&self) -> bool;
    /// `Date.now()`, for a `Retry-After` date.
    fn now_ms(&self) -> i64;
    /// A number in `[0, 1)` for the jitter.
    fn random(&self) -> f64;
    /// Waits `duration`, or less once the app starts quitting.
    fn sleep(&self, duration: Duration) -> SleepFuture<'_>;
}

/// The real clock and waits, on the Tokio runtime, with the quit flag the
/// caller reads (`SyncRuntime::is_quitting` of pipette-sync-runtime).
pub struct SystemRetryEnv {
    quitting: Arc<dyn Fn() -> bool + Send + Sync>,
    hasher: RandomState,
    draws: AtomicU64,
}

impl SystemRetryEnv {
    pub fn new(quitting: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        Self { quitting: Arc::new(quitting), hasher: RandomState::new(), draws: AtomicU64::new(0) }
    }
}

impl RetryEnv for SystemRetryEnv {
    fn is_quitting(&self) -> bool {
        (self.quitting)()
    }

    fn now_ms(&self) -> i64 {
        pipette_time::now_ms()
    }

    /// A per-process random key hashed with a counter: enough to spread
    /// the retries of several machines, which is all the jitter is for.
    fn random(&self) -> f64 {
        let bits = self.hasher.hash_one(self.draws.fetch_add(1, Ordering::Relaxed)) >> 11;
        bits as f64 / (1u64 << 53) as f64
    }

    /// Waits in short slices, so the wait ends soon after quitting begins.
    fn sleep(&self, duration: Duration) -> SleepFuture<'_> {
        Box::pin(async move {
            let end = tokio::time::Instant::now() + duration;
            while !self.is_quitting() {
                let remaining = end.saturating_duration_since(tokio::time::Instant::now());
                if remaining.is_zero() {
                    return;
                }
                tokio::time::sleep(remaining.min(QUIT_CHECK_INTERVAL)).await;
            }
        })
    }
}

/// How one operation is retried.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// The verb of the error message: `Drive <label> failed: <status> <body>`.
    pub label: &'static str,
    /// Whether 5xx answers and requests without an answer are retried.
    pub retry_transient: bool,
}

/// A failed operation: the error of its last attempt and the operation's
/// label.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{}", self.message())]
pub struct DriveFailure {
    pub label: &'static str,
    pub error: DriveError,
}

impl DriveFailure {
    /// The status of an answer that was not a success.
    pub fn status(&self) -> Option<u16> {
        self.error.status()
    }

    /// `Drive <label> failed: <status> <body>` for an answer that was not a
    /// success; the error itself for anything else.
    fn message(&self) -> String {
        match &self.error {
            DriveError::Status { status, body, .. } => {
                format!("Drive {} failed: {status} {body}", self.label)
            }
            other => other.to_string(),
        }
    }
}

/// Runs `attempt` until it succeeds, a failure is not retried, the
/// attempts run out or the app is quitting.
pub async fn drive_request<T, F, Fut>(
    env: &dyn RetryEnv,
    policy: RetryPolicy,
    attempt: F,
) -> Result<T, DriveFailure>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, DriveError>>,
{
    run(env, policy, None, attempt).await
}

/// [`drive_request`] for an operation whose 404 the caller handles
/// (`acceptStatus`): `Ok(None)` for a 404, which is never retried.
pub async fn drive_request_or_not_found<T, F, Fut>(
    env: &dyn RetryEnv,
    policy: RetryPolicy,
    mut attempt: F,
) -> Result<Option<T>, DriveFailure>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, DriveError>>,
{
    let attempt = move || {
        let answer = attempt();
        async move { answer.await.map(Some) }
    };
    run(env, policy, Some(|| None), attempt).await
}

/// The loop of both: `not_found` answers a 404 when the caller handles it.
async fn run<R, F, Fut>(
    env: &dyn RetryEnv,
    policy: RetryPolicy,
    not_found: Option<fn() -> R>,
    mut attempt: F,
) -> Result<R, DriveFailure>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<R, DriveError>>,
{
    let fail = |error| DriveFailure { label: policy.label, error };
    for number in 1.. {
        let error = match attempt().await {
            Ok(value) => return Ok(value),
            Err(error) => error,
        };
        if let (Some(answer), Some(404)) = (not_found, error.status()) {
            return Ok(answer());
        }
        let wait = match &error {
            DriveError::Status { status, body, retry_after } => {
                if !can_retry(env, number) || !is_retryable_status(*status, body, policy.retry_transient) {
                    return Err(fail(error));
                }
                retry_after.as_deref().and_then(|value| retry_after_ms(value, env.now_ms()))
            }
            DriveError::Network(_) => {
                if !policy.retry_transient || !can_retry(env, number) {
                    return Err(fail(error));
                }
                None
            }
            // An error before the request (the token), one that sending again
            // repeats (too large, refused) or one after a success (a body that
            // does not parse) is not retried.
            DriveError::Auth(_) | DriveError::Rejected(_) | DriveError::BadResponse(_) => {
                return Err(fail(error));
            }
        };
        let wait_ms = wait.unwrap_or_else(|| backoff_ms(env, number));
        env.sleep(Duration::from_secs_f64(wait_ms / 1000.0)).await;
        // Quitting may begin during the wait.
        if env.is_quitting() {
            return Err(fail(error));
        }
    }
    unreachable!("the attempts are numbered without end")
}

/// The before-quit handler holds the app open until pending changes are
/// flushed, so no retry starts once quitting begins.
fn can_retry(env: &dyn RetryEnv, attempt: u32) -> bool {
    attempt < MAX_ATTEMPTS && !env.is_quitting()
}

fn is_retryable_status(status: u16, body: &str, retry_transient: bool) -> bool {
    match status {
        429 => true,
        403 => is_rate_limit_body(body),
        _ => retry_transient && status >= 500,
    }
}

/// Whether a Drive v3 error body (`{ error: { errors: [{ reason }] } }`)
/// has a rate-limit reason. Any other shape is not a rate limit.
fn is_rate_limit_body(body: &str) -> bool {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    parsed
        .get("error")
        .and_then(|error| error.get("errors"))
        .and_then(serde_json::Value::as_array)
        .is_some_and(|errors| {
            errors.iter().any(|entry| {
                entry
                    .get("reason")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|reason| RATE_LIMIT_REASONS.contains(&reason))
            })
        })
}

/// `Retry-After` as delay-seconds or an HTTP date, in milliseconds between
/// 0 and 30 s; `None` when it is empty or neither, so the backoff applies.
///
/// JavaScript's `Number` also reads `0x`, `0o` and `0b` forms and
/// `Date.parse` many date forms beyond the HTTP date; those fall back to
/// the backoff here.
pub fn retry_after_ms(value: &str, now_ms: i64) -> Option<f64> {
    let text = value.trim();
    if text.is_empty() {
        return None;
    }
    let ms = match text.parse::<f64>() {
        Ok(seconds) if seconds.is_finite() => seconds * 1000.0,
        _ => {
            let date = jiff::fmt::rfc2822::DateTimeParser::new().parse_timestamp(text).ok()?;
            (date.as_millisecond() - now_ms) as f64
        }
    };
    Some(ms.clamp(0.0, MAX_RETRY_AFTER_MS))
}

fn backoff_ms(env: &dyn RetryEnv, attempt: u32) -> f64 {
    BASE_DELAY_MS * f64::from(1u32 << (attempt - 1)) + (env.random() * JITTER_MS).floor()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_retry_after_in_seconds_and_as_an_http_date() {
        let now = 1_767_225_600_000; // 2026-01-01T00:00:00Z
        assert_eq!(retry_after_ms("3", now), Some(3000.0));
        assert_eq!(retry_after_ms(" 1.5 ", now), Some(1500.0));
        assert_eq!(retry_after_ms("120", now), Some(30_000.0));
        assert_eq!(retry_after_ms("-4", now), Some(0.0));
        assert_eq!(retry_after_ms("Thu, 01 Jan 2026 00:00:05 GMT", now), Some(5000.0));
        assert_eq!(retry_after_ms("Wed, 31 Dec 2025 23:59:55 GMT", now), Some(0.0));
        assert_eq!(retry_after_ms("Thu, 01 Jan 2026 01:00:00 GMT", now), Some(30_000.0));
        for unreadable in ["", "  ", "soon", "Infinity", "NaN"] {
            assert_eq!(retry_after_ms(unreadable, now), None, "{unreadable:?}");
        }
    }

    #[test]
    fn a_rate_limit_403_names_a_rate_limit_reason() {
        let body = |reason: &str| format!(r#"{{"error":{{"code":403,"errors":[{{"reason":"{reason}"}}]}}}}"#);
        assert!(is_rate_limit_body(&body("rateLimitExceeded")));
        assert!(is_rate_limit_body(&body("userRateLimitExceeded")));
        assert!(!is_rate_limit_body(&body("insufficientPermissions")));
        for other in ["forbidden", "null", "{}", r#"{"error":{"errors":{}}}"#, r#"{"error":{"errors":[1]}}"#]
        {
            assert!(!is_rate_limit_body(other), "{other}");
        }
    }

    #[test]
    fn the_system_random_is_in_the_unit_interval() {
        let env = SystemRetryEnv::new(|| false);
        for _ in 0..1000 {
            let value = env.random();
            assert!((0.0..1.0).contains(&value), "{value}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_system_wait_ends_early_once_quitting_begins() {
        let quitting = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = Arc::clone(&quitting);
        let env = SystemRetryEnv::new(move || flag.load(Ordering::SeqCst));
        let start = tokio::time::Instant::now();
        env.sleep(Duration::from_millis(1000)).await;
        assert_eq!(start.elapsed(), Duration::from_millis(1000));

        let start = tokio::time::Instant::now();
        let wait = env.sleep(Duration::from_secs(30));
        let quit = async {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            quitting.store(true, Ordering::SeqCst);
        };
        tokio::join!(wait, quit);
        assert!(start.elapsed() <= Duration::from_millis(1250), "{:?}", start.elapsed());
    }
}
