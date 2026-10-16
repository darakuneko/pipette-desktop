// SPDX-License-Identifier: GPL-2.0-or-later
//! The entry merge of sync format v2 (src/main/sync/entry-merge.ts): every
//! field group (created / body / name / hub / enabled) merges on its own
//! clock, and an entry is alive only while its newest `created` is later
//! than its newest `deletedAt`.
//!
//! Each group's winner is the larger (clock, canonical JSON of the group's
//! values, caller-supplied body hash) tuple. That is a total order, so under
//! [`BodyPolicy::Clock`] the merge is commutative, associative and
//! idempotent and every device converges on the same entries; there is no
//! "keep local on a tie".
//!
//! Two rules keep a body file and its index entry together:
//! - Every body filename carries its entry id ([`crate::id_body_filename`]),
//!   so two ids never share a file. Local entries are expected in that form
//!   already; remote names are converted here.
//! - A side whose body file is missing cannot win the body group.

use std::cell::OnceCell;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use indexmap::IndexMap;
use pipette_js_json::{JsString, Object, Value};

use crate::body_filename::id_body_filename;
use crate::canonical::{body_fields_of, canonical_json, group_values};
use crate::clocks::{EPOCH_ISO, clock_ms, derived_updated_at};
use crate::entry::{Entry, EntryGroup, MetaGroup};
use crate::normalize::normalize_entry;
use crate::retention::apply_run_log_retention;
use crate::store_groups::{EntryStore, StoreGroupDef};

/// How long a tombstone is kept after its `deletedAt` (30 days).
pub const TOMBSTONE_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MergeSide {
    Local,
    Remote,
}

/// Whether a side holds an entry's body file (the local store for
/// [`MergeSide::Local`], the remote bundle for [`MergeSide::Remote`]). For
/// the remote side the entry's `filename` is the name in the remote bundle,
/// which may lack the id.
pub type HasBody<'a> = &'a dyn Fn(MergeSide, &Entry) -> bool;

/// The hash of an entry's body file ([`crate::body_hash`]), for stores
/// that overwrite the same filename (snapshots, analyze filters). Called
/// only when both sides' body clocks and fields are equal; the entry is
/// passed as [`HasBody`] gets it.
pub type BodyHash<'a> = &'a dyn Fn(MergeSide, &Entry) -> Option<String>;

/// How the body group merges.
#[derive(Clone, Copy)]
pub enum BodyPolicy<'a> {
    /// By the body tuple, like every other group, among the sides that
    /// have their body file.
    Clock { has_body: HasBody<'a> },
    /// For the pack indexes, whose body travels in its own sync unit: a
    /// live local entry keeps its body group whatever the clocks; a
    /// remote-only or revived entry takes the remote body fields for
    /// display with body clock 0, and the body unit fetches the file. The
    /// body group is left out of `remote_needs_update`.
    LocalIfPresent,
}

#[derive(Clone, Copy)]
pub struct MergeOptions<'a> {
    pub body_policy: BodyPolicy<'a>,
    /// Keep the local order for alive entries (remote-only ids go after
    /// them) instead of sorting by `updatedAt`, newest first.
    pub preserve_local_order: bool,
    pub body_hash: Option<BodyHash<'a>>,
    /// Keep the newest N alive run logs ([`apply_run_log_retention`]).
    pub run_log_retention_max: Option<usize>,
    /// The time of the tombstone GC and the retention.
    pub now_ms: i64,
}

impl<'a> MergeOptions<'a> {
    pub fn new(body_policy: BodyPolicy<'a>, now_ms: i64) -> Self {
        Self {
            body_policy,
            preserve_local_order: false,
            body_hash: None,
            run_log_retention_max: None,
            now_ms,
        }
    }
}

