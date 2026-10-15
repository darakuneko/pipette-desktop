// SPDX-License-Identifier: GPL-2.0-or-later
//! The per-group clocks of an entry (ISO 8601 strings in `clocks`): reading
//! them, and the writers every write path uses so `updatedAt` always equals
//! [`derived_updated_at`]. `created` is set when an id is created or written
//! again after being deleted or missing; it is the only clock that can
//! bring an entry back after a delete.

use pipette_js_json::{Object, Value};
use pipette_time::{date_string_ms, iso_8601_millis, iso_8601_millis_checked, parse_date_time_string};
use sha2::{Digest, Sha256};

use crate::entry::{Entry, EntryGroup, MetaGroup};
use crate::store_groups::EntryStore;

/// The epoch as `toISOString` writes it: the clock of built-in entries and
/// of clocks that are missing or invalid.
pub const EPOCH_ISO: &str = "1970-01-01T00:00:00.000Z";

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum EntryError {
    /// A clock would move past the last time a JavaScript `Date` can hold
    /// (where `toISOString` throws a RangeError with this message).
    #[error("Invalid time value")]
    TimeOutOfRange,
    /// A write the user did not ask for would bring back a deleted entry;
    /// callers refuse those before writing anything.
    #[error("An unattended write cannot bring back a deleted entry")]
    UnattendedRevive,
}

/// Epoch ms of a clock; anything that is not a string in the ECMAScript
/// date time format is 0, so a corrupt remote clock always loses. Times
/// before the epoch are negative, as in JavaScript.
pub fn clock_ms(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::String(s)) => date_string_ms(s).unwrap_or(0),
        _ => 0,
    }
}

/// The canonical ISO form of a clock, or `None` when it is not after the
/// epoch.
pub fn valid_clock(value: Option<&Value>) -> Option<String> {
    let ms = clock_ms(value);
    (ms > 0).then(|| iso_8601_millis(ms))
}

pub(crate) fn iso_ms(iso: &str) -> i64 {
    parse_date_time_string(iso).unwrap_or(0)
}

/// max(all clocks, `deletedAt`), never before the epoch: the only value
/// written to `updatedAt`.
pub fn derived_updated_at(clocks: &Object, deleted_at: Option<&Value>) -> String {
    let groups =
        [EntryGroup::Created, EntryGroup::Body, EntryGroup::Name, EntryGroup::Hub, EntryGroup::Enabled];
    let best =
        groups.iter().map(|g| clock_ms(clocks.get(g.key()))).chain([clock_ms(deleted_at)]).fold(0, i64::max);
    iso_8601_millis(best)
}

/// Clocks for a brand-new entry of `store`: every group the store has
/// starts at `now_ms`.
pub fn new_clocks(store: EntryStore, now_ms: i64) -> Object {
    let iso = Value::from(iso_8601_millis(now_ms));
    let mut clocks = Object::new();
    clocks.insert("created", iso.clone());
    clocks.insert("body", iso.clone());
    for group in MetaGroup::ALL {
        if store.groups().meta(group).is_some() {
            clocks.insert(EntryGroup::from(group).key(), iso.clone());
        }
    }
    clocks
}

fn clocks_of(entry: &Entry) -> Object {
    entry.clocks().cloned().unwrap_or_default()
}

/// Sets `group`'s clock to `now_ms`, or 1 ms past its current value when
/// that is later (a clock running behind must still move the group
/// forward), and rewrites `updatedAt`. Moving `created` past `deletedAt`
/// brings the entry back, so `deletedAt` goes. On an error the entry is
/// left as it was.
pub fn touch_clock(entry: &mut Entry, group: EntryGroup, now_ms: i64) -> Result<(), EntryError> {
    let mut clocks = clocks_of(entry);
    let next = now_ms.max(clock_ms(clocks.get(group.key())).saturating_add(1));
    let iso = iso_8601_millis_checked(next).ok_or(EntryError::TimeOutOfRange)?;
    clocks.insert(group.key(), iso.into());
    if entry.is_deleted() && clock_ms(clocks.get("created")) > clock_ms(entry.deleted_at()) {
        entry.remove("deletedAt");
    }
    let updated_at = derived_updated_at(&clocks, entry.deleted_at());
    entry.set("clocks", clocks);
    entry.set("updatedAt", updated_at);
    Ok(())
}

/// Sets `group`'s clock to `iso` as it is (no "never move back" rule, see
/// [`touch_clock`]) and rewrites `updatedAt`. For clocks a write fixes
/// instead of taking from now: the epoch of built-ins, a migrated or
/// received body clock.
pub fn set_clock(entry: &mut Entry, group: EntryGroup, iso: &str) {
    let mut clocks = clocks_of(entry);
    clocks.insert(group.key(), iso.into());
    let updated_at = derived_updated_at(&clocks, entry.deleted_at());
    entry.set("clocks", clocks);
    entry.set("updatedAt", updated_at);
}

/// SHA-256 of a body's text (its UTF-8 bytes) in lowercase hex, the
/// tie-break of equal body clocks and fields.
pub fn body_hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// Tombstones the entry at `now_ms`, never before its `created` clock, so
/// it stays deleted under the merge rule (a tie is deleted) even when
/// `created` came from a clock that runs ahead.
pub fn mark_deleted(entry: &mut Entry, now_ms: i64) {
    let clocks = clocks_of(entry);
    let deleted_at = Value::from(iso_8601_millis(now_ms.max(clock_ms(clocks.get("created")))));
    let updated_at = derived_updated_at(&clocks, Some(&deleted_at));
    entry.set("deletedAt", deleted_at);
    entry.set("updatedAt", updated_at);
}

/// Brings a deleted entry back (an explicit overwrite by the user): sets
/// `created` to `now_ms`, never earlier than 1 ms past `deletedAt`, so the
/// revival wins even when `deletedAt` came from a clock that runs ahead. An
/// entry without `deletedAt` is left alone: saving over a live entry does
/// not move `created`. On an error the entry is left as it was.
pub fn revive_entry(entry: &mut Entry, now_ms: i64) -> Result<(), EntryError> {
    if !entry.is_deleted() {
        return Ok(());
    }
    let next = now_ms.max(clock_ms(entry.deleted_at()).saturating_add(1));
    let created = iso_8601_millis_checked(next).ok_or(EntryError::TimeOutOfRange)?;
    let mut clocks = clocks_of(entry);
    clocks.insert("created", created.into());
    let updated_at = derived_updated_at(&clocks, None);
    entry.remove("deletedAt");
    entry.set("clocks", clocks);
    entry.set("updatedAt", updated_at);
    Ok(())
}
