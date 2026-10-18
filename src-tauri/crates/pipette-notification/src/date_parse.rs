// SPDX-License-Identifier: GPL-2.0-or-later
//! `isValidIsoDate` of src/main/notification-store.ts: a non-empty string
//! that `Date.parse` reads. `Date.parse` reads the ECMAScript Date Time
//! String Format, the RFC 2822 form `Date.prototype.toUTCString` writes,
//! and whatever else the engine's fallback parser makes of a string. Only
//! the first two are read here:
//!
//! - the Date Time String Format as `pipette_time::parse_date_time_string`
//!   reads it;
//! - RFC 2822 (RFC 5322 §3.3) date-times with a zone:
//!   `[ddd, ]d[d] MMM yyyy hh:mm[:ss] zone`, with single spaces, a two-digit
//!   year read as 2000 to 2049 or 1950 to 1999, case-insensitive day and
//!   month names, the weekday not checked against the date (V8 ignores
//!   it too), and the zone `±hhmm`, `UT`, `UTC`, `GMT`, `Z` or one of the
//!   North American zones of RFC 5322.
//!
//! Everything else is not a date here, even where V8 reads one
//! (`2026/10/18`, `Oct 18 2026`, a lowercase `t`, `+0900` in an ISO
//! string, a trailing comment, …): such a notice is dropped.

/// Whether `text` is a publication date the notice keeps.
pub fn is_valid_iso_date(text: &str) -> bool {
    !text.is_empty() && date_parse_ms(text).is_some()
}

/// `Date.parse(text)` for the forms read here, in milliseconds since the
/// epoch; `None` for NaN and for every other form.
pub fn date_parse_ms(text: &str) -> Option<i64> {
    pipette_time::parse_date_time_string(text).or_else(|| rfc_2822_ms(text))
}

const WEEKDAYS: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MONTHS: [&str; 12] =
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// The zones by name and their offsets from UTC in minutes.
const NAMED_ZONES: [(&str, i64); 12] = [
    ("ut", 0),
    ("utc", 0),
    ("gmt", 0),
    ("z", 0),
    ("edt", -4 * 60),
    ("est", -5 * 60),
    ("cdt", -5 * 60),
    ("cst", -6 * 60),
    ("mdt", -6 * 60),
    ("mst", -7 * 60),
    ("pdt", -7 * 60),
    ("pst", -8 * 60),
];

/// An RFC 2822 date-time as described in the module docs.
fn rfc_2822_ms(text: &str) -> Option<i64> {
    let rest = match text.split_once(", ") {
        Some((weekday, rest)) if WEEKDAYS.contains(&weekday.to_ascii_lowercase().as_str()) => rest,
        Some(_) => return None,
        None => text,
    };
    let fields: Vec<&str> = rest.split(' ').collect();
    let &[day, month, year, time, zone] = fields.as_slice() else { return None };
    let day = number(day, 1..=2).filter(|day| (1..=31).contains(day))?;
    let month = MONTHS.iter().position(|name| name.eq_ignore_ascii_case(month))? + 1;
    let year = match year.len() {
        2 => number(year, 2..=2).map(|year| if year < 50 { 2000 + year } else { 1900 + year })?,
        _ => number(year, 4..=4)?,
    };
    let (hours, minutes, seconds) = match *time.split(':').collect::<Vec<_>>().as_slice() {
        [hours, minutes] => (number(hours, 2..=2)?, number(minutes, 2..=2)?, 0),
        [hours, minutes, seconds] => {
            (number(hours, 2..=2)?, number(minutes, 2..=2)?, number(seconds, 2..=2)?)
        }
        _ => return None,
    };
    if hours > 23 || minutes > 59 || seconds > 59 {
        return None;
    }
    let offset_minutes = zone_offset_minutes(zone)?;
    // The same instant in the Date Time String Format, which reads the day
    // without checking it against the month's length, as V8 does here.
    let sign = if offset_minutes < 0 { '-' } else { '+' };
    let offset = offset_minutes.abs();
    pipette_time::parse_date_time_string(&format!(
        "{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}{sign}{:02}:{:02}",
        offset / 60,
        offset % 60
    ))
}

