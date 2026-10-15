// SPDX-License-Identifier: GPL-2.0-or-later
//! `Date.prototype.toISOString` and `Date.parse` of JavaScript, for the
//! timestamps the Electron build writes and reads (log lines, sync
//! envelopes, the clocks of the entry stores).

/// The largest distance from the epoch a JavaScript `Date` can hold, in
/// milliseconds (100,000,000 days).
pub const MAX_TIME_MS: i64 = 8_640_000_000_000_000;

/// `YYYY-MM-DDTHH:MM:SS.sssZ` in UTC for milliseconds since the Unix epoch,
/// as `new Date(epoch_ms).toISOString()` writes it: years 0 to 9999 with
/// four digits, other years as a sign and six digits (`+010000`,
/// `-000001`). For a time past [`MAX_TIME_MS`], where JavaScript throws a
/// RangeError, the result is meaningless; [`iso_8601_millis_checked`] is
/// the checked form.
pub fn iso_8601_millis(epoch_ms: i64) -> String {
    let days = epoch_ms.div_euclid(86_400_000);
    let ms_of_day = epoch_ms.rem_euclid(86_400_000);
    let (year, month, day) = civil_from_days(days);
    let (secs, ms) = (ms_of_day / 1000, ms_of_day % 1000);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{}{:06}", if year < 0 { '-' } else { '+' }, year.abs())
    };
    format!("{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z", secs / 3600, secs / 60 % 60, secs % 60)
}

/// [`iso_8601_millis`], or `None` where `toISOString` throws (a time past
/// [`MAX_TIME_MS`]).
pub fn iso_8601_millis_checked(epoch_ms: i64) -> Option<String> {
    (epoch_ms.abs() <= MAX_TIME_MS).then(|| iso_8601_millis(epoch_ms))
}

/// `new Date(text).getTime()` for the ECMAScript Date Time String Format
/// (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, each optionally followed by
/// `THH:mm`, `THH:mm:ss` or `THH:mm:ss.s…` and `Z` or `±HH:mm`; the year
/// may be `±YYYYYY`); `None` where JavaScript gives NaN.
///
/// Where it differs from V8:
/// - a date-time without an offset is read as UTC; JavaScript reads it as
///   local time (the Electron build only writes `Z` times);
/// - the forms only V8's fallback parser accepts (`Jan 1 2026`,
///   `2026-1-1`, a lowercase `t` / `z`, `+0900`, leading spaces, a date
///   followed by `Z`, …) are `None`.
///
/// As in V8, the day is not checked against the month's length
/// (`2026-02-30` is March 2), `24:00` is the end of the day, and digits
/// past the milliseconds are ignored.
pub fn parse_date_time_string(text: &str) -> Option<i64> {
    let mut p = Cursor { bytes: text.as_bytes(), at: 0 };
    let year = match p.peek() {
        Some(sign @ (b'+' | b'-')) => {
            p.at += 1;
            let digits = p.digits(6)?;
            if sign == b'-' && digits == 0 {
                return None;
            }
            if sign == b'-' { -digits } else { digits }
        }
        _ => p.digits(4)?,
    };
    let mut month = 1;
    let mut day = 1;
    if p.eat(b'-') {
        month = p.digits(2)?;
        if p.eat(b'-') {
            day = p.digits(2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut time_ms = 0;
    let mut offset_ms = 0;
    if p.eat(b'T') {
        let hours = p.digits(2)?;
        if !p.eat(b':') {
            return None;
        }
        let minutes = p.digits(2)?;
        let mut seconds = 0;
        let mut millis = 0;
        if p.eat(b':') {
            seconds = p.digits(2)?;
            if p.eat(b'.') {
                millis = p.fraction_millis()?;
            }
        }
        if hours > 24 || minutes > 59 || seconds > 59 || (hours == 24 && minutes + seconds + millis > 0) {
            return None;
        }
        time_ms = ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
        if !p.eat(b'Z')
            && let Some(sign @ (b'+' | b'-')) = p.peek()
        {
            p.at += 1;
            let offset_hours = p.digits(2)?;
            if !p.eat(b':') {
                return None;
            }
            let offset_minutes = p.digits(2)?;
            if offset_hours > 23 || offset_minutes > 59 {
                return None;
            }
            let offset = (offset_hours * 60 + offset_minutes) * 60_000;
            offset_ms = if sign == b'+' { offset } else { -offset };
        }
    }
    if p.at != p.bytes.len() {
        return None;
    }
    let ms = (days_from_civil(year, month) + day - 1) * 86_400_000 + time_ms - offset_ms;
    (ms.abs() <= MAX_TIME_MS).then_some(ms)
}

struct Cursor<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        let found = self.peek() == Some(byte);
        if found {
            self.at += 1;
        }
        found
    }

    /// Exactly `count` ASCII digits as a number.
    fn digits(&mut self, count: usize) -> Option<i64> {
        let digits = self.bytes.get(self.at..self.at + count)?;
        if !digits.iter().all(u8::is_ascii_digit) {
            return None;
        }
        self.at += count;
        Some(digits.iter().fold(0, |n, d| n * 10 + i64::from(d - b'0')))
    }

    /// One or more digits of a fraction of a second, as whole milliseconds.
    fn fraction_millis(&mut self) -> Option<i64> {
        let start = self.at;
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.at += 1;
        }
        let digits = &self.bytes[start..self.at];
        if digits.is_empty() {
            return None;
        }
        Some((0..3).fold(0, |n, i| n * 10 + digits.get(i).map_or(0, |d| i64::from(d - b'0'))))
    }
}