/// What the merge made of one id.
#[derive(Clone, Debug, PartialEq)]
pub struct EntryMergeOutcome {
    pub entry: Entry,
    /// The alive result's body is the remote one and differs from the
    /// local one, so the caller copies the remote file.
    pub body_from_remote: bool,
    /// [`BodyPolicy::LocalIfPresent`] only: the alive result shows remote
    /// body fields the local store has no file for, so the body unit has
    /// to be fetched.
    pub body_fetch_needed: bool,
    /// The merge would make the entry alive but no side has its body file:
    /// the local entry is kept exactly as it is (an id only the remote side
    /// has is left out of `entries`), and the id is left out of
    /// `remote_needs_update`.
    pub body_missing: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteFileCopy {
    /// Key in the remote bundle's `files`.
    pub from: JsString,
    /// Local filename to save it under (carries the id).
    pub to: JsString,
}

/// The caller applies a result under the store's lock: save every
/// `remote_files_to_copy` file under its `to` name, write `entries` as the
/// local index, then unlink the local body files outside
/// `referenced_filenames`.
#[derive(Clone, Debug, PartialEq)]
pub struct EntryMergeResult {
    /// The index to write locally. An id only a body-less remote entry has
    /// is not in it.
    pub entries: Vec<Entry>,
    /// Every merged id, in the order the ids were first met (local first).
    pub by_id: IndexMap<JsString, EntryMergeOutcome>,
    /// One per `body_from_remote` outcome.
    pub remote_files_to_copy: Vec<RemoteFileCopy>,
    /// Every filename `entries` still points at, tombstones included.
    pub referenced_filenames: HashSet<JsString>,
    /// `entries` differs from the local input (order included).
    pub local_needs_write: bool,
    /// Some entry with a body differs from the remote input after GC, or
    /// Drive needs this device's body file (it lacks it, or the body won
    /// only by its hash).
    pub remote_needs_update: bool,
    /// Entries of `entries` tombstoned by the run log retention; the caller
    /// unlinks their files.
    pub evicted: Vec<Entry>,
}

struct Candidate<'o> {
    side: MergeSide,
    /// The entry as the merge compares it (a remote filename carries the id).
    entry: Entry,
    /// The entry as given to the hooks.
    given: Entry,
    options: &'o MergeOptions<'o>,
    hash: OnceCell<String>,
    has: OnceCell<bool>,
}

impl Candidate<'_> {
    fn hash(&self) -> &str {
        self.hash.get_or_init(|| {
            self.options.body_hash.and_then(|f| f(self.side, &self.given)).unwrap_or_default()
        })
    }

    fn has_body(&self) -> bool {
        *self.has.get_or_init(|| match self.options.body_policy {
            BodyPolicy::Clock { has_body } => has_body(self.side, &self.given),
            BodyPolicy::LocalIfPresent => true,
        })
    }
}

fn deleted_ms(entry: &Entry) -> i64 {
    clock_ms(entry.deleted_at())
}

fn created_ms(entry: &Entry) -> i64 {
    clock_ms(entry.clock(EntryGroup::Created))
}

/// Whether the entry is a tombstone that stays deleted under the merge
/// rule: it has `deletedAt` and its `created` is not later.
pub fn is_dead_entry(entry: &Entry) -> bool {
    entry.is_deleted() && created_ms(entry) <= deleted_ms(entry)
}

fn keep_after_gc(entry: &Entry, now_ms: i64) -> bool {
    !is_dead_entry(entry) || now_ms.saturating_sub(deleted_ms(entry)) < TOMBSTONE_TTL_MS
}

/// The entries without the dead ones whose `deletedAt` is older than the
/// TTL. Alive entries are always kept.
pub fn gc_tombstones(entries: &[Entry], now_ms: i64) -> Vec<Entry> {
    entries.iter().filter(|e| keep_after_gc(e, now_ms)).cloned().collect()
}

