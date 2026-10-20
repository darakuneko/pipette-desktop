// SPDX-License-Identifier: GPL-2.0-or-later
//! The range aggregates of the Analyze Bigrams view and the keypress
//! duration chart: the
//! per-minute n-gram rows summed per n-gram id, ranked by count or by
//! average interval, and the per-minute duration rows summed per cell.
//!
//! The sums run in the order of the rows and of the first appearance of
//! each id, with JavaScript's double arithmetic, so the answers are the
//! same numbers.
//!
//! The ties of a ranking are broken by the n-gram id as `localeCompare`
//! orders it, which [`collate`] gives for the ids the recorder writes.

use std::cmp::Ordering;
use std::collections::HashMap;

use pipette_js_json::{Object, Value};
use pipette_typing_analytics_db::{HIST_BUCKETS, MatrixDurationCellRow, NgramMinuteCellRow};

/// Exclusive upper bound of each interval bucket in ms.
const BUCKET_UPPER_BOUNDS_MS: [f64; HIST_BUCKETS] =
    [60.0, 100.0, 150.0, 200.0, 300.0, 500.0, 1000.0, f64::INFINITY];

/// The center of each interval bucket in ms (`BIGRAM_BUCKET_CENTERS_MS`);
/// the open last bucket takes 1500, so its percentile span is 1000..2000.
const BUCKET_CENTERS_MS: [f64; HIST_BUCKETS] = [30.0, 80.0, 125.0, 175.0, 250.0, 400.0, 750.0, 1500.0];

/// The characters of the n-gram ids the recorder writes (keycodes as
/// `String(number)` joined by `_`), in the order V8's `localeCompare`
/// (ICU's root collation) gives them. The analytics fixtures record that
/// order from V8 and the tests compare it with this one.
pub const RECORDED_ID_ORDER: &str = "_-.+0123456789e";

/// `a.localeCompare(b)` for n-gram ids. Two ids made only of
/// [`RECORDED_ID_ORDER`]'s characters compare as ICU compares them: one
/// character at a time by that order, a prefix first. Any other id
/// compares by code points, which can differ from ICU (ICU orders `a_B`
/// before `A_b`, code points the other way): ids from imported or synced
/// files are not checked, but the recorder never writes those.
pub fn collate(a: &str, b: &str) -> Ordering {
    fn rank(c: char) -> Option<usize> {
        RECORDED_ID_ORDER.find(c)
    }
    let recorded = |s: &str| s.chars().all(|c| rank(c).is_some());
    if recorded(a) && recorded(b) { a.chars().map(rank).cmp(b.chars().map(rank)) } else { a.cmp(b) }
}

/// `BigramPairTotal`: one n-gram id summed over the rows.
#[derive(Debug, Clone, PartialEq)]
pub struct PairTotal {
    pub ngram_id: String,
    pub count: f64,
    pub hist: [f64; HIST_BUCKETS],
    /// The interval sums, `None` once any row of the id lacks them.
    pub sums: Option<(f64, f64)>,
    pub overlap_count: f64,
    pub overlap_n: f64,
}

/// `aggregatePairTotals`: one total per n-gram id, in the order the ids
/// first appear. Counts and histograms add up; the interval sums are lost
/// for good at the first row without them; a row without overlap sums (an
/// older row, or any trigram row) adds nothing to them.
pub fn aggregate_pair_totals(rows: &[NgramMinuteCellRow]) -> Vec<PairTotal> {
    let mut totals: Vec<PairTotal> = Vec::new();
    let mut index: HashMap<&str, usize> = HashMap::new();
    for row in rows {
        let at = *index.entry(row.ngram_id.as_str()).or_insert_with(|| {
            totals.push(PairTotal {
                ngram_id: row.ngram_id.clone(),
                count: 0.0,
                hist: [0.0; HIST_BUCKETS],
                sums: Some((0.0, 0.0)),
                overlap_count: 0.0,
                overlap_n: 0.0,
            });
            totals.len() - 1
        });
        let entry = &mut totals[at];
        entry.count += row.count;
        for (sum, &bucket) in entry.hist.iter_mut().zip(&row.hist) {
            *sum += f64::from(bucket);
        }
        entry.sums = match (row.sum_iki, row.sum_sq_iki, entry.sums) {
            (Some(sum), Some(sum_sq), Some((total, total_sq))) => Some((total + sum, total_sq + sum_sq)),
            _ => None,
        };
        if let Some(overlap) = row.overlap
            && let (Some(count), Some(n)) = (overlap.count, overlap.n)
        {
            entry.overlap_count += count;
            entry.overlap_n += n;
        }
    }
    totals
}

