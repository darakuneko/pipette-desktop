// SPDX-License-Identifier: GPL-2.0-or-later
//! Where the envelope encryption runs: each envelope derives its key with
//! 600,000 rounds of PBKDF2, so the work goes to the blocking threads, at
//! most 4 at a time (the size of the thread pool libuv gives Node's
//! `crypto.pbkdf2`), and the async threads stay free.

use tokio::sync::Semaphore;

use crate::preflight::PreflightError;

static KEY_DERIVATIONS: Semaphore = Semaphore::const_new(4);

/// Runs `work`, which derives an envelope key, on a blocking thread.
pub async fn run_key_derivation<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, PreflightError> {
    let _slot = KEY_DERIVATIONS.acquire().await.map_err(|err| PreflightError::Other(err.to_string()))?;
    tokio::task::spawn_blocking(work).await.map_err(|err| PreflightError::Other(err.to_string()))
}
