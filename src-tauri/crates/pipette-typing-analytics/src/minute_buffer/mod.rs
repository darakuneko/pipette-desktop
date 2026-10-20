// SPDX-License-Identifier: GPL-2.0-or-later
//! The per-minute aggregation of the recording: every
//! event lands in the entry of its scope, minute and test run, and a flush
//! turns the entries into [`MinuteSnapshot`]s. Nothing finer than a minute
//! leaves this buffer, so the written data is always derived, never a log
//! of keystrokes.
//!
//! An entry is kept for [`RETENTION_MS`] after its minute ends: a late event
//! reopens it, and the next drain sends the whole minute again (the cache
//! and the merge of the day files keep the newest row), never a partial
//! minute that would replace the full one.
//!
//! The maps keep the order their keys were first added, and the rows come
//! out in that order.

use std::sync::Arc;

use indexmap::map::Entry as Slot;
use indexmap::{IndexMap, IndexSet};
use pipette_js_json::JsString;

use crate::event::{EventKind, MatrixKey, TapHold, TypingEvent};
use crate::fingerprint::Fingerprint;
use crate::jsonl::row::js_number_string;

pub const MINUTE_MS: f64 = 60_000.0;

/// `NGRAM_MAX_IKI_MS`: the slowest interval between two presses that still
/// forms a bigram or trigram. Not the session idle gap: this one keeps
/// pauses out of the n-gram statistics.
pub const NGRAM_MAX_IKI_MS: f64 = 5000.0;

/// `MAX_TAP_HOLD_DEFER_MS` (src/shared/qmk-settings-tapping-term.ts): the
/// longest the renderer holds back a tap-hold press.
const MAX_TAP_HOLD_DEFER_MS: f64 = 1000.0;

/// `DRAIN_CLOSE_GRACE_MS`: how long past its end a minute waits before its
/// first drain, so a deferred tap-hold press and the IPC trip after it
/// usually land before the minute is sent. A later straggler only costs one
/// more send of the whole minute.
pub const DRAIN_CLOSE_GRACE_MS: f64 = MAX_TAP_HOLD_DEFER_MS + 1000.0;

/// `RETENTION_MS`: how long past its end a minute stays in the buffer. An
/// event for an older minute with no entry is dropped (see
/// [`MinuteBuffer::add_event`]).
pub const RETENTION_MS: f64 = 5.0 * MINUTE_MS;

/// A matrix cell's counts in a minute (`MatrixCellCounts`). `tap_count`
/// and `hold_count` split `count` for tap-hold keys; `durations` are the
/// keypress durations of the releases that landed in this minute, which
/// need not match the presses (a release follows its own time).
#[derive(Clone, Debug, PartialEq)]
pub struct MatrixCellCounts {
    pub row: f64,
    pub col: f64,
    pub layer: f64,
    pub keycode: f64,
    pub count: u64,
    pub tap_count: u64,
    pub hold_count: u64,
    pub durations: Vec<f64>,
}

/// `OverlapCounts`: of the pairs whose overlap was known (`on`), those
/// that overlapped (`oc`). A pair whose overlap was unknown counts in
/// neither.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OverlapCounts {
    pub oc: u64,
    pub on: u64,
}

/// One drained minute of a scope and run (`MinuteSnapshot`).
#[derive(Clone, Debug, PartialEq)]
pub struct MinuteSnapshot {
    pub scope_id: String,
    pub fingerprint: Arc<Fingerprint>,
    pub minute_ts: f64,
    pub keystrokes: u64,
    pub active_ms: f64,
    pub interval_avg_ms: Option<f64>,
    pub interval_min_ms: Option<f64>,
    pub interval_p25_ms: Option<f64>,
    pub interval_p50_ms: Option<f64>,
    pub interval_p75_ms: Option<f64>,
    pub interval_max_ms: Option<f64>,
    pub char_counts: IndexMap<String, u64>,
    pub matrix_counts: IndexMap<CellKey, MatrixCellCounts>,
    /// `{prevKeycode}_{keycode}` → the intervals of that pair.
    pub bigrams: IndexMap<String, Vec<f64>>,
    /// `{k1}_{k2}_{k3}` → the mean of the triple's two intervals.
    pub trigrams: IndexMap<String, Vec<f64>>,
    /// Keyed as `bigrams`.
    pub overlaps: IndexMap<String, OverlapCounts>,
    pub poll_p50_ms: Option<f64>,
    pub poll_p95_ms: Option<f64>,
    /// The one application seen this minute; `None` when none was or more
    /// than one.
    pub app_name: Option<JsString>,
    /// The one typing test of this minute; `None` for none or several.
    pub typing_test: Option<String>,
    pub run_id: String,
}

