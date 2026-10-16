// SPDX-License-Identifier: GPL-2.0-or-later
//! The keyboard-name backfill of a full download (`backfillKeyboardMeta` of
//! src/main/sync/keyboard-meta.ts, called by `executeSync` after a
//! download of scope `'all'`): each keyboard that Drive has a snapshots file
//! of and the names index has no entry for (a tombstone counts as an entry)
//! is named after its first live snapshot, read from the local snapshots
//! or else from the snapshots bundle on Drive.

use std::sync::Arc;

use pipette_drive::DriveFile;
use pipette_drive::canonical::Listing;
use pipette_drive::client::DriveClient;
use pipette_js_json::{JsString, Value};
use pipette_keyboard_stores::{
    KEYBOARD_META_SYNC_UNIT, StoreContext, StoreError, keyboard_meta_uids, keyboard_uids_of_drive_names,
    name_unnamed_keyboards, resolve_device_name_from_local_snapshots, snapshot_index_device_name,
};
use pipette_sync_format::Envelope;
use pipette_sync_format::drive_names::drive_file_name;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use zeroize::Zeroizing;

use crate::crypto::run_key_derivation;
use crate::execute::KeyboardMetaBackfill;
use crate::merge::MergeEvents;
use crate::preflight::BoxFuture;

/// How many keyboards are resolved at once.
const BACKFILL_CONCURRENCY: usize = 5;

/// What a backfill did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BackfillResult {
    /// How many names the index got.
    pub resolved: usize,
    /// The keyboards no name was found for, in Drive's order.
    pub failed: Vec<String>,
}

/// The device name in the snapshots bundle `file` on Drive
/// (`resolveDeviceNameFromRemoteSnapshots`); `None` when it cannot be
/// downloaded, opened with `password` or read, or names none.
async fn remote_device_name(
    drive: &DriveClient,
    file: &DriveFile,
    password: Arc<Zeroizing<String>>,
) -> Option<JsString> {
    let bytes = drive.download(&file.id).await.ok()?;
    let envelope: Envelope = serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    let plaintext = run_key_derivation(move || pipette_sync_format::crypto::decrypt(&envelope, &password))
        .await
        .ok()?
        .ok()?;
    match pipette_js_json::parse(&plaintext).ok()? {
        // `bundle.index` of `null` throws.
        Value::Null => None,
        bundle => snapshot_index_device_name(bundle.as_object().and_then(|b| b.get("index"))),
    }
}

/// The name of `uid` from its local snapshots, else from its snapshots
/// bundle `remote` on Drive.
async fn resolve(
    ctx: StoreContext,
    drive: DriveClient,
    uid: String,
    remote: Option<DriveFile>,
    password: Arc<Zeroizing<String>>,
) -> Option<JsString> {
    let local_uid = uid.clone();
    let local =
        tokio::task::spawn_blocking(move || resolve_device_name_from_local_snapshots(&ctx, &local_uid))
            .await
            .ok()?;
    match (local, remote) {
        (Some(name), _) => Some(name),
        (None, Some(file)) => remote_device_name(&drive, &file, password).await,
        (None, None) => None,
    }
}

/// Names the keyboards Drive's `listing` has snapshots of and the names
/// index lacks, at most [`BACKFILL_CONCURRENCY`] at a time, and records the
/// names in one write. A keyboard that gains an entry while its name is
/// looked up (a delete leaves a tombstone) keeps that entry; the TypeScript
/// backfill writes the name over it. Reports `sync:unit-applied` for the names unit when
/// any name was recorded; the caller marks the unit pending for upload.
/// Fails only when the names index cannot be read or written.
pub async fn backfill_keyboard_meta(
    ctx: &StoreContext,
    drive: &DriveClient,
    password: &str,
    listing: &Listing,
    events: &dyn MergeEvents,
) -> Result<BackfillResult, StoreError> {
    let known_ctx = ctx.clone();
    let known = tokio::task::spawn_blocking(move || keyboard_meta_uids(&known_ctx))
        .await
        .map_err(|err| StoreError::Io(std::io::Error::other(err)))??;
    let missing: Vec<String> = keyboard_uids_of_drive_names(listing.files().iter().map(|f| f.name.as_str()))
        .into_iter()
        .filter(|uid| !known.contains(uid))
        .collect();
    if missing.is_empty() {
        return Ok(BackfillResult::default());
    }

    let password = Arc::new(Zeroizing::new(password.to_owned()));
    let slots = Arc::new(Semaphore::new(BACKFILL_CONCURRENCY));
    let mut tasks = JoinSet::new();
    for (at, uid) in missing.iter().enumerate() {
        let remote = listing.pick_canonical(&drive_file_name(&format!("keyboards/{uid}/snapshots"))).cloned();
        let (ctx, drive, uid, password, slots) =
            (ctx.clone(), drive.clone(), uid.clone(), Arc::clone(&password), Arc::clone(&slots));
        tasks.spawn(async move {
            let _slot = slots.acquire_owned().await.ok();
            (at, resolve(ctx, drive, uid, remote, password).await)
        });
    }
    let mut names: Vec<Option<JsString>> = vec![None; missing.len()];
    while let Some(done) = tasks.join_next().await {
        // A task that panicked names nothing: its keyboard is listed as failed.
        if let Ok((at, name)) = done {
            names[at] = name;
        }
    }

    let mut found = Vec::new();
    let mut failed = Vec::new();
    for (uid, name) in missing.into_iter().zip(names) {
        match name {
            Some(name) => found.push((uid, name)),
            None => failed.push(uid),
        }
    }
    let write_ctx = ctx.clone();
    let resolved = tokio::task::spawn_blocking(move || name_unnamed_keyboards(&write_ctx, &found))
        .await
        .map_err(|err| StoreError::Io(std::io::Error::other(err)))??;
    if resolved > 0 {
        events.unit_applied(KEYBOARD_META_SYNC_UNIT);
    }
    Ok(BackfillResult { resolved, failed })
}

/// The backfill a pass of [`crate::execute::SyncExecutor`] runs after a
/// download of `'all'`: [`backfill_keyboard_meta`] on the stores of `ctx`
/// and on `drive`, reporting to `events`. A failure is the error's message.
pub struct StoreMetaBackfill {
    pub ctx: StoreContext,
    pub drive: DriveClient,
    pub events: Arc<dyn MergeEvents>,
}

impl KeyboardMetaBackfill for StoreMetaBackfill {
    fn backfill<'a>(
        &'a self,
        password: &'a str,
        listing: &'a Listing,
    ) -> BoxFuture<'a, Result<usize, String>> {
        Box::pin(async move {
            backfill_keyboard_meta(&self.ctx, &self.drive, password, listing, self.events.as_ref())
                .await
                .map(|result| result.resolved)
                .map_err(|err| err.to_string())
        })
    }
}
