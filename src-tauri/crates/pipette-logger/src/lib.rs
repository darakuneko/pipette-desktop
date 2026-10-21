// SPDX-License-Identifier: GPL-2.0-or-later
//! The app's log, the same files and lines as the 0.4 build's log:
//!
//! - `<userData>/logs/pipette-0.log`, rotated before a write once it has
//!   reached 5 MB: `pipette-3.log` → `pipette-4.log`, …, `pipette-0.log` →
//!   `pipette-1.log`, and the old `pipette-4.log` is deleted;
//! - one line per record, `[<ISO 8601 UTC with ms>] [<LEVEL>] <message>\n`
//!   (tests/ts_log_lines.rs checks recorded lines of the 0.4 build's logger).
//!
//! Every line is written to stderr; to the files only while they are
//! enabled ([`set_file_enabled`], off after [`init`]). The home folder in a
//! message is replaced with `~` on both (mask.rs). Records of the app's own crates
//! (targets starting with `pipette`) are kept from DEBUG up; those of other
//! crates (Tauri, the WebView) from WARN up, so their debug output does not
//! fill the files. A panic is logged as an ERROR before the default panic
//! output, except one raised inside [`expecting_panics`], which its caller
//! catches and reports itself: that one is logged as a DEBUG record only.
//! When the log directory cannot be created the logger still writes to
//! stderr.
//!
//! [`set_file_enabled`] works on the files under the logger's lock, and does
//! nothing before [`init`] or when the logger writes to stderr only. Nothing
//! under that lock logs or panics: a record would take the lock again. So it
//! returns its error, for the caller to log.

mod format;
mod mask;
mod rotating_file;

use std::cell::Cell;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use log::{Level, LevelFilter, Log, Metadata, Record};

pub use format::format_line;
use mask::HomeMask;
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

/// The log files and whether lines go to them.
struct FileOutput {
    file: RotatingFile,
    enabled: bool,
}

/// The log files, shared by [`FileLogger`] and [`set_file_enabled`]. Unset
/// before [`init`] and when the log directory could not be created: stderr
/// only.
static FILE: OnceLock<Mutex<FileOutput>> = OnceLock::new();

/// The files under the logger's lock (see the module doc); `None` when there
/// are none.
fn lock_file() -> Option<std::sync::MutexGuard<'static, FileOutput>> {
    FILE.get().map(|file| file.lock().unwrap_or_else(std::sync::PoisonError::into_inner))
}

struct FileLogger {
    home: HomeMask,
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
        let message = record.args().to_string();
        let line = format_line(pipette_time::now_ms(), record.level(), &self.home.apply(&message));
        let _ = std::io::stderr().write_all(line.as_bytes());
        let Some(mut output) = lock_file() else {
            return;
        };
        if !output.enabled {
            return;
        }
        let result = output.file.append(&line);
        drop(output);
        if let Err(err) = result {
            // Logging must never take the app down; the line is on stderr.
            let _ = writeln!(std::io::stderr(), "failed to write the log file: {err}");
        }
    }

    fn flush(&self) {}
}

/// Installs the logger, with the files in `log_dir` (created if missing)
/// disabled, and the panic hook. `home` is the home folder to mask. Call
/// once, first thing at startup. When `log_dir` cannot be created the logger
/// and the hook are installed anyway, writing to stderr only, and the error
/// says why.
pub fn init(log_dir: PathBuf, home: Option<&Path>) -> Result<(), InitError> {
    let created = std::fs::create_dir_all(&log_dir);
    let logger = FileLogger { home: HomeMask::new(home) };
    log::set_boxed_logger(Box::new(logger)).map_err(|_| InitError::AlreadyInstalled)?;
    if created.is_ok() {
        let file = RotatingFile::new(log_dir.clone(), MAX_FILE_SIZE);
        let _ = FILE.set(Mutex::new(FileOutput { file, enabled: false }));
    }
    log::set_max_level(LevelFilter::Debug);
    install_panic_hook();
    created.map_err(|err| InitError::CreateDir(log_dir, err))
}

/// Starts or stops writing lines to the files, under the logger's lock
/// (module doc). Stopping also removes them under the same lock, so no line
/// is appended between the switch and the removal.
pub fn set_file_enabled(enabled: bool) -> std::io::Result<()> {
    let Some(mut output) = lock_file() else {
        return Ok(());
    };
    output.enabled = enabled;
    if enabled { Ok(()) } else { output.file.remove_files() }
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if panics_are_expected() {
            log::debug!("caught panic: {info}");
            return;
        }
        log::error!("panic: {info}");
        previous(info);
    }));
}

thread_local! {
    /// Whether this thread is inside [`expecting_panics`].
    static EXPECTING_PANICS: Cell<bool> = const { Cell::new(false) };
}

fn panics_are_expected() -> bool {
    EXPECTING_PANICS.with(Cell::get)
}

/// Runs `f`, whose panics the caller catches (`catch_unwind`) and reports
/// itself: the panic hook logs a panic of this thread inside `f` as a DEBUG
/// record and leaves out the default panic output. Panics elsewhere, and on
/// other threads, are reported as usual.
pub fn expecting_panics<T>(f: impl FnOnce() -> T) -> T {
    /// Restores the flag when `f` returns or unwinds.
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            EXPECTING_PANICS.with(|flag| flag.set(self.0));
        }
    }
    let _restore = Restore(EXPECTING_PANICS.with(|flag| flag.replace(true)));
    f()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panics_are_expected_only_inside_the_scope() {
        assert!(!panics_are_expected());
        assert!(expecting_panics(|| expecting_panics(panics_are_expected) && panics_are_expected()));
        assert!(!panics_are_expected());
        let caught = std::panic::catch_unwind(|| expecting_panics(|| panic!("expected")));
        assert!(caught.is_err());
        assert!(!panics_are_expected());
        assert!(!expecting_panics(|| std::thread::spawn(panics_are_expected).join().unwrap()));
    }

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
