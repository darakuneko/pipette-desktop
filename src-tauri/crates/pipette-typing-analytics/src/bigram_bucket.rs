// SPDX-License-Identifier: GPL-2.0-or-later
//! The histograms the recorder writes: an n-gram's
//! inter-key intervals (`h`) and a matrix cell's keypress durations (`dh`),
//! each counted into [`HIST_BUCKETS`] buckets, and the sum and sum of
//! squares stored beside them for the true standard deviation.

use crate::jsonl::row::HIST_BUCKETS;

/// `BIGRAM_BUCKET_UPPER_BOUNDS_MS`: the exclusive upper bound of each
/// inter-key interval bucket; the last one is open.
pub const BIGRAM_BUCKET_UPPER_BOUNDS_MS: [f64; HIST_BUCKETS] =
    [60.0, 100.0, 150.0, 200.0, 300.0, 500.0, 1000.0, f64::INFINITY];

/// `DURATION_BUCKET_UPPER_BOUNDS_MS` (src/shared/duration-buckets.ts): the
/// tighter grid of the keypress durations.
pub const DURATION_BUCKET_UPPER_BOUNDS_MS: [f64; HIST_BUCKETS] =
    [50.0, 80.0, 110.0, 140.0, 180.0, 250.0, 400.0, f64::INFINITY];

/// The count of `values` in each bucket of `bounds`. A value under no
/// bound before the last one (NaN included) lands in the last bucket.
fn bucketize(values: &[f64], bounds: &[f64; HIST_BUCKETS]) -> [u32; HIST_BUCKETS] {
    let mut buckets = [0; HIST_BUCKETS];
    for &value in values {
        let index = bounds.iter().position(|&bound| value < bound).unwrap_or(HIST_BUCKETS - 1);
        buckets[index] += 1;
    }
    buckets
}

/// `bucketizeIki`.
pub fn bucketize_iki(ikis: &[f64]) -> [u32; HIST_BUCKETS] {
    bucketize(ikis, &BIGRAM_BUCKET_UPPER_BOUNDS_MS)
}

/// `bucketizeDurations`.
pub fn bucketize_durations(durations_ms: &[f64]) -> [u32; HIST_BUCKETS] {
    bucketize(durations_ms, &DURATION_BUCKET_UPPER_BOUNDS_MS)
}

/// `sumAndSumSquares`: summed in order, as the JavaScript loop sums them.
pub fn sum_and_sum_squares(values: &[f64]) -> (f64, f64) {
    values.iter().fold((0.0, 0.0), |(sum, sum_sq), &v| (sum + v, sum_sq + v * v))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hist(counts: [u32; HIST_BUCKETS]) -> [u32; HIST_BUCKETS] {
        counts
    }

    #[test]
    fn an_empty_list_is_all_zero() {
        assert_eq!(bucketize_iki(&[]), [0; HIST_BUCKETS]);
        assert_eq!(bucketize_durations(&[]), [0; HIST_BUCKETS]);
    }

    #[test]
    fn values_below_the_first_bound_go_to_bucket_zero() {
        assert_eq!(bucketize_iki(&[0.0, 1.0, 30.0, 59.0]), hist([4, 0, 0, 0, 0, 0, 0, 0]));
    }

    #[test]
    fn a_bound_belongs_to_the_next_bucket() {
        for (i, bound) in [60.0, 100.0, 150.0, 200.0, 300.0, 500.0, 1000.0].into_iter().enumerate() {
            let mut expected = [0; HIST_BUCKETS];
            expected[i + 1] = 1;
            assert_eq!(bucketize_iki(&[bound]), expected, "{bound}");
        }
        for (i, bound) in [50.0, 80.0, 110.0, 140.0, 180.0, 250.0, 400.0].into_iter().enumerate() {
            let mut expected = [0; HIST_BUCKETS];
            expected[i + 1] = 1;
            assert_eq!(bucketize_durations(&[bound]), expected, "{bound}");
        }
    }

    #[test]
    fn values_above_the_last_bound_go_to_the_last_bucket() {
        assert_eq!(bucketize_iki(&[1500.0, 60_000.0, 299_999.0]), hist([0, 0, 0, 0, 0, 0, 0, 3]));
        assert_eq!(bucketize_durations(&[1000.0, 60_000.0]), hist([0, 0, 0, 0, 0, 0, 0, 2]));
    }

    #[test]
    fn counts_duplicates_per_bucket() {
        assert_eq!(bucketize_iki(&[50.0, 80.0, 80.0, 250.0, 250.0, 250.0]), hist([1, 2, 0, 0, 3, 0, 0, 0]));
    }

    #[test]
    fn the_duration_grid_is_not_the_interval_grid() {
        assert_eq!(bucketize_durations(&[120.0]), hist([0, 0, 0, 1, 0, 0, 0, 0]));
        assert_eq!(bucketize_iki(&[120.0]), hist([0, 0, 1, 0, 0, 0, 0, 0]));
    }

    #[test]
    fn the_bounds_ascend_to_an_open_end() {
        for bounds in [BIGRAM_BUCKET_UPPER_BOUNDS_MS, DURATION_BUCKET_UPPER_BOUNDS_MS] {
            assert!(bounds.windows(2).all(|w| w[0] < w[1]));
            assert_eq!(bounds[HIST_BUCKETS - 1], f64::INFINITY);
        }
    }

    #[test]
    fn sums_in_order() {
        assert_eq!(sum_and_sum_squares(&[]), (0.0, 0.0));
        assert_eq!(sum_and_sum_squares(&[3.0, 4.0]), (7.0, 25.0));
    }
}
