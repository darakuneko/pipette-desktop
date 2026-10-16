// SPDX-License-Identifier: GPL-2.0-or-later
//! This machine's password-change state file, `local/auth/
//! sync-password-change.json` (the read side of
//! src/main/sync/sync-password-change-state.ts): the non-secret progress of
//! a sync password change, so a restart can tell where it stopped. While
//! it exists, readable or not, no ordinary sync runs (the guard,
//! [`crate::password::guard`]).

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde_json::Value;

pub const CHANGE_STATE_FILE: &str = "sync-password-change.json";

const TARGETS: [&str; 2] = ["new", "old"];
const STEPS: [&str; 4] = ["locking", "reencrypting", "committing", "cleanup"];

/// `PasswordChangeState`: the fields of the file that pass its checks.
#[derive(Clone, Debug, PartialEq)]
pub struct PasswordChangeState {
    /// `'new'` while changing, `'old'` while rolling back.
    pub target: String,
    pub step: String,
    /// The random id written into this machine's Drive lock; the lock is
    /// recognised as ours by this id alone.
    pub lock_id: String,
    pub lock_file_id: Option<String>,
    /// Epoch milliseconds when the change started (a JavaScript number).
    pub started_at: f64,
}

/// `ChangeStateReadResult`.
#[derive(Clone, Debug, PartialEq)]
pub enum ChangeStateRead {
    None,
    Ok(PasswordChangeState),
    /// The file is there but cannot be read, is not JSON or fails the
    /// checks.
    Invalid,
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn one_of(values: &[&str], value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|s| values.contains(s)).map(str::to_owned)
}

/// `parseChangeState`: every field is checked strictly; keys that are not
/// part of the state are dropped.
pub fn parse_change_state(value: &Value) -> Option<PasswordChangeState> {
    let object = value.as_object()?;
    if object.get("version").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let target = one_of(&TARGETS, object.get("target"))?;
    let step = one_of(&STEPS, object.get("step"))?;
    let lock_id = non_empty_string(object.get("lockId"))?;
    let lock_file_id = match object.get("lockFileId") {
        None => None,
        present => Some(non_empty_string(present)?),
    };
    let started_at =
        object.get("startedAt").and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= 0.0)?;
    Some(PasswordChangeState { target, step, lock_id, lock_file_id, started_at })
}

/// The state file, and whether it is there, kept in memory until the next
/// [`ChangeStateFile::forget_cache`]: the guard asks before every pass.
pub(crate) struct ChangeStateFile {
    path: PathBuf,
    /// The last answer, and a generation that drops the answer of a read
    /// that overlapped a write, a clear or a forget.
    cache: Mutex<(Option<bool>, u64)>,
}

impl ChangeStateFile {
    pub fn new(auth_dir: &Path) -> Self {
        Self { path: auth_dir.join(CHANGE_STATE_FILE), cache: Mutex::new((None, 0)) }
    }

    fn cache(&self) -> MutexGuard<'_, (Option<bool>, u64)> {
        self.cache.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn unreadable(err: &dyn std::fmt::Display) -> ChangeStateRead {
        log::warn!("sync password change state: cannot read {CHANGE_STATE_FILE}: {err}");
        ChangeStateRead::Invalid
    }