/// `observedRolloverRatio`: Σ overlap count / Σ overlap samples over every
/// id, null without a sample.
pub fn observed_rollover_ratio(totals: &[PairTotal]) -> Option<f64> {
    let (mut oc, mut on) = (0.0, 0.0);
    for entry in totals {
        oc += entry.overlap_count;
        on += entry.overlap_n;
    }
    (on > 0.0).then(|| oc / on)
}

/// `sdFromSums` (src/shared/stat-sums.ts): the population standard
/// deviation from the sum and the sum of squares, a rounding below zero
/// read as zero; null under two samples.
pub fn sd_from_sums(sum: f64, sum_sq: f64, count: f64) -> Option<f64> {
    if count < 2.0 {
        return None;
    }
    let mean = sum / count;
    let variance = sum_sq / count - mean * mean;
    // Math.max(0, NaN) is NaN, where f64::max would give 0.
    Some(if variance.is_nan() { f64::NAN } else { variance.max(0.0).sqrt() })
}

fn sd_of(entry: &PairTotal) -> Option<f64> {
    entry.sums.and_then(|(sum, sum_sq)| sd_from_sums(sum, sum_sq, entry.count))
}

/// `avgIkiFromHist`: the average interval by bucket centers, null for an
/// empty histogram.
pub fn avg_iki_from_hist(hist: &[f64; HIST_BUCKETS]) -> Option<f64> {
    let (mut sum, mut count) = (0.0, 0.0);
    for (&c, center) in hist.iter().zip(BUCKET_CENTERS_MS) {
        if c <= 0.0 {
            continue;
        }
        sum += c * center;
        count += c;
    }
    (count > 0.0).then(|| sum / count)
}

/// `percentileFromHist`: the `q` quantile (0..=1), interpolated linearly
/// inside its bucket; null for an empty histogram.
pub fn percentile_from_hist(hist: &[f64; HIST_BUCKETS], q: f64) -> Option<f64> {
    let total: f64 = hist.iter().fold(0.0, |sum, &c| sum + c);
    if total == 0.0 {
        return None;
    }
    let target = q * total;
    let mut acc = 0.0;
    for (i, &c) in hist.iter().enumerate() {
        if c <= 0.0 {
            continue;
        }
        if acc + c >= target {
            let lower = if i == 0 { 0.0 } else { BUCKET_UPPER_BOUNDS_MS[i - 1] };
            let upper = if BUCKET_UPPER_BOUNDS_MS[i].is_finite() {
                BUCKET_UPPER_BOUNDS_MS[i]
            } else {
                2.0 * BUCKET_CENTERS_MS[i] - lower
            };
            let fraction = (target - acc) / c;
            return Some(lower + fraction * (upper - lower));
        }
        acc += c;
    }
    None
}

fn number(n: Option<f64>) -> Value {
    n.map_or(Value::Null, Value::Number)
}

fn hist_value(hist: &[f64; HIST_BUCKETS]) -> Value {
    Value::Array(hist.iter().map(|&c| Value::Number(c)).collect())
}

