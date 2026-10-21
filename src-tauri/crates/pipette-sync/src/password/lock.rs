// SPDX-License-Identifier: GPL-2.0-or-later
//! The unencrypted "password change in progress" lock file in appDataFolder,
//! `password-change-lock.json`. A machine re-encrypting every file under a new
//! sync password holds it so the other machines stop syncing until the change
//! is finished or rolled back. It carries no secret and is never a sync unit.
//!
//! Which lock wins is decided by Drive's `createdTime` (then the smallest
//! id), never by a machine's clock; a lock is recognised as this machine's
//! by its `lockId` alone, the machine hash in it is only shown to the user.

use std::cmp::Ordering;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use pipette_drive::DriveFile;
use pipette_drive::client::DriveClient;
use pipette_js_json::write_str;
use pipette_sync_format::drive_names::{PASSWORD_CHANGE_LOCK_FILE, is_password_change_lock_file};
use serde_json::Value;

use super::change_error::PasswordChangeError;
use crate::preflight::BoxFuture;

const LOCK_TYPE: &str = "password-change-lock";

/// A wait of the lock's re-lists.
pub type Sleep = Arc<dyn Fn(Duration) -> BoxFuture<'static, ()> + Send + Sync>;

/// Drive's listings can miss a file created a moment ago. `relist_delays` are
/// the waits before each extra re-list while our own lock is not yet visible;
/// `settle` is the wait before the final re-list once we appear to win, so a
/// peer lock that becomes visible slightly later is still seen.
#[derive(Clone)]
pub struct LockTiming {
    pub sleep: Sleep,
    pub relist_delays: Vec<Duration>,
    pub settle: Duration,
}

impl Default for LockTiming {
    fn default() -> Self {
        Self {
            sleep: Arc::new(|duration| Box::pin(tokio::time::sleep(duration))),
            relist_delays: [1000, 2000, 4000].map(Duration::from_millis).to_vec(),
            settle: Duration::from_millis(2000),
        }
    }
}

/// `PasswordChangeLock`: the content of a lock file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PasswordChangeLock {
    /// The random id of the change; recognises its holder's own lock.
    pub lock_id: String,
    /// The holder's machine hash, for display.
    pub machine_hash: String,
    /// ISO 8601 time the change started by the holder's clock, for
    /// display.
    pub started_at: String,
}

impl PasswordChangeLock {
    /// `JSON.stringify` of the lock's content.
    pub fn to_json(&self) -> String {
        let mut out = String::from("{\"type\":");
        write_str(&mut out, LOCK_TYPE);
        out.push_str(",\"version\":1,\"lockId\":");
        write_str(&mut out, &self.lock_id);
        out.push_str(",\"machineHash\":");
        write_str(&mut out, &self.machine_hash);
        out.push_str(",\"startedAt\":");
        write_str(&mut out, &self.started_at);
        out.push('}');
        out
    }
}

/// What is shown of another machine's lock.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockInfo {
    pub machine_hash: String,
    pub started_at: String,
}

/// What an attempt to take the password-change lock found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AcquireOutcome {
    Acquired(String),
    /// A lock already existed before ours was created: the earliest one's
    /// content, `None` when it could not be read.
    Locked(Option<LockInfo>),
    /// Another lock created around the same time won; ours was deleted.
    Lost,
}

fn non_empty_string(object: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// Parses a lock's text: `None` when it is not a valid version-1 lock. Callers
/// take `None` as a lock whose content cannot be read, not as no lock.
pub fn parse_password_change_lock(text: &str) -> Option<PasswordChangeLock> {
    let value: Value = serde_json::from_str(text).ok()?;
    let object = value.as_object()?;
    if object.get("type").and_then(Value::as_str) != Some(LOCK_TYPE)
        || object.get("version").and_then(Value::as_f64) != Some(1.0)
    {
        return None;
    }
    let lock = PasswordChangeLock {
        lock_id: non_empty_string(object, "lockId")?,
        machine_hash: non_empty_string(object, "machineHash")?,
        started_at: non_empty_string(object, "startedAt")?,
    };
    pipette_time::parse_date_time_string(&lock.started_at)?;
    Some(lock)
}

/// The winner rule: the earliest Drive `createdTime` first, ties broken by
/// the smallest id; a file without a usable `createdTime` after every timed
/// one.
fn compare_lock_files(a: &DriveFile, b: &DriveFile) -> Ordering {
    let created =
        |file: &DriveFile| file.created_time.as_deref().and_then(pipette_time::parse_date_time_string);
    let by_time = match (created(a), created(b)) {
        (Some(ta), Some(tb)) => ta.cmp(&tb),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    };
    by_time.then_with(|| a.id.cmp(&b.id))
}

/// Whether `file_id` is the earliest lock of `locks` (and listed at all).
fn is_winner(locks: &[DriveFile], file_id: &str) -> bool {
    locks.iter().min_by(|a, b| compare_lock_files(a, b)).is_some_and(|first| first.id == file_id)
}

/// The Drive operations on the lock.
pub struct DriveLocks<'a> {
    pub drive: &'a DriveClient,
    pub timing: &'a LockTiming,
}

