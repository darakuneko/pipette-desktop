// SPDX-License-Identifier: GPL-2.0-or-later
//! Local calendar days: `new Date(year, month, day).getTime()` of
//! JavaScript in the system time zone ([`local_date_ms`]), the local day
//! range of a `YYYY-MM-DD` date ([`local_day_range_ms`],
//! `localDayRangeMs` of src/shared/local-day-range.ts) and the UTC day
//! check of the typing-analytics files ([`is_utc_day`], `isUtcDay` of
//! src/main/typing-analytics/jsonl/utc-day.ts).
//!
//! The time zone is the one JavaScript reads too: `TZ` when set, otherwise
//! the system's, with the IANA time zone data. A local midnight that does
//! not exist (the clocks jump over it) is the first instant after the jump,
//! and one that happens twice is the earlier one, as for a JavaScript
//! `Date`.

use jiff::civil::Date;
use jiff::tz::TimeZone;

use crate::{MAX_TIME_MS, days_from_civil};

const MS_PER_DAY: i64 = 86_400_000;

/// Days in 400 Gregorian years, after which weekdays and leap years repeat.
const DAYS_PER_CYCLE: i64 = 146_097;

/// The years the time zone lookup takes as they are; dates further out are
/// moved by whole 400-year cycles into this range and back. The rules of a
/// time zone past its last listed change repeat every year by weekday, so
/// the move keeps the offset.
const LOOKUP_YEARS: std::ops::RangeInclusive<i64> = -9000..=9000;

/// `new Date(year, month_index, day).getTime()`: local midnight of that day
/// in the system time zone, in milliseconds since the Unix epoch. As in
/// JavaScript, a year from 0 to 99 is a year of the 1900s, a month index
/// outside 0 to 11 and a day outside the month carry into the next or
/// previous month or year, and a time past [`MAX_TIME_MS`] is `None`
/// (NaN).
pub fn local_date_ms(year: i64, month_index: i64, day: i64) -> Option<i64> {
    local_date_ms_in(&TimeZone::system(), year, month_index, day)
}

fn local_date_ms_in(tz: &TimeZone, year: i64, month_index: i64, day: i64) -> Option<i64> {
    let year = if (0..=99).contains(&year) { 1900 + year } else { year };
    // Beyond these a Date is NaN anyway; the bounds keep the arithmetic
    // from overflowing.
    let in_reach = |n: i64| n.unsigned_abs() < 1 << 40;
    if !in_reach(year) || !in_reach(month_index) || !in_reach(day) {
        return None;
    }
    let year = year + month_index.div_euclid(12);
    let month = month_index.rem_euclid(12) + 1;
    let local_days = days_from_civil(year, month) + day - 1;
    let ms = local_midnight_to_utc(tz, local_days)?;
    (ms.abs() <= MAX_TIME_MS).then_some(ms)
}

/// The instant of local midnight of `local_days` (days from 1970-01-01 on
/// the local calendar).
fn local_midnight_to_utc(tz: &TimeZone, local_days: i64) -> Option<i64> {
    let (year, _, _) = crate::civil_from_days(local_days);
    let cycles = if LOOKUP_YEARS.contains(&year) {
        0
    } else {
        (year - year.clamp(*LOOKUP_YEARS.start(), *LOOKUP_YEARS.end())).div_euclid(400) + i64::from(year > 0)
    };
    let (year, month, day) = crate::civil_from_days(local_days - cycles * DAYS_PER_CYCLE);
    let date =
        Date::new(i16::try_from(year).ok()?, i8::try_from(month).ok()?, i8::try_from(day).ok()?).ok()?;
    let instant =
        tz.to_ambiguous_timestamp(date.to_datetime(jiff::civil::Time::midnight())).compatible().ok()?;
    instant.as_millisecond().checked_add(cycles.checked_mul(DAYS_PER_CYCLE * MS_PER_DAY)?)
}

/// `localDayRangeMs(date)`: the `[start, end)` milliseconds of the local
/// calendar day `date` (`YYYY-MM-DD`), from its local midnight to the next
/// one, so the day of a daylight saving change is 23 or 25 hours long.
/// `None` for text of another form and for a day a `Date` cannot hold. The
/// parts are read as numbers and carry like [`local_date_ms`]: `0050-01-01`
/// is 1950-01-01 and `2026-13-01` is 2027-01-01.
pub fn local_day_range_ms(date: &str) -> Option<(i64, i64)> {
    let (year, month, day) = date_parts(date)?;
    let start = local_date_ms(year, month - 1, day)?;
    let end = local_date_ms(year, month - 1, day + 1)?;
    Some((start, end))
}

/// The numbers of `^(\d{4})-(\d{2})-(\d{2})$`, ASCII digits only.
fn date_parts(date: &str) -> Option<(i64, i64, i64)> {
    let bytes = date.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let number = |range: std::ops::Range<usize>| {
        let digits = &bytes[range];
        digits
            .iter()
            .all(u8::is_ascii_digit)
            .then(|| digits.iter().fold(0, |n, d| n * 10 + i64::from(d - b'0')))
    };
    Some((number(0..4)?, number(5..7)?, number(8..10)?))
}

