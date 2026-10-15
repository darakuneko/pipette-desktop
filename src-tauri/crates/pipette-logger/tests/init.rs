// SPDX-License-Identifier: GPL-2.0-or-later
//! `init` with a log directory that cannot be created: the logger is still
//! installed (stderr only) and the error says why. A test binary of its own,
//! since a process has one logger.

use std::path::PathBuf;

#[test]
fn an_unusable_log_directory_still_installs_the_logger() {
    let blocker = std::env::temp_dir().join(format!("pipette-logger-init-{}", std::process::id()));
    std::fs::write(&blocker, "a file, not a directory").unwrap();
    let result = pipette_logger::init(PathBuf::from(&blocker).join("logs"));
    assert!(matches!(result, Err(pipette_logger::InitError::CreateDir(..))), "{result:?}");
    assert!(log::log_enabled!(target: "pipette_app", log::Level::Info));
    log::info!(target: "pipette_app", "reaches stderr");
    std::fs::remove_file(blocker).unwrap();
}
