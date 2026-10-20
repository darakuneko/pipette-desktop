// SPDX-License-Identifier: GPL-2.0-or-later

use super::*;
use crate::fingerprint::{KeyboardInfo, OsInfo};

const GRACE: f64 = DRAIN_CLOSE_GRACE_MS;

fn fingerprint(uid: &str) -> Arc<Fingerprint> {
    Arc::new(Fingerprint {
        machine_hash: "hash-abc".into(),
        os: OsInfo { platform: "linux".into(), release: "6.8.0".into(), arch: "x64".into() },
        keyboard: KeyboardInfo {
            uid: uid.into(),
            vendor_id: f64::from(0xFEED),
            product_id: 0.0,
            product_name: "Pipette".into(),
        },
    })
}

fn default_fp() -> Arc<Fingerprint> {
    fingerprint("0xAABB")
}

/// The buffer files events by the fingerprint, never by the event's own
/// keyboard, so every event carries the same placeholder keyboard.
fn event(ts: f64, kind: EventKind) -> TypingEvent {
    TypingEvent {
        ts,
        keyboard: KeyboardInfo {
            uid: "x".into(),
            vendor_id: 0.0,
            product_id: 0.0,
            product_name: String::new(),
        },
        typing_test: None,
        run_id: String::new(),
        kind,
    }
}

fn char_ev(key: &str, ts: f64) -> TypingEvent {
    event(ts, EventKind::Char { key: key.into() })
}

fn press(
    row: f64,
    col: f64,
    layer: f64,
    keycode: f64,
    ts: f64,
    (action, overlap, poll_gap_ms): (Option<TapHold>, Option<bool>, Option<f64>),
) -> TypingEvent {
    let key = MatrixKey { row, col, layer, keycode };
    event(ts, EventKind::Matrix { key, action, overlap, poll_gap_ms })
}

fn matrix_ev(row: f64, col: f64, layer: f64, keycode: f64, ts: f64) -> TypingEvent {
    press(row, col, layer, keycode, ts, (None, None, None))
}

fn hold_ev(row: f64, col: f64, keycode: f64, ts: f64) -> TypingEvent {
    press(row, col, 0.0, keycode, ts, (Some(TapHold::Hold), None, None))
}

fn overlap_ev(col: f64, keycode: f64, ts: f64, overlap: bool) -> TypingEvent {
    press(0.0, col, 0.0, keycode, ts, (None, Some(overlap), None))
}

fn release_ev(row: f64, col: f64, layer: f64, keycode: f64, ts: f64, duration_ms: f64) -> TypingEvent {
    event(ts, EventKind::Release { key: MatrixKey { row, col, layer, keycode }, duration_ms })
}

fn in_run(mut event: TypingEvent, run_id: &str) -> TypingEvent {
    event.run_id = run_id.into();
    event
}

/// Adds with `now` at the event's own time, which is always inside its
/// minute's retention, so only the tests of the late drop pass a `now`.
fn add(buffer: &mut MinuteBuffer, event: TypingEvent, fp: &Arc<Fingerprint>) {
    let now = event.ts;
    buffer.add_event(&event, fp, now);
}

fn add_at(buffer: &mut MinuteBuffer, event: TypingEvent, fp: &Arc<Fingerprint>, now: f64) {
    buffer.add_event(&event, fp, now);
}

fn by_minute(mut snapshots: Vec<MinuteSnapshot>) -> Vec<MinuteSnapshot> {
    snapshots.sort_by(|a, b| a.minute_ts.total_cmp(&b.minute_ts));
    snapshots
}

fn only(mut snapshots: Vec<MinuteSnapshot>) -> MinuteSnapshot {
    assert_eq!(snapshots.len(), 1);
    snapshots.remove(0)
}

fn pairs<V: Clone>(map: &IndexMap<String, V>) -> Vec<(&str, V)> {
    map.iter().map(|(k, v)| (k.as_str(), v.clone())).collect()
}

fn cell(snap: &MinuteSnapshot, row: f64, col: f64, layer: f64) -> Option<&MatrixCellCounts> {
    snap.matrix_counts.values().find(|c| c.row == row && c.col == col && c.layer == layer)
}

fn counts(
    (row, col, layer, keycode): (f64, f64, f64, f64),
    (count, tap_count, hold_count): (u64, u64, u64),
    durations: &[f64],
) -> MatrixCellCounts {
    MatrixCellCounts { row, col, layer, keycode, count, tap_count, hold_count, durations: durations.to_vec() }
}

fn chars(snap: &MinuteSnapshot, key: &str) -> Option<u64> {
    snap.char_counts.get(key).copied()
}

fn find(snaps: &[MinuteSnapshot], pred: impl Fn(&MinuteSnapshot) -> bool) -> &MinuteSnapshot {
    snaps.iter().find(|s| pred(s)).unwrap()
}

/// Every key of `pick` across the snapshots.
fn all_keys(snaps: &[MinuteSnapshot], pick: impl Fn(&MinuteSnapshot) -> Vec<String>) -> Vec<String> {
    snaps.iter().flat_map(pick).collect()
}

#[test]
fn starts_empty() {
    let mut buffer = MinuteBuffer::new();
    assert!(buffer.is_empty());
    assert!(buffer.drain_all().is_empty());
}