/// A number as a map key: equal for the values JavaScript writes the same
/// (`-0` and `0`).
fn key_bits(n: f64) -> u64 {
    (n + 0.0).to_bits()
}

/// A matrix cell by row, column and layer (`${row},${col},${layer}`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CellKey(u64, u64, u64);

impl CellKey {
    fn of(key: &MatrixKey) -> Self {
        CellKey(key_bits(key.row), key_bits(key.col), key_bits(key.layer))
    }
}

/// An entry by scope, minute and run (`${scopeId}|${minuteTs}|${runId}`).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct EntryKey(String, u64, String);

/// Where an entry stands against what has been sent (`Entry.state`):
/// `Open` was never drained, `Retained` was drained and is unchanged since,
/// `Reopened` was drained and has had events since. An entry needs a drain
/// unless it is `Retained`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    Open,
    Retained,
    Reopened,
}

struct Entry {
    scope_id: String,
    fingerprint: Arc<Fingerprint>,
    minute_ts: f64,
    run_id: String,
    char_counts: IndexMap<String, u64>,
    matrix_counts: IndexMap<CellKey, MatrixCellCounts>,
    intervals: Vec<f64>,
    bigrams: IndexMap<String, Vec<f64>>,
    trigrams: IndexMap<String, Vec<f64>>,
    overlaps: IndexMap<String, OverlapCounts>,
    poll_gaps: Vec<f64>,
    keystrokes: u64,
    first_event_ms: f64,
    last_event_ms: f64,
    app_set: IndexSet<JsString>,
    typing_test_set: IndexSet<String>,
    state: State,
}

impl Entry {
    fn cell(&mut self, key: &MatrixKey) -> &mut MatrixCellCounts {
        self.matrix_counts.entry(CellKey::of(key)).or_insert_with(|| MatrixCellCounts {
            row: key.row,
            col: key.col,
            layer: key.layer,
            keycode: key.keycode,
            count: 0,
            tap_count: 0,
            hold_count: 0,
            durations: Vec::new(),
        })
    }

    fn fold_overlap(&mut self, pair: String, overlap: Option<bool>) {
        let Some(overlap) = overlap else { return };
        let counts = self.overlaps.entry(pair).or_default();
        counts.on += 1;
        if overlap {
            counts.oc += 1;
        }
    }

    /// `finalize`. Sorts the kept samples in place: a later straggler adds
    /// to them, and sorting a nearly sorted list again is cheap.
    fn finalize(&mut self) -> MinuteSnapshot {
        sort(&mut self.intervals);
        sort(&mut self.poll_gaps);
        let sorted = &self.intervals;
        MinuteSnapshot {
            scope_id: self.scope_id.clone(),
            fingerprint: self.fingerprint.clone(),
            minute_ts: self.minute_ts,
            keystrokes: self.keystrokes,
            active_ms: (self.last_event_ms - self.first_event_ms).max(0.0),
            interval_avg_ms: (!sorted.is_empty())
                .then(|| js_round(sorted.iter().fold(0.0, |sum, v| sum + v) / sorted.len() as f64)),
            interval_min_ms: sorted.first().copied(),
            interval_p25_ms: percentile(sorted, 0.25),
            interval_p50_ms: percentile(sorted, 0.5),
            interval_p75_ms: percentile(sorted, 0.75),
            interval_max_ms: sorted.last().copied(),
            char_counts: self.char_counts.clone(),
            matrix_counts: self.matrix_counts.clone(),
            bigrams: self.bigrams.clone(),
            trigrams: self.trigrams.clone(),
            overlaps: self.overlaps.clone(),
            poll_p50_ms: percentile(&self.poll_gaps, 0.5),
            poll_p95_ms: percentile(&self.poll_gaps, 0.95),
            app_name: single(&self.app_set),
            typing_test: single(&self.typing_test_set),
            run_id: self.run_id.clone(),
        }
    }
}

