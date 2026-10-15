// SPDX-License-Identifier: GPL-2.0-or-later
//! `Date.prototype.toISOString` for the current time.

use std::time::{SystemTime, UNIX_EPOCH};

/// `YYYY-MM-DDTHH:MM:SS.sssZ` for `time`. Times before 1970 are clamped to
/// the epoch; envelopes are only stamped with the current time.
pub(crate) fn iso_8601_millis(time: SystemTime) -> String {
    let millis = time.duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    pipette_time::iso_8601_millis(i64::try_from(millis).unwrap_or(i64::MAX))
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
