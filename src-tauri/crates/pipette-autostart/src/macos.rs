// SPDX-License-Identifier: GPL-2.0-or-later
//! The macOS login item, `app.setLoginItemSettings({ openAtLogin })` of the
//! Electron build: the app registered with SMAppService (macOS 13 and
//! later), through the auto-launch crate. SMAppService registers the
//! running app bundle, and the release replaces the Electron build's
//! `/Applications/Pipette.app` under the same bundle id, so the item the
//! Electron build registered is this build's item.
//!
//! macOS 12 has no SMAppService. Nothing else is used there (Electron falls
//! back to an older API this build does not have): an item the Electron
//! build added keeps starting the app at the same path, but turning
//! `autoLaunch` off cannot remove it, which is logged as an error each time.

use std::path::Path;

use auto_launch::{AutoLaunch, AutoLaunchBuilder, Error, MacOSLaunchMode};

use crate::PRODUCT_NAME;

/// Registers the app when `enabled`, else removes the item when it is
/// enabled (an item still waiting for the user's approval in System
/// Settings does not start the app). A failure is logged as an error.
pub(crate) fn apply(enabled: bool, exe: Result<&Path, &str>) {
    let result = login_item(exe).and_then(|item| {
        if enabled {
            item.enable()
        } else if item.is_enabled()? {
            item.disable()
        } else {
            // Unregistering an item that is not registered is an error.
            Ok(())
        }
    });
    match result {
        Ok(()) => {}
        Err(Error::UnsupportedOS) => log::error!(
            "auto-launch: the login item cannot be changed before macOS 13; a login item an earlier \
             Pipette added stays until it is removed in System Preferences > Users & Groups > Login Items"
        ),
        Err(err) => log::error!("auto-launch: failed to update the login item: {err}"),
    }
}

fn login_item(exe: Result<&Path, &str>) -> Result<AutoLaunch, Error> {
    let exe = exe.map_err(|err| Error::Io(std::io::Error::other(err.to_owned())))?;
    let path = exe.to_str().ok_or_else(|| {
        Error::Io(std::io::Error::other(format!("the executable's path is not UTF-8: {}", exe.display())))
    })?;
    AutoLaunchBuilder::new()
        .set_app_name(PRODUCT_NAME)
        .set_app_path(path)
        .set_macos_launch_mode(MacOSLaunchMode::SMAppService)
        .build()
}
