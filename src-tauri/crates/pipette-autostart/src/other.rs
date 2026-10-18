// SPDX-License-Identifier: GPL-2.0-or-later
//! The login item of Windows and macOS, `app.setLoginItemSettings({
//! openAtLogin })` of the Electron build, through the auto-launch crate:
//! the current user's Run key on Windows, SMAppService on macOS (13 and
//! later). Whether the registration matches the Electron build's (the value
//! name, the path, the macOS mechanism) is to be checked on those systems
//! before [`crate::AUTOSTART_APPLIES`] turns true.

use std::path::Path;

use auto_launch::{AutoLaunch, AutoLaunchBuilder, MacOSLaunchMode, WindowsEnableMode};

/// The name the item is registered under: the app's product name.
const APP_NAME: &str = "Pipette";

/// Registers `exe` when `enabled`, else removes the item. A failure is
/// logged as an error.
pub(crate) fn apply(enabled: bool, exe: Result<&Path, &str>) {
    let result = login_item(exe).and_then(|item| {
        let changed = if enabled { item.enable() } else { item.disable() };
        changed.map_err(|err| err.to_string())
    });
    if let Err(err) = result {
        log::error!("auto-launch: failed to update the login item: {err}");
    }
}

fn login_item(exe: Result<&Path, &str>) -> Result<AutoLaunch, String> {
    let exe = exe.map_err(str::to_owned)?;
    let path =
        exe.to_str().ok_or_else(|| format!("the executable's path is not UTF-8: {}", exe.display()))?;
    AutoLaunchBuilder::new()
        .set_app_name(APP_NAME)
        .set_app_path(path)
        .set_windows_enable_mode(WindowsEnableMode::CurrentUser)
        .set_macos_launch_mode(MacOSLaunchMode::SMAppService)
        .build()
        .map_err(|err| err.to_string())
}
