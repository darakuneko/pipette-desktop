// SPDX-License-Identifier: GPL-2.0-or-later
//! `Date.prototype.toISOString` of JavaScript, for the timestamps the
//! Electron build writes (log lines, sync envelopes).

/// `YYYY-MM-DDTHH:MM:SS.sssZ` in UTC for milliseconds since the Unix epoch,
/// as `new Date(epoch_ms).toISOString()` writes it for years 0 to 9999
/// (times before 1970 included).
pub fn iso_8601_millis(epoch_ms: i64) -> String {
    let days = epoch_ms.div_euclid(86_400_000);
    let ms_of_day = epoch_ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let (secs, ms) = (ms_of_day / 1000, ms_of_day % 1000);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        secs / 3600,
        secs / 60 % 60,
        secs % 60
    )
}

/// The proleptic Gregorian date of a day count from 1970-01-01 (Howard
/// Hinnant's `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn around_the_epoch() {
        assert_eq!(iso_8601_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_8601_millis(-1), "1969-12-31T23:59:59.999Z");
        assert_eq!(iso_8601_millis(86_400_000), "1970-01-02T00:00:00.000Z");
        // new Date(-62135596800000).toISOString()
        assert_eq!(iso_8601_millis(-62_135_596_800_000), "0001-01-01T00:00:00.000Z");
    }

    #[test]
    fn leap_days_and_century_years() {
        // 2000-02-29 and 2024-02-29 exist; 2100 is not a leap year.
        assert_eq!(iso_8601_millis(951_782_400_123), "2000-02-29T00:00:00.123Z");
        assert_eq!(iso_8601_millis(1_709_164_800_000), "2024-02-29T00:00:00.000Z");
        assert_eq!(iso_8601_millis(4_107_542_400_000), "2100-03-01T00:00:00.000Z");
        assert_eq!(iso_8601_millis(4_102_444_799_999), "2099-12-31T23:59:59.999Z");
    }
}
