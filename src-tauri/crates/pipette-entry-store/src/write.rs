// SPDX-License-Identifier: GPL-2.0-or-later
//! Write-side helpers of the entry stores: the clocks of a created,
//! overwritten or changed entry, on top of the clock writers. Every helper
//! leaves `updatedAt` equal to [`derived_updated_at`] of the clocks.

use pipette_js_json::{JsString, Object, Value};

use crate::canonical::{canonical_json, group_values};
use crate::clocks::{
    EPOCH_ISO, EntryError, derived_updated_at, mark_deleted, new_clocks, revive_entry, touch_clock,
};
use crate::entry::{Entry, EntryGroup, MetaGroup};
use crate::store_groups::EntryStore;

/// `fields` as a brand-new entry: every group the store has starts at
/// `now_ms`. Any `deletedAt` in `fields` is dropped.
pub fn create_entry(store: EntryStore, fields: Object, now_ms: i64) -> Entry {
    let clocks = new_clocks(store, now_ms);
    let updated_at = derived_updated_at(&clocks, None);
    let mut entry = Entry::from_object(fields);
    entry.set("clocks", clocks);
    entry.set("updatedAt", updated_at);
    entry.remove("deletedAt");
    entry
}

/// A built-in entry (the QWERTY key label, the English pack): every clock,
/// and `updatedAt`, is the epoch, so every device creates the identical
/// entry and none of them wins over a user change.
pub fn builtin_entry(store: EntryStore, fields: Object) -> Entry {
    let mut entry = create_entry(store, fields, 0);
    entry.set("updatedAt", EPOCH_ISO);
    entry
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OverwriteOptions {
    /// The body file was written.
    pub body: bool,
    /// The user asked for this write (a Hub download, an import over an
    /// entry of the same name, an UPDATE). It brings a tombstoned entry
    /// back and raises `created` on a live one, so it also wins over a
    /// delete made on another device that this one has not seen yet. An
    /// unattended write (the Hub startup auto-update) passes false: it
    /// never revives anything.
    pub explicit: bool,
}

/// `next` written over `existing` (same id), or created when `existing` is
/// `None`. Groups move as follows:
/// - a revival (`existing` deleted, `explicit`): `created` and every other
///   group the store has move to `now_ms`, so no older value of the deleted
///   entry wins over what was just written.
/// - otherwise: `created` moves when `explicit`, `body` when
///   `options.body`, and a meta group (name / hub / enabled) only when its
///   values differ from `existing`'s, so a save that keeps the name leaves
///   the name clock alone.
///
/// A non-explicit write over a deleted entry is
/// [`EntryError::UnattendedRevive`]: callers refuse those before writing
/// anything.
pub fn overwrite_entry(
    store: EntryStore,
    existing: Option<&Entry>,
    next: Object,
    now_ms: i64,
    options: OverwriteOptions,
) -> Result<Entry, EntryError> {
    let Some(existing) = existing else {
        return Ok(create_entry(store, next, now_ms));
    };
    let def = store.groups();
    let mut base = Entry::from_object(next);
    base.set("clocks", existing.clocks().cloned().unwrap_or_default());
    // Rewritten below; set here for its position.
    base.set("updatedAt", existing.get("updatedAt").cloned().unwrap_or(Value::Null));
    if let Some(deleted_at) = existing.deleted_at() {
        if !options.explicit {
            return Err(EntryError::UnattendedRevive);
        }
        base.set("deletedAt", deleted_at.clone());
        revive_entry(&mut base, now_ms)?;
        touch_clock(&mut base, EntryGroup::Body, now_ms)?;
        for group in MetaGroup::ALL {
            if def.meta(group).is_some() {
                touch_clock(&mut base, group.into(), now_ms)?;
            }
        }
        return Ok(base);
    }
    base.remove("deletedAt");
    let mut groups = Vec::new();
    if options.explicit {
        groups.push(EntryGroup::Created);
    }
    if options.body {
        groups.push(EntryGroup::Body);
    }
    for group in MetaGroup::ALL {
        if def.meta(group).is_none() {
            continue;
        }
        let before = group_values(def, existing.as_object(), group.into());
        let after = group_values(def, base.as_object(), group.into());
        if canonical_json(Some(&before.into())) != canonical_json(Some(&after.into())) {
            groups.push(group.into());
        }
    }
    let updated_at = derived_updated_at(&base.clocks().cloned().unwrap_or_default(), base.deleted_at());
    base.set("updatedAt", updated_at);
    for group in groups {
        touch_clock(&mut base, group, now_ms)?;
    }
    Ok(base)
}

/// A meta-only change of an entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryMutation {
    /// The group's clock moves ([`touch_clock`]).
    Meta(MetaGroup),
    /// The entry is tombstoned ([`mark_deleted`]).
    Delete,
}

/// A meta-only change of the entry `id` in `entries`: `mutate` edits a copy,
/// then `mutation` applies, and the copy replaces the entry. Returns the
/// new entry, or `None` when `entries` has no `id`. On an error `entries`
/// is left as it was.
pub fn apply_entry_mutation<'a>(
    entries: &'a mut [Entry],
    id: &JsString,
    mutation: EntryMutation,
    now_ms: i64,
    mutate: impl FnOnce(&mut Entry),
) -> Result<Option<&'a Entry>, EntryError> {
    let Some(at) = entries.iter().position(|e| e.id() == Some(id)) else {
        return Ok(None);
    };
    let mut entry = entries[at].clone();
    mutate(&mut entry);
    match mutation {
        EntryMutation::Delete => mark_deleted(&mut entry, now_ms),
        EntryMutation::Meta(group) => touch_clock(&mut entry, group.into(), now_ms)?,
    }
    entries[at] = entry;
    Ok(Some(&entries[at]))
}