/// The fields every ranked entry starts with, then the ones of its view,
/// then the overlap sums: both null when the id has no overlap sample,
/// else the sums as they are (a real 0 included).
fn ranked_entry(entry: &PairTotal, view_fields: Vec<(&str, Value)>) -> Value {
    let mut out = Object::new();
    out.insert("ngramId", Value::from(entry.ngram_id.as_str()));
    out.insert("count", Value::Number(entry.count));
    out.insert("hist", hist_value(&entry.hist));
    for (key, value) in view_fields {
        out.insert(key, value);
    }
    let sampled = entry.overlap_n != 0.0;
    out.insert("overlapCount", number(sampled.then_some(entry.overlap_count)));
    out.insert("overlapN", number(sampled.then_some(entry.overlap_n)));
    out.into()
}

/// `(b - a) || tie`: a difference that is zero falls to the tie. A NaN
/// value goes after every number and to the tie with another NaN, so the
/// order stays total (Rust's sort may panic on one that is not); V8 takes
/// the NaN difference as equal instead. Two equal infinities differ by NaN
/// and fall to the tie, as in V8.
fn descending(a: f64, b: f64, tie: impl FnOnce() -> Ordering) -> Ordering {
    match (a.is_nan(), b.is_nan()) {
        (true, true) => return tie(),
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        (false, false) => {}
    }
    let difference = b - a;
    if difference > 0.0 {
        Ordering::Greater
    } else if difference < 0.0 {
        Ordering::Less
    } else {
        tie()
    }
}

/// The number of entries `slice(0, limit)` keeps.
fn take(limit: f64) -> usize {
    // `as` saturates: a limit past usize::MAX keeps every entry.
    limit.max(0.0) as usize
}

/// `rankBigramsByCount`: the `limit` ids with the most occurrences, ties
/// by id.
pub fn rank_by_count(totals: &[PairTotal], limit: f64) -> Vec<Value> {
    let mut ranked: Vec<&PairTotal> = totals.iter().collect();
    ranked.sort_by(|a, b| descending(a.count, b.count, || collate(&a.ngram_id, &b.ngram_id)));
    ranked
        .into_iter()
        .take(take(limit))
        .map(|entry| {
            ranked_entry(
                entry,
                vec![("avgIki", number(avg_iki_from_hist(&entry.hist))), ("sd", number(sd_of(entry)))],
            )
        })
        .collect()
}

/// `rankBigramsBySlow`: the `limit` ids with the longest average interval
/// among those with at least `min_sample` occurrences, ties by id.
pub fn rank_by_slow(totals: &[PairTotal], min_sample: f64, limit: f64) -> Vec<Value> {
    let mut eligible: Vec<(&PairTotal, f64)> = totals
        .iter()
        .filter(|entry| entry.count.partial_cmp(&min_sample) != Some(Ordering::Less))
        .filter_map(|entry| avg_iki_from_hist(&entry.hist).map(|avg| (entry, avg)))
        .collect();
    eligible
        .sort_by(|(a, a_avg), (b, b_avg)| descending(*a_avg, *b_avg, || collate(&a.ngram_id, &b.ngram_id)));
    eligible
        .into_iter()
        .take(take(limit))
        .map(|(entry, avg)| {
            ranked_entry(
                entry,
                vec![
                    ("avgIki", Value::Number(avg)),
                    ("p95", number(percentile_from_hist(&entry.hist, 0.95))),
                    ("sd", number(sd_of(entry))),
                ],
            )
        })
        .collect()
}

/// `MatrixCellDurationTotal`: one cell's keypress durations over a range.
#[derive(Debug, Clone, PartialEq)]
pub struct DurationTotal {
    pub row: f64,
    pub col: f64,
    pub layer: f64,
    /// The duration samples (the histogram's total), not the presses.
    pub count: f64,
    pub hist: [f64; HIST_BUCKETS],
    pub sum: f64,
    pub sum_sq: f64,
}