    /// `readChangeState`: `None` when no change is in progress, `Invalid`
    /// (with a warning) when the file is there but does not read as a
    /// state.
    pub async fn read(&self) -> ChangeStateRead {
        let path = self.path.clone();
        let read = tokio::task::spawn_blocking(move || std::fs::read(path)).await;
        let bytes = match read {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(err)) if err.kind() == ErrorKind::NotFound => return ChangeStateRead::None,
            Ok(Err(err)) => return Self::unreadable(&err),
            Err(err) => return Self::unreadable(&err),
        };
        let Ok(value) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) else {
            log::warn!("sync password change state: {CHANGE_STATE_FILE} is not valid JSON");
            return ChangeStateRead::Invalid;
        };
        match parse_change_state(&value) {
            Some(state) => ChangeStateRead::Ok(state),
            None => {
                log::warn!("sync password change state: {CHANGE_STATE_FILE} has unexpected contents");
                ChangeStateRead::Invalid
            }
        }
    }

    /// `hasChangeState`: whether the file is there, readable or not.
    pub async fn has(&self) -> bool {
        let generation = {
            let cache = self.cache();
            if let Some(present) = cache.0 {
                return present;
            }
            cache.1
        };
        let present = self.read().await != ChangeStateRead::None;
        let mut cache = self.cache();
        if cache.1 == generation {
            cache.0 = Some(present);
        }
        present
    }

    /// `forgetChangeStateCache`: whatever writes or removes the file (or
    /// the whole `local/auth/`) calls this.
    pub fn forget_cache(&self) {
        let mut cache = self.cache();
        *cache = (None, cache.1 + 1);
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;

    use serde_json::json;

    use super::*;

    #[test]
    fn checks_every_field_and_drops_unknown_keys() {
        let state = json!({ "version": 1, "target": "new", "step": "locking", "lockId": "l", "startedAt": 5, "extra": 1 });
        assert_eq!(
            parse_change_state(&state),
            Some(PasswordChangeState {
                target: "new".into(),
                step: "locking".into(),
                lock_id: "l".into(),
                lock_file_id: None,
                started_at: 5.0,
            })
        );
        let with_lock = json!({ "version": 1.0, "target": "old", "step": "cleanup", "lockId": "l", "lockFileId": "f", "startedAt": 0 });
        assert_eq!(parse_change_state(&with_lock).unwrap().lock_file_id.as_deref(), Some("f"));
        for bad in [
            json!([]),
            json!({ "version": 2, "target": "new", "step": "locking", "lockId": "l", "startedAt": 5 }),
            json!({ "version": 1, "target": "x", "step": "locking", "lockId": "l", "startedAt": 5 }),
            json!({ "version": 1, "target": "new", "step": "x", "lockId": "l", "startedAt": 5 }),
            json!({ "version": 1, "target": "new", "step": "locking", "lockId": "", "startedAt": 5 }),
            json!({ "version": 1, "target": "new", "step": "locking", "lockId": "l", "lockFileId": null, "startedAt": 5 }),
            json!({ "version": 1, "target": "new", "step": "locking", "lockId": "l", "lockFileId": "", "startedAt": 5 }),
            json!({ "version": 1, "target": "new", "step": "locking", "lockId": "l", "startedAt": -1 }),
            json!({ "version": 1, "target": "new", "step": "locking", "lockId": "l", "startedAt": "5" }),
        ] {
            assert_eq!(parse_change_state(&bad), None, "{bad}");
        }
    }

    #[tokio::test]
    async fn an_unreadable_file_counts_as_a_change_and_the_answer_is_kept_until_forgotten() {
        let dir = tempfile::tempdir().unwrap();
        let file = ChangeStateFile::new(dir.path());
        assert_eq!(file.read().await, ChangeStateRead::None);
        assert!(!file.has().await);
        std::fs::write(dir.path().join(CHANGE_STATE_FILE), "not json").unwrap();
        // The cached answer stands until forgotten.
        assert!(!file.has().await);
        file.forget_cache();
        assert_eq!(file.read().await, ChangeStateRead::Invalid);
        assert!(file.has().await);
        std::fs::remove_file(dir.path().join(CHANGE_STATE_FILE)).unwrap();
        std::fs::create_dir(dir.path().join(CHANGE_STATE_FILE)).unwrap();
        file.forget_cache();
        assert!(file.has().await, "a state path that cannot be read as a file still blocks");
    }

    #[tokio::test]
    async fn a_read_that_overlapped_a_forget_is_not_kept() {
        let dir = tempfile::tempdir().unwrap();
        let file = ChangeStateFile::new(dir.path());
        let mut reading = std::pin::pin!(file.has());
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        // The first poll takes the generation and starts the read.
        assert!(reading.as_mut().poll(&mut context).is_pending());
        file.forget_cache();
        assert!(!reading.await);
        std::fs::write(dir.path().join(CHANGE_STATE_FILE), "{}").unwrap();
        assert!(file.has().await);
    }
}
