// SPDX-License-Identifier: GPL-2.0-or-later
//! The app's log, the same files and lines as src/main/logger.ts of the
//! Electron build:
//!
//! - `<userData>/logs/pipette-0.log`, rotated before a write once it has
//!   reached 5 MB: `pipette-3.log` → `pipette-4.log`, …, `pipette-0.log` →
//!   `pipette-1.log`, and the old `pipette-4.log` is deleted;
//! - one line per record, `[<ISO 8601 UTC with ms>] [<LEVEL>] <message>\n`
//!   (tests/ts_log_lines.rs checks lines the TypeScript logger wrote).
//!
//! Every line is also written to stderr. Records of the app's own crates
//! (targets starting with `pipette`) are kept from DEBUG up; those of other
//! crates (Tauri, the WebView) from WARN up, so their debug output does not
//! fill the files. A panic is logged as an ERROR before the default panic
//! output. When the log directory cannot be created the logger still
//! writes to stderr.

mod format;
mod rotating_file;

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use log::{Level, LevelFilter, Log, Metadata, Record};

pub use format::format_line;
use rotating_file::{MAX_FILE_SIZE, RotatingFile};

/// Targets of the app's own crates (`pipette_app`, `pipette_hid`, …).
const OWN_TARGET_PREFIX: &str = "pipette";

#[derive(Debug, thiserror::Error)]
pub enum InitError {
    #[error("failed to create the log directory {0}: {1}")]
    CreateDir(PathBuf, std::io::Error),
    #[error("a logger is already installed")]
    AlreadyInstalled,
}

struct FileLogger {
    /// `None` when the log directory could not be created: stderr only.
    file: Option<Mutex<RotatingFile>>,
}

/// Whether a record of `target` at `level` is kept.
fn keeps(target: &str, level: Level) -> bool {
    let max = if target.starts_with(OWN_TARGET_PREFIX) { Level::Debug } else { Level::Warn };
    level <= max
}

impl Log for FileLogger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        keeps(metadata.target(), metadata.level())
    }

    fn log(&self, record: &Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format_line(pipette_time::now_ms(), record.level(), &record.args().to_string());
        let _ = std::io::stderr().write_all(line.as_bytes());
        let Some(file) = &self.file else {
            return;
        };
        let result = file.lock().unwrap_or_else(std::sync::PoisonError::into_inner).append(&line);
        if let Err(err) = result {
            // Logging must never take the app down; the line is on stderr.
            let _ = writeln!(std::io::stderr(), "failed to write the log file: {err}");
        }
    }

    fn flush(&self) {}
}

/// Installs the logger, writing to `log_dir` (created if missing), and the
/// panic hook. Call once, first thing at startup. When `log_dir` cannot be
/// created the logger and the hook are installed anyway, writing to stderr
/// only, and the error says why.
pub fn init(log_dir: PathBuf) -> Result<(), InitError> {
    let created = std::fs::create_dir_all(&log_dir);
    let file = created.is_ok().then(|| Mutex::new(RotatingFile::new(log_dir.clone(), MAX_FILE_SIZE)));
    log::set_boxed_logger(Box::new(FileLogger { file })).map_err(|_| InitError::AlreadyInstalled)?;
    log::set_max_level(LevelFilter::Debug);
    install_panic_hook();
    created.map_err(|err| InitError::CreateDir(log_dir, err))
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!("panic: {info}");
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_app_crates_log_from_debug_up() {
        assert!(keeps("pipette_app", Level::Debug));
        assert!(keeps("pipette_hid::service", Level::Debug));
        assert!(!keeps("pipette_app", Level::Trace));
    }

    #[test]
    fn other_crates_log_from_warn_up() {
        assert!(keeps("tauri::app", Level::Warn));
        assert!(keeps("tao", Level::Error));
        assert!(!keeps("tauri::app", Level::Info));
        assert!(!keeps("wry", Level::Debug));
    }
}