/// A zone's offset from UTC in minutes.
fn zone_offset_minutes(zone: &str) -> Option<i64> {
    if let Some((sign, digits)) = zone.split_at_checked(1)
        && (sign == "+" || sign == "-")
    {
        let hhmm = number(digits, 4..=4)?;
        let (hours, minutes) = (hhmm / 100, hhmm % 100);
        if hours > 23 || minutes > 59 {
            return None;
        }
        let offset = hours * 60 + minutes;
        return Some(if sign == "-" { -offset } else { offset });
    }
    let zone = zone.to_ascii_lowercase();
    NAMED_ZONES.iter().find(|(name, _)| *name == zone).map(|&(_, offset)| offset)
}

/// `text` as a number when it is ASCII digits only, as many as `lengths`
/// allows.
fn number(text: &str, lengths: std::ops::RangeInclusive<usize>) -> Option<i64> {
    if !lengths.contains(&text.len()) || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_rfc_2822_as_date_parse_does() {
        // Date.parse(text) in Node.
        let cases: &[(&str, i64)] = &[
            ("Sun, 18 Oct 2026 00:00:00 GMT", 1_792_281_600_000),
            ("Sun, 18 Oct 2026 09:00:00 +0900", 1_792_281_600_000),
            ("Sun, 18 Oct 2026 00:00:00 -0000", 1_792_281_600_000),
            ("18 Oct 2026 00:00 +0000", 1_792_281_600_000),
            ("sun, 18 oct 2026 00:00:00 gmt", 1_792_281_600_000),
            ("Mon, 18 Oct 2026 00:00:00 UT", 1_792_281_600_000),
            ("Sun, 18 Oct 2026 00:00:00 UTC", 1_792_281_600_000),
            ("Sun, 18 Oct 2026 00:00:00 Z", 1_792_281_600_000),
            ("Sun, 18 Oct 2026 00:00:00 EST", 1_792_299_600_000),
            ("Sun, 18 Oct 2026 00:00:00 PDT", 1_792_306_800_000),
            ("Sun, 8 Oct 2026 00:00:00 GMT", 1_791_417_600_000),
            ("Sun, 08 Oct 2026 00:00:00 GMT", 1_791_417_600_000),
            ("Sun, 18 Oct 26 00:00:00 GMT", 1_792_281_600_000),
            ("Sun, 18 Oct 49 00:00:00 GMT", 2_518_128_000_000),
            ("Sun, 18 Oct 50 00:00:00 GMT", -606_096_000_000),
            ("Sun, 31 Feb 2026 00:00:00 GMT", 1_772_496_000_000),
        ];
        for &(text, ms) in cases {
            assert_eq!(date_parse_ms(text), Some(ms), "{text:?}");
        }
    }

    #[test]
    fn other_rfc_2822_like_forms_are_not_dates() {
        for text in [
            // NaN in V8 too.
            "Sun, 00 Oct 2026 00:00:00 GMT",
            "Sun, 32 Oct 2026 00:00:00 GMT",
            "Sun, 18 Foo 2026 00:00:00 GMT",
            "Sun, 18 Oct 2026 00:00:00 A",
            // Read by V8, outside the forms read here.
            "Sun, 18 Oct 2026 00:00:00",
            "Sun,18 Oct 2026 00:00:00 GMT",
            "Sun, 18 Oct 2026  00:00:00 GMT",
            "Sunday, 18 Oct 2026 00:00:00 GMT",
            "Xyz, 18 Oct 2026 00:00:00 GMT",
            "Sun, 18 October 2026 00:00:00 GMT",
            "Sun, 18 Oct 026 00:00:00 GMT",
            "Sun, 18 Oct 12026 00:00:00 GMT",
            "Sun, 18 Oct 2026 24:00:00 GMT",
            "Sun, 18 Oct 2026 23:59:60 GMT",
            "Sun, 18 Oct 2026 0:0:0 GMT",
            "Sun, 18 Oct 2026 00:00:00.5 GMT",
            "Sun, 18 Oct 2026 00:00:00 +2400",
            "Sun, 18 Oct 2026 00:00:00 +0960",
            "Sun, 18 Oct 2026 00:00:00 GMT (comment)",
            "Sun Oct 18 2026 09:00:00 GMT+0900 (Japan Standard Time)",
        ] {
            assert_eq!(date_parse_ms(text), None, "{text:?}");
        }
    }

    #[test]
    fn an_empty_string_is_not_a_date() {
        assert!(!is_valid_iso_date(""));
        assert!(is_valid_iso_date("2026"));
    }
}