/// `aggregateMatrixDurationTotals`: one total per (row, col, layer), in the
/// order the cells first appear. A missing sum of squares adds 0, as
/// JavaScript adds null.
pub fn aggregate_duration_totals(rows: &[MatrixDurationCellRow]) -> Vec<DurationTotal> {
    let mut totals: Vec<DurationTotal> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let key = format!("{},{},{}", js_number(row.row), js_number(row.col), js_number(row.layer));
        let at = *index.entry(key).or_insert_with(|| {
            totals.push(DurationTotal {
                row: row.row,
                col: row.col,
                layer: row.layer,
                count: 0.0,
                hist: [0.0; HIST_BUCKETS],
                sum: 0.0,
                sum_sq: 0.0,
            });
            totals.len() - 1
        });
        let entry = &mut totals[at];
        for (sum, &bucket) in entry.hist.iter_mut().zip(&row.hist) {
            let bucket = f64::from(bucket);
            *sum += bucket;
            entry.count += bucket;
        }
        entry.sum += row.sum;
        entry.sum_sq += row.sum_sq.unwrap_or(0.0);
    }
    totals
}

/// `TypingDurationCell`: a duration total as the handler answers it.
pub fn duration_cell(total: &DurationTotal) -> Value {
    let mut out = Object::new();
    out.insert("row", Value::Number(total.row));
    out.insert("col", Value::Number(total.col));
    out.insert("layer", Value::Number(total.layer));
    out.insert("durationSamples", Value::Number(total.count));
    out.insert("hist", hist_value(&total.hist));
    out.insert("sum", Value::Number(total.sum));
    out.insert("sumSq", Value::Number(total.sum_sq));
    out.into()
}

/// `String(n)`: the text a JavaScript template literal writes for a number.
pub fn js_number(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else {
        let mut out = String::new();
        pipette_js_json::write_number(&mut out, n);
        out
    }
}

#[cfg(test)]
mod tests {
    use pipette_typing_analytics_db::Overlap;

    use super::*;

    fn hist(values: &[u32]) -> [u32; HIST_BUCKETS] {
        let mut out = [0; HIST_BUCKETS];
        out[..values.len()].copy_from_slice(values);
        out
    }

    fn row(
        id: &str,
        count: f64,
        h: &[u32],
        sums: Option<(f64, f64)>,
        overlap: Option<(f64, f64)>,
    ) -> NgramMinuteCellRow {
        NgramMinuteCellRow {
            ngram_id: id.into(),
            minute_ts: 60_000.0,
            count,
            hist: hist(h),
            sum_iki: sums.map(|s| s.0),
            sum_sq_iki: sums.map(|s| s.1),
            overlap: Some(Overlap { count: overlap.map(|o| o.0), n: overlap.map(|o| o.1) }),
        }
    }

    fn trigram(id: &str, count: f64, h: &[u32]) -> NgramMinuteCellRow {
        NgramMinuteCellRow { overlap: None, ..row(id, count, h, None, None) }
    }

    fn total(id: &str, count: f64, h: &[f64], sums: Option<(f64, f64)>, overlap: (f64, f64)) -> PairTotal {
        let mut hist = [0.0; HIST_BUCKETS];
        hist[..h.len()].copy_from_slice(h);
        PairTotal { ngram_id: id.into(), count, hist, sums, overlap_count: overlap.0, overlap_n: overlap.1 }
    }

    fn ids(entries: &[Value]) -> Vec<&str> {
        entries.iter().map(|e| e.as_object().unwrap().get("ngramId").unwrap().as_str().unwrap()).collect()
    }

