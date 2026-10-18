// SPDX-License-Identifier: GPL-2.0-or-later
//! Where the userData directory is: the root of everything the app keeps on
//! disk (config, logs, sync data, the quit marker).
//!
//! - `PIPETTE_USER_DATA_DIR`, when set to an absolute path, wins. It isolates
//!   e2e runs, CI and screenshots, and lets a run use real data (with the
//!   Electron build stopped).
//! - Otherwise a distributed build (src/distribution.rs) uses
//!   `<config dir>/pipette-desktop`, the Electron build's directory: the
//!   release takes the user's data over where it is, without copying it.
//! - Every other build uses `<config dir>/app.pipette.desktop`, a directory
//!   of its own, so a debug, development tools' or locally built release
//!   build never opens the user's data.
//!
//! `<config dir>` is the base Electron's `app.getPath('userData')` is under
//! on every OS (`$XDG_CONFIG_HOME` or `~/.config` on Linux,
//! `~/Library/Application Support` on macOS, `%APPDATA%` on Windows).

use std::ffi::OsString;
use std::path::PathBuf;

/// The environment variable that names the userData directory.
pub const USER_DATA_DIR_ENV: &str = "PIPETTE_USER_DATA_DIR";

/// The userData directory name of the builds that are not distributed: the
/// app identifier.
pub const MIGRATION_USER_DATA_NAME: &str = "app.pipette.desktop";

/// The Electron build's userData directory name, its package name (`name`
/// in package.json, which src/tauri-shim/__tests__/user-data-name.test.ts
/// checks against this value). A distributed build uses it too.
pub const ELECTRON_USER_DATA_NAME: &str = "pipette-desktop";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum UserDataError {
    #[error("{USER_DATA_DIR_ENV} must be an absolute path, got {0:?}")]
    NotAbsolute(PathBuf),
    #[error("no config directory to put the userData directory in")]
    NoConfigDir,
}

/// The value of [`USER_DATA_DIR_ENV`] when it names a directory: an empty
/// value counts as unset.
pub fn user_data_override(value: Option<OsString>) -> Option<OsString> {
    value.filter(|dir| !dir.is_empty())
}

/// The userData directory from the environment and the OS config directory,
/// for a build that is `distributed` or not. The directory is not created.
pub fn user_data_dir(distributed: bool) -> Result<PathBuf, UserDataError> {
    resolve_user_data_dir(std::env::var_os(USER_DATA_DIR_ENV), dirs::config_dir(), distributed)
}

/// The userData directory for an `override_dir` (the value of
/// [`USER_DATA_DIR_ENV`]; empty counts as unset), a `config_dir` and
/// whether the build is `distributed`.
pub fn resolve_user_data_dir(
    override_dir: Option<OsString>,
    config_dir: Option<PathBuf>,
    distributed: bool,
) -> Result<PathBuf, UserDataError> {
    if let Some(dir) = user_data_override(override_dir).map(PathBuf::from) {
        if !dir.is_absolute() {
            return Err(UserDataError::NotAbsolute(dir));
        }
        return Ok(dir);
    }
    let name = if distributed { ELECTRON_USER_DATA_NAME } else { MIGRATION_USER_DATA_NAME };
    config_dir.map(|dir| dir.join(name)).ok_or(UserDataError::NoConfigDir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn absolute(path: &str) -> PathBuf {
        // An absolute path on every OS the tests run on.
        std::env::temp_dir().join(path)
    }

    #[test]
    fn a_build_that_is_not_distributed_defaults_to_a_directory_of_its_own() {
        let config = absolute("config");
        assert_eq!(
            resolve_user_data_dir(None, Some(config.clone()), false),
            Ok(config.join("app.pipette.desktop"))
        );
    }

    #[test]
    fn a_distributed_build_defaults_to_the_electron_directory() {
        let config = absolute("config");
        assert_eq!(
            resolve_user_data_dir(None, Some(config.clone()), true),
            Ok(config.join("pipette-desktop"))
        );
    }

    #[test]
    fn an_absolute_override_wins() {
        let ud = absolute("ud");
        for distributed in [false, true] {
            assert_eq!(
                resolve_user_data_dir(Some(ud.clone().into()), Some(absolute("config")), distributed),
                Ok(ud.clone())
            );
            assert_eq!(resolve_user_data_dir(Some(ud.clone().into()), None, distributed), Ok(ud.clone()));
        }
    }

    #[test]
    fn an_empty_override_counts_as_unset() {
        let config = absolute("config");
        assert_eq!(
            resolve_user_data_dir(Some(OsString::new()), Some(config.clone()), false),
            Ok(config.join(MIGRATION_USER_DATA_NAME))
        );
        assert_eq!(
            resolve_user_data_dir(Some(OsString::new()), Some(config.clone()), true),
            Ok(config.join(ELECTRON_USER_DATA_NAME))
        );
    }

    #[test]
    fn a_relative_override_is_refused() {
        for distributed in [false, true] {
            assert_eq!(
                resolve_user_data_dir(Some("relative/ud".into()), Some(absolute("config")), distributed),
                Err(UserDataError::NotAbsolute(PathBuf::from("relative/ud")))
            );
        }
    }

    #[test]
    fn without_a_config_dir_there_is_no_default() {
        assert_eq!(resolve_user_data_dir(None, None, false), Err(UserDataError::NoConfigDir));
        assert_eq!(resolve_user_data_dir(None, None, true), Err(UserDataError::NoConfigDir));
    }

    #[test]
    fn the_migration_directory_is_not_the_electron_one() {
        assert_ne!(MIGRATION_USER_DATA_NAME, ELECTRON_USER_DATA_NAME);
    }
}
