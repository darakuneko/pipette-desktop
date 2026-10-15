// SPDX-License-Identifier: GPL-2.0-or-later
//! The app config, `<userData>/config.json`, kept as the Electron build's
//! electron-store 11 (conf 15) keeps it, so either build reads what the
//! other wrote and writes it back byte for byte the same: JSON with tab
//! indentation and no final newline, JavaScript's number formatting and key
//! order (pipette-js-json), unknown keys and conf's `__internal__` kept.
//! The goldens in tests/fixtures are recorded from the real electron-store
//! by scripts/app-config-fixtures/.
//!
//! Tauri-free; the app wires the IPC commands and the change listeners.

mod coerce;
mod defaults;
mod file;
mod store;

pub use coerce::{clamp_zoom_factor, truthy};
pub use defaults::{DEFAULTS, Defaults};
pub use pipette_js_json::{JsString, Object, Value};
pub use store::{AppConfigStore, CONFIG_FILE_NAME};

/// Why a config operation failed. The messages of the value and key checks
/// are conf's, which the renderer saw from the Electron build.
#[derive(Debug, thiserror::Error)]
pub enum AppConfigError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("config.json is not valid JSON: {0}")]
    Parse(#[from] pipette_js_json::ParseError),
    #[error("Use `delete()` to clear values")]
    Undefined,
    #[error("Please don't use the __internal__ key, as it's used to manage this module internal operations.")]
    ReservedKey,
    #[error("`{0}` is a property path; only top-level keys can be set")]
    PathKey(String),
    #[error("the value is not valid JSON: {0}")]
    InvalidValue(pipette_js_json::ParseError),
}
