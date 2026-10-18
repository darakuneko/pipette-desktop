// SPDX-License-Identifier: GPL-2.0-or-later
//! This machine's state of a sync password change
//! (src/main/sync/sync-password-change-state.ts), all under `local/auth/`:
//!
//! - `sync-password-change.json`: the non-secret progress (direction,
//!   step, Drive lock identity), plain JSON in the format of the Electron
//!   build, so a restart can tell where the change stopped. While it
//!   exists, readable or not, no ordinary sync runs (the guard,
//!   [`crate::password::guard`]).
//! - the old and new passwords together, as one secret of the secret store
//!   (`SecretKind::SyncPasswordChangeKeys`), written at once so a crash
//!   never leaves only one of them. The Electron build keeps them in
//!   `sync-password-change-keys.enc`, which this build never reads or
//!   writes: a change the Electron build left behind reads here as keys
//!   that are missing.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use pipette_js_json::{write_number, write_str};
use pipette_secret_store::{SecretFailure, SecretKind, SecretStore};
use serde::Serialize;
use serde_json::Value;
use zeroize::Zeroizing;

pub const CHANGE_STATE_FILE: &str = "sync-password-change.json";

/// The password a change is heading towards.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeTarget {
    /// While changing.
    New,
    /// While rolling back.
    Old,
}

