// SPDX-License-Identifier: GPL-2.0-or-later
//! The startup update of the Hub-linked language packs
//! (`src/main/hub/i18n-startup-sync.ts`).
//!
//! Every live pack with a Hub post id is checked against the Hub's
//! timestamps (in batches of 100, sent at once); a pack whose Hub time
//! differs from its cached `hubUpdatedAt`, or that has none, is downloaded,
//! checked by [`validate_i18n_export`] and saved over the local pack as an
//! unattended save, which keeps its name and enabled state and is refused
//! when the pack was deleted or unlinked meanwhile. Nothing fails the pass:
//! every failure is counted and logged.
//!
//! A pass stops at a save boundary once `stopped` answers true (the app
//! quits): no save starts after that, and a save already running finishes.
//! A stopped pass reports nothing.

use std::collections::{HashMap, HashSet};

use futures_util::future::join_all;
use log::Level;
use pipette_entry_store::{Entry, js_trim};
use pipette_js_json::{JsString, Value, js_string};
use pipette_keyboard_stores::StoreContext;
use pipette_pack_stores::Field;
use pipette_pack_stores::i18n::{self, SavePackInput};

use crate::endpoint::Endpoint;
use crate::http::{HubError, HubHttp, RequestBody, StatusKind};
use crate::packs::{TimestampsError, fetch_timestamp_items, validate_i18n_export};
use crate::sources::BoxFuture;

/// The language pack store as the pass reads and saves it. The app runs it
/// off the async runtime, as every store write; a [`StoreContext`] runs it
/// in place, for the tests.
pub trait StartupPacks: Send + Sync {
    /// The live metas (`listMetas`); the error is the text of the failure.
    fn list_metas(&self) -> BoxFuture<'_, Result<Vec<Entry>, String>>;
    /// `savePack`; the error is the store's message.
    fn save_pack(&self, input: SavePackInput) -> BoxFuture<'_, Result<(), String>>;
}

impl StartupPacks for StoreContext {
    fn list_metas(&self) -> BoxFuture<'_, Result<Vec<Entry>, String>> {
        let metas = i18n::list_metas(self).map_err(|err| format!("Error: {}", err.message));
        Box::pin(std::future::ready(metas))
    }

    fn save_pack(&self, input: SavePackInput) -> BoxFuture<'_, Result<(), String>> {
        let saved = i18n::save_pack(self, input).map(|_| ()).map_err(|err| err.message);
        Box::pin(std::future::ready(saved))
    }
}

/// A pack the pass could not update.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncError {
    pub pack_id: String,
    pub hub_post_id: String,
    pub reason: String,
}

/// `I18nStartupSyncResult`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StartupSyncResult {
    /// The Hub-linked packs checked.
    pub checked: usize,
    /// The packs downloaded again because the Hub has other content.
    pub updated: usize,
    /// The packs whose Hub post is gone; the local copy stays.
    pub missing_on_hub: usize,
    pub errors: Vec<SyncError>,
}

/// One line of the pass's log, as Electron's `log(level, message)`.
pub type LogLine = (Level, String);

/// What a pass did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StartupSyncOutcome {
    pub result: StartupSyncResult,
    /// The quit stopped the pass; it reports nothing.
    pub stopped: bool,
    /// The lines logged while the pass ran, before its summary.
    pub logs: Vec<LogLine>,
}

impl StartupSyncOutcome {
    /// The log lines of the pass and of its summary (`reportSyncResult`):
    /// the summary only when packs were checked, one line per error.
    pub fn report(&self) -> Vec<LogLine> {
        let mut lines = self.logs.clone();
        let result = &self.result;
        if self.stopped || result.checked == 0 {
            return lines;
        }
        lines.push((
            Level::Info,
            format!(
                "i18n startup sync: checked={} updated={} missingOnHub={} errors={}",
                result.checked,
                result.updated,
                result.missing_on_hub,
                result.errors.len()
            ),
        ));
        for err in &result.errors {
            lines.push((
                Level::Warn,
                format!(
                    "i18n startup sync error pack={} hub={}: {}",
                    err.pack_id, err.hub_post_id, err.reason
                ),
            ));
        }
        lines
    }

    /// Whether the pass changed a pack, so `i18n-pack:changed` goes to
    /// every window.
    pub fn changed(&self) -> bool {
        !self.stopped && self.result.updated > 0
    }
}

/// The first line of the stack of the error the TS throws:
/// `<class name>: <message>`. A request that got no response is the
/// `TypeError` of `fetch`, a body that is not JSON the `SyntaxError` of
/// `response.json()`; their messages are this build's own.
fn error_line(err: &HubError) -> String {
    let class = match err {
        HubError::Status { kind, .. } => match kind {
            StatusKind::Unauthorized => "Hub401Error",
            StatusKind::Forbidden => "Hub403Error",
            StatusKind::NotFound => "Hub404Error",
            StatusKind::Conflict => "Hub409Error",
            StatusKind::RateLimited => "Hub429Error",
            StatusKind::Other => "Error",
        },
        HubError::Envelope { .. } => "Error",
        HubError::Network(_) => "TypeError",
        HubError::Body(_) => "SyntaxError",
    };
    format!("{class}: {err}")
}

/// A live pack linked to a Hub post (`pickHubLinked`): its id and the post
/// id, trimmed and not empty.
struct Linked {
    meta: Entry,
    id: JsString,
    hub_post_id: JsString,
}