impl DriveLocks<'_> {
    /// Every listed lock file. The listing is narrowed by name on Drive;
    /// the exact name is checked here because Drive matches a prefix.
    async fn list_lock_files(&self) -> Result<Vec<DriveFile>, PasswordChangeError> {
        let files = self.drive.list_files(Some(PASSWORD_CHANGE_LOCK_FILE)).await?;
        Ok(files.into_iter().filter(|file| is_password_change_lock_file(&file.name)).collect())
    }

    /// Every listed lock, the earliest (the holder) first.
    pub async fn list_locks(&self) -> Result<Vec<DriveFile>, PasswordChangeError> {
        let mut locks = self.list_lock_files().await?;
        locks.sort_by(compare_lock_files);
        Ok(locks)
    }

    /// The holder of `file`, for display; `None` when it cannot be downloaded
    /// or its content is not a lock.
    pub async fn read_info(&self, file: &DriveFile) -> Option<LockInfo> {
        let bytes = self.drive.download(&file.id).await.ok()?;
        let lock = parse_password_change_lock(&String::from_utf8_lossy(&bytes))?;
        Some(LockInfo { machine_hash: lock.machine_hash, started_at: lock.started_at })
    }

    async fn delete_own_quietly(&self, file_id: &str) {
        // A lock left behind can still be found by its lockId, and the
        // caller's error (or `Lost`) is more useful than this one.
        if let Err(err) = self.drive.delete_file(file_id).await {
            log::warn!("sync password change lock: cannot delete our lock: {err}");
        }
    }

    /// After a create whose answer was lost, the file may exist anyway.
    async fn delete_by_lock_id_quietly(&self, lock_id: &str) {
        match self.find_own(lock_id).await {
            Ok(Some(file_id)) => self.delete_own_quietly(&file_id).await,
            Ok(None) => {}
            Err(err) => log::warn!("sync password change lock: cannot look for our lock: {err}"),
        }
    }

    /// The listed locks after re-lists (with the `relist_delays` waits)
    /// until `file_id` is among them or the waits run out.
    async fn locks_showing(&self, file_id: &str) -> Result<Vec<DriveFile>, PasswordChangeError> {
        let mut locks = self.list_lock_files().await?;
        for delay in &self.timing.relist_delays {
            if locks.iter().any(|file| file.id == file_id) {
                break;
            }
            (self.timing.sleep)(*delay).await;
            locks = self.list_lock_files().await?;
        }
        Ok(locks)
    }

    /// Re-lists until our lock is visible, then, if it is the earliest,
    /// waits `settle` and checks once more.
    async fn settle_ownership(&self, file_id: &str) -> Result<bool, PasswordChangeError> {
        if !is_winner(&self.locks_showing(file_id).await?, file_id) {
            return Ok(false);
        }
        (self.timing.sleep)(self.timing.settle).await;
        Ok(is_winner(&self.list_lock_files().await?, file_id))
    }

    /// Creates our lock unless one exists, then re-lists to settle a race with
    /// a machine that created its lock at about the same time. `on_created`
    /// gets the new file id before the re-list, so the caller can save it; when
    /// it fails, our lock is deleted and its error returned. Only our own file
    /// is ever deleted here.
    pub async fn acquire<F, Fut>(
        &self,
        lock: &PasswordChangeLock,
        on_created: F,
    ) -> Result<AcquireOutcome, PasswordChangeError>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = Result<(), PasswordChangeError>>,
    {
        let existing = self.list_locks().await?;
        if let Some(first) = existing.first() {
            return Ok(AcquireOutcome::Locked(self.read_info(first).await));
        }
        let file_id = match self.drive.create_raw_file(PASSWORD_CHANGE_LOCK_FILE, &lock.to_json()).await {
            Ok(file_id) => file_id,
            Err(err) => {
                self.delete_by_lock_id_quietly(&lock.lock_id).await;
                return Err(err.into());
            }
        };
        let settled = match on_created(file_id.clone()).await {
            Ok(()) => self.settle_ownership(&file_id).await,
            Err(err) => Err(err),
        };
        match settled {
            Ok(true) => Ok(AcquireOutcome::Acquired(file_id)),
            Ok(false) => {
                self.delete_own_quietly(&file_id).await;
                Ok(AcquireOutcome::Lost)
            }
            Err(err) => {
                self.delete_own_quietly(&file_id).await;
                Err(err)
            }
        }
    }

    /// The id of the lock whose content carries `lock_id`. A failed download
    /// fails: "could not check" must not be taken for "no lock".
    pub async fn find_own(&self, lock_id: &str) -> Result<Option<String>, PasswordChangeError> {
        for file in self.list_lock_files().await? {
            let bytes = self.drive.download(&file.id).await?;
            let lock = parse_password_change_lock(&String::from_utf8_lossy(&bytes));
            if lock.is_some_and(|lock| lock.lock_id == lock_id) {
                return Ok(Some(file.id));
            }
        }
        Ok(None)
    }

    /// Whether `file_id` is listed and is the earliest lock. Our own file
    /// missing from a listing may be listing lag, so that case re-lists first;
    /// an earlier lock is final at once.
    pub async fn is_held(&self, file_id: &str) -> Result<bool, PasswordChangeError> {
        Ok(is_winner(&self.locks_showing(file_id).await?, file_id))
    }

    /// Deletes the lock `file_id`; an already deleted lock is not an error.
    pub async fn release(&self, file_id: &str) -> Result<(), PasswordChangeError> {
        Ok(self.drive.delete_file(file_id).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lock_file(id: &str, created_time: Option<&str>) -> DriveFile {
        DriveFile {
            id: id.to_owned(),
            name: PASSWORD_CHANGE_LOCK_FILE.to_owned(),
            modified_time: "2026-01-01T00:00:00.000Z".to_owned(),
            created_time: created_time.map(str::to_owned),
            version: None,
        }
    }

    #[test]
    fn writes_and_reads_the_lock_file_json() {
        let lock = PasswordChangeLock {
            lock_id: "id".into(),
            machine_hash: "hash".into(),
            started_at: "2026-10-16T00:00:00.000Z".into(),
        };
        let json = lock.to_json();
        assert_eq!(
            json,
            r#"{"type":"password-change-lock","version":1,"lockId":"id","machineHash":"hash","startedAt":"2026-10-16T00:00:00.000Z"}"#
        );
        assert_eq!(parse_password_change_lock(&json), Some(lock));
        for bad in [
            "not json",
            "[]",
            r#"{"type":"other","version":1,"lockId":"i","machineHash":"h","startedAt":"2026-10-16T00:00:00.000Z"}"#,
            r#"{"type":"password-change-lock","version":2,"lockId":"i","machineHash":"h","startedAt":"2026-10-16T00:00:00.000Z"}"#,
            r#"{"type":"password-change-lock","version":1,"lockId":"","machineHash":"h","startedAt":"2026-10-16T00:00:00.000Z"}"#,
            r#"{"type":"password-change-lock","version":1,"lockId":"i","machineHash":"h","startedAt":"soon"}"#,
        ] {
            assert_eq!(parse_password_change_lock(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_earliest_created_lock_wins_and_ties_go_to_the_smaller_id() {
        let early = lock_file("b", Some("2026-01-01T00:00:00.000Z"));
        let tie = lock_file("a", Some("2026-01-01T00:00:00.000Z"));
        let late = lock_file("0", Some("2026-01-01T00:00:01.000Z"));
        let untimed = lock_file(".", None);
        assert!(is_winner(&[late.clone(), early.clone(), untimed.clone()], "b"));
        assert!(is_winner(&[early.clone(), tie.clone()], "a"));
        assert!(is_winner(&[untimed.clone(), late.clone()], "0"));
        assert!(is_winner(&[untimed.clone(), lock_file("-", Some("bad"))], "-"));
        assert!(!is_winner(&[early], "z"));
        assert!(!is_winner(&[], "a"));
    }
}