impl ChangeTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Old => "old",
        }
    }

    pub fn flipped(self) -> Self {
        match self {
            Self::New => Self::Old,
            Self::Old => Self::New,
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "new" => Some(Self::New),
            "old" => Some(Self::Old),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeStep {
    Locking,
    Reencrypting,
    Committing,
    Cleanup,
}

impl ChangeStep {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Locking => "locking",
            Self::Reencrypting => "reencrypting",
            Self::Committing => "committing",
            Self::Cleanup => "cleanup",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        match text {
            "locking" => Some(Self::Locking),
            "reencrypting" => Some(Self::Reencrypting),
            "committing" => Some(Self::Committing),
            "cleanup" => Some(Self::Cleanup),
            _ => None,
        }
    }
}

/// `PasswordChangeState`: the fields of the file that pass its checks.
#[derive(Clone, Debug, PartialEq)]
pub struct PasswordChangeState {
    pub target: ChangeTarget,
    pub step: ChangeStep,
    /// The random id written into this machine's Drive lock; the lock is
    /// recognised as ours by this id alone.
    pub lock_id: String,
    pub lock_file_id: Option<String>,
    /// Epoch milliseconds when the change started (a JavaScript number).
    pub started_at: f64,
}

impl PasswordChangeState {
    /// Whether the state passes the checks of a read.
    fn is_valid(&self) -> bool {
        !self.lock_id.is_empty()
            && self.lock_file_id.as_deref() != Some("")
            && self.started_at.is_finite()
            && self.started_at >= 0.0
    }

    /// The file's content: `JSON.stringify` of the state, `lockFileId`
    /// left out when there is none.
    pub fn to_json(&self) -> String {
        let mut out = String::from("{\"version\":1,\"target\":");
        write_str(&mut out, self.target.as_str());
        out.push_str(",\"step\":");
        write_str(&mut out, self.step.as_str());
        out.push_str(",\"lockId\":");
        write_str(&mut out, &self.lock_id);
        if let Some(file_id) = &self.lock_file_id {
            out.push_str(",\"lockFileId\":");
            write_str(&mut out, file_id);
        }
        out.push_str(",\"startedAt\":");
        write_number(&mut out, self.started_at);
        out.push('}');
        out
    }
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

/// `parseChangeState`: every field is checked strictly; keys that are not
/// part of the state are dropped.
pub fn parse_change_state(value: &Value) -> Option<PasswordChangeState> {
    let object = value.as_object()?;
    if object.get("version").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let target = object.get("target").and_then(Value::as_str).and_then(ChangeTarget::parse)?;
    let step = object.get("step").and_then(Value::as_str).and_then(ChangeStep::parse)?;
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
/// write, clear or [`ChangeStateFile::forget_cache`]: the guard asks
/// before every pass.
pub(crate) struct ChangeStateFile {
    path: PathBuf,
    /// The last answer, and a generation that drops the answer of a read
    /// that overlapped a write, a clear or a forget.
    cache: Mutex<(Option<bool>, u64)>,
}

/// The message of a failed blocking file operation, or of the task that
/// ran it.
fn blocking_result(joined: Result<std::io::Result<()>, tokio::task::JoinError>) -> Result<(), String> {
    joined.map_err(|err| err.to_string())?.map_err(|err| err.to_string())
}

/// Forgets the cached answer when dropped, so a write or clear forgets it
/// whether it succeeds, fails or is cancelled.
struct ForgetOnDrop<'a>(&'a ChangeStateFile);

impl Drop for ForgetOnDrop<'_> {
    fn drop(&mut self) {
        self.0.forget_cache();
    }
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

    /// `writeChangeState`: fails without touching the disk when `state`
    /// would not pass the checks of a read. Creates `local/auth/` and
    /// replaces the file atomically.
    pub async fn write(&self, state: &PasswordChangeState) -> Result<(), String> {
        if !state.is_valid() {
            return Err("Invalid sync password change state".to_owned());
        }
        let _forget = ForgetOnDrop(self);
        let (path, content) = (self.path.clone(), state.to_json());
        let written = tokio::task::spawn_blocking(move || {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            pipette_fs::write_file_atomic(&path, content.as_bytes())
        })
        .await;
        blocking_result(written)
    }

    /// `clearChangeState`: removes the file; a missing one is not an error.
    pub async fn clear(&self) -> Result<(), String> {
        let _forget = ForgetOnDrop(self);
        let path = self.path.clone();
        let removed = tokio::task::spawn_blocking(move || match std::fs::remove_file(path) {
            Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
            other => other,
        })
        .await;
        blocking_result(removed)
    }

    /// `hasChangeState`: whether the file is there, readable or not.
    pub async fn has(&self) -> bool {
        let generation = match self.cached() {
            Ok(present) => return present,
            Err(generation) => generation,
        };
        let present = self.read().await != ChangeStateRead::None;
        self.keep(generation, present);
        present
    }

    /// The cached answer, or the generation a read starting now belongs to.
    fn cached(&self) -> Result<bool, u64> {
        let cache = self.cache();
        cache.0.ok_or(cache.1)
    }

    /// Caches the answer of a read that started at `generation`, unless a
    /// write, clear or forget happened since.
    fn keep(&self, generation: u64, present: bool) {
        let mut cache = self.cache();
        if cache.1 == generation {
            cache.0 = Some(present);
        }
    }

    /// `forgetChangeStateCache`: whatever writes or removes the file (or
    /// the whole `local/auth/`) without [`ChangeStateFile::write`] or
    /// [`ChangeStateFile::clear`] calls this.
    pub fn forget_cache(&self) {
        let mut cache = self.cache();
        *cache = (None, cache.1 + 1);
    }
}

/// `PasswordChangeKeys`: both passwords, each non-empty.
pub struct ChangeKeys {
    pub old_password: Zeroizing<String>,
    pub new_password: Zeroizing<String>,
}

impl ChangeKeys {
    pub fn new(old_password: &str, new_password: &str) -> Self {
        Self {
            old_password: Zeroizing::new(old_password.to_owned()),
            new_password: Zeroizing::new(new_password.to_owned()),
        }
    }

    /// The password of `target`.
    pub fn key_for(&self, target: ChangeTarget) -> &str {
        match target {
            ChangeTarget::New => &self.new_password,
            ChangeTarget::Old => &self.old_password,
        }
    }

    /// The password of the other direction.
    pub fn other_key(&self, target: ChangeTarget) -> &str {
        self.key_for(target.flipped())
    }

    fn is_valid(&self) -> bool {
        !self.old_password.is_empty() && !self.new_password.is_empty()
    }

    /// `JSON.stringify({ oldPassword, newPassword })`.
    fn to_json(&self) -> Zeroizing<String> {
        let mut out = Zeroizing::new(String::from("{\"oldPassword\":"));
        write_str(&mut out, &self.old_password);
        out.push_str(",\"newPassword\":");
        write_str(&mut out, &self.new_password);
        out.push('}');
        out
    }

    /// `parseChangeKeys`: both fields non-empty strings.
    fn parse(text: &str) -> Option<Self> {
        let value: Value = serde_json::from_str(text).ok()?;
        let object = value.as_object()?;
        let field = |name: &str| object.get(name).and_then(Value::as_str).filter(|s| !s.is_empty());
        Some(Self::new(field("oldPassword")?, field("newPassword")?))
    }
}

/// `ChangeKeysFailureReason`: why the keys cannot be returned.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKeysFailure {
    /// The OS key store is not ready; a later try can succeed.
    KeystoreUnavailable,
    /// There is no keys file (or it cannot be read).
    NoPasswordFile,
    /// The key store cannot open the file.
    DecryptFailed,
    /// It opens, but is not the two passwords.
    InvalidContent,
}