#[test]
fn groups_events_into_minute_buckets() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, char_ev("a", 1_000.0), &fp);
    add(&mut b, char_ev("b", 30_000.0), &fp);
    add(&mut b, char_ev("a", MINUTE_MS + 5_000.0), &fp);

    let snaps = by_minute(b.drain_all());
    assert_eq!(snaps.len(), 2);
    assert_eq!((snaps[0].minute_ts, snaps[0].keystrokes), (0.0, 2));
    assert_eq!((chars(&snaps[0], "a"), chars(&snaps[0], "b")), (Some(1), Some(1)));
    assert_eq!((snaps[1].minute_ts, snaps[1].keystrokes), (MINUTE_MS, 1));
}

#[test]
fn splits_one_minute_into_buckets_per_run_id() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, in_run(char_ev("a", 1_000.0), "run-1"), &fp);
    add(&mut b, in_run(char_ev("a", 2_000.0), "run-1"), &fp);
    add(&mut b, in_run(char_ev("b", 3_000.0), "run-2"), &fp);
    // Input outside a run is its own '' bucket.
    add(&mut b, char_ev("c", 4_000.0), &fp);

    let mut snaps = b.drain_all();
    snaps.sort_by(|a, b| a.run_id.cmp(&b.run_id));
    assert_eq!(snaps.iter().map(|s| s.run_id.as_str()).collect::<Vec<_>>(), ["", "run-1", "run-2"]);
    assert!(snaps.iter().all(|s| s.minute_ts == 0.0));
    let run1 = find(&snaps, |s| s.run_id == "run-1");
    assert_eq!((run1.keystrokes, chars(run1, "a")), (2, Some(2)));
    assert_eq!(find(&snaps, |s| s.run_id == "run-2").keystrokes, 1);
    assert_eq!(chars(find(&snaps, |s| s.run_id.is_empty()), "c"), Some(1));
}

#[test]
fn accumulates_char_counts_within_a_minute() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    for (key, ts) in [("a", 1_000.0), ("a", 2_000.0), ("b", 3_000.0)] {
        add(&mut b, char_ev(key, ts), &fp);
    }
    let snap = only(b.drain_all());
    assert_eq!((chars(&snap, "a"), chars(&snap, "b")), (Some(2), Some(1)));
}

#[test]
fn accumulates_matrix_counts_by_position_with_the_latest_keycode() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 3.0, 0.0, 4.0, 1_000.0), &fp);
    add(&mut b, matrix_ev(0.0, 3.0, 0.0, 4.0, 2_000.0), &fp);
    add(&mut b, matrix_ev(2.0, 1.0, 1.0, 16405.0, 3_000.0), &fp);

    let snap = only(b.drain_all());
    assert_eq!(snap.matrix_counts.len(), 2);
    assert_eq!(cell(&snap, 0.0, 3.0, 0.0), Some(&counts((0.0, 3.0, 0.0, 4.0), (2, 0, 0), &[])));
    assert_eq!(cell(&snap, 2.0, 1.0, 1.0), Some(&counts((2.0, 1.0, 1.0, 16405.0), (1, 0, 0), &[])));
}

#[test]
fn computes_interval_stats_from_event_timing() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    // Intervals 100, 200, 300, 400.
    for ts in [1_000.0, 1_100.0, 1_300.0, 1_600.0, 2_000.0] {
        add(&mut b, char_ev("a", ts), &fp);
    }
    let snap = only(b.drain_all());
    assert_eq!(snap.keystrokes, 5);
    assert_eq!(
        (snap.interval_min_ms, snap.interval_max_ms, snap.interval_avg_ms),
        (Some(100.0), Some(400.0), Some(250.0))
    );
    // Index floor(3 * q) of the sorted intervals.
    assert_eq!(
        (snap.interval_p25_ms, snap.interval_p50_ms, snap.interval_p75_ms),
        (Some(100.0), Some(200.0), Some(300.0))
    );
    assert_eq!(snap.active_ms, 1_000.0);
}

#[test]
fn keeps_separate_buckets_per_scope_within_a_minute() {
    let (mut b, fp1, fp2) = (MinuteBuffer::new(), fingerprint("0xAAAA"), fingerprint("0xBBBB"));
    add(&mut b, char_ev("a", 1_000.0), &fp1);
    add(&mut b, char_ev("a", 2_000.0), &fp2);

    let snaps = b.drain_all();
    assert_eq!(snaps.len(), 2);
    let mut scopes: Vec<_> = snaps.iter().map(|s| s.scope_id.clone()).collect();
    scopes.sort();
    let mut expected = vec![fp1.scope_key(), fp2.scope_key()];
    expected.sort();
    assert_eq!(scopes, expected);
}

#[test]
fn drain_closed_returns_only_minutes_past_the_grace() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    for minute in 0..3 {
        add(&mut b, char_ev("a", f64::from(minute) * MINUTE_MS + 1_000.0), &fp);
    }
    // Minutes 0 and 1 ended well over the grace ago; minute 2 just ended.
    let closed = by_minute(b.drain_closed(3.0 * MINUTE_MS));
    assert_eq!(closed.iter().map(|s| s.minute_ts).collect::<Vec<_>>(), [0.0, MINUTE_MS]);
    assert!(!b.is_empty());

    let remaining = only(b.drain_all());
    assert_eq!(remaining.minute_ts, 2.0 * MINUTE_MS);
}

#[test]
fn a_late_event_with_an_earlier_ts_keeps_active_ms() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    for ts in [1_000.0, 1_200.0, 1_100.0] {
        add(&mut b, char_ev("a", ts), &fp);
    }
    let snap = only(b.drain_all());
    assert_eq!((snap.keystrokes, snap.active_ms), (3, 200.0));
}

