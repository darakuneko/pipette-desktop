// SPDX-License-Identifier: GPL-2.0-or-later
//! What is on Drive, read without merging it (src/main/sync/sync-scan.ts):
//! the data files behind the guard and the password-check, and the ones
//! the stored password cannot open (`listUndecryptableFiles`).

use std::sync::Arc;

use futures_util::StreamExt;
use futures_util::stream;
use pipette_drive::DriveFile;
use pipette_drive::trash_names::parse_trash_file;
use pipette_sync_format::drive_names::{is_data_file_name, sync_unit_from_file_name};
use serde::Serialize;
use zeroize::Zeroizing;

use crate::codec::EnvelopeCodec;
use crate::execute::SYNC_CONCURRENCY;
use crate::preflight::{Preflight, PreflightError};

/// `UndecryptableFile`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndecryptableFile {
    pub file_id: String,
    pub file_name: String,
    pub sync_unit: Option<String>,
}

/// `fetchValidatedDataFiles`: the stored password and the data files of
/// one listing, once the guard passed and the password opens the
/// password-check (created when Drive has none). `None` without
/// credentials.
pub async fn fetch_validated_data_files(
    preflight: &Arc<Preflight>,
) -> Result<Option<(Zeroizing<String>, Vec<DriveFile>)>, PreflightError> {
    let Ok(password) = preflight.require_sync_credentials().await else { return Ok(None) };
    preflight.assert_no_local_password_change().await?;
    let generation = preflight.sync_format_generation();
    let listing = preflight.drive().list_files(None).await?;
    preflight.assert_sync_allowed(Some((&listing, generation))).await?;
    preflight.validate_password_check(&password, &listing, generation).await?;
    let data_files = listing.into_iter().filter(|file| is_data_file_name(&file.name)).collect();
    Ok(Some((password, data_files)))
}

/// `listUndecryptableFiles`: the data files the stored password does not
/// open, in listed order; empty without credentials. Trash files are not
/// checked: the sync never reads them.
pub async fn list_undecryptable_files(
    preflight: &Arc<Preflight>,
    codec: &dyn EnvelopeCodec,
) -> Result<Vec<UndecryptableFile>, PreflightError> {
    let Some((password, data_files)) = fetch_validated_data_files(preflight).await? else {
        return Ok(Vec::new());
    };
    let drive = preflight.drive();
    let checks: Vec<_> = data_files
        .iter()
        .filter(|file| parse_trash_file(&file.id, &file.name).is_none())
        .map(|file| {
            let password = password.clone();
            async move {
                let opens = match drive.download(&file.id).await {
                    Ok(content) => codec.open(content, password).await.is_ok(),
                    Err(_) => false,
                };
                (!opens).then(|| UndecryptableFile {
                    file_id: file.id.clone(),
                    file_name: file.name.clone(),
                    sync_unit: sync_unit_from_file_name(&file.name),
                })
            }
        })
        .collect();
    let found: Vec<Option<UndecryptableFile>> =
        stream::iter(checks).buffered(SYNC_CONCURRENCY).collect().await;
    Ok(found.into_iter().flatten().collect())
}
