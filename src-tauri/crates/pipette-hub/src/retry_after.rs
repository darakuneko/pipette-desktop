// SPDX-License-Identifier: GPL-2.0-or-later
//! `parseRetryAfter` of src/main/hub/hub-client.ts (copied verbatim into
//! hub-i18n.ts, hub-theme.ts and hub-key-labels.ts): a number of seconds as
//! JavaScript's `Number(header)` reads it, else an HTTP date as seconds from
//! now, rounded up.
//!
//! The number follows JavaScript's rules exactly (surrounding whitespace,
//! `0x` / `0o` / `0b`, fractions, exponents). The date is read in the three
//! forms of RFC 7231 §7.1.1.1 only, which is what a server sends;
//! `Date.parse` also takes other, engine-specific forms, which are not
//! followed. An asctime date is read as UTC, as the RFC says, where
//! `Date.parse` takes it as local time.

use pipette_entry_store::is_js_whitespace;

/// `parseRetryAfter(header)` at `now_ms` (`Date.now()`): `None` for an
/// absent or empty header and for one that is neither a non-negative
/// number nor a date.
pub fn parse_retry_after(header: Option<&str>, now_ms: f64) -> Option<f64> {
    let header = header.filter(|header| !header.is_empty())?;
    let seconds = js_number(header);
    if seconds.is_finite() && seconds >= 0.0 {
        return Some(seconds);
    }
    let date_ms = parse_http_date(header)?;
    Some(((date_ms - now_ms) / 1000.0).ceil().max(0.0))
}

/// `Number(text)` of JavaScript (StringToNumber): NaN where it is not a
/// numeric literal.
pub fn js_number(text: &str) -> f64 {
    let units: Vec<u16> = text.encode_utf16().collect();
    let start = units.iter().position(|&unit| !is_js_whitespace(unit)).unwrap_or(units.len());
    let end = units.iter().rposition(|&unit| !is_js_whitespace(unit)).map_or(start, |last| last + 1);
    // Whitespace is all in the BMP, so the cut falls between characters.
    let trimmed = String::from_utf16_lossy(&units[start..end]);
    if trimmed.is_empty() {
        return 0.0;
    }
    if let Some(value) = non_decimal(&trimmed) {
        return value;
    }
    decimal(&trimmed).unwrap_or(f64::NAN)
}

/// A `0x` / `0o` / `0b` literal (no sign allowed), or `None` when `text`
/// has none of those prefixes. NaN for a prefix without valid digits.
fn non_decimal(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'0' {
        return None;
    }
    let radix = match bytes[1] {
        b'x' | b'X' => 16,
        b'o' | b'O' => 8,
        b'b' | b'B' => 2,
        _ => return None,
    };
    let digits = &text[2..];
    if digits.is_empty() {
        return Some(f64::NAN);
    }
    let mut value = 0.0_f64;
    for ch in digits.chars() {
        match ch.to_digit(radix) {
            Some(digit) => value = value * f64::from(radix) + f64::from(digit),
            None => return Some(f64::NAN),
        }
    }
    Some(value)
}

/// A StrDecimalLiteral: an optional sign, then `Infinity` or digits with an
/// optional fraction and exponent.
fn decimal(text: &str) -> Option<f64> {
    let (negative, unsigned) = match text.as_bytes().first() {
        Some(b'+') => (false, &text[1..]),
        Some(b'-') => (true, &text[1..]),
        _ => (false, text),
    };
    let magnitude = if unsigned == "Infinity" {
        f64::INFINITY
    } else {
        if !is_unsigned_decimal(unsigned.as_bytes()) {
            return None;
        }
        unsigned.parse::<f64>().ok()?
    };
    Some(if negative { -magnitude } else { magnitude })
}

/// `digits [. digits?] exponent?` or `. digits exponent?`.
fn is_unsigned_decimal(bytes: &[u8]) -> bool {
    let digits = |from: usize| bytes[from..].iter().take_while(|b| b.is_ascii_digit()).count();
    let mut at = digits(0);
    let integer = at;
    let mut fraction = 0;
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        fraction = digits(at);
        at += fraction;
    }
    if integer == 0 && fraction == 0 {
        return false;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at += 1;
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at += 1;
        }
        let exponent = digits(at);
        if exponent == 0 {
            return false;
        }
        at += exponent;
    }
    at == bytes.len()
}

const MONTHS: [&str; 12] =
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/// An HTTP date in milliseconds since the epoch: IMF-fixdate
/// (`Sun, 06 Nov 1994 08:49:37 GMT`), the obsolete RFC 850 form
/// (`Sunday, 06-Nov-94 08:49:37 GMT`, a two-digit year below 50 in the
/// 2000s, as `Date.parse` reads it) or asctime (`Sun Nov  6 08:49:37 1994`).
/// Names are read without regard to case and the weekday is not checked
/// against the date, as `Date.parse` does; a day past the end of its month
/// runs into the next month, as there.
pub fn parse_http_date(text: &str) -> Option<f64> {
    let text = text.trim_matches(|c| c == ' ' || c == '\t');
    let (weekday, rest) = text.split_once([',', ' '])?;
    if weekday.is_empty() || !weekday.bytes().all(|b| b.is_ascii_alphabetic()) {
        return None;
    }
    if text.as_bytes()[weekday.len()] == b',' {
        let rest = rest.strip_prefix(' ')?;
        let fields: Vec<&str> = rest.split(' ').collect();
        match fields.as_slice() {
            [day, month, year, time, zone] => {
                let year = digits_value(year, 4, 4)?;
                imf_or_rfc850(day, month, year, time, zone)
            }
            [date, time, zone] => {
                let mut parts = date.split('-');
                let (day, month, year) = (parts.next()?, parts.next()?, parts.next()?);
                if parts.next().is_some() {
                    return None;
                }
                let year = digits_value(year, 2, 2)?;
                let year = if year < 50 { 2000 + year } else { 1900 + year };
                imf_or_rfc850(day, month, year, time, zone)
            }
            _ => None,
        }
    } else {
        // asctime: the day may be padded with a second space.
        let fields: Vec<&str> = rest.split(' ').filter(|field| !field.is_empty()).collect();
        let [month, day, time, year] = fields.as_slice() else { return None };
        let year = digits_value(year, 4, 4)?;
        civil_ms(year, month_index(month)?, digits_value(day, 1, 2)?, time)
    }
}