/// Days from 1970-01-01 to the first of `month` (1 to 12) of `year` in the
/// proleptic Gregorian calendar (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
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

    #[test]
    fn years_outside_0_to_9999_have_a_sign_and_six_digits() {
        // new Date(8.64e15).toISOString(), new Date(-1e14).toISOString(),
        // new Date(253402300800000).toISOString()
        assert_eq!(iso_8601_millis(MAX_TIME_MS), "+275760-09-13T00:00:00.000Z");
        assert_eq!(iso_8601_millis(-MAX_TIME_MS), "-271821-04-20T00:00:00.000Z");
        assert_eq!(iso_8601_millis(-100_000_000_000_000), "-001199-02-15T14:13:20.000Z");
        assert_eq!(iso_8601_millis(253_402_300_800_000), "+010000-01-01T00:00:00.000Z");
        assert_eq!(iso_8601_millis(-62_167_219_200_001), "-000001-12-31T23:59:59.999Z");
    }

    #[test]
    fn the_checked_form_refuses_what_to_iso_string_throws_for() {
        assert_eq!(iso_8601_millis_checked(MAX_TIME_MS).as_deref(), Some("+275760-09-13T00:00:00.000Z"));
        assert_eq!(iso_8601_millis_checked(MAX_TIME_MS + 1), None);
        assert_eq!(iso_8601_millis_checked(-MAX_TIME_MS - 1), None);
    }

    #[test]
    fn parses_the_date_time_string_format() {
        // new Date(text).getTime() in Node (TZ=UTC for the local forms).
        let cases: &[(&str, Option<i64>)] = &[
            ("2026-01-01T00:00:00.000Z", Some(1_767_225_600_000)),
            ("2026-01-01", Some(1_767_225_600_000)),
            ("2026-01", Some(1_767_225_600_000)),
            ("2026", Some(1_767_225_600_000)),
            ("2026-01-01T00:00Z", Some(1_767_225_600_000)),
            ("2026-01-01T00:00:00.1Z", Some(1_767_225_600_100)),
            ("2026-01-01T00:00:00.1234567890123Z", Some(1_767_225_600_123)),
            ("2026-01-01T24:00:00.000Z", Some(1_767_312_000_000)),
            ("2026-01-01T00:00:00+09:00", Some(1_767_193_200_000)),
            ("2026-01-01T00:00:00.000-00:00", Some(1_767_225_600_000)),
            ("2026-01-01T00:00:00", Some(1_767_225_600_000)),
            ("+010000-01-01T00:00:00.000Z", Some(253_402_300_800_000)),
            ("-000001-01-01T00:00:00.000Z", Some(-62_198_755_200_000)),
            ("+275760-09-13T00:00:00.000Z", Some(MAX_TIME_MS)),
            ("-271821-04-20T00:00:00Z", Some(-MAX_TIME_MS)),
            ("2026-02-30T00:00:00Z", Some(1_772_409_600_000)),
            ("0000-01-01T00:00:00Z", Some(-62_167_219_200_000)),
            ("-000000-01-01T00:00:00.000Z", None),
            ("+275760-09-13T00:00:00.001Z", None),
            ("-271821-04-19T23:59:59.999Z", None),
            ("2026-01-01T24:00:01Z", None),
            ("2026-01-01T00:00:60Z", None),
            ("2026-13-01", None),
            ("2026-01-32", None),
            ("2026-01-00", None),
            ("2026-01-01T00:00:00.Z", None),
            ("2026-01-01T00:00:00.000+24:00", None),
            ("2026-01-01T00Z", None),
            ("2026-01-01T00:00:00.000Z ", None),
            ("20260101", None),
            ("", None),
            ("garbage", None),
        ];
        for &(text, expected) in cases {
            assert_eq!(parse_date_time_string(text), expected, "{text:?}");
        }
    }

    #[test]
    fn v8_only_forms_are_not_read() {
        // Each of these parses in V8 through its fallback parser.
        for text in [
            "Jan 1 2026",
            "2026-1-1",
            " 2026-01-01",
            "2026-01-01t00:00:00z",
            "2026-01-01T00:00:00+0900",
            "2026-01-01Z",
            "12",
        ] {
            assert_eq!(parse_date_time_string(text), None, "{text:?}");
        }
    }

    #[test]
    fn parse_and_format_round_trip() {
        for ms in
            [0, 1, -1, 1_767_225_600_123, MAX_TIME_MS, -MAX_TIME_MS, 253_402_300_800_000, -62_198_755_200_000]
        {
            assert_eq!(parse_date_time_string(&iso_8601_millis(ms)), Some(ms));
        }
    }
}