#[test]
fn a_late_event_before_the_first_extends_the_window_back() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    for ts in [1_500.0, 2_000.0, 500.0] {
        add(&mut b, char_ev("a", ts), &fp);
    }
    let snap = only(b.drain_all());
    assert_eq!((snap.keystrokes, snap.active_ms), (3, 1_500.0));
}

#[test]
fn a_single_event_minute_has_no_interval_stats() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, char_ev("a", 1_000.0), &fp);
    let snap = only(b.drain_all());
    assert_eq!((snap.keystrokes, snap.active_ms), (1, 0.0));
    assert_eq!(snap.interval_avg_ms, None);
    assert_eq!(snap.interval_min_ms, None);
    assert_eq!(snap.interval_p50_ms, None);
    assert_eq!(snap.interval_max_ms, None);
}

/// Adds layer-0 presses on row 0, column by order, as `(keycode, ts)`.
fn presses(b: &mut MinuteBuffer, fp: &Arc<Fingerprint>, keys: &[(f64, f64)]) {
    for (col, &(keycode, ts)) in keys.iter().enumerate() {
        add(b, matrix_ev(0.0, col as f64, 0.0, keycode, ts), fp);
    }
}

/// The bigrams and trigrams of the single drained snapshot of `keys`.
fn ngrams_of(keys: &[(f64, f64)]) -> MinuteSnapshot {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    presses(&mut b, &fp, keys);
    only(b.drain_all())
}

#[test]
fn bigrams_record_pair_intervals_of_consecutive_presses() {
    let snap = ngrams_of(&[(4.0, 1_000.0), (11.0, 1_120.0), (7.0, 1_300.0)]);
    assert_eq!(pairs(&snap.bigrams), [("4_11", vec![120.0]), ("11_7", vec![180.0])]);
}

#[test]
fn bigrams_skip_char_events_without_resetting_the_chain() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_000.0), &fp);
    add(&mut b, char_ev("a", 1_050.0), &fp);
    add(&mut b, matrix_ev(0.0, 1.0, 0.0, 11.0, 1_200.0), &fp);
    assert_eq!(pairs(&only(b.drain_all()).bigrams), [("4_11", vec![200.0])]);
}

#[test]
fn bigrams_drop_pairs_slower_than_the_cap() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    presses(&mut b, &fp, &[(4.0, 1_000.0), (11.0, 1_000.0 + 6.0 * MINUTE_MS)]);
    let snaps = b.drain_all();
    assert_eq!(snaps.len(), 2);
    assert!(snaps.iter().all(|s| s.bigrams.is_empty()));
}

#[test]
fn bigrams_keep_a_pair_exactly_at_the_cap() {
    let snap = ngrams_of(&[(4.0, 1_000.0), (11.0, 1_000.0 + NGRAM_MAX_IKI_MS)]);
    assert_eq!(pairs(&snap.bigrams), [("4_11", vec![NGRAM_MAX_IKI_MS])]);
}

#[test]
fn bigrams_drop_a_pair_one_ms_past_the_cap() {
    let snap = ngrams_of(&[(4.0, 1_000.0), (11.0, 1_000.0 + NGRAM_MAX_IKI_MS + 1.0)]);
    assert!(snap.bigrams.is_empty());
}

#[test]
fn an_over_cap_gap_still_advances_the_chain() {
    let snap = ngrams_of(&[(4.0, 0.0), (2.0, NGRAM_MAX_IKI_MS + 3_000.0), (3.0, NGRAM_MAX_IKI_MS + 3_100.0)]);
    assert_eq!(pairs(&snap.bigrams), [("2_3", vec![100.0])]);
}

#[test]
fn drain_closed_drops_the_cross_minute_pair() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 30_000.0), &fp);
    let closed = only(b.drain_closed(MINUTE_MS + GRACE));
    assert!(closed.bigrams.is_empty());

    add(&mut b, matrix_ev(0.0, 1.0, 0.0, 11.0, 90_000.0), &fp);
    add(&mut b, matrix_ev(0.0, 2.0, 0.0, 7.0, 90_150.0), &fp);
    assert_eq!(pairs(&only(b.drain_all()).bigrams), [("11_7", vec![150.0])]);
}

#[test]
fn a_cross_minute_pair_lands_in_the_later_minute_without_a_drain() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    presses(&mut b, &fp, &[(4.0, 58_000.0), (11.0, 61_000.0)]);
    let snaps = b.drain_all();
    assert!(find(&snaps, |s| s.minute_ts == 0.0).bigrams.is_empty());
    assert_eq!(pairs(&find(&snaps, |s| s.minute_ts == 60_000.0).bigrams), [("4_11", vec![3_000.0])]);
}

#[test]
fn bigrams_do_not_advance_the_chain_on_a_tie() {
    let snap = ngrams_of(&[(4.0, 1_000.0), (11.0, 1_000.0), (7.0, 1_150.0)]);
    assert_eq!(pairs(&snap.bigrams), [("4_7", vec![150.0])]);
}

#[test]
fn drain_all_clears_the_bigram_chain() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_000.0), &fp);
    b.drain_all();
    add(&mut b, matrix_ev(0.0, 1.0, 0.0, 11.0, 1_500.0), &fp);
    add(&mut b, matrix_ev(0.0, 2.0, 0.0, 7.0, 1_650.0), &fp);
    assert_eq!(pairs(&only(b.drain_all()).bigrams), [("11_7", vec![150.0])]);
}

