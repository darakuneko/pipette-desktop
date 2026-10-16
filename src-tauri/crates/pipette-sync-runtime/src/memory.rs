// SPDX-License-Identifier: GPL-2.0-or-later
//! The sync's memory of the password-check it last opened
//! (`validatedPasswordCheck`, src/main/sync/sync-password.ts) and of its own
//! sync-format marker (`syncFormatMarker*`, src/main/sync/sync-format.ts).
//! Memory only.

use std::sync::Mutex;

use crate::lock;

/// A password-check that opened, with the SHA-256 digest of the password
/// that opened it (never the password itself). A listing whose chosen
/// password-check differs in id or `modifiedTime`, or a pass holding
/// another password, validates again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ValidatedPasswordCheck {
    pub id: String,
    pub modified_time: String,
    pub password_fingerprint: [u8; 32],
}

/// What this process knows of its own sync-format marker. Times are the
/// sync-format clock's milliseconds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SyncFormatMemory {
    /// When this process created its marker, until a listing shows it.
    pub created_at_ms: Option<u64>,
    /// When a listing last showed the marker.
    pub seen_at_ms: Option<u64>,
    /// Bumped at sign-out: a create or listing that started under an older
    /// generation belongs to the previous account and records nothing.
    pub generation: u64,
}

#[derive(Default)]
pub struct CredentialMemory {
    validated: Mutex<Option<ValidatedPasswordCheck>>,
    sync_format: Mutex<SyncFormatMemory>,
}

impl CredentialMemory {
    pub fn validated_password_check(&self) -> Option<ValidatedPasswordCheck> {
        lock(&self.validated).clone()
    }

    pub fn set_validated_password_check(&self, check: ValidatedPasswordCheck) {
        *lock(&self.validated) = Some(check);
    }

    pub fn forget_validated_password_check(&self) {
        *lock(&self.validated) = None;
    }

    pub fn sync_format(&self) -> SyncFormatMemory {
        *lock(&self.sync_format)
    }

    /// `forgetCreatedSyncFormatMarker`: for sign-out, the next account's
    /// Drive is checked afresh.
    pub fn forget_sync_format_marker(&self) {
        let mut memory = lock(&self.sync_format);
        *memory = SyncFormatMemory { generation: memory.generation + 1, ..SyncFormatMemory::default() };
    }

    /// Records the marker created at `at_ms`, unless the generation moved
    /// on from `generation`.
    pub fn record_sync_format_created(&self, generation: u64, at_ms: u64) {
        let mut memory = lock(&self.sync_format);
        if memory.generation == generation {
            memory.created_at_ms = Some(at_ms);
        }
    }

    /// Records a listing at `at_ms` that showed the marker, unless the
    /// generation moved on from `generation`.
    pub fn record_sync_format_seen(&self, generation: u64, at_ms: u64) {
        let mut memory = lock(&self.sync_format);
        if memory.generation == generation {
            memory.created_at_ms = None;
            memory.seen_at_ms = Some(at_ms);
        }
    }

    /// Drops the creation time once it is too old to explain a listing
    /// without the marker.
    pub fn clear_sync_format_created(&self) {
        lock(&self.sync_format).created_at_ms = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_validated_password_check_until_forgotten() {
        let memory = CredentialMemory::default();
        assert_eq!(memory.validated_password_check(), None);
        let check = ValidatedPasswordCheck {
            id: "1".into(),
            modified_time: "t".into(),
            password_fingerprint: [7; 32],
        };
        memory.set_validated_password_check(check.clone());
        assert_eq!(memory.validated_password_check(), Some(check));
        memory.forget_validated_password_check();
        assert_eq!(memory.validated_password_check(), None);
    }

    #[test]
    fn records_the_marker_only_in_its_generation() {
        let memory = CredentialMemory::default();
        memory.record_sync_format_created(0, 10);
        assert_eq!(
            memory.sync_format(),
            SyncFormatMemory { created_at_ms: Some(10), seen_at_ms: None, generation: 0 }
        );
        memory.record_sync_format_seen(0, 20);
        assert_eq!(
            memory.sync_format(),
            SyncFormatMemory { created_at_ms: None, seen_at_ms: Some(20), generation: 0 }
        );
        memory.record_sync_format_created(0, 30);
        memory.forget_sync_format_marker();
        assert_eq!(
            memory.sync_format(),
            SyncFormatMemory { created_at_ms: None, seen_at_ms: None, generation: 1 }
        );
        // A create or listing started before the sign-out records nothing.
        memory.record_sync_format_created(0, 40);
        memory.record_sync_format_seen(0, 40);
        assert_eq!(memory.sync_format().generation, 1);
        assert_eq!((memory.sync_format().created_at_ms, memory.sync_format().seen_at_ms), (None, None));
        memory.record_sync_format_created(1, 50);
        memory.clear_sync_format_created();
        assert_eq!(memory.sync_format().created_at_ms, None);
    }
}