fn imf_or_rfc850(day: &str, month: &str, year: i64, time: &str, zone: &str) -> Option<f64> {
    if !(zone.eq_ignore_ascii_case("GMT") || zone.eq_ignore_ascii_case("UTC")) {
        return None;
    }
    civil_ms(year, month_index(month)?, digits_value(day, 1, 2)?, time)
}

fn month_index(name: &str) -> Option<i64> {
    let lower = name.to_ascii_lowercase();
    MONTHS.iter().position(|month| *month == lower).map(|index| index as i64)
}

/// The value of `text` when it is `min..=max` ASCII digits.
fn digits_value(text: &str, min: usize, max: usize) -> Option<i64> {
    if text.len() < min || text.len() > max || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// `year`, `month` (0-based), `day` and `HH:MM:SS` in UTC as milliseconds
/// since the epoch; the day may run past the month's end.
fn civil_ms(year: i64, month: i64, day: i64, time: &str) -> Option<f64> {
    if !(1..=31).contains(&day) {
        return None;
    }
    let mut parts = time.split(':');
    let hour = digits_value(parts.next()?, 2, 2)?;
    let minute = digits_value(parts.next()?, 2, 2)?;
    let second = digits_value(parts.next()?, 2, 2)?;
    if parts.next().is_some() || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let days = days_from_civil(year, month + 1, 1) + day - 1;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second;
    Some(seconds as f64 * 1000.0)
}

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`), `month` 1-based.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_from_march = (month + 9) % 12;
    let day_of_year = (153 * month_from_march + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_numbers_as_javascript_does() {
        for (text, expected) in [
            ("", 0.0),
            ("  ", 0.0),
            ("12", 12.0),
            (" 5 ", 5.0),
            ("\u{3000}7\u{feff}", 7.0),
            ("1.5", 1.5),
            (".5", 0.5),
            ("5.", 5.0),
            ("+5", 5.0),
            ("1e3", 1000.0),
            ("1E-1", 0.1),
            ("0x1f", 31.0),
            ("0B101", 5.0),
            ("0o17", 15.0),
            ("Infinity", f64::INFINITY),
            ("-Infinity", f64::NEG_INFINITY),
        ] {
            assert_eq!(js_number(text), expected, "{text:?}");
        }
        assert!(js_number("-0").is_sign_negative());
        for text in [
            "abc", "1_0", "1e", "1e+", "0x", "0x1g", "-0x1", "+0x1", ".", "+", "1 2", "inf", "infinity",
            "NaN", "1.2.3", "e5",
        ] {
            assert!(js_number(text).is_nan(), "{text:?}");
        }
    }

    #[test]
    fn reads_the_three_rfc_7231_date_forms() {
        let expected = Some(784_111_777_000.0);
        assert_eq!(parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT"), expected);
        assert_eq!(parse_http_date("Sunday, 06-Nov-94 08:49:37 GMT"), expected);
        assert_eq!(parse_http_date("Sun Nov  6 08:49:37 1994"), expected);
        assert_eq!(parse_http_date("Sun Nov 6 08:49:37 1994"), expected);
        assert_eq!(parse_http_date("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0.0));
        assert_eq!(parse_http_date("Wed, 29 Feb 2000 00:00:00 GMT"), Some(951_782_400_000.0));
    }

    /// Where `Date.parse` takes more than the three forms, these are not
    /// read: the retry then waits for no date.
    #[test]
    fn leaves_the_engine_specific_forms_unread() {
        for text in [
            "-5",
            "Sun, 06 Nov 1994 08:49:30.400 GMT",
            "Sun, 06 Nov 1994 24:00:00 GMT",
            "Sun, 06 Nov 1994 08:49:60 GMT",
            "1994-11-06T08:49:37Z",
            "Sun, 06 Nov 1994 08:49:37 +0000",
            "Sun, 06 Nov 1994 08:49:37",
            "Sun, 06 Nov 94 08:49:37 GMT",
            ", 06 Nov 1994 08:49:37 GMT",
        ] {
            assert_eq!(parse_http_date(text), None, "{text:?}");
        }
    }

    #[test]
    fn a_date_is_seconds_from_now_rounded_up_and_never_negative() {
        let now = 784_111_770_000.0;
        assert_eq!(parse_retry_after(Some("Sun, 06 Nov 1994 08:49:37 GMT"), now), Some(7.0));
        assert_eq!(parse_retry_after(Some("Sun, 06 Nov 1994 08:49:37 GMT"), now + 500.0), Some(7.0));
        assert_eq!(parse_retry_after(Some("Sun, 06 Nov 1994 08:49:00 GMT"), now), Some(0.0));
        assert_eq!(parse_retry_after(None, now), None);
        assert_eq!(parse_retry_after(Some(""), now), None);
        assert_eq!(parse_retry_after(Some("-5"), now), None);
    }
}