#[test]
fn a_trigram_is_the_mean_of_its_two_intervals() {
    let snap = ngrams_of(&[(4.0, 1_000.0), (11.0, 1_120.0), (7.0, 1_300.0)]);
    assert_eq!(pairs(&snap.trigrams), [("4_11_7", vec![150.0])]);
}

#[test]
fn trigrams_form_a_rolling_window() {
    let snap = ngrams_of(&[(4.0, 1_000.0), (11.0, 1_100.0), (7.0, 1_250.0), (5.0, 1_450.0)]);
    assert_eq!(pairs(&snap.trigrams), [("4_11_7", vec![125.0]), ("11_7_5", vec![175.0])]);
}

#[test]
fn trigrams_skip_char_events() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_000.0), &fp);
    add(&mut b, char_ev("a", 1_050.0), &fp);
    add(&mut b, matrix_ev(0.0, 1.0, 0.0, 11.0, 1_100.0), &fp);
    add(&mut b, char_ev("b", 1_150.0), &fp);
    add(&mut b, matrix_ev(0.0, 2.0, 0.0, 7.0, 1_300.0), &fp);
    assert_eq!(pairs(&only(b.drain_all()).trigrams), [("4_11_7", vec![150.0])]);
}

fn trigram_keys(keys: &[(f64, f64)]) -> Vec<String> {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    presses(&mut b, &fp, keys);
    all_keys(&b.drain_all(), |s| s.trigrams.keys().cloned().collect())
}

#[test]
fn no_trigram_when_the_trailing_interval_is_over_the_cap() {
    let far = 1_100.0 + 6.0 * MINUTE_MS;
    assert!(trigram_keys(&[(4.0, 1_000.0), (11.0, 1_100.0), (7.0, far), (5.0, far + 120.0)]).is_empty());
}

#[test]
fn no_trigram_when_only_the_leading_interval_is_over_the_cap() {
    let far = 1_000.0 + 6.0 * MINUTE_MS;
    assert!(trigram_keys(&[(4.0, 1_000.0), (11.0, far), (7.0, far + 100.0)]).is_empty());
}

#[test]
fn trigrams_need_two_in_range_intervals_after_an_over_cap_gap() {
    let c = 100.0 + NGRAM_MAX_IKI_MS + 3_000.0;
    let snap = ngrams_of(&[(1.0, 0.0), (2.0, 100.0), (3.0, c), (4.0, c + 100.0), (5.0, c + 200.0)]);
    assert_eq!(pairs(&snap.bigrams), [("1_2", vec![100.0]), ("3_4", vec![100.0]), ("4_5", vec![100.0])]);
    assert_eq!(pairs(&snap.trigrams), [("3_4_5", vec![100.0])]);
}

#[test]
fn trigrams_do_not_advance_the_chain_on_a_tie() {
    let snap = ngrams_of(&[(4.0, 1_000.0), (11.0, 1_100.0), (99.0, 1_100.0), (7.0, 1_250.0)]);
    assert_eq!(pairs(&snap.trigrams), [("4_11_7", vec![125.0])]);
}

#[test]
fn drain_closed_drops_the_cross_minute_trigram() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    presses(&mut b, &fp, &[(4.0, 20_000.0), (11.0, 40_000.0)]);
    let closed = only(b.drain_closed(MINUTE_MS + GRACE));
    assert!(closed.trigrams.is_empty());

    presses(&mut b, &fp, &[(7.0, 90_000.0), (5.0, 90_150.0), (6.0, 90_300.0)]);
    assert_eq!(pairs(&only(b.drain_all()).trigrams), [("7_5_6", vec![150.0])]);
}

#[test]
fn drain_all_clears_the_trigram_chain() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    presses(&mut b, &fp, &[(4.0, 1_000.0), (11.0, 1_100.0)]);
    b.drain_all();
    presses(&mut b, &fp, &[(7.0, 1_500.0), (5.0, 1_650.0), (6.0, 1_800.0)]);
    assert_eq!(pairs(&only(b.drain_all()).trigrams), [("7_5_6", vec![150.0])]);
}

#[test]
fn interleaved_scopes_never_pair() {
    let (mut b, fp_a, fp_b) = (MinuteBuffer::new(), fingerprint("0xAAAA"), fingerprint("0xBBBB"));
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_000.0), &fp_a);
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 20.0, 1_050.0), &fp_b);
    add(&mut b, matrix_ev(0.0, 1.0, 0.0, 11.0, 1_100.0), &fp_a);
    add(&mut b, matrix_ev(0.0, 1.0, 0.0, 21.0, 1_150.0), &fp_b);
    add(&mut b, matrix_ev(0.0, 2.0, 0.0, 7.0, 1_200.0), &fp_a);

    let snaps = b.drain_all();
    assert_eq!(snaps.len(), 2);
    assert!(snaps.iter().all(|s| s.bigrams.is_empty() && s.trigrams.is_empty()));
}

#[test]
fn same_scope_presses_pair_again_after_a_foreign_press() {
    let (mut b, fp_a, fp_b) = (MinuteBuffer::new(), fingerprint("0xAAAA"), fingerprint("0xBBBB"));
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_000.0), &fp_a);
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 20.0, 1_050.0), &fp_b);
    add(&mut b, matrix_ev(0.0, 1.0, 0.0, 11.0, 1_100.0), &fp_a);
    add(&mut b, matrix_ev(0.0, 2.0, 0.0, 7.0, 1_250.0), &fp_a);

    let snaps = b.drain_all();
    let snap_a = find(&snaps, |s| s.scope_id == fp_a.scope_key());
    let snap_b = find(&snaps, |s| s.scope_id == fp_b.scope_key());
    assert_eq!(pairs(&snap_a.bigrams), [("11_7", vec![150.0])]);
    assert!(snap_a.trigrams.is_empty());
    assert!(snap_b.bigrams.is_empty() && snap_b.trigrams.is_empty());
}

