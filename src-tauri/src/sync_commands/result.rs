// SPDX-License-Identifier: GPL-2.0-or-later
//! `SyncOperationResult` of src/shared/types/sync.ts: success, or the failure's
//! message with the `reason` of a refusal the renderer shows its own
//! message for (a credential failure, or `syncBusy` from an account
//! switch). A sync pass also answers what it did (`status`, and why it was
//! skipped).

use pipette_sync::data_error::DataError;
use pipette_sync::preflight::PreflightError;
use serde::Serialize;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct SyncOperationResult {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<&'static str>,
    #[serde(rename = "skipReason", skip_serializing_if = "Option::is_none")]
    skip_reason: Option<&'static str>,
}

impl SyncOperationResult {
    pub const SUCCESS: Self =
        Self { success: true, error: None, reason: None, status: None, skip_reason: None };

    pub fn failure(error: String, reason: Option<&'static str>) -> Self {
        Self { success: false, error: Some(error), reason, ..Self::SUCCESS }
    }

    /// With `error` and `success` kept: a pass whose units partly failed.
    pub fn with_error(mut self, error: String) -> Self {
        self.error = Some(error);
        self
    }

    /// The outcome of a sync pass: `status` and why it was `skipped`.
    pub fn with_status(mut self, status: &'static str, skip_reason: Option<&'static str>) -> Self {
        self.status = Some(status);
        self.skip_reason = skip_reason;
        self
    }
}

impl From<Result<(), PreflightError>> for SyncOperationResult {
    fn from(result: Result<(), PreflightError>) -> Self {
        match result {
            Ok(()) => Self::SUCCESS,
            Err(err) => {
                let reason = match &err {
                    PreflightError::Credential(reason) => Some(reason.as_str()),
                    _ => None,
                };
                Self::failure(err.to_string(), reason)
            }
        }
    }
}

impl From<Result<(), DataError>> for SyncOperationResult {
    fn from(result: Result<(), DataError>) -> Self {
        match result {
            Ok(()) => Self::SUCCESS,
            Err(err) => Self::failure(err.to_string(), err.reason()),
        }
    }
}

#[cfg(test)]
mod tests {
    use pipette_sync::password::guard::SyncBlockReason;
    use pipette_sync_runtime::SyncCredentialFailureReason;
    use serde_json::json;

    use super::*;

    #[test]
    fn answers_as_wrap_ipc_does() {
        let json = |result: Result<(), PreflightError>| {
            serde_json::to_value(SyncOperationResult::from(result)).unwrap()
        };
        assert_eq!(json(Ok(())), json!({ "success": true }));
        assert_eq!(
            json(Err(PreflightError::Credential(SyncCredentialFailureReason::KeystoreUnavailable))),
            json!({ "success": false, "error": "sync.changePasswordError.keystoreUnavailable", "reason": "keystoreUnavailable" })
        );
        assert_eq!(
            json(Err(PreflightError::Blocked(SyncBlockReason::BlockedLocal))),
            json!({ "success": false, "error": "sync.passwordChange.blockedLocal" })
        );
    }
}
