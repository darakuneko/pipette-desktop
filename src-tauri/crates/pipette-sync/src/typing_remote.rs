// SPDX-License-Identifier: GPL-2.0-or-later
//! The typing day files on Drive: finding a device's days in a listing;
//! reconciling this device's days with the local day files and the upload
//! bookkeeping of `sync_state.json` before an upload pass collects its units;
//! and the Data modal's reads of other devices' days ([`RemoteTyping`]).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io;
use std::path::Path;
use std::sync::Arc;

use indexmap::{IndexMap, IndexSet};
use pipette_drive::DriveFile;
use pipette_drive::canonical::Listing;
use pipette_drive::client::DriveClient;
use pipette_drive::retry::DriveFailure;
use pipette_js_json::Value;
use pipette_sync_format::drive_names::{drive_file_name, is_data_file_name, sync_unit_from_file_name};
use pipette_typing_analytics::TypingAnalytics;
use pipette_typing_analytics::jsonl::paths::deleted_ranges_path;
use pipette_typing_analytics::jsonl::{keyboards_root, try_list_device_days};
use pipette_typing_analytics::sync_state::{TypingSyncState, try_load_sync_state};
use pipette_typing_analytics::sync_units::{
    typing_analytics_device_day_sync_unit, typing_deleted_ranges_sync_unit,
};
use zeroize::Zeroizing;

use crate::day_uploads::retain_day_uploads;
use crate::dispatch::{UnitError, UnitSync};
use crate::preflight::{Preflight, PreflightError};
use crate::units::{DeviceDayUnit, parse_device_day_unit};

/// A typing day file on Drive: `live` is the copy sync reads, absent when
/// only trash files of the day's name are left.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoteDay<'a> {
    pub name: &'a str,
    pub live: Option<&'a DriveFile>,
}

/// UTC day → its file, in the order the listing first shows each day.
pub type RemoteDays<'a> = IndexMap<String, RemoteDay<'a>>;

/// The day files of `hash` in `listing`, by keyboard uid, in the order the
/// listing first shows each uid and day. A name that is not a day unit is
/// skipped. A day with several files of its name maps to the copy every lookup
/// by name uses; a day with only trash files is listed without `live`.
pub fn collect_remote_own_hash_days<'a>(
    listing: &'a Listing,
    hash: &str,
) -> IndexMap<String, RemoteDays<'a>> {
    let mut per_uid: IndexMap<String, RemoteDays<'a>> = IndexMap::new();
    let mut add = |name: &'a str, live: Option<&'a DriveFile>| {
        let Some(unit) = sync_unit_from_file_name(name) else { return };
        let Some(day) = parse_device_day_unit(&unit).filter(|day| day.machine_hash == hash) else { return };
        let by_day = per_uid.entry(day.uid.to_owned()).or_default();
        // Setting a key that is there keeps its place (`Map.set`).
        if live.is_some() || !by_day.contains_key(day.utc_day) {
            by_day.insert(day.utc_day.to_owned(), RemoteDay { name, live });
        }
    };
    for file in listing.canonical_files() {
        add(&file.name, Some(file));
    }
    for name in listing.names_with_trash() {
        add(name, None);
    }
    per_uid
}

/// What [`reconcile_own_hash_typing_analytics`] left.
#[derive(Debug, Clone, PartialEq)]
pub struct Reconciled {
    pub state: TypingSyncState,
    /// The state changed, and Drive may have: the pass lists Drive again
    /// before it uploads.
    pub mutated: bool,
}

/// `{uid}|{hash}`, the key of a device's lists in `sync_state.json`.
pub(crate) fn pointer_key(uid: &str, hash: &str) -> String {
    format!("{uid}|{hash}")
}

/// The days `uploaded` lists under `key`. The record may be an array: none of
/// its keys holds a `|`, so it lists nothing.
pub(crate) fn uploaded_days(uploaded: &Value, key: &str) -> IndexSet<String> {
    match uploaded.as_object().and_then(|record| record.get(key)) {
        Some(Value::Array(days)) => days.iter().filter_map(|day| day.as_str().map(str::to_owned)).collect(),
        _ => IndexSet::new(),
    }
}