#[test]
fn a_run_id_change_resets_the_chain() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_000.0), &fp);
    add(&mut b, in_run(matrix_ev(0.0, 1.0, 0.0, 11.0, 1_100.0), "run-1"), &fp);
    add(&mut b, in_run(matrix_ev(0.0, 2.0, 0.0, 7.0, 1_250.0), "run-1"), &fp);

    let snaps = b.drain_all();
    assert!(find(&snaps, |s| s.run_id.is_empty()).bigrams.is_empty());
    let run = find(&snaps, |s| s.run_id == "run-1");
    assert_eq!(pairs(&run.bigrams), [("11_7", vec![150.0])]);
    assert!(run.trigrams.is_empty());
}

#[test]
fn an_uninterrupted_run_records_pairs_and_triples() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    for (col, keycode, ts) in [(0.0, 4.0, 1_000.0), (1.0, 11.0, 1_100.0), (2.0, 7.0, 1_250.0)] {
        add(&mut b, in_run(matrix_ev(0.0, col, 0.0, keycode, ts), "run-1"), &fp);
    }
    let snap = only(b.drain_all());
    assert_eq!(pairs(&snap.bigrams), [("4_11", vec![100.0]), ("11_7", vec![150.0])]);
    assert_eq!(pairs(&snap.trigrams), [("4_11_7", vec![125.0])]);
}

#[test]
fn a_hold_does_not_pair_with_the_press_before_it() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_000.0), &fp);
    add(&mut b, hold_ev(1.0, 0.0, 16405.0, 1_100.0), &fp);
    assert!(only(b.drain_all()).bigrams.is_empty());
}

#[test]
fn a_hold_does_not_pair_with_the_press_after_it() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, hold_ev(1.0, 0.0, 16405.0, 1_000.0), &fp);
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_100.0), &fp);
    assert!(only(b.drain_all()).bigrams.is_empty());
}

#[test]
fn a_hold_does_not_join_its_neighbours_into_a_pair() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_000.0), &fp);
    add(&mut b, hold_ev(1.0, 0.0, 16405.0, 1_120.0), &fp);
    add(&mut b, matrix_ev(0.0, 1.0, 0.0, 7.0, 1_300.0), &fp);
    let snap = only(b.drain_all());
    assert!(snap.bigrams.is_empty());
    assert!(!snap.bigrams.contains_key("4_7"));
}

#[test]
fn a_tap_joins_the_chain_like_an_unmarked_press() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, press(0.0, 0.0, 0.0, 4.0, 1_000.0, (Some(TapHold::Tap), None, None)), &fp);
    add(&mut b, press(0.0, 1.0, 0.0, 11.0, 1_120.0, (Some(TapHold::Tap), None, None)), &fp);
    assert_eq!(pairs(&only(b.drain_all()).bigrams), [("4_11", vec![120.0])]);
}

#[test]
fn a_hold_counts_as_a_keystroke_and_a_hold() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, hold_ev(1.0, 0.0, 16405.0, 1_000.0), &fp);
    let snap = only(b.drain_all());
    assert_eq!(snap.keystrokes, 1);
    assert_eq!(cell(&snap, 1.0, 0.0, 0.0), Some(&counts((1.0, 0.0, 0.0, 16405.0), (1, 0, 1), &[])));
}

#[test]
fn no_trigram_spans_a_hold() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_000.0), &fp);
    add(&mut b, matrix_ev(0.0, 1.0, 0.0, 11.0, 1_100.0), &fp);
    add(&mut b, hold_ev(1.0, 0.0, 16405.0, 1_200.0), &fp);
    add(&mut b, matrix_ev(0.0, 2.0, 0.0, 7.0, 1_300.0), &fp);
    let snap = only(b.drain_all());
    assert_eq!(pairs(&snap.bigrams), [("4_11", vec![100.0])]);
    assert!(snap.trigrams.is_empty());
}

#[test]
fn a_release_adds_only_its_duration() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_000.0), &fp);
    add(&mut b, release_ev(0.0, 0.0, 0.0, 4.0, 1_120.0, 120.0), &fp);
    let snap = only(b.drain_all());
    assert_eq!((snap.keystrokes, snap.active_ms, snap.interval_min_ms), (1, 0.0, None));
    assert_eq!(cell(&snap, 0.0, 0.0, 0.0), Some(&counts((0.0, 0.0, 0.0, 4.0), (1, 0, 0), &[120.0])));
}

#[test]
fn releases_accumulate_durations_per_cell() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_000.0), &fp);
    add(&mut b, release_ev(0.0, 0.0, 0.0, 4.0, 1_100.0, 100.0), &fp);
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_200.0), &fp);
    add(&mut b, release_ev(0.0, 0.0, 0.0, 4.0, 1_290.0, 90.0), &fp);
    let snap = only(b.drain_all());
    let c = cell(&snap, 0.0, 0.0, 0.0).unwrap();
    assert_eq!((c.durations.as_slice(), c.count), ([100.0, 90.0].as_slice(), 2));
}

