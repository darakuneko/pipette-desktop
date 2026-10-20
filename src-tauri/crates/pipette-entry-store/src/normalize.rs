// SPDX-License-Identifier: GPL-2.0-or-later
//! Reading index entries as v2 entries (the v1 → v2 normalization the
//! writes and the merge build on).

use pipette_js_json::{Object, Value};

use crate::clocks::{EPOCH_ISO, clock_ms, derived_updated_at, iso_ms, valid_clock};
use crate::entry::{Entry, EntryGroup, MetaGroup};
use crate::store_groups::{EntryStore, V1BodyClockRule};

/// The entries of an index read from disk, as v2 entries. Anything that is
/// not an object with a string `id` is dropped, as is everything when
/// `entries` is not an array. Nothing is written back here: the next write
/// of the index stores the normalized form.
pub fn normalize_entries(store: EntryStore, entries: Option<&Value>) -> Vec<Entry> {
    let Some(Value::Array(entries)) = entries else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|e| match e {
            Value::Object(object) if matches!(object.get("id"), Some(Value::String(_))) => {
                Some(normalize_entry(store, object))
            }
            _ => None,
        })
        .collect()
}

/// `raw` read as a v2 entry, as a new entry with `raw`'s fields in their
/// order:
/// - v1 (no `clocks` object): created = `savedAt` (no later than
///   `deletedAt`, so a v1 tombstone stays deleted), name / hub / enabled =
///   `updatedAt ?? savedAt`, body per the store's [`V1BodyClockRule`].
/// - v2: invalid clocks count as 0 (`created` / `body` become the epoch,
///   the others are dropped) and clocks of groups the store lacks are
///   dropped.
/// - A v2 entry whose `updatedAt` is later than every clock and
///   `deletedAt` was written by an app that only knows v1 (v2 writes
///   `updatedAt` only through [`derived_updated_at`]). Its name / hub /
///   enabled clocks are raised to that `updatedAt`, and so is `body` for
///   stores whose v1 rule is [`V1BodyClockRule::UpdatedAtOrSavedAt`].
///   `created` is never raised: a v1 write cannot say whether it re-created
///   the entry.
/// - An entry alive under the merge rule (created > deletedAt) carries no
///   `deletedAt`, so "has deletedAt" means deleted on read too.
pub fn normalize_entry(store: EntryStore, raw: &Object) -> Entry {
    let def = store.groups();
    // An array is an object to JavaScript's `typeof`; it has none of the
    // clock keys.
    let given = match raw.get("clocks") {
        Some(Value::Object(clocks)) => Some(Some(clocks)),
        Some(Value::Array(_)) => Some(None),
        _ => None,
    };
    let mut deleted_at =
        raw.get("deletedAt").map(|value| valid_clock(Some(value)).unwrap_or_else(|| EPOCH_ISO.to_owned()));
    let v1_meta = valid_clock(raw.get("updatedAt")).or_else(|| valid_clock(raw.get("savedAt")));

    let mut clocks = Object::new();
    match given {
        None => {
            // A v1 tombstone stays deleted: its created is never past its deletedAt.
            let created = match &deleted_at {
                Some(deleted) if clock_ms(raw.get("savedAt")) > iso_ms(deleted) => Some(deleted.clone()),
                _ => valid_clock(raw.get("savedAt")),
            };
            set(&mut clocks, EntryGroup::Created, created.as_deref().unwrap_or(EPOCH_ISO));
            let body = match def.v1_body_clock {
                V1BodyClockRule::SavedAt => valid_clock(raw.get("savedAt")),
                V1BodyClockRule::UpdatedAtOrSavedAt => v1_meta.clone(),
                V1BodyClockRule::Epoch => None,
            };
            set(&mut clocks, EntryGroup::Body, body.as_deref().unwrap_or(EPOCH_ISO));
            if let Some(meta) = &v1_meta {
                for group in present_meta_groups(store) {
                    set(&mut clocks, group, meta);
                }
            }
        }
        Some(given) => {
            let given_clock = |group: EntryGroup| valid_clock(given.and_then(|g| g.get(group.key())));
            set(
                &mut clocks,
                EntryGroup::Created,
                given_clock(EntryGroup::Created).as_deref().unwrap_or(EPOCH_ISO),
            );
            set(&mut clocks, EntryGroup::Body, given_clock(EntryGroup::Body).as_deref().unwrap_or(EPOCH_ISO));
            for group in present_meta_groups(store) {
                if let Some(iso) = given_clock(group) {
                    set(&mut clocks, group, &iso);
                }
            }
            let deleted_value = deleted_at.clone().map(Value::from);
            if let Some(written) = valid_clock(raw.get("updatedAt"))
                && iso_ms(&written) > iso_ms(&derived_updated_at(&clocks, deleted_value.as_ref()))
            {
                for group in present_meta_groups(store) {
                    set(&mut clocks, group, &written);
                }
                if def.v1_body_clock == V1BodyClockRule::UpdatedAtOrSavedAt {
                    set(&mut clocks, EntryGroup::Body, &written);
                }
            }
        }
    }
    if deleted_at.as_deref().is_some_and(|deleted| clock_ms(clocks.get("created")) > iso_ms(deleted)) {
        deleted_at = None;
    }

    let mut out = raw.clone();
    let deleted_value = deleted_at.map(Value::from);
    let updated_at = derived_updated_at(&clocks, deleted_value.as_ref());
    out.insert("clocks", Value::Object(clocks));
    match deleted_value {
        None => {
            out.remove("deletedAt");
        }
        Some(deleted) => {
            out.insert("deletedAt", deleted);
        }
    }
    out.insert("updatedAt", updated_at.into());
    Entry::from_object(out)
}

fn set(clocks: &mut Object, group: EntryGroup, iso: &str) {
    clocks.insert(group.key(), iso.into());
}

/// The meta groups `store` has, in clock order.
fn present_meta_groups(store: EntryStore) -> impl Iterator<Item = EntryGroup> {
    MetaGroup::ALL.into_iter().filter(move |&g| store.groups().meta(g).is_some()).map(EntryGroup::from)
}