    fn field<'a>(entry: &'a Value, key: &str) -> &'a Value {
        entry.as_object().unwrap().get(key).unwrap()
    }

    #[test]
    fn sums_counts_and_histograms_per_id_in_first_appearance_order() {
        assert!(aggregate_pair_totals(&[]).is_empty());
        let totals = aggregate_pair_totals(&[
            row("A", 1.0, &[1], None, None),
            row("B", 2.0, &[0, 2], None, None),
            row("A", 4.0, &[3, 1], None, None),
        ]);
        assert_eq!(
            totals,
            [total("A", 5.0, &[4.0, 1.0], None, (0.0, 0.0)), total("B", 2.0, &[0.0, 2.0], None, (0.0, 0.0)),]
        );
        let trigrams = aggregate_pair_totals(&[
            trigram("4_11_7", 1.0, &[1]),
            trigram("4_11_7", 1.0, &[0, 1]),
            trigram("11_7_5", 1.0, &[0, 0, 1]),
        ]);
        assert_eq!(trigrams.len(), 2);
        assert_eq!(trigrams[0].count, 2.0);
        assert_eq!((trigrams[0].overlap_count, trigrams[0].overlap_n), (0.0, 0.0));
    }

    #[test]
    fn interval_sums_are_lost_for_good_at_the_first_row_without_them() {
        let both = aggregate_pair_totals(&[
            row("A", 2.0, &[2], Some((100.0, 5_000.0)), None),
            row("A", 3.0, &[3], Some((150.0, 7_500.0)), None),
        ]);
        assert_eq!(both[0].sums, Some((250.0, 12_500.0)));
        let later = aggregate_pair_totals(&[
            row("A", 2.0, &[2], Some((100.0, 5_000.0)), None),
            row("A", 1.0, &[1], None, None),
        ]);
        assert_eq!(later[0].sums, None);
        let first = aggregate_pair_totals(&[
            row("A", 1.0, &[1], None, None),
            row("A", 2.0, &[2], Some((100.0, 5_000.0)), None),
        ]);
        assert_eq!(first[0].sums, None);
    }

    #[test]
    fn a_row_without_overlap_sums_adds_nothing_to_them() {
        let totals = aggregate_pair_totals(&[
            row("A", 2.0, &[2], None, Some((1.0, 2.0))),
            row("A", 3.0, &[3], None, Some((2.0, 3.0))),
            row("A", 1.0, &[1], None, None),
        ]);
        assert_eq!((totals[0].overlap_count, totals[0].overlap_n), (3.0, 5.0));
    }

    #[test]
    fn the_rollover_ratio_is_over_every_id() {
        assert_eq!(observed_rollover_ratio(&[]), None);
        let two = [total("A", 5.0, &[], None, (3.0, 5.0)), total("B", 2.0, &[], None, (1.0, 5.0))];
        assert_eq!(observed_rollover_ratio(&two), Some(4.0 / 10.0));
        let one = [total("A", 5.0, &[], None, (3.0, 5.0)), total("B", 2.0, &[], None, (0.0, 0.0))];
        assert_eq!(observed_rollover_ratio(&one), Some(3.0 / 5.0));
        assert_eq!(observed_rollover_ratio(&[total("A", 5.0, &[], None, (0.0, 0.0))]), None);
    }

    #[test]
    fn the_standard_deviation_from_sums() {
        let sd = sd_from_sums(300.0, 80.0_f64.powi(2) + 100.0_f64.powi(2) + 120.0_f64.powi(2), 3.0).unwrap();
        assert!((sd - 266.666_667_f64.sqrt()).abs() < 1e-3);
        let value = 100.0 / 3.0;
        let (mut sum, mut sum_sq) = (0.0, 0.0);
        for _ in 0..3 {
            sum += value;
            sum_sq += value * value;
        }
        assert_eq!(sd_from_sums(sum, sum_sq, 3.0), Some(0.0));
        assert_eq!(sd_from_sums(400.0, 40_000.0, 4.0), Some(0.0));
        assert_eq!(sd_from_sums(100.0, 10_000.0, 1.0), None);
        assert_eq!(sd_from_sums(0.0, 0.0, 0.0), None);
        assert!(sd_from_sums(f64::INFINITY, f64::INFINITY, 2.0).unwrap().is_nan());
    }

    #[test]
    fn averages_and_percentiles_from_histograms() {
        let h = |values: &[f64]| {
            let mut out = [0.0; HIST_BUCKETS];
            out[..values.len()].copy_from_slice(values);
            out
        };
        assert_eq!(avg_iki_from_hist(&h(&[])), None);
        assert_eq!(avg_iki_from_hist(&h(&[0.0, 5.0])), Some(80.0));
        assert_eq!(avg_iki_from_hist(&h(&[2.0, 0.0, 0.0, 0.0, 2.0])), Some(140.0));
        assert_eq!(percentile_from_hist(&h(&[]), 0.5), None);
        assert_eq!(percentile_from_hist(&h(&[0.0, 4.0]), 0.5), Some(80.0));
        assert_eq!(percentile_from_hist(&h(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]), 0.5), Some(1500.0));
        assert_eq!(percentile_from_hist(&h(&[2.0, 2.0]), 0.75), Some(80.0));
    }

    #[test]
    fn ranks_by_count_with_ties_by_id() {
        let totals = [
            total("A", 5.0, &[5.0], None, (0.0, 0.0)),
            total("B", 10.0, &[0.0, 10.0], None, (0.0, 0.0)),
            total("C", 1.0, &[0.0, 0.0, 1.0], None, (0.0, 0.0)),
        ];
        assert_eq!(ids(&rank_by_count(&totals, 2.0)), ["B", "A"]);
        let tied =
            [total("B", 3.0, &[3.0], None, (0.0, 0.0)), total("A", 3.0, &[0.0, 0.0, 3.0], None, (0.0, 0.0))];
        assert_eq!(ids(&rank_by_count(&tied, 5.0)), ["A", "B"]);
        let entry = &rank_by_count(&[total("A", 2.0, &[2.0], Some((200.0, 20_400.0)), (0.0, 0.0))], 5.0)[0];
        assert_eq!(field(entry, "avgIki"), &Value::Number(30.0));
        assert_eq!(field(entry, "sd"), &number(sd_from_sums(200.0, 20_400.0, 2.0)));
        assert_eq!(field(entry, "overlapCount"), &Value::Null);
        assert_eq!(field(entry, "overlapN"), &Value::Null);
        let observed_zero = &rank_by_count(&[total("A", 5.0, &[5.0], None, (0.0, 5.0))], 5.0)[0];
        assert_eq!(field(observed_zero, "overlapCount"), &Value::Number(0.0));
        assert_eq!(field(observed_zero, "overlapN"), &Value::Number(5.0));
        assert_eq!(
            pipette_js_json::stringify(entry),
            r#"{"ngramId":"A","count":2,"hist":[2,0,0,0,0,0,0,0],"avgIki":30,"sd":14.142135623730951,"overlapCount":null,"overlapN":null}"#
        );
    }

    #[test]
    fn ranks_by_slow_among_ids_with_enough_samples() {
        let totals = [
            total("low", 1.0, &[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0], None, (0.0, 0.0)),
            total("kept", 5.0, &[5.0], None, (0.0, 0.0)),
        ];
        assert_eq!(ids(&rank_by_slow(&totals, 5.0, 5.0)), ["kept"]);
        let three = [
            total("A", 5.0, &[5.0], None, (0.0, 0.0)),
            total("B", 5.0, &[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 5.0], None, (0.0, 0.0)),
            total("C", 5.0, &[0.0, 0.0, 0.0, 0.0, 5.0], None, (0.0, 0.0)),
        ];
        assert_eq!(ids(&rank_by_slow(&three, 5.0, 5.0)), ["B", "C", "A"]);
        let tail = &rank_by_slow(
            &[total("A", 5.0, &[4.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0], None, (0.0, 4.0))],
            5.0,
            5.0,
        )[0];
        let Value::Number(p95) = field(tail, "p95") else { panic!("p95") };
        assert!(*p95 > 1000.0);
        assert_eq!(field(tail, "sd"), &Value::Null);
        assert_eq!(field(tail, "overlapCount"), &Value::Number(0.0));
        assert!(rank_by_slow(&[total("x", 1.0, &[1.0], None, (0.0, 0.0))], 5.0, 5.0).is_empty());
    }

    #[test]
    fn ranks_nan_and_infinite_values_without_panicking() {
        let odd = [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 3.0, -0.0, 1.0];
        let totals: Vec<PairTotal> = (0..48)
            .map(|i| {
                let value = odd[i % odd.len()];
                total(&format!("{i:02}"), value, &[value, odd[(i / 6) % odd.len()]], None, (0.0, 0.0))
            })
            .collect();
        let by_count = rank_by_count(&totals, 100.0);
        assert_eq!(by_count.len(), totals.len());
        let counts: Vec<f64> = by_count
            .iter()
            .map(|entry| match field(entry, "count") {
                Value::Number(n) => *n,
                _ => panic!("count"),
            })
            .collect();
        let numbers = counts.iter().take_while(|n| !n.is_nan()).count();
        assert_eq!(numbers, 40);
        assert!(counts[..numbers].is_sorted_by(|a, b| a >= b));
        assert!(counts[numbers..].iter().all(|n| n.is_nan()));
        assert_eq!(ids(&by_count[numbers..]), ["00", "06", "12", "18", "24", "30", "36", "42"]);
        assert!(rank_by_slow(&totals, f64::NEG_INFINITY, 100.0).len() <= totals.len());
    }

    #[test]
    fn sums_durations_per_cell_and_layer() {
        let duration = |row: f64, col: f64, layer: f64, h: &[u32], sum: f64, sum_sq: Option<f64>| {
            MatrixDurationCellRow { row, col, layer, minute_ts: 60_000.0, hist: hist(h), sum, sum_sq }
        };
        assert!(aggregate_duration_totals(&[]).is_empty());
        let totals = aggregate_duration_totals(&[
            duration(0.0, 0.0, 0.0, &[0, 1], 65.0, Some(4_225.0)),
            duration(0.0, 1.0, 0.0, &[1], 40.0, None),
            duration(0.0, 0.0, 0.0, &[0, 0, 1], 95.0, Some(9_025.0)),
            duration(0.0, 0.0, 1.0, &[0, 1], 65.0, Some(4_225.0)),
        ]);
        assert_eq!(totals.len(), 3);
        assert_eq!((totals[0].count, totals[0].sum, totals[0].sum_sq), (2.0, 160.0, 13_250.0));
        assert_eq!(totals[0].hist[..3], [0.0, 1.0, 1.0]);
        assert_eq!((totals[1].count, totals[1].sum_sq), (1.0, 0.0));
        assert_eq!(
            pipette_js_json::stringify(&duration_cell(&totals[1])),
            r#"{"row":0,"col":1,"layer":0,"durationSamples":1,"hist":[1,0,0,0,0,0,0,0],"sum":40,"sumSq":0}"#
        );
    }

    #[test]
    fn collates_recorded_ids_as_icu_and_others_by_code_point() {
        let mut recorded = ["4_5", "_", "1e+21", "4_10", "-1", "1_04", "10_4", "1.5"];
        recorded.sort_by(|a, b| collate(a, b));
        assert_eq!(recorded, ["_", "-1", "1_04", "1.5", "10_4", "1e+21", "4_10", "4_5"]);
        assert_eq!(collate("4_5", "4_5"), Ordering::Equal);
        assert_eq!(collate("a_B", "A_b"), Ordering::Greater);
    }

    #[test]
    fn writes_numbers_as_string_does() {
        assert_eq!(js_number(2.5), "2.5");
        assert_eq!(js_number(-0.0), "0");
        assert_eq!(js_number(1e21), "1e+21");
        assert_eq!(js_number(f64::NAN), "NaN");
        assert_eq!(js_number(f64::NEG_INFINITY), "-Infinity");
    }
}