impl ChangeKeysFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::KeystoreUnavailable => "keystoreUnavailable",
            Self::NoPasswordFile => "noPasswordFile",
            Self::DecryptFailed => "decryptFailed",
            Self::InvalidContent => "invalidContent",
        }
    }
}

impl From<SecretFailure> for ChangeKeysFailure {
    fn from(failure: SecretFailure) -> Self {
        match failure {
            SecretFailure::KeystoreUnavailable => Self::KeystoreUnavailable,
            SecretFailure::NoPasswordFile => Self::NoPasswordFile,
            SecretFailure::DecryptFailed => Self::DecryptFailed,
        }
    }
}

/// `storeChangeKeys`: fails without touching the disk when either password
/// is empty.
pub async fn store_change_keys(secrets: &SecretStore, keys: &ChangeKeys) -> Result<(), String> {
    if !keys.is_valid() {
        return Err("Invalid sync password change keys".to_owned());
    }
    let json = keys.to_json();
    secrets.store(SecretKind::SyncPasswordChangeKeys, json.as_bytes()).await.map_err(|err| err.to_string())
}

/// `retrieveChangeKeys`.
pub async fn retrieve_change_keys(secrets: &SecretStore) -> Result<ChangeKeys, ChangeKeysFailure> {
    let text = secrets.retrieve_string(SecretKind::SyncPasswordChangeKeys).await?;
    ChangeKeys::parse(&text).ok_or(ChangeKeysFailure::InvalidContent)
}