fn pick_hub_linked(metas: Vec<Entry>) -> Vec<Linked> {
    metas
        .into_iter()
        .filter_map(|meta| {
            let Some(Value::String(post)) = meta.get("hubPostId") else { return None };
            let hub_post_id = js_trim(post);
            if hub_post_id.is_empty() {
                return None;
            }
            let id = meta.id()?.clone();
            Some(Linked { meta, id, hub_post_id })
        })
        .collect()
}

/// `fetchTimestampsByPostId`: the Hub time of each distinct post id, by id.
/// The batches go out at once and the first to fail ends the lookup.
async fn fetch_timestamps(http: &HubHttp, post_ids: &[JsString]) -> Result<HashMap<JsString, Value>, String> {
    let mut seen = HashSet::new();
    let unique: Vec<&JsString> = post_ids.iter().filter(|id| seen.insert(*id)).collect();
    let items =
        fetch_timestamp_items(http, &Endpoint::I18nTimestamps, &unique).await.map_err(|err| match err {
            TimestampsError::Request(err) => error_line(&err),
            TimestampsError::Read(message) => format!("TypeError: {}", message.to_string_lossy()),
        })?;
    Ok(items
        .into_iter()
        .map(|(id, item)| {
            let updated = item.as_object().and_then(|item| item.get("updated_at")).cloned();
            (id, updated.unwrap_or(Value::Null))
        })
        .collect())
}

/// What became of one pack.
enum PackOutcome {
    Current,
    Missing,
    Updated,
    Failed(String),
    Stopped,
}

/// Downloads, checks and saves one pack whose Hub time is `remote`.
async fn update_pack(
    http: &HubHttp,
    packs: &dyn StartupPacks,
    stopped: &(dyn Fn() -> bool + Sync),
    pack: &Linked,
    remote: Option<&Value>,
) -> PackOutcome {
    // `!remote`: a post the Hub did not answer, or answered without a time.
    let Some(remote) = remote.filter(|remote| remote.is_truthy()) else { return PackOutcome::Missing };
    if pack.meta.get("hubUpdatedAt").is_some_and(|cached| cached.is_truthy() && cached == remote) {
        return PackOutcome::Current;
    }
    if stopped() {
        return PackOutcome::Stopped;
    }
    let post_id = pack.hub_post_id.to_string_lossy();
    let export =
        match http.send(&Endpoint::I18nDownload { post_id: post_id.as_ref() }, None, RequestBody::None).await
        {
            Ok(export) => export,
            Err(err) => return PackOutcome::Failed(error_line(&err)),
        };
    let check = validate_i18n_export(export.as_ref());
    if let Some(reason) = check.reason {
        return PackOutcome::Failed(format!("invalid pack from Hub: {}", reason.to_string_lossy()));
    }
    if stopped() {
        return PackOutcome::Stopped;
    }
    let pack_value =
        export.as_ref().and_then(|export| export.as_object()).and_then(|e| e.get("pack")).cloned();
    let remote = match remote {
        Value::String(remote) => remote.clone(),
        other => JsString::from(js_string(Some(other))),
    };
    let input = SavePackInput {
        id: Some(pack.id.clone()),
        pack: pack_value,
        hub_post_id: Field::Set(pack.hub_post_id.clone()),
        hub_updated_at: Field::Set(remote),
        // `enabled` is left out: the user's choice outranks the Hub's.
        unattended: true,
        ..SavePackInput::default()
    };
    match packs.save_pack(input).await {
        Ok(()) => PackOutcome::Updated,
        Err(err) => PackOutcome::Failed(format!("savePack failed: {err}")),
    }
}

/// `syncHubI18nPacksOnStartup`: one pass over the Hub-linked packs. The
/// downloads run at once; the errors are listed in the order of the packs.
pub async fn run(
    http: &HubHttp,
    packs: &dyn StartupPacks,
    stopped: &(dyn Fn() -> bool + Sync),
) -> StartupSyncOutcome {
    let mut outcome = StartupSyncOutcome::default();
    let metas = match packs.list_metas().await {
        Ok(metas) => metas,
        Err(err) => {
            outcome.logs.push((Level::Warn, format!("i18n startup sync: failed to read pack index: {err}")));
            return outcome;
        }
    };
    let linked = pick_hub_linked(metas);
    if linked.is_empty() {
        return outcome;
    }
    outcome.result.checked = linked.len();
    if stopped() {
        outcome.stopped = true;
        return outcome;
    }
    let post_ids: Vec<JsString> = linked.iter().map(|pack| pack.hub_post_id.clone()).collect();
    let timestamps = match fetch_timestamps(http, &post_ids).await {
        Ok(timestamps) => timestamps,
        Err(err) => {
            outcome.logs.push((Level::Warn, format!("i18n startup sync: timestamps fetch failed: {err}")));
            return outcome;
        }
    };
    let passes =
        linked.iter().map(|pack| update_pack(http, packs, stopped, pack, timestamps.get(&pack.hub_post_id)));
    for (pack, done) in linked.iter().zip(join_all(passes).await) {
        match done {
            PackOutcome::Current => {}
            PackOutcome::Missing => outcome.result.missing_on_hub += 1,
            PackOutcome::Updated => outcome.result.updated += 1,
            PackOutcome::Stopped => outcome.stopped = true,
            PackOutcome::Failed(reason) => outcome.result.errors.push(SyncError {
                pack_id: pack.id.to_string_lossy().into_owned(),
                hub_post_id: pack.hub_post_id.to_string_lossy().into_owned(),
                reason,
            }),
        }
    }
    outcome
}

#[cfg(test)]
mod tests;
