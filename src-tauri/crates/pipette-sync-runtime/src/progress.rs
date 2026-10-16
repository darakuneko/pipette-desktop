// SPDX-License-Identifier: GPL-2.0-or-later
//! Where the sync passes report their progress (`setProgressCallback` and
//! `emitProgress` of src/main/sync/sync-runtime-state.ts), and the report
//! (`SyncProgress` of src/shared/types/sync.ts).

use std::sync::{Arc, Mutex};

use crate::lock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncDirection {
    Upload,
    Download,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncStatus {
    Idle,
    Syncing,
    Error,
    Success,
    Partial,
}

/// A credential failure the renderer localizes (`SyncCredentialFailureReason`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SyncCredentialFailureReason {
    Unauthenticated,
    NoPasswordFile,
    DecryptFailed,
    KeystoreUnavailable,
    RemoteCheckFailed,
}

impl SyncCredentialFailureReason {
    /// The reason as the renderer names it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unauthenticated => "unauthenticated",
            Self::NoPasswordFile => "noPasswordFile",
            Self::DecryptFailed => "decryptFailed",
            Self::KeystoreUnavailable => "keystoreUnavailable",
            Self::RemoteCheckFailed => "remoteCheckFailed",
        }
    }
}

/// One progress report; the absent fields are left out of the event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncProgress {
    pub direction: SyncDirection,
    pub status: SyncStatus,
    pub message: Option<String>,
    pub sync_unit: Option<String>,
    pub current: Option<u32>,
    pub total: Option<u32>,
    pub failed_units: Option<Vec<String>>,
    pub reason: Option<SyncCredentialFailureReason>,
}

impl SyncProgress {
    /// A report with only the direction and the status.
    pub fn new(direction: SyncDirection, status: SyncStatus) -> Self {
        Self {
            direction,
            status,
            message: None,
            sync_unit: None,
            current: None,
            total: None,
            failed_units: None,
            reason: None,
        }
    }
}

type Callback = Arc<dyn Fn(&SyncProgress) + Send + Sync>;

/// The one receiver of the reports; none until the app sets it, and the
/// reports before that are dropped.
#[derive(Default)]
pub struct ProgressSink {
    callback: Mutex<Option<Callback>>,
}

impl ProgressSink {
    pub fn set(&self, callback: impl Fn(&SyncProgress) + Send + Sync + 'static) {
        *lock(&self.callback) = Some(Arc::new(callback));
    }

    pub fn emit(&self, progress: &SyncProgress) {
        // Called outside the lock, so the callback may set another one.
        let callback = lock(&self.callback).clone();
        if let Some(callback) = callback {
            callback(progress);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sends_each_report_to_the_callback_set_last() {
        let sink = ProgressSink::default();
        let report = SyncProgress::new(SyncDirection::Upload, SyncStatus::Syncing);
        sink.emit(&report);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let first = Arc::clone(&seen);
        sink.set(move |progress| first.lock().unwrap().push(("first", progress.clone())));
        sink.emit(&report);
        let second = Arc::clone(&seen);
        sink.set(move |progress| second.lock().unwrap().push(("second", progress.clone())));
        let done = SyncProgress {
            message: Some("Sync complete".into()),
            ..SyncProgress::new(SyncDirection::Download, SyncStatus::Success)
        };
        sink.emit(&done);
        assert_eq!(*seen.lock().unwrap(), vec![("first", report), ("second", done)]);
    }
}
