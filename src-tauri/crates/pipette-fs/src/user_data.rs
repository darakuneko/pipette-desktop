// SPDX-License-Identifier: GPL-2.0-or-later
//! Where the userData directory is: the root of everything the app keeps on
//! disk (config, logs, sync data, the quit marker).
//!
//! - `PIPETTE_USER_DATA_DIR`, when set to an absolute path, wins. It isolates
//!   e2e runs, CI and screenshots, and lets a run use real data (with the
//!   Electron build stopped).
//! - Otherwise `<config dir>/app.pipette.desktop`, a directory of its own
//!   while the backend is being ported, so unfinished stores never touch the
//!   Electron build's data in `<config dir>/pipette-desktop`.
//!
//! `<config dir>` is the base Electron's `app.getPath('userData')` is under
//! on every OS (`$XDG_CONFIG_HOME` or `~/.config` on Linux,
//! `~/Library/Application Support` on macOS, `%APPDATA%` on Windows).

use std::ffi::OsString;
use std::path::PathBuf;

/// The environment variable that names the userData directory.
pub const USER_DATA_DIR_ENV: &str = "PIPETTE_USER_DATA_DIR";

/// The default userData directory name while the backend is being ported:
/// the app identifier.
pub const MIGRATION_USER_DATA_NAME: &str = "app.pipette.desktop";

/// The Electron build's userData directory name, its package name (`name`
/// in package.json, which src/tauri-shim/__tests__/user-data-name.test.ts
/// checks against this value).
pub const ELECTRON_USER_DATA_NAME: &str = "pipette-desktop";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum UserDataError {
    #[error("{USER_DATA_DIR_ENV} must be an absolute path, got {0:?}")]
    NotAbsolute(PathBuf),
    #[error("no config directory to put the userData directory in")]
    NoConfigDir,
}

/// The userData directory from the environment and the OS config directory.
/// The directory is not created.
pub fn user_data_dir() -> Result<PathBuf, UserDataError> {
    resolve_user_data_dir(std::env::var_os(USER_DATA_DIR_ENV), dirs::config_dir())
}

/// The userData directory for an `override_dir` (the value of
/// [`USER_DATA_DIR_ENV`]; empty counts as unset) and a `config_dir`.
pub fn resolve_user_data_dir(
    override_dir: Option<OsString>,
    config_dir: Option<PathBuf>,
) -> Result<PathBuf, UserDataError> {
    if let Some(dir) = override_dir.filter(|dir| !dir.is_empty()).map(PathBuf::from) {
        if !dir.is_absolute() {
            return Err(UserDataError::NotAbsolute(dir));
        }
        return Ok(dir);
    }
    config_dir.map(|dir| dir.join(MIGRATION_USER_DATA_NAME)).ok_or(UserDataError::NoConfigDir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn absolute(path: &str) -> PathBuf {
        // An absolute path on every OS the tests run on.
        std::env::temp_dir().join(path)
    }

    #[test]
    fn the_default_is_the_migration_directory_under_the_config_dir() {
        let config = absolute("config");
        assert_eq!(resolve_user_data_dir(None, Some(config.clone())), Ok(config.join("app.pipette.desktop")));
    }

    #[test]
    fn an_absolute_override_wins() {
        let ud = absolute("ud");
        assert_eq!(resolve_user_data_dir(Some(ud.clone().into()), Some(absolute("config"))), Ok(ud.clone()));
        assert_eq!(resolve_user_data_dir(Some(ud.clone().into()), None), Ok(ud));
    }

    #[test]
    fn an_empty_override_counts_as_unset() {
        let config = absolute("config");
        assert_eq!(
            resolve_user_data_dir(Some(OsString::new()), Some(config.clone())),
            Ok(config.join(MIGRATION_USER_DATA_NAME))
        );
    }

    #[test]
    fn a_relative_override_is_refused() {
        assert_eq!(
            resolve_user_data_dir(Some("relative/ud".into()), Some(absolute("config"))),
            Err(UserDataError::NotAbsolute(PathBuf::from("relative/ud")))
        );
    }

    #[test]
    fn without_a_config_dir_there_is_no_default() {
        assert_eq!(resolve_user_data_dir(None, None), Err(UserDataError::NoConfigDir));
    }

    #[test]
    fn the_migration_directory_is_not_the_electron_one() {
        assert_ne!(MIGRATION_USER_DATA_NAME, ELECTRON_USER_DATA_NAME);
    }
}
