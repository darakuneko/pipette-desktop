// SPDX-License-Identifier: GPL-2.0-or-later
//! Why a password-change operation stopped. The message is what the renderer
//! shows: an i18n key, or the text of a Drive or storage failure.

use pipette_drive::retry::DriveFailure;

use crate::preflight::PreflightError;

/// The i18n keys of `PasswordChangeError`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeErrorKey {
    AlreadyInProgress,
    NotInProgress,
    InvalidState,
    KeysUnavailable,
    WrongStep,
    NotStarted,
    Locked,
    Lost,
    LockLost,
    Interrupted,
    Undecryptable,
    NotConverged,
}

impl ChangeErrorKey {
    pub fn key(self) -> &'static str {
        match self {
            Self::AlreadyInProgress => "sync.passwordChange.alreadyInProgress",
            Self::NotInProgress => "sync.passwordChange.notInProgress",
            Self::InvalidState => "sync.passwordChange.invalidState",
            Self::KeysUnavailable => "sync.passwordChange.keysUnavailable",
            Self::WrongStep => "sync.passwordChange.wrongStep",
            Self::NotStarted => "sync.passwordChange.notStarted",
            Self::Locked => "sync.passwordChange.locked",
            Self::Lost => "sync.passwordChange.lost",
            Self::LockLost => "sync.passwordChange.lockLost",
            Self::Interrupted => "sync.passwordChange.interrupted",
            Self::Undecryptable => "sync.passwordChange.undecryptable",
            Self::NotConverged => "sync.passwordChange.notConverged",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum PasswordChangeError {
    #[error("{}", .0.key())]
    Change(ChangeErrorKey),
    /// Sync work runs or tokens are being switched, so no password-change
    /// operation starts.
    #[error("sync.changePasswordInProgress")]
    Refused,
    #[error("sync.samePassword")]
    SamePassword,
    /// The release of the Drive locks while sync work runs here.
    #[error("sync.passwordChange.releaseBusy")]
    ReleaseBusy,
    #[error(transparent)]
    Preflight(#[from] PreflightError),
    /// A local file or the secret store failed.
    #[error("{0}")]
    Other(String),
}

impl From<ChangeErrorKey> for PasswordChangeError {
    fn from(key: ChangeErrorKey) -> Self {
        Self::Change(key)
    }
}

impl From<DriveFailure> for PasswordChangeError {
    fn from(failure: DriveFailure) -> Self {
        Self::Preflight(PreflightError::Drive(failure))
    }
}

impl PasswordChangeError {
    /// The `reason` the renderer shows its own message for: the credential
    /// failure of [`PreflightError::Credential`].
    pub fn reason(&self) -> Option<&'static str> {
        match self {
            Self::Preflight(PreflightError::Credential(reason)) => Some(reason.as_str()),
            _ => None,
        }
    }

    /// Whether the pre-commit check found files to fix: a file neither key
    /// opens, or files that keep changing.
    pub(crate) fn is_not_converged(&self) -> bool {
        matches!(self, Self::Change(ChangeErrorKey::Undecryptable | ChangeErrorKey::NotConverged))
    }
}

#[cfg(test)]
mod tests {
    use pipette_sync_runtime::SyncCredentialFailureReason;

    use super::*;

    #[test]
    fn the_messages_are_the_i18n_keys() {
        assert_eq!(
            PasswordChangeError::from(ChangeErrorKey::LockLost).to_string(),
            "sync.passwordChange.lockLost"
        );
        assert_eq!(PasswordChangeError::Refused.to_string(), "sync.changePasswordInProgress");
        let credential = PasswordChangeError::Preflight(PreflightError::Credential(
            SyncCredentialFailureReason::Unauthenticated,
        ));
        assert_eq!(credential.to_string(), "sync.changePasswordError.unauthenticated");
        assert_eq!(credential.reason(), Some("unauthenticated"));
        assert_eq!(
            PasswordChangeError::from(PreflightError::PasswordMismatch).to_string(),
            "sync.passwordMismatch"
        );
    }
}
