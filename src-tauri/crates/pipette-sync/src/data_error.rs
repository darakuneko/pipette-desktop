// SPDX-License-Identifier: GPL-2.0-or-later
//! Why a delete, a reset or a trash action of the Data modal failed, with the
//! message the renderer shows: an i18n key or the text of the failure.

use pipette_sync_runtime::{Busy, SyncCredentialFailureReason};

use crate::preflight::PreflightError;

#[derive(Debug, thiserror::Error)]
pub enum DataError {
    /// Signed out or without a sync password, in the `readiness` namespace.
    #[error("sync.readiness.{}", .0.as_str())]
    Readiness(SyncCredentialFailureReason),
    #[error(transparent)]
    Preflight(#[from] PreflightError),
    /// The sync lock is held, or a lock-free writer of the keyboards runs.
    #[error(transparent)]
    Busy(#[from] Busy),
    #[error("{0}")]
    Other(String),
}

impl DataError {
    pub fn other(err: impl std::fmt::Display) -> Self {
        Self::Other(err.to_string())
    }

    /// The `reason` the answer carries: that of a credential failure.
    pub fn reason(&self) -> Option<&'static str> {
        match self {
            Self::Readiness(reason) | Self::Preflight(PreflightError::Credential(reason)) => {
                Some(reason.as_str())
            }
            _ => None,
        }
    }
}