/// The set's value when it has exactly one.
fn single<T: Clone>(set: &IndexSet<T>) -> Option<T> {
    (set.len() == 1).then(|| set[0].clone())
}

/// `values.sort((a, b) => a - b)` for finite values: a stable sort.
fn sort(values: &mut [f64]) {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
}

/// `Math.round`: the nearest integer, halves toward +∞.
fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `percentile(sorted, q)`: the value at `floor((n - 1) * q)`.
fn percentile(sorted: &[f64], q: f64) -> Option<f64> {
    let last = sorted.len().checked_sub(1)?;
    let index = ((last as f64 * q).floor() as usize).min(last);
    Some(sorted[index])
}

/// What [`MinuteBuffer::peek_matrix_counts_for_uid`] sums per cell.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PeekCounts {
    pub total: u64,
    pub tap: u64,
    pub hold: u64,
}

/// The chain of the last two presses that the next press closes into a
/// bigram (`k2_curr`) and, with `k1`, a trigram.
#[derive(Default)]
struct NgramChain {
    k1_keycode: Option<f64>,
    /// The bigram's previous press and its time; `None` when the chain is
    /// empty.
    k2: Option<(f64, f64)>,
    /// The `k1 → k2` interval when it was eligible.
    prev_iki: Option<f64>,
    /// `{scopeId}|{runId}` of the stream the chain belongs to.
    key: Option<String>,
    /// The keyboard of that stream, for [`MinuteBuffer::discard_for_uid`].
    uid: Option<String>,
}

#[derive(Default)]
pub struct MinuteBuffer {
    buffers: IndexMap<EntryKey, Entry>,
    chain: NgramChain,
}

/// `minuteTs + MINUTE_MS + window <= now`: the one comparison behind both
/// the drop of an event too late for its minute and the drain's grace and
/// eviction, so a dropped event's minute is always one already evicted.
fn minute_aged_past(minute_ts: f64, window_ms: f64, now_ms: f64) -> bool {
    minute_ts + MINUTE_MS + window_ms <= now_ms
}