/// `clearChangeKeys`: a missing file is not an error.
pub async fn clear_change_keys(secrets: &SecretStore) -> Result<(), String> {
    secrets.clear(SecretKind::SyncPasswordChangeKeys).await.map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use pipette_secret_store::MemoryKeystore;
    use serde_json::json;

    use super::*;

    fn state(lock_file_id: Option<&str>) -> PasswordChangeState {
        PasswordChangeState {
            target: ChangeTarget::New,
            step: ChangeStep::Locking,
            lock_id: "l".into(),
            lock_file_id: lock_file_id.map(str::to_owned),
            started_at: 5.0,
        }
    }

    #[test]
    fn checks_every_field_and_drops_unknown_keys() {
        let value = json!({ "version": 1, "target": "new", "step": "locking", "lockId": "l", "startedAt": 5, "extra": 1 });
        assert_eq!(parse_change_state(&value), Some(state(None)));
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

    #[test]
    fn writes_the_fields_in_the_order_of_the_electron_build() {
        assert_eq!(
            state(None).to_json(),
            r#"{"version":1,"target":"new","step":"locking","lockId":"l","startedAt":5}"#
        );
        let full = PasswordChangeState {
            target: ChangeTarget::Old,
            step: ChangeStep::Reencrypting,
            lock_file_id: Some("f\"1".into()),
            started_at: 1_792_108_800_000.0,
            ..state(None)
        };
        assert_eq!(
            full.to_json(),
            r#"{"version":1,"target":"old","step":"reencrypting","lockId":"l","lockFileId":"f\"1","startedAt":1792108800000}"#
        );
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
        assert!(file.clear().await.is_err(), "a directory in its place is not removed");
    }

    #[tokio::test]
    async fn a_read_that_overlapped_a_forget_is_not_kept() {
        let dir = tempfile::tempdir().unwrap();
        let file = ChangeStateFile::new(dir.path());
        // The steps of `has`, with a forget and a new file between the start
        // of the read and its answer.
        let generation = file.cached().unwrap_err();
        let present = file.read().await != ChangeStateRead::None;
        assert!(!present);
        file.forget_cache();
        std::fs::write(dir.path().join(CHANGE_STATE_FILE), "{}").unwrap();
        file.keep(generation, present);
        assert_eq!(file.cached(), Err(generation + 1), "the stale answer is dropped");
        assert!(file.has().await);
        // Without an overlap the answer is kept.
        assert_eq!(file.cached(), Ok(true));
    }

    #[tokio::test]
    async fn write_and_clear_follow_the_file_and_forget_the_answer() {
        let dir = tempfile::tempdir().unwrap();
        let auth = dir.path().join("local/auth");
        let file = ChangeStateFile::new(&auth);
        assert!(!file.has().await);
        file.write(&state(Some("f"))).await.unwrap();
        assert!(file.has().await);
        assert_eq!(file.read().await, ChangeStateRead::Ok(state(Some("f"))));
        assert_eq!(
            std::fs::read_to_string(auth.join(CHANGE_STATE_FILE)).unwrap(),
            r#"{"version":1,"target":"new","step":"locking","lockId":"l","lockFileId":"f","startedAt":5}"#
        );
        file.clear().await.unwrap();
        assert!(!file.has().await);
        file.clear().await.unwrap();
        let invalid = PasswordChangeState { lock_id: String::new(), ..state(None) };
        assert_eq!(file.write(&invalid).await.unwrap_err(), "Invalid sync password change state");
        assert!(!auth.join(CHANGE_STATE_FILE).exists());
    }

    #[tokio::test]
    async fn the_keys_are_one_secret_with_the_five_answers() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(dir.path(), Arc::new(MemoryKeystore::default()));
        let failure = |result: Result<ChangeKeys, ChangeKeysFailure>| result.err();
        assert_eq!(failure(retrieve_change_keys(&secrets).await), Some(ChangeKeysFailure::NoPasswordFile));
        store_change_keys(&secrets, &ChangeKeys::new("old", "new")).await.unwrap();
        let keys = retrieve_change_keys(&secrets).await.unwrap();
        assert_eq!((keys.key_for(ChangeTarget::New), keys.other_key(ChangeTarget::New)), ("new", "old"));
        assert_eq!(
            store_change_keys(&secrets, &ChangeKeys::new("", "new")).await.unwrap_err(),
            "Invalid sync password change keys"
        );
        assert_eq!(retrieve_change_keys(&secrets).await.unwrap().old_password.as_str(), "old");

        secrets.store(SecretKind::SyncPasswordChangeKeys, br#"{"oldPassword":"x"}"#).await.unwrap();
        assert_eq!(failure(retrieve_change_keys(&secrets).await), Some(ChangeKeysFailure::InvalidContent));
        let other = SecretStore::new(dir.path(), Arc::new(MemoryKeystore::default()));
        assert_eq!(failure(retrieve_change_keys(&other).await), Some(ChangeKeysFailure::DecryptFailed));
        let unavailable = Arc::new(MemoryKeystore::default());
        unavailable.set_unavailable(true);
        let locked = SecretStore::new(dir.path(), unavailable);
        assert_eq!(
            failure(retrieve_change_keys(&locked).await),
            Some(ChangeKeysFailure::KeystoreUnavailable)
        );

        clear_change_keys(&secrets).await.unwrap();
        clear_change_keys(&secrets).await.unwrap();
        assert_eq!(failure(retrieve_change_keys(&secrets).await), Some(ChangeKeysFailure::NoPasswordFile));
    }

    #[tokio::test]
    async fn the_keys_of_the_electron_build_are_never_read() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = SecretStore::new(dir.path(), Arc::new(MemoryKeystore::default()));
        let electron = secrets.auth_dir().join("sync-password-change-keys.enc");
        std::fs::create_dir_all(secrets.auth_dir()).unwrap();
        std::fs::write(&electron, b"electron keys").unwrap();
        assert_eq!(retrieve_change_keys(&secrets).await.err(), Some(ChangeKeysFailure::NoPasswordFile));
        clear_change_keys(&secrets).await.unwrap();
        assert_eq!(std::fs::read(&electron).unwrap(), b"electron keys");
    }
}