/// `record[key] = value`. Set on an array, the value is a property that
/// `JSON.stringify` leaves out, so the array is kept as it is.
pub(crate) fn set(record: &mut Value, key: &str, value: Value) {
    if let Value::Object(record) = record {
        record.insert(key, value);
    }
}

/// Writes `days` as the list `uploaded` holds under `key`, sorted so the
/// file's diff stays stable.
pub(crate) fn set_uploaded_days(uploaded: &mut Value, key: &str, days: impl IntoIterator<Item = String>) {
    let mut days: Vec<String> = days.into_iter().collect();
    days.sort();
    set(uploaded, key, Value::Array(days.into_iter().map(Value::from).collect()));
}

/// What a reconcile changes in the state, applied to the state read again
/// when it is saved, so what another writer recorded meanwhile is kept.
#[derive(Default)]
struct ReconcileChanges {
    /// Each keyboard reconciled, by its key, with the days it left
    /// `uploaded`. The list of each is written back sorted.
    uploaded: Vec<(String, IndexSet<String>)>,
    /// The keyboards whose orphans were looked for, with the time.
    reconciled_at: Vec<(String, f64)>,
}

impl ReconcileChanges {
    /// Whether the reconcile removed a day or recorded a time.
    fn changes_state(&self) -> bool {
        !self.reconciled_at.is_empty() || self.uploaded.iter().any(|(_, removed)| !removed.is_empty())
    }

    /// Also drops each reconciled keyboard's `day_uploads` entries whose day
    /// is not in its resulting `uploaded`: a day sent again after it left
    /// must not count as unchanged. Returns whether any entry was dropped.
    fn apply(&self, state: &mut TypingSyncState) -> bool {
        let mut pruned = false;
        for (key, removed) in &self.uploaded {
            let days: IndexSet<String> = uploaded_days(&state.uploaded, key)
                .into_iter()
                .filter(|day| !removed.contains(day))
                .collect();
            pruned |= retain_day_uploads(&mut state.day_uploads, key, |day| days.contains(day));
            set_uploaded_days(&mut state.uploaded, key, days);
        }
        for (key, at) in &self.reconciled_at {
            set(&mut state.reconciled_at, key, Value::Number(*at));
        }
        pruned
    }
}

/// Whether no time is recorded for `key` (missing or null).
fn reconcile_pending(reconciled_at: &Value, key: &str) -> bool {
    matches!(reconciled_at.as_object().and_then(|record| record.get(key)), None | Some(Value::Null))
}

/// Runs `work` on a blocking-task thread.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> io::Result<T> + Send + 'static) -> io::Result<T> {
    tokio::task::spawn_blocking(work).await.map_err(io::Error::other)?
}

/// The keyboard directories under `sync/keyboards/`, in the byte order of
/// their names (libuv's scandir order); none when it cannot be read.
fn local_keyboard_uids(user_data: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(keyboards_root(user_data)) else { return Vec::new() };
    let mut uids: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    uids.sort();
    uids
}

/// Deletes every copy and every trash file of `day`'s name, so nothing is
/// left to be picked up or renamed back. A failed delete is logged and the
/// pass goes on.
async fn delete_all_copies(drive: &DriveClient, listing: &Listing, day: &RemoteDay<'_>, failure: &str) {
    let ids: Vec<String> =
        listing.files_named_with_trash(day.name).into_iter().map(|f| f.id.clone()).collect();
    let outcome = drive.delete_files_by_id(&ids).await;
    if outcome.failed > 0 {
        log::warn!("{failure}: {}", outcome.first_error.unwrap_or_default());
    }
}

