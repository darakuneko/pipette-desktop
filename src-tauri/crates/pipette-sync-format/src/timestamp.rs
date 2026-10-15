// SPDX-License-Identifier: GPL-2.0-or-later
//! `Date.prototype.toISOString` for the current time.

use std::time::{SystemTime, UNIX_EPOCH};

/// `YYYY-MM-DDTHH:MM:SS.sssZ` for `time`. Times before 1970 are clamped to
/// the epoch; envelopes are only stamped with the current time.
pub(crate) fn iso_8601_millis(time: SystemTime) -> String {
    let millis = time.duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let secs_total = millis / 1000;
    let days = i64::try_from(secs_total / 86_400).unwrap_or(i64::MAX);
    let secs_of_day = secs_total % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        secs_of_day / 3600,
        (secs_of_day % 3600) / 60,
        secs_of_day % 60,
        millis % 1000
    )
}

/// Proleptic Gregorian date of `days` since 1970-01-01 (Howard Hinnant's
/// `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    // `day` is 1..=31 and `month` 1..=12 by construction.
    (year, u32::try_from(month).unwrap_or(1), u32::try_from(day).unwrap_or(1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(millis: u64) -> String {
        iso_8601_millis(UNIX_EPOCH + Duration::from_millis(millis))
    }

    #[test]
    fn formats_like_to_iso_string() {
        assert_eq!(at(0), "1970-01-01T00:00:00.000Z");
        // new Date(951782400123).toISOString() — a leap day.
        assert_eq!(at(951_782_400_123), "2000-02-29T00:00:00.123Z");
        // new Date(1791936000999).toISOString()
        assert_eq!(at(1_791_936_000_999), "2026-10-14T00:00:00.999Z");
        // new Date(4102444799999).toISOString()
        assert_eq!(at(4_102_444_799_999), "2099-12-31T23:59:59.999Z");
    }
}