/// JavaScript's `<` on strings: by UTF-16 code units.
fn cmp_js(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// (clock, canonical values) order of one group; `Equal` means only the
/// body hash can still tell the two apart.
fn compare_clock_and_values(def: &StoreGroupDef, group: EntryGroup, a: &Entry, b: &Entry) -> Ordering {
    clock_ms(a.clock(group)).cmp(&clock_ms(b.clock(group))).then_with(|| {
        let av = canonical_json(Some(&Value::Object(group_values(def, a.as_object(), group))));
        let bv = canonical_json(Some(&Value::Object(group_values(def, b.as_object(), group))));
        cmp_js(&av, &bv)
    })
}

/// Total order of two bodies: `Greater` when `a` wins. `hashes` is called
/// only on an exact (clock, fields) tie and gives the hashes of `a` and
/// `b`. The body unit of the packs uses the same order, so the index and
/// the body unit agree.
pub fn compare_bodies(
    store: EntryStore,
    a: &Entry,
    b: &Entry,
    hashes: Option<&dyn Fn() -> (Option<String>, Option<String>)>,
) -> Ordering {
    let by_values = compare_clock_and_values(store.groups(), EntryGroup::Body, a, b);
    match hashes {
        Some(hashes) if by_values == Ordering::Equal => {
            let (ha, hb) = hashes();
            cmp_js(&ha.unwrap_or_default(), &hb.unwrap_or_default())
        }
        _ => by_values,
    }
}

fn compare_group(def: &StoreGroupDef, group: EntryGroup, a: &Candidate<'_>, b: &Candidate<'_>) -> Ordering {
    let by_values = compare_clock_and_values(def, group, &a.entry, &b.entry);
    if by_values != Ordering::Equal || group != EntryGroup::Body {
        return by_values;
    }
    cmp_js(a.hash(), b.hash())
}

/// The winning candidate; the first (local) one on a full tie, where the
/// values are equal.
fn winner<'c, 'o>(def: &StoreGroupDef, group: EntryGroup, cands: &[&'c Candidate<'o>]) -> &'c Candidate<'o> {
    let mut best = cands[0];
    for &c in &cands[1..] {
        if compare_group(def, group, c, best) == Ordering::Greater {
            best = c;
        }
    }
    best
}

struct Assembled {
    entry: Entry,
    body_side: MergeSide,
    body_fetch_needed: bool,
    body_missing: bool,
}

fn assign(out: &mut Object, values: Object) {
    for (key, value) in values.iter() {
        out.insert(key.clone(), value.clone());
    }
}

fn assemble(
    def: &StoreGroupDef,
    id: &JsString,
    cands: &[&Candidate<'_>],
    policy: BodyPolicy<'_>,
) -> Assembled {
    let created_w = winner(def, EntryGroup::Created, cands);
    let mut deleted_at: Option<&Value> = None;
    for c in cands {
        if let Some(d) = c.entry.deleted_at()
            && deleted_at.is_none_or(|best| clock_ms(Some(d)) > clock_ms(Some(best)))
        {
            deleted_at = Some(d);
        }
    }
    // An alive result never carries deletedAt: "has deletedAt" stays the
    // single deleted check for every reader and for GC.
    if deleted_at.is_some_and(|d| created_ms(&created_w.entry) > clock_ms(Some(d))) {
        deleted_at = None;
    }
    let alive = deleted_at.is_none();
    let local = cands.iter().find(|c| c.side == MergeSide::Local).copied();

    let mut body_clock: Option<Value> = None;
    let mut body_fetch_needed = false;
    let body_w = match policy {
        BodyPolicy::LocalIfPresent => match local {
            Some(local) if !is_dead_entry(&local.entry) || !alive => local,
            _ => {
                body_clock = Some(EPOCH_ISO.into());
                body_fetch_needed = alive;
                cands.iter().find(|c| c.side == MergeSide::Remote).copied().unwrap_or(cands[0])
            }
        },
        // A tombstone holds no body, so file presence does not matter.
        BodyPolicy::Clock { .. } if !alive => winner(def, EntryGroup::Body, cands),
        BodyPolicy::Clock { .. } => {
            let with_body: Vec<&Candidate<'_>> = cands.iter().copied().filter(|c| c.has_body()).collect();
            if with_body.is_empty() {
                let kept = local.unwrap_or(cands[0]);
                return Assembled {
                    entry: kept.entry.clone(),
                    body_side: kept.side,
                    body_fetch_needed: false,
                    body_missing: true,
                };
            }
            winner(def, EntryGroup::Body, &with_body)
        }
    };

    let mut out = Object::new();
    out.insert("id", Value::String(id.clone()));
    assign(&mut out, group_values(def, body_w.entry.as_object(), EntryGroup::Body));
    assign(&mut out, group_values(def, created_w.entry.as_object(), EntryGroup::Created));
    let mut clocks = Object::new();
    clocks.insert("created", created_w.entry.clock(EntryGroup::Created).cloned().unwrap_or(Value::Null));
    clocks.insert(
        "body",
        body_clock.or_else(|| body_w.entry.clock(EntryGroup::Body).cloned()).unwrap_or(Value::Null),
    );
    for meta in MetaGroup::ALL {
        if def.meta(meta).is_none() {
            continue;
        }
        let group = EntryGroup::from(meta);
        let w = winner(def, group, cands);
        assign(&mut out, group_values(def, w.entry.as_object(), group));
        if let Some(clock) = w.entry.clock(group) {
            clocks.insert(group.key(), clock.clone());
        }
    }
    let updated_at = derived_updated_at(&clocks, deleted_at);
    out.insert("clocks", Value::Object(clocks));
    if let Some(d) = deleted_at {
        out.insert("deletedAt", d.clone());
    }
    out.insert("updatedAt", updated_at.into());
    Assembled {
        entry: Entry::from_object(out),
        body_side: body_w.side,
        body_fetch_needed,
        body_missing: false,
    }
}

/// The entry without its body group, `updatedAt` and body clock: what the
/// pack indexes compare.
fn strip_body(def: &StoreGroupDef, entry: &Object) -> Value {
    let mut out = entry.clone();
    for field in body_fields_of(def, entry) {
        remove_key(&mut out, &field);
    }
    out.remove("updatedAt");
    // `{ body, ...rest } = clocks` for anything `typeof` calls an object.
    match out.get("clocks").cloned() {
        Some(Value::Object(mut clocks)) => {
            clocks.remove("body");
            out.insert("clocks", Value::Object(clocks));
        }
        Some(Value::Array(items)) => {
            let rest: Object = items.into_iter().enumerate().map(|(i, v)| (i.to_string(), v)).collect();
            out.insert("clocks", Value::Object(rest));
        }
        _ => {}
    }
    Value::Object(out)
}

/// Removes `key`, also one with a lone surrogate.
fn remove_key(object: &mut Object, key: &JsString) {
    match key.as_str() {
        Some(key) => {
            object.remove(key);
        }
        None => {
            *object = object.iter().filter(|(k, _)| *k != key).map(|(k, v)| (k.clone(), v.clone())).collect()
        }
    }
}

fn ordered(entries: Vec<Entry>, preserve_local_order: bool) -> Vec<Entry> {
    let (mut alive, dead): (Vec<Entry>, Vec<Entry>) = entries.into_iter().partition(|e| !e.is_deleted());
    if !preserve_local_order {
        // Stable, as `Array.prototype.sort` is.
        alive.sort_by_key(|e| std::cmp::Reverse(clock_ms(e.get("updatedAt"))));
    }
    alive.extend(dead);
    alive
}

fn entries_json(entries: &[Entry]) -> String {
    canonical_json(Some(&Value::Array(entries.iter().cloned().map(Value::from).collect())))
}

/// Entries by id after normalization and GC, the later of two kept entries
/// with one id winning; ids in the order first kept.
fn prepare(store: EntryStore, raw: &[Entry], now_ms: i64) -> IndexMap<JsString, Entry> {
    let mut out = IndexMap::new();
    for entry in raw {
        let Some(id) = entry.id() else { continue };
        let normalized = normalize_entry(store, entry.as_object());
        if keep_after_gc(&normalized, now_ms) {
            out.insert(id.clone(), normalized);
        }
    }
    out
}

/// Merges the `local` and `remote` entries of `store`. Entries without a
/// string `id` are left out.
pub fn merge_entries(
    store: EntryStore,
    local: &[Entry],
    remote: &[Entry],
    options: &MergeOptions<'_>,
) -> EntryMergeResult {
    let def = store.groups();
    let now = options.now_ms;
    let policy = options.body_policy;
    let is_clock = matches!(policy, BodyPolicy::Clock { .. });
    let l = prepare(store, local, now);
    let r = prepare(store, remote, now);

    let candidate = |side: MergeSide, given: &Entry| -> Candidate<'_> {
        let mut entry = given.clone();
        if side == MergeSide::Remote
            && let (Some(id), Some(filename)) = (given.id(), given.filename())
        {
            entry.set("filename", Value::String(id_body_filename(store, id, filename)));
        }
        Candidate { side, entry, given: given.clone(), options, hash: OnceCell::new(), has: OnceCell::new() }
    };

    let mut by_id: IndexMap<JsString, EntryMergeOutcome> = IndexMap::new();
    let mut remote_files_to_copy = Vec::new();
    let mut body_missing_ids: HashSet<JsString> = HashSet::new();
    let mut local_body_needed = false;
    let ids: Vec<JsString> = l.keys().chain(r.keys().filter(|k| !l.contains_key(*k))).cloned().collect();
    for id in &ids {
        let lc = l.get(id).map(|n| candidate(MergeSide::Local, n));
        let rc = r.get(id).map(|n| candidate(MergeSide::Remote, n));
        let cands: Vec<&Candidate<'_>> = lc.iter().chain(rc.iter()).collect();
        let merged = assemble(def, id, &cands, policy);
        if merged.body_missing {
            body_missing_ids.insert(id.clone());
            if lc.is_none() {
                continue;
            }
        }
        let body_from_remote = is_clock
            && !merged.body_missing
            && merged.body_side == MergeSide::Remote
            && !merged.entry.is_deleted();
        if body_from_remote
            && let (Some(rc), Some(to)) = (&rc, merged.entry.filename())
            && let Some(from) = rc.given.filename()
        {
            remote_files_to_copy.push(RemoteFileCopy { from: from.clone(), to: to.clone() });
        }

        // Two cases leave the index fields equal while Drive needs this
        // device's body: Drive lacks the file of a body kept from here, or
        // the body won only by its hash.
        if is_clock
            && let (Some(lc), Some(rc)) = (&lc, &rc)
            && !merged.body_missing
            && !merged.entry.is_deleted()
            && merged.body_side == MergeSide::Local
            && lc.has_body()
            && (!rc.has_body()
                || (compare_clock_and_values(def, EntryGroup::Body, &lc.entry, &rc.entry) == Ordering::Equal
                    && lc.hash() != rc.hash()))
        {
            local_body_needed = true;
        }
        by_id.insert(
            id.clone(),
            EntryMergeOutcome {
                entry: merged.entry,
                body_from_remote,
                body_fetch_needed: merged.body_fetch_needed,
                body_missing: merged.body_missing,
            },
        );
    }

    let mut entries =
        ordered(by_id.values().map(|o| o.entry.clone()).collect(), options.preserve_local_order);
    let mut evicted = Vec::new();
    if let Some(max) = options.run_log_retention_max {
        let (kept, gone) = apply_run_log_retention(entries, max, now);
        entries = kept;
        evicted = gone;
        for e in &entries {
            if let Some(prev) = e.id().and_then(|id| by_id.get_mut(id)) {
                prev.body_from_remote = prev.body_from_remote && !e.is_deleted();
                prev.entry = e.clone();
            }
        }
    }

    // Every remote id is either in `entries` or body-less, so comparing the
    // merged entries covers both directions. Body-less ids never count: no
    // side can send a body for them.
    let view = |e: &Object| -> String {
        if is_clock {
            canonical_json(Some(&Value::Object(e.clone())))
        } else {
            canonical_json(Some(&strip_body(def, e)))
        }
    };
    // The last remote entry of each kept id, as given.
    let mut remote_raw: HashMap<&JsString, &Entry> = HashMap::new();
    for raw in remote {
        if let Some(id) = raw.id().filter(|id| r.contains_key(*id)) {
            remote_raw.insert(id, raw);
        }
    }
    let mut remote_needs_update = local_body_needed;
    for e in &entries {
        if remote_needs_update {
            break;
        }
        let Some(id) = e.id() else { continue };
        if body_missing_ids.contains(id) {
            continue;
        }
        remote_needs_update = match remote_raw.get(id) {
            None => true,
            Some(raw) => view(e.as_object()) != view(raw.as_object()),
        };
    }

    EntryMergeResult {
        referenced_filenames: entries.iter().filter_map(Entry::filename).cloned().collect(),
        local_needs_write: entries_json(&entries) != entries_json(local),
        entries,
        by_id,
        remote_files_to_copy,
        remote_needs_update,
        evicted,
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    const NOW: i64 = 1_767_312_000_000;

    fn snap(id: &str, body: &str, vil: f64) -> Entry {
        let mut clocks = Object::new();
        for group in ["created", "body", "name", "hub"] {
            clocks.insert(group, "2026-01-01T00:00:01.000Z".into());
        }
        clocks.insert("body", body.into());
        let mut o = Object::new();
        o.insert("id", id.into());
        o.insert("label", "S".into());
        o.insert("savedAt", "2026-01-01T00:00:00.000Z".into());
        o.insert("filename", format!("s_{id}.pipette").into());
        o.insert("vilVersion", vil.into());
        o.insert("clocks", Value::Object(clocks));
        Entry::from_object(o)
    }

    #[test]
    fn the_body_hash_is_read_only_on_an_exact_tie() {
        let calls = RefCell::new(Vec::new());
        let hash = |side: MergeSide, _: &Entry| {
            calls.borrow_mut().push(side);
            Some(format!("{side:?}"))
        };
        let all = |_: MergeSide, _: &Entry| true;
        let mut options = MergeOptions::new(BodyPolicy::Clock { has_body: &all }, NOW);
        options.body_hash = Some(&hash);
        let t1 = "2026-01-01T00:00:01.000Z";
        merge_entries(
            EntryStore::Snapshots,
            &[snap("a", "2026-01-01T00:00:02.000Z", 2.0)],
            &[snap("a", t1, 2.0)],
            &options,
        );
        merge_entries(EntryStore::Snapshots, &[snap("a", t1, 1.0)], &[snap("a", t1, 2.0)], &options);
        assert!(calls.borrow().is_empty());
        let r = merge_entries(EntryStore::Snapshots, &[snap("a", t1, 2.0)], &[snap("a", t1, 2.0)], &options);
        let mut seen = calls.borrow().clone();
        seen.sort_by_key(|side| *side == MergeSide::Remote);
        assert_eq!(seen, [MergeSide::Local, MergeSide::Remote]);
        // "Remote" > "Local": the remote body wins by its hash alone.
        assert!(r.by_id["a"].body_from_remote);
    }

    #[test]
    fn has_body_gets_the_remote_bundle_name() {
        let seen = RefCell::new(Vec::new());
        let has_body = |side: MergeSide, e: &Entry| {
            seen.borrow_mut().push((side, e.filename().unwrap().to_string_lossy().into_owned()));
            true
        };
        let mut remote = snap("a", "2026-01-01T00:00:01.000Z", 2.0);
        remote.set("filename", "legacy.pipette");
        let r = merge_entries(
            EntryStore::Snapshots,
            &[],
            &[remote],
            &MergeOptions::new(BodyPolicy::Clock { has_body: &has_body }, NOW),
        );
        assert_eq!(*seen.borrow(), [(MergeSide::Remote, "legacy.pipette".to_owned())]);
        assert_eq!(r.remote_files_to_copy[0].from, JsString::from("legacy.pipette"));
        assert_eq!(r.remote_files_to_copy[0].to, JsString::from("legacy_a.pipette"));
    }
}