/// `isUtcDay(text)`: `YYYY-MM-DD` naming a day of the Gregorian calendar
/// whose year has four digits as `Date.UTC` reads it, so the years 0000 to
/// 0099 (read as 1900 to 1999) are not days.
pub fn is_utc_day(text: &str) -> bool {
    let Some((year, month, day)) = date_parts(text) else { return false };
    year >= 100 && (1..=12).contains(&month) && day >= 1 && day <= days_in_month(year, month)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    let next = if month == 12 { days_from_civil(year + 1, 1) } else { days_from_civil(year, month + 1) };
    next - days_from_civil(year, month)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zone(name: &str) -> TimeZone {
        TimeZone::get(name).unwrap()
    }

    /// `new Date(...).getTime()` in Node with TZ set to the zone.
    #[test]
    fn local_midnights_follow_the_zone() {
        let utc = zone("UTC");
        assert_eq!(local_date_ms_in(&utc, 2026, 0, 1), Some(1_767_225_600_000));
        let tokyo = zone("Asia/Tokyo");
        assert_eq!(local_date_ms_in(&tokyo, 2026, 0, 1), Some(1_767_193_200_000));
    }

    #[test]
    fn a_missing_midnight_is_the_first_instant_after_the_jump() {
        // Santiago moved its clocks from 00:00 to 01:00 on 2024-09-08:
        // new Date(2024, 8, 8) is 2024-09-08T04:00:00Z, which is 01:00 there.
        let santiago = zone("America/Santiago");
        assert_eq!(local_date_ms_in(&santiago, 2024, 8, 8), Some(1_725_768_000_000));
    }

    #[test]
    fn a_doubled_midnight_is_the_earlier_one() {
        // Havana moved its clocks from 01:00 back to 00:00 on 2024-11-03:
        // new Date(2024, 10, 3) is the first 00:00, 2024-11-03T04:00:00Z.
        let havana = zone("America/Havana");
        assert_eq!(local_date_ms_in(&havana, 2024, 10, 3), Some(1_730_606_400_000));
    }

    #[test]
    fn parts_carry_and_two_digit_years_are_the_1900s() {
        let utc = zone("UTC");
        assert_eq!(local_date_ms_in(&utc, 2026, 12, 1), local_date_ms_in(&utc, 2027, 0, 1));
        assert_eq!(local_date_ms_in(&utc, 2026, -1, 1), local_date_ms_in(&utc, 2025, 11, 1));
        assert_eq!(local_date_ms_in(&utc, 2026, 1, 29), local_date_ms_in(&utc, 2026, 2, 1));
        assert_eq!(local_date_ms_in(&utc, 2026, 0, 0), local_date_ms_in(&utc, 2025, 11, 31));
        assert_eq!(local_date_ms_in(&utc, 50, 0, 1), local_date_ms_in(&utc, 1950, 0, 1));
        assert_eq!(local_date_ms_in(&utc, 99, 11, 31), local_date_ms_in(&utc, 1999, 11, 31));
        assert_eq!(local_date_ms_in(&utc, 100, 0, 1), Some(-59_011_459_200_000));
    }

    #[test]
    fn far_dates_keep_the_offset_and_the_range_of_a_date() {
        let new_york = zone("America/New_York");
        // new Date(10000, 0, 1) and new Date(275760, 8, 13) with
        // TZ=America/New_York; the second is past the range of a Date.
        assert_eq!(local_date_ms_in(&new_york, 10_000, 0, 1), Some(253_402_318_800_000));
        assert_eq!(local_date_ms_in(&new_york, 275_760, 8, 13), None);
        assert_eq!(local_date_ms_in(&zone("UTC"), 275_760, 8, 13), Some(MAX_TIME_MS));
        assert_eq!(local_date_ms_in(&zone("UTC"), i64::MAX, 0, 1), None);
        assert_eq!(local_date_ms_in(&zone("UTC"), 2026, 0, 1 << 39), None);
        assert_eq!(local_date_ms_in(&zone("UTC"), 2026, -(1 << 39), 1), None);
    }

    #[test]
    fn day_ranges_read_four_digit_dates_only() {
        assert_eq!(date_parts("2026-10-16"), Some((2026, 10, 16)));
        for text in ["2026-1-16", "2026-10-16 ", "２０２６-10-16", "20261016", "2026/10/16", ""] {
            assert_eq!(date_parts(text), None, "{text:?}");
        }
    }

    #[test]
    fn utc_days_are_real_days_with_four_digit_years() {
        for day in ["2026-10-16", "2024-02-29", "2000-02-29", "0100-01-01", "9999-12-31"] {
            assert!(is_utc_day(day), "{day}");
        }
        for day in
            ["2026-02-29", "1900-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "0050-01-01", "0099-12-31"]
        {
            assert!(!is_utc_day(day), "{day}");
        }
    }
}
