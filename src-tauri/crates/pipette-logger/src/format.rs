// SPDX-License-Identifier: GPL-2.0-or-later
//! The line format of src/main/logger.ts: the timestamp is JavaScript's
//! `Date.prototype.toISOString()` and the level is upper case.

use log::Level;

/// The level as src/main/logger.ts writes it. The Electron build has no
/// TRACE level, so TRACE is written as DEBUG.
fn level_name(level: Level) -> &'static str {
    match level {
        Level::Error => "ERROR",
        Level::Warn => "WARN",
        Level::Info => "INFO",
        Level::Debug | Level::Trace => "DEBUG",
    }
}

/// `[<timestamp>] [<LEVEL>] <message>\n` for milliseconds since the Unix
/// epoch.
pub fn format_line(epoch_ms: i64, level: Level, message: &str) -> String {
    format!("[{}] [{}] {message}\n", pipette_time::iso_8601_millis(epoch_ms), level_name(level))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_is_written_as_debug() {
        assert_eq!(format_line(0, Level::Trace, "x"), "[1970-01-01T00:00:00.000Z] [DEBUG] x\n");
    }
}