#[test]
fn a_release_in_a_later_minute_puts_its_duration_there() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, MINUTE_MS - 100.0), &fp);
    add(&mut b, release_ev(0.0, 0.0, 0.0, 4.0, MINUTE_MS + 100.0, 200.0), &fp);

    let snaps = by_minute(b.drain_all());
    assert_eq!(snaps.len(), 2);
    let first = cell(&snaps[0], 0.0, 0.0, 0.0).unwrap();
    assert_eq!((first.count, first.durations.as_slice()), (1, [].as_slice()));
    // The release minute holds a duration-only cell.
    let second = cell(&snaps[1], 0.0, 0.0, 0.0).unwrap();
    assert_eq!((second.count, second.durations.as_slice()), (0, [200.0].as_slice()));
    assert_eq!(snaps[1].keystrokes, 0);
}

#[test]
fn a_release_without_its_press_makes_only_a_duration_cell() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, release_ev(0.0, 0.0, 0.0, 4.0, 1_000.0, 50.0), &fp);
    let snap = only(b.drain_all());
    assert_eq!(snap.keystrokes, 0);
    assert_eq!(cell(&snap, 0.0, 0.0, 0.0), Some(&counts((0.0, 0.0, 0.0, 4.0), (0, 0, 0), &[50.0])));
}

#[test]
fn a_late_release_reopens_a_drained_minute() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_000.0), &fp);
    let first = only(b.drain_closed(1_000.0 + MINUTE_MS + GRACE));
    assert!(cell(&first, 0.0, 0.0, 0.0).unwrap().durations.is_empty());
    assert!(b.is_empty());

    let now = 1_000.0 + MINUTE_MS + GRACE + 10.0;
    add_at(&mut b, release_ev(0.0, 0.0, 0.0, 4.0, 1_050.0, 50.0), &fp, now);
    assert!(!b.is_empty());

    // The re-drain is the whole minute, press count included.
    let second = only(b.drain_all());
    assert_eq!(cell(&second, 0.0, 0.0, 0.0), Some(&counts((0.0, 0.0, 0.0, 4.0), (1, 0, 0), &[50.0])));
}

/// The overlaps of a press of keycode 4 at 1000 followed by `next`.
fn overlaps_after(next: TypingEvent) -> MinuteSnapshot {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_000.0), &fp);
    add(&mut b, next, &fp);
    only(b.drain_all())
}

#[test]
fn overlap_true_counts_on_and_oc() {
    let snap = overlaps_after(overlap_ev(1.0, 11.0, 1_050.0, true));
    assert_eq!(snap.overlaps.get("4_11"), Some(&OverlapCounts { oc: 1, on: 1 }));
}

#[test]
fn overlap_false_counts_on_only() {
    let snap = overlaps_after(overlap_ev(1.0, 11.0, 1_050.0, false));
    assert_eq!(snap.overlaps.get("4_11"), Some(&OverlapCounts { oc: 0, on: 1 }));
}

#[test]
fn an_unknown_overlap_counts_in_neither() {
    let snap = overlaps_after(matrix_ev(0.0, 1.0, 0.0, 11.0, 1_050.0));
    assert!(!snap.overlaps.contains_key("4_11"));
    assert_eq!(snap.bigrams.get("4_11"), Some(&vec![50.0]));
}

#[test]
fn overlap_accumulates_over_a_three_key_chord() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_000.0), &fp);
    add(&mut b, overlap_ev(1.0, 11.0, 1_010.0, true), &fp);
    add(&mut b, overlap_ev(2.0, 7.0, 1_020.0, true), &fp);
    let snap = only(b.drain_all());
    assert_eq!(snap.overlaps.get("4_11"), Some(&OverlapCounts { oc: 1, on: 1 }));
    assert_eq!(snap.overlaps.get("11_7"), Some(&OverlapCounts { oc: 1, on: 1 }));
}

#[test]
fn no_overlap_for_a_pair_over_the_cap() {
    let snap = overlaps_after(overlap_ev(1.0, 11.0, 1_000.0 + NGRAM_MAX_IKI_MS + 1.0, true));
    assert!(snap.overlaps.is_empty());
}

#[test]
fn a_tie_folds_its_overlap_without_an_interval() {
    for (overlap, expected) in [
        (Some(true), Some(OverlapCounts { oc: 1, on: 1 })),
        (Some(false), Some(OverlapCounts { oc: 0, on: 1 })),
        (None, None),
    ] {
        let snap = overlaps_after(press(0.0, 1.0, 0.0, 11.0, 1_000.0, (None, overlap, None)));
        assert_eq!(snap.overlaps.get("4_11").copied(), expected, "{overlap:?}");
        assert!(!snap.bigrams.contains_key("4_11"), "{overlap:?}");
    }
}

#[test]
fn a_tie_with_an_overlap_leaves_the_chain_on_the_earlier_press() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_000.0), &fp);
    add(&mut b, overlap_ev(1.0, 11.0, 1_000.0, true), &fp);
    add(&mut b, matrix_ev(0.0, 2.0, 0.0, 7.0, 1_050.0), &fp);
    let snap = only(b.drain_all());
    assert!(snap.bigrams.contains_key("4_7"));
    assert!(!snap.bigrams.contains_key("11_7"));
}

#[test]
fn poll_percentiles_are_none_without_samples() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_000.0), &fp);
    let snap = only(b.drain_all());
    assert_eq!((snap.poll_p50_ms, snap.poll_p95_ms), (None, None));
}