impl MinuteBuffer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds `event` to the entry of its scope, minute (by the
    /// event's own time) and run. `now_ms` only decides whether an event
    /// for a minute with no entry is new or too late: past [`RETENTION_MS`]
    /// it is dropped, since a fresh partial entry for a minute already sent
    /// would replace that minute's totals.
    pub fn add_event(&mut self, event: &TypingEvent, fingerprint: &Arc<Fingerprint>, now_ms: f64) {
        let scope_id = fingerprint.scope_key();
        let minute_ts = (event.ts / MINUTE_MS).floor() * MINUTE_MS;
        let key = EntryKey(scope_id.clone(), key_bits(minute_ts), event.run_id.clone());
        let entry = match self.buffers.entry(key) {
            Slot::Occupied(slot) => {
                let entry = slot.into_mut();
                if entry.state == State::Retained {
                    entry.state = State::Reopened;
                }
                entry
            }
            Slot::Vacant(slot) => {
                if minute_aged_past(minute_ts, RETENTION_MS, now_ms) {
                    return;
                }
                slot.insert(Entry {
                    scope_id: scope_id.clone(),
                    fingerprint: fingerprint.clone(),
                    minute_ts,
                    run_id: event.run_id.clone(),
                    char_counts: IndexMap::new(),
                    matrix_counts: IndexMap::new(),
                    intervals: Vec::new(),
                    bigrams: IndexMap::new(),
                    trigrams: IndexMap::new(),
                    overlaps: IndexMap::new(),
                    poll_gaps: Vec::new(),
                    keystrokes: 0,
                    first_event_ms: event.ts,
                    last_event_ms: event.ts,
                    app_set: IndexSet::new(),
                    typing_test_set: IndexSet::new(),
                    state: State::Open,
                })
            }
        };
        if let Some(test) = &event.typing_test {
            entry.typing_test_set.insert(test.clone());
        }

        match &event.kind {
            EventKind::Release { key, duration_ms } => {
                // A release only adds its duration to the cell: its press
                // was counted by its own event, possibly in another minute,
                // and it is no keystroke of the n-gram chain.
                entry.cell(key).durations.push(*duration_ms);
                return;
            }
            EventKind::Char { key } => *entry.char_counts.entry(key.clone()).or_insert(0) += 1,
            EventKind::Matrix { .. } => {}
        }

        if entry.keystrokes > 0 {
            let gap = event.ts - entry.last_event_ms;
            if gap >= 0.0 {
                entry.intervals.push(gap);
            }
        }
        // A late event counts but moves neither end of the minute's window
        // inward; its interval is not reconstructed.
        if event.ts > entry.last_event_ms {
            entry.last_event_ms = event.ts;
        }
        if event.ts < entry.first_event_ms {
            entry.first_event_ms = event.ts;
        }
        entry.keystrokes += 1;

        let EventKind::Matrix { key, action, overlap, poll_gap_ms } = &event.kind else { return };
        let (action, overlap) = (*action, *overlap);
        let cell = entry.cell(key);
        // A press is what tells the keycode mapped at the cell now.
        cell.keycode = key.keycode;
        cell.count += 1;
        match action {
            Some(TapHold::Tap) => cell.tap_count += 1,
            Some(TapHold::Hold) => cell.hold_count += 1,
            None => {}
        }
        if let Some(gap) = *poll_gap_ms {
            entry.poll_gaps.push(gap);
        }
        if action == Some(TapHold::Hold) {
            // A hold reaches for a layer or modifier; its neighbours were
            // not typed one after the other, so the chain starts over
            // rather than pairing them across it.
            self.chain = NgramChain::default();
        } else {
            let stream = format!("{scope_id}|{}", event.run_id);
            Self::record_ngram(&mut self.chain, entry, stream, key.keycode, event.ts, overlap);
        }
    }

    /// Advances the chain by one press and records the
    /// pair (and triple) it closes.
    ///
    /// The `k2 → curr` interval is eligible when `0 < iki <=`
    /// [`NGRAM_MAX_IKI_MS`]; the trigram also needs the eligible `k1 → k2`
    /// interval kept from the previous press. A press tied with or older
    /// than `k2` records no interval and leaves the chain as it is, but its
    /// overlap still counts for the pair: two presses in one polled frame
    /// are the clearest overlap there is. A slower interval still advances
    /// the chain. A press of another scope or run starts the chain over.
    fn record_ngram(
        chain: &mut NgramChain,
        entry: &mut Entry,
        stream: String,
        keycode: f64,
        ts: f64,
        overlap: Option<bool>,
    ) {
        let (k2_keycode, k2_ts) = match chain.k2 {
            Some(k2) if chain.key.as_deref() == Some(stream.as_str()) => k2,
            _ => {
                *chain = NgramChain {
                    k1_keycode: None,
                    k2: Some((keycode, ts)),
                    prev_iki: None,
                    key: Some(stream),
                    uid: Some(entry.fingerprint.keyboard.uid.clone()),
                };
                return;
            }
        };
        let pair = format!("{}_{}", js_number_string(k2_keycode), js_number_string(keycode));
        let iki = ts - k2_ts;
        if iki <= 0.0 {
            entry.fold_overlap(pair, overlap);
            return;
        }
        let eligible = iki <= NGRAM_MAX_IKI_MS;
        if eligible {
            entry.bigrams.entry(pair.clone()).or_default().push(iki);
            entry.fold_overlap(pair, overlap);
            if let (Some(k1), Some(prev_iki)) = (chain.k1_keycode, chain.prev_iki) {
                let triple = format!(
                    "{}_{}_{}",
                    js_number_string(k1),
                    js_number_string(k2_keycode),
                    js_number_string(keycode)
                );
                entry.trigrams.entry(triple).or_default().push((prev_iki + iki) / 2.0);
            }
        }
        chain.k1_keycode = Some(k2_keycode);
        chain.prev_iki = eligible.then_some(iki);
        chain.k2 = Some((keycode, ts));
    }

    /// Tags every entry never drained with the application
    /// in focus. Entries already sent keep the application of the minute
    /// they describe.
    pub fn mark_app_name(&mut self, app_name: &JsString) {
        for entry in self.buffers.values_mut().filter(|entry| entry.state == State::Open) {
            entry.app_set.insert(app_name.clone());
        }
    }

    /// Snapshots every entry needing a drain whose minute
    /// ended [`DRAIN_CLOSE_GRACE_MS`] before `now_ms`, then drops every
    /// entry whose minute ended [`RETENTION_MS`] before it (after its last
    /// chance to be sent). Snapshotted entries stay, retained.
    pub fn drain_closed(&mut self, now_ms: f64) -> Vec<MinuteSnapshot> {
        let mut closed = Vec::new();
        self.buffers.retain(|_, entry| {
            if entry.state != State::Retained
                && minute_aged_past(entry.minute_ts, DRAIN_CLOSE_GRACE_MS, now_ms)
            {
                closed.push(entry.finalize());
                entry.state = State::Retained;
            }
            !minute_aged_past(entry.minute_ts, RETENTION_MS, now_ms)
        });
        // A reopened minute closing again resets the chain once more; at
        // most one pair of the live minute is lost.
        if !closed.is_empty() {
            self.chain = NgramChain::default();
        }
        closed
    }

    /// Snapshots every entry needing a drain (the explicit
    /// flush, the end of a test, the quit). They stay, retained; only
    /// [`Self::drain_closed`] drops entries.
    pub fn drain_all(&mut self) -> Vec<MinuteSnapshot> {
        let all = self
            .buffers
            .values_mut()
            .filter(|entry| entry.state != State::Retained)
            .map(|entry| {
                entry.state = State::Retained;
                entry.finalize()
            })
            .collect();
        self.chain = NgramChain::default();
        all
    }

    /// After a flush failed to write what it drained, marks
    /// every retained entry for another drain. Reopening one the failed
    /// flush did not drain only sends it once more. An entry drained and
    /// dropped by that same flush is gone and cannot be reopened.
    pub fn reopen_all(&mut self) {
        for entry in self.buffers.values_mut().filter(|entry| entry.state == State::Retained) {
            entry.state = State::Reopened;
        }
    }

    /// Drops the entries of `uid` whose minute `drops`
    /// accepts, in any state, and starts the chain over when it is that
    /// keyboard's. A kept entry would bring deleted counts back with its
    /// next drain.
    pub fn discard_for_uid(&mut self, uid: &str, drops: impl Fn(f64) -> bool) {
        self.buffers.retain(|_, entry| !(entry.fingerprint.keyboard.uid == uid && drops(entry.minute_ts)));
        if self.chain.uid.as_deref() == Some(uid) {
            self.chain = NgramChain::default();
        }
    }

    /// Nothing needs a drain (every entry is retained).
    pub fn is_empty(&self) -> bool {
        self.buffers.values().all(|entry| entry.state == State::Retained)
    }

    /// The press counts of the never-drained
    /// entries of `uid` on this device for `layer`, summed per `row,col`,
    /// for the heatmap to add to what the cache holds. A reopened entry's
    /// counts include what was already sent, so it is left out until its
    /// next drain.
    pub fn peek_matrix_counts_for_uid(
        &self,
        uid: &str,
        machine_hash: &str,
        layer: f64,
    ) -> IndexMap<String, PeekCounts> {
        let mut result: IndexMap<String, PeekCounts> = IndexMap::new();
        let entries = self.buffers.values().filter(|entry| {
            entry.state == State::Open
                && entry.fingerprint.keyboard.uid == uid
                && entry.fingerprint.machine_hash == machine_hash
        });
        for cell in entries.flat_map(|entry| entry.matrix_counts.values()).filter(|cell| cell.layer == layer)
        {
            let key = format!("{},{}", js_number_string(cell.row), js_number_string(cell.col));
            let sum = result.entry(key).or_default();
            sum.total += cell.count;
            sum.tap += cell.tap_count;
            sum.hold += cell.hold_count;
        }
        result
    }
}

#[cfg(test)]
mod tests;