/// Reconciles this device's day files on Drive with the local ones and
/// `sync_state.json` before the upload pass collects its units. For each
/// keyboard in the uploaded record, on Drive or with a local directory:
///
/// - rule 2: a day `uploaded` lists that is not local was removed here
///   (Local delete) → its files on Drive are deleted too;
/// - rule 3: a day `uploaded` lists without a live copy on Drive was
///   removed there (a reset, another device) → it leaves `uploaded` and the
///   local file stays, so the upload pass sends it again. Another device
///   never removes this device's data by deleting its files; it adds
///   deleted ranges instead;
/// - orphans: while `reconciled_at` has no time for the keyboard (after a
///   rebuild or a fresh install), a day on Drive that is neither local nor
///   in `uploaded` is a leftover and is deleted; the time is then recorded,
///   so this runs once.
///
/// A delete removes every copy and trash file of the day's name. Rule 2
/// and the orphans also see a day that only has trash files; rule 3 needs
/// a live copy, so such a day is uploaded again. A `day_uploads` entry goes
/// with its day. The state is saved only when it changed, through
/// [`TypingAnalytics::update_sync_state`]: the file is read again and only
/// the reconcile's changes are applied to it, so a day recorded while the
/// deletes ran is kept. Nothing holds that lock while Drive is called.
/// `last_synced_at` moves only when a day left `uploaded` or a time was
/// recorded; dropping only `day_uploads` entries saves the state without
/// it (Drive is untouched). A failed save is the error, after any deletes
/// on Drive.
///
/// Rule 2 and the orphans delete what is not local, so nothing runs on
/// what was not read: a state that cannot be loaded is the error before any
/// delete, and a keyboard whose day directory cannot be listed is skipped
/// with a warning, its `uploaded` and `reconciled_at` left for the next pass.
pub async fn reconcile_own_hash_typing_analytics(
    drive: &DriveClient,
    listing: &Listing,
    analytics: &Arc<TypingAnalytics>,
    own_hash: &str,
) -> io::Result<Reconciled> {
    let clock = analytics.clock();
    let root = analytics.user_data().to_path_buf();
    let (state, local_uids) =
        blocking(move || Ok((try_load_sync_state(&root)?, local_keyboard_uids(&root)))).await?;
    let mut state = state.unwrap_or_else(|| TypingSyncState::empty(own_hash));
    let mut remote = collect_remote_own_hash_days(listing, own_hash);

    let mut candidates: IndexSet<String> = IndexSet::new();
    if let Some(record) = state.uploaded.as_object() {
        for key in record.keys() {
            let key = key.to_string_lossy();
            if let [uid, hash] = key.split('|').collect::<Vec<_>>().as_slice()
                && *hash == own_hash
            {
                candidates.insert((*uid).to_owned());
            }
        }
    }
    candidates.extend(remote.keys().cloned());
    candidates.extend(local_uids);
    // The local days, read before any delete: the reconcile never changes
    // them.
    let mut local_days = {
        let (root, uids, own) =
            (analytics.user_data().to_path_buf(), candidates.clone(), own_hash.to_owned());
        blocking(move || {
            Ok(uids
                .into_iter()
                .map(|uid| {
                    let days = try_list_device_days(&root, &uid, &own)
                        .map(|days| days.into_iter().collect::<HashSet<String>>());
                    (uid, days)
                })
                .collect::<HashMap<_, _>>())
        })
        .await?
    };

    let mut changes = ReconcileChanges::default();
    for uid in &candidates {
        let key = pointer_key(uid, own_hash);
        let local = match local_days.remove(uid).unwrap_or_else(|| Ok(HashSet::new())) {
            Ok(local) => local,
            Err(err) => {
                log::warn!("typing-analytics reconcile skipped {uid}: its day files cannot be listed: {err}");
                continue;
            }
        };
        let listed = uploaded_days(&state.uploaded, &key);
        let mut uploaded = listed.clone();
        let mut cloud = remote.shift_remove(uid).unwrap_or_default();

        // Rule 2: uploaded but not local — delete from Drive.
        for day in uploaded.clone() {
            if local.contains(&day) {
                continue;
            }
            if let Some(file) = cloud.shift_remove(&day) {
                delete_all_copies(
                    drive,
                    listing,
                    &file,
                    &format!("typing-analytics cloud delete failed for {uid} {day}"),
                )
                .await;
            }
            uploaded.shift_remove(&day);
        }

        // Rule 3: uploaded but no live copy on Drive — forget the upload.
        for day in uploaded.clone() {
            if cloud.get(&day).is_some_and(|file| file.live.is_some()) {
                continue;
            }
            uploaded.shift_remove(&day);
        }

        if reconcile_pending(&state.reconciled_at, &key) {
            for (day, file) in cloud {
                if local.contains(&day) || uploaded.contains(&day) {
                    continue;
                }
                delete_all_copies(
                    drive,
                    listing,
                    &file,
                    &format!("typing-analytics orphan delete failed for {uid} {day}"),
                )
                .await;
            }
            changes.reconciled_at.push((key.clone(), clock.now_ms() as f64));
        }
        let removed = listed.into_iter().filter(|day| !uploaded.contains(day)).collect();
        changes.uploaded.push((key, removed));
    }

    let mutated = changes.changes_state();
    // Applied here too so the state returned when nothing is saved carries
    // each reconciled keyboard's list sorted, as the file would.
    let pruned = changes.apply(&mut state);
    if !mutated && !pruned {
        return Ok(Reconciled { state, mutated });
    }
    let synced_at = clock.now_ms() as f64;
    let (analytics, own) = (analytics.clone(), own_hash.to_owned());
    let state = blocking(move || {
        analytics.update_sync_state(&own, |state| {
            let pruned = changes.apply(state);
            if mutated {
                state.last_synced_at = synced_at;
            }
            mutated || pruned
        })
    })
    .await?;
    Ok(Reconciled { state, mutated })
}