#[test]
fn poll_percentiles_come_from_the_samples() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    for (i, gap) in [10.0, 20.0, 30.0, 40.0, 50.0].into_iter().enumerate() {
        let i = i as f64;
        add(&mut b, press(0.0, i, 0.0, 4.0 + i, 1_000.0 + i * 10.0, (None, None, Some(gap))), &fp);
    }
    let snap = only(b.drain_all());
    assert_eq!((snap.poll_p50_ms, snap.poll_p95_ms), (Some(30.0), Some(40.0)));
}

#[test]
fn drain_closed_keeps_a_minute_inside_the_grace() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, char_ev("a", 30_000.0), &fp);
    assert!(b.drain_closed(MINUTE_MS + 500.0).is_empty());
    assert!(!b.is_empty());
}

#[test]
fn drain_closed_sends_a_minute_past_the_grace() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, char_ev("a", 30_000.0), &fp);
    assert_eq!(only(b.drain_closed(MINUTE_MS + GRACE + 1.0)).minute_ts, 0.0);
    assert!(b.is_empty());
}

#[test]
fn the_grace_exceeds_the_longest_tap_hold_defer() {
    const { assert!(DRAIN_CLOSE_GRACE_MS > MAX_TAP_HOLD_DEFER_MS) };
}

#[test]
fn a_snapshot_without_presses_has_empty_ngram_maps() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, char_ev("a", 1_000.0), &fp);
    let snap = only(b.drain_all());
    assert!(snap.bigrams.is_empty() && snap.trigrams.is_empty());
}

/// The app names of the drained minute 0 after tagging it with `names`.
fn app_after(names: &[&str]) -> Option<JsString> {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, char_ev("a", 1_000.0), &fp);
    for name in names {
        b.mark_app_name(&JsString::from(*name));
    }
    only(b.drain_all()).app_name
}

#[test]
fn app_name_is_none_when_never_marked() {
    assert_eq!(app_after(&[]), None);
}

#[test]
fn app_name_is_the_single_app_marked() {
    assert_eq!(app_after(&["VSCode"]), Some("VSCode".into()));
}

#[test]
fn app_name_is_none_for_several_apps() {
    assert_eq!(app_after(&["VSCode", "Slack"]), None);
}

#[test]
fn the_same_app_marked_twice_is_one_app() {
    assert_eq!(app_after(&["VSCode", "VSCode"]), Some("VSCode".into()));
}

/// `mark_app_name` takes only a name, so an absent application is simply
/// no call, and leaves the one app seen.
#[test]
fn no_app_observed_keeps_the_single_app() {
    assert_eq!(app_after(&["VSCode"]), Some("VSCode".into()));
}

#[test]
fn mark_app_name_tags_every_scope() {
    let (mut b, fp_a, fp_b) = (MinuteBuffer::new(), fingerprint("0xAAAA"), fingerprint("0xBBBB"));
    add(&mut b, char_ev("a", 1_000.0), &fp_a);
    add(&mut b, char_ev("b", 1_000.0), &fp_b);
    b.mark_app_name(&"VSCode".into());
    let snaps = b.drain_all();
    assert_eq!(snaps.len(), 2);
    assert!(snaps.iter().all(|s| s.app_name == Some("VSCode".into())));
}

#[test]
fn app_tags_do_not_reach_a_minute_after_a_drain() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, char_ev("a", 1_000.0), &fp);
    b.mark_app_name(&"VSCode".into());
    b.drain_all();
    add(&mut b, char_ev("b", MINUTE_MS + 500.0), &fp);
    b.mark_app_name(&"Slack".into());
    assert_eq!(only(b.drain_all()).app_name, Some("Slack".into()));
}

#[test]
fn drain_closed_sends_the_app_of_closed_minutes_and_keeps_tagging_open_ones() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 500.0), &fp);
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, MINUTE_MS + 500.0), &fp);
    b.mark_app_name(&"VSCode".into());
    assert_eq!(only(b.drain_closed(MINUTE_MS + GRACE)).app_name, Some("VSCode".into()));
    b.mark_app_name(&"Slack".into());
    assert_eq!(only(b.drain_all()).app_name, None);
}

#[test]
fn a_straggler_after_drain_closed_resends_the_whole_minute() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, char_ev("a", 30_000.0), &fp);
    assert_eq!(only(b.drain_closed(MINUTE_MS + GRACE)).keystrokes, 1);

    let late = MINUTE_MS + GRACE + 500.0;
    add_at(&mut b, char_ev("a", 30_500.0), &fp, late);
    let second = only(b.drain_closed(late + GRACE + 1.0));
    assert_eq!((second.minute_ts, second.keystrokes, chars(&second, "a")), (0.0, 2, Some(2)));
}

#[test]
fn an_unchanged_drained_minute_is_not_sent_again() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, char_ev("a", 30_000.0), &fp);
    assert_eq!(b.drain_closed(MINUTE_MS + GRACE).len(), 1);
    assert!(b.drain_closed(MINUTE_MS + GRACE + 10_000.0).is_empty());
}

#[test]
fn an_event_past_retention_is_dropped() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, char_ev("a", 30_000.0), &fp);
    let now = MINUTE_MS + RETENTION_MS + 1.0;
    assert_eq!(b.drain_closed(now).len(), 1);
    assert!(b.is_empty());

    add_at(&mut b, char_ev("a", 30_100.0), &fp, now + 100.0);
    assert!(b.is_empty());
    assert!(b.drain_all().is_empty());
}

#[test]
fn only_retained_entries_count_as_empty() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, char_ev("a", 30_000.0), &fp);
    assert_eq!(b.drain_closed(MINUTE_MS + GRACE).len(), 1);
    assert!(b.is_empty());
}

