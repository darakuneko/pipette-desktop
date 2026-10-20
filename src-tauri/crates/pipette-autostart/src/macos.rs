// SPDX-License-Identifier: GPL-2.0-or-later
//! The macOS login item: the app registered with SMAppService (macOS 13 and
//! later), through the auto-launch crate. SMAppService registers the
//! running app bundle, and the release replaces the 0.4 build's
//! `/Applications/Pipette.app` under the same bundle id, so the item the
//! 0.4 build registered is this build's item.
//!
//! macOS 12 has no SMAppService. Nothing else is used there (the 0.4 build
//! used an older API there that this build does not have): an item the 0.4
//! build added keeps starting the app at the same path, but turning
//! `autoLaunch` off cannot remove it. Each apply (at every launch, with
//! `autoLaunch` on or off, and at every change) logs that as an error.

use std::path::Path;

use auto_launch::{AutoLaunch, AutoLaunchBuilder, Error, MacOSLaunchMode};
use smappservice_rs::{AppService, ServiceStatus, ServiceType};

use crate::PRODUCT_NAME;

/// Registers the app when `enabled`, else unregisters it unless it is not
/// registered at all (unregistering then fails), so an item still waiting
/// for the user's approval is removed too. A failure is logged as an error.
pub(crate) fn apply(enabled: bool, exe: Result<&Path, &str>) {
    let result = login_item(exe).and_then(|item| {
        if enabled {
            item.enable()
        } else if AppService::new(ServiceType::MainApp).status() == ServiceStatus::NotRegistered {
            Ok(())
        } else {
            item.disable()
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