/// Why a read of another device's typing data on Drive failed.
#[derive(Debug, thiserror::Error)]
pub enum RemoteTypingError {
    #[error(transparent)]
    Preflight(#[from] PreflightError),
    #[error(transparent)]
    Unit(#[from] UnitError),
}

impl From<DriveFailure> for RemoteTypingError {
    fn from(failure: DriveFailure) -> Self {
        Self::Preflight(failure.into())
    }
}

/// The Data modal's reads of the typing data on Drive (the Sync > Typing
/// tree): the other devices with days of a keyboard, their days, and the
/// lazy fetch of one of those days. None takes the sync lock or creates the
/// sync-format marker; each lists Drive whole and stops on the guard like
/// a pass. Signed out, without a usable password, or while the guard
/// blocks, they find nothing.
pub struct RemoteTyping {
    preflight: Arc<Preflight>,
    units: Arc<UnitSync>,
}

impl RemoteTyping {
    pub fn new(preflight: Arc<Preflight>, units: Arc<UnitSync>) -> Self {
        Self { preflight, units }
    }

    /// The local guard, a full listing and the remote guard: the listing
    /// with the sign-out generation taken before it, or `None` when a guard
    /// stops the read.
    async fn guarded_listing(&self) -> Result<Option<(Listing, u64)>, PreflightError> {
        let preflight = &self.preflight;
        if preflight.local_sync_block().await.is_some() {
            return Ok(None);
        }
        let generation = preflight.sync_format_generation();
        let listing = Listing::new(preflight.drive().list_files(None).await?);
        if preflight.remote_sync_block(listing.files(), generation).is_some() {
            return Ok(None);
        }
        Ok(Some((listing, generation)))
    }

    /// The stored password once signed in.
    async fn signed_in_with_password(&self) -> Option<Zeroizing<String>> {
        self.preflight.require_sync_credentials().await.ok()
    }

    /// The day units of other devices in `listing`, every copy, trash
    /// files aside.
    fn remote_day_units(listing: &Listing, own_hash: &str) -> Vec<(String, String)> {
        listing
            .files()
            .iter()
            .filter_map(|file| sync_unit_from_file_name(&file.name))
            .filter_map(|unit| {
                let day = parse_device_day_unit(&unit)?;
                (day.machine_hash != own_hash).then(|| (day.uid.to_owned(), day.machine_hash.to_owned()))
            })
            .collect()
    }

    /// The other devices with a day file of keyboard `uid` on Drive, sorted; it
    /// finds those the cache has not merged yet.
    pub async fn list_remote_typing_hashes(&self, uid: &str) -> Result<Vec<String>, RemoteTypingError> {
        if self.signed_in_with_password().await.is_none() {
            return Ok(Vec::new());
        }
        let own = self.units.own_hash()?;
        let Some((listing, _)) = self.guarded_listing().await? else { return Ok(Vec::new()) };
        let hashes: BTreeSet<String> = Self::remote_day_units(&listing, &own)
            .into_iter()
            .filter(|(day_uid, _)| day_uid == uid)
            .map(|(_, hash)| hash)
            .collect();
        Ok(hashes.into_iter().collect())
    }

    /// The UTC days with a live day file of device `hash` of keyboard `uid` on
    /// Drive, sorted.
    pub async fn list_remote_typing_days(
        &self,
        uid: &str,
        hash: &str,
    ) -> Result<Vec<String>, RemoteTypingError> {
        if self.signed_in_with_password().await.is_none() {
            return Ok(Vec::new());
        }
        let Some((listing, _)) = self.guarded_listing().await? else { return Ok(Vec::new()) };
        let mut per_uid = collect_remote_own_hash_days(&listing, hash);
        let mut days: Vec<String> = per_uid
            .shift_remove(uid)
            .unwrap_or_default()
            .into_iter()
            .filter(|(_, day)| day.live.is_some())
            .map(|(day, _)| day)
            .collect();
        days.sort();
        Ok(days)
    }

    /// Downloads the day `utc_day` of device `hash` of keyboard `uid` and
    /// merges it into the local files and the cache. False when Drive has no
    /// such day, or when the fetch does not run (a reset of the keyboard or a
    /// switch of accounts runs, no credentials, the guard blocks). Fails when
    /// the password-check does not open with the stored password.
    ///
    /// It takes no lock: it is counted as a fetch of the keyboard before
    /// its first await, so a password change refuses to start and a reset
    /// of the keyboard waits or refuses while it runs.
    pub async fn fetch_remote_typing_day(
        &self,
        uid: &str,
        hash: &str,
        utc_day: &str,
    ) -> Result<bool, RemoteTypingError> {
        let Some(_fetching) = self.preflight.runtime().try_start_remote_day_fetch(uid) else {
            return Ok(false);
        };
        let Some(password) = self.signed_in_with_password().await else { return Ok(false) };
        let Some((listing, generation)) = self.guarded_listing().await? else { return Ok(false) };
        let day_unit = typing_analytics_device_day_sync_unit(uid, hash, utc_day);
        let Some(file) = listing.pick_canonical(&drive_file_name(&day_unit)) else { return Ok(false) };
        self.preflight.ensure_password_check_validated(&password, listing.files(), generation).await?;

        // The device's deleted ranges first, so the day's rows in them are
        // hidden as the day is replayed. Skipped only when the revision is
        // known and the local file exists: the polling also records the
        // revisions of keyboards it leaves alone because they are not
        // local, so a known revision alone does not mean the file was
        // merged. A failed merge fails the fetch before the day is
        // downloaded.
        let ranges_unit = typing_deleted_ranges_sync_unit(uid, hash);
        if let Some(ranges) = listing.pick_canonical(&drive_file_name(&ranges_unit)) {
            let known =
                self.preflight.runtime().remote().is_known(&ranges.name, &ranges.id, &ranges.modified_time);
            let path = deleted_ranges_path(self.units.ctx().user_data(), uid, hash);
            if !(known && blocking(move || Ok(path.exists())).await.unwrap_or(false)) {
                self.units.merge_with_remote(ranges, &ranges_unit, &password, Some(&listing)).await?;
            }
        }
        let day = DeviceDayUnit { uid, machine_hash: hash, utc_day };
        self.units.merge_remote_day(file, day, &password).await?;
        Ok(true)
    }

    /// The names of the data files on Drive, which the typing data import
    /// checks a file against; `None` when Drive is not consulted (no
    /// credentials, the guard blocks).
    pub async fn remote_data_file_names(&self) -> Result<Option<HashSet<String>>, PreflightError> {
        if self.signed_in_with_password().await.is_none() {
            return Ok(None);
        }
        let Some((listing, _)) = self.guarded_listing().await? else { return Ok(None) };
        Ok(Some(
            listing
                .files()
                .iter()
                .filter(|file| is_data_file_name(&file.name))
                .map(|file| file.name.clone())
                .collect(),
        ))
    }
}