#[test]
fn peek_leaves_out_a_drained_minute_even_when_reopened() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, matrix_ev(1.0, 2.0, 0.0, 4.0, 30_000.0), &fp);
    assert_eq!(b.peek_matrix_counts_for_uid("0xAABB", "hash-abc", 0.0).get("1,2").map(|c| c.total), Some(1));

    assert_eq!(b.drain_closed(MINUTE_MS + GRACE).len(), 1);
    assert!(b.peek_matrix_counts_for_uid("0xAABB", "hash-abc", 0.0).is_empty());

    add_at(&mut b, matrix_ev(1.0, 2.0, 0.0, 4.0, 30_100.0), &fp, MINUTE_MS + GRACE + 500.0);
    assert!(b.peek_matrix_counts_for_uid("0xAABB", "hash-abc", 0.0).is_empty());
}

#[test]
fn a_straggler_after_drain_all_is_sent_with_the_whole_minute() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, char_ev("a", 1_000.0), &fp);
    assert_eq!(only(b.drain_all()).keystrokes, 1);

    add_at(&mut b, char_ev("a", 1_500.0), &fp, 2_000.0);
    assert!(!b.is_empty());
    let closed = only(b.drain_closed(MINUTE_MS + GRACE + 1.0));
    assert_eq!((closed.minute_ts, closed.keystrokes, chars(&closed, "a")), (0.0, 2, Some(2)));
}

#[test]
fn reopen_all_resends_the_whole_minute() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, char_ev("a", 30_000.0), &fp);
    assert_eq!(b.drain_closed(MINUTE_MS + GRACE).len(), 1);
    assert!(b.is_empty());

    b.reopen_all();
    assert!(!b.is_empty());
    let resent = only(b.drain_closed(MINUTE_MS + GRACE + 1.0));
    assert_eq!((resent.minute_ts, resent.keystrokes, chars(&resent, "a")), (0.0, 1, Some(1)));
}

#[test]
fn reopen_all_and_a_straggler_resend_the_true_total() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, char_ev("a", 30_000.0), &fp);
    b.drain_closed(MINUTE_MS + GRACE);
    b.reopen_all();
    let late = MINUTE_MS + GRACE + 500.0;
    add_at(&mut b, char_ev("a", 30_100.0), &fp, late);

    let resent = only(b.drain_closed(late + GRACE));
    assert_eq!((resent.keystrokes, chars(&resent, "a")), (2, Some(2)));
}

#[test]
fn reopen_all_leaves_an_open_minute_alone() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, char_ev("a", 30_000.0), &fp);
    b.reopen_all();
    assert!(b.drain_closed(30_000.0).is_empty());
    assert_eq!(only(b.drain_closed(MINUTE_MS + GRACE)).keystrokes, 1);
}

#[test]
fn retention_exceeds_the_grace() {
    const { assert!(RETENTION_MS > DRAIN_CLOSE_GRACE_MS) };
}

#[test]
fn discard_drops_every_entry_of_the_uid_and_keeps_others() {
    let (mut b, fp_a, fp_b) = (MinuteBuffer::new(), fingerprint("0xAAAA"), fingerprint("0xBBBB"));
    add(&mut b, char_ev("a", 1_000.0), &fp_a);
    b.drain_all(); // retained
    add(&mut b, char_ev("b", 1_100.0), &fp_a); // reopened
    add(&mut b, char_ev("c", MINUTE_MS + 1_000.0), &fp_a); // open
    add(&mut b, char_ev("x", 1_200.0), &fp_b);

    b.discard_for_uid("0xAAAA", |_| true);

    let scopes: Vec<_> = b.drain_all().into_iter().map(|s| s.scope_id).collect();
    assert_eq!(scopes, [fp_b.scope_key()]);
    // A later event of the discarded uid starts a new entry of its own.
    add(&mut b, char_ev("d", 1_300.0), &fp_a);
    assert_eq!(b.drain_all().iter().map(|s| s.keystrokes).collect::<Vec<_>>(), [1]);
}

#[test]
fn discard_drops_only_the_minutes_accepted() {
    let (mut b, fp) = (MinuteBuffer::new(), default_fp());
    add(&mut b, char_ev("a", 1_000.0), &fp);
    add(&mut b, char_ev("b", MINUTE_MS + 1_000.0), &fp);
    b.discard_for_uid("0xAABB", |minute_ts| minute_ts == MINUTE_MS);
    assert_eq!(b.drain_all().iter().map(|s| s.minute_ts).collect::<Vec<_>>(), [0.0]);
}

#[test]
fn discard_restarts_only_the_chain_of_its_uid() {
    let (mut b, fp_a, fp_b) = (MinuteBuffer::new(), fingerprint("0xAAAA"), fingerprint("0xBBBB"));
    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 1_000.0), &fp_a);
    b.discard_for_uid("0xAAAA", |_| true);
    add(&mut b, matrix_ev(0.0, 1.0, 0.0, 11.0, 1_100.0), &fp_a);
    assert!(b.drain_all()[0].bigrams.is_empty());

    add(&mut b, matrix_ev(0.0, 0.0, 0.0, 4.0, 2_000.0), &fp_b);
    b.discard_for_uid("0xAAAA", |_| true);
    add(&mut b, matrix_ev(0.0, 1.0, 0.0, 11.0, 2_100.0), &fp_b);
    let snaps = b.drain_all();
    assert_eq!(pairs(&find(&snaps, |s| s.scope_id == fp_b.scope_key()).bigrams), [("4_11", vec![100.0])]);
}
