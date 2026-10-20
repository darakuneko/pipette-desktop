// SPDX-License-Identifier: GPL-2.0-or-later
//! The value conversions shared by the writes and the reads: the histogram
//! BLOB and the local
//! calendar day a `localtime` query groups by.

use rusqlite::types::ValueRef;

use crate::Error;
use crate::jsonl::HIST_BUCKETS;

/// Pack a histogram into 8 little-endian u32: a
/// negative or non-finite bucket becomes 0 and a fractional one is
/// truncated, as Buffer.writeUInt32LE stores it. A bucket above u32::MAX
/// makes writeUInt32LE throw, which aborts the whole write; here it is an
/// error with the same effect.
pub(crate) fn encode_hist(hist: &[f64; HIST_BUCKETS]) -> Result<[u8; HIST_BUCKETS * 4], Error> {
    let mut out = [0u8; HIST_BUCKETS * 4];
    for (&value, slot) in hist.iter().zip(out.chunks_exact_mut(4)) {
        let clamped = if value.is_finite() && value >= 0.0 { value } else { 0.0 };
        if clamped > f64::from(u32::MAX) {
            return Err(Error::HistogramBucketOutOfRange(value));
        }
        // In range and non-negative, so the cast only drops the fraction.
        slot.copy_from_slice(&(clamped as u32).to_le_bytes());
    }
    Ok(out)
}

/// Unpack a stored histogram. Anything but a 32-byte
/// BLOB reads as all zeros, so a broken row never fails a query.
pub(crate) fn decode_hist(value: ValueRef<'_>) -> [u32; HIST_BUCKETS] {
    let mut out = [0u32; HIST_BUCKETS];
    if let ValueRef::Blob(bytes) = value
        && bytes.len() == HIST_BUCKETS * 4
    {
        for (slot, chunk) in out.iter_mut().zip(bytes.chunks_exact(4)) {
            *slot = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
    }
    out
}

/// The local midnight of the `YYYY-MM-DD` text
/// SQLite's `strftime(…, 'localtime')` gives, read the way JavaScript reads
/// it: the text split at `-`, each part through `Number.parseInt(s, 10)`
/// and `new Date(year, month - 1, day)`. NaN where JavaScript gives NaN.
pub(crate) fn local_date_string_to_ms(date: &str) -> f64 {
    let mut parts = date.split('-').map(parse_int);
    let (Some(year), Some(month), Some(day)) = (parts.next(), parts.next(), parts.next()) else {
        return f64::NAN;
    };
    let as_int = |n: f64| n.is_finite().then_some(n as i64);
    match (as_int(year), as_int(month), as_int(day)) {
        (Some(year), Some(month), Some(day)) => {
            pipette_time::local_date_ms(year, month - 1, day).map_or(f64::NAN, |ms| ms as f64)
        }
        _ => f64::NAN,
    }
}

/// `Number.parseInt(text, 10)` for the parts of a date `strftime` writes
/// (ASCII digits): the leading digits, NaN when there is none. A value too
/// large for an i64 saturates, which the local date then rejects as a Date
/// rejects it.
fn parse_int(text: &str) -> f64 {
    let digits = text.bytes().take_while(u8::is_ascii_digit).count();
    // Only ASCII digits, so the parse cannot fail.
    text[..digits].parse().unwrap_or(f64::NAN)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hist_buckets_truncate_clamp_and_reject_overflow() {
        let bytes = encode_hist(&[1.0, 2.9, -3.0, 0.0, 0.0, 0.0, 0.0, f64::from(u32::MAX)]).unwrap();
        assert_eq!(&bytes[..12], &[1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(&bytes[28..], &[0xff; 4]);
        assert!(encode_hist(&[f64::from(u32::MAX) + 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]).is_err());
    }

    #[test]
    fn hist_round_trips_and_a_broken_value_reads_as_zeros() {
        let bytes = encode_hist(&[0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]).unwrap();
        assert_eq!(decode_hist(ValueRef::Blob(&bytes)), [0, 1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(decode_hist(ValueRef::Blob(&bytes[..31])), [0; 8]);
        assert_eq!(decode_hist(ValueRef::Null), [0; 8]);
        assert_eq!(decode_hist(ValueRef::Text(b"x")), [0; 8]);
    }

    #[test]
    fn parse_int_reads_a_leading_integer() {
        assert_eq!(parse_int("2026"), 2026.0);
        assert_eq!(parse_int("07"), 7.0);
        assert_eq!(parse_int("12x"), 12.0);
        assert!(parse_int("").is_nan());
        assert!(parse_int("x1").is_nan());
    }

    #[test]
    fn a_date_with_too_few_parts_is_nan() {
        assert!(local_date_string_to_ms("2026-01").is_nan());
        assert!(local_date_string_to_ms("").is_nan());
    }
}
