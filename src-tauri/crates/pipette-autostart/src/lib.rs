// SPDX-License-Identifier: GPL-2.0-or-later
//! Starting the app at sign-in, which the Electron build sets up in
//! `applyAutoLaunch` of src/main/app-behavior.ts: on Linux the desktop entry
//! `$HOME/.config/autostart/pipette.desktop` (src/linux.rs), on Windows and
//! macOS the OS's login item (src/other.rs).
//!
//! [`AUTOSTART_APPLIES`] keeps every build away from the real autostart
//! entry: while it is false, the only place an entry is written to or
//! removed from is the directory a development tools' build is given in
//! `PIPETTE_DEV_AUTOSTART_DIR` (src/dev_dir.rs), and every other build logs
//! a warning and does nothing.

use std::ffi::OsString;
use std::path::PathBuf;

mod dev_dir;
mod linux;
#[cfg(any(target_os = "windows", target_os = "macos"))]
mod other;

#[cfg(test)]
mod golden_tests;
#[cfg(test)]
mod tests;

pub use dev_dir::VARIABLE as DEV_DIR_VARIABLE;

/// Whether a build may register itself to start at sign-in. False: the
/// Electron build owns the shared entry, and a Tauri build must neither
/// write nor remove it. It turns true in the same change that makes the
/// Tauri build take over the Electron build's userData directory
/// (`MIGRATION_USER_DATA_NAME` of pipette-fs), so that from then on the
/// entry points at the Tauri build.
pub const AUTOSTART_APPLIES: bool = false;

/// The operating system, which decides how the app is registered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Linux,
    Windows,
    MacOs,
    /// Every other system, where the Electron build registers nothing.
    Other,
}

impl Os {
    pub const fn current() -> Self {
        if cfg!(target_os = "linux") {
            Self::Linux
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else {
            Self::Other
        }
    }
}

/// What deciding and writing the registration reads from the process.
#[derive(Clone, Debug)]
pub struct Environment {
    pub os: Os,
    /// Whether this is a build that gets bundled. The Electron build skips
    /// unpackaged builds, whose executable is not the app.
    pub packaged: bool,
    /// The home directory: `$HOME`, else the user's entry in the system's
    /// user database (Node's `os.homedir()`). The real entry lives in its
    /// `.config/autostart`; `XDG_CONFIG_HOME` does not move it.
    pub home: Option<PathBuf>,
    /// `XDG_CONFIG_HOME`, only so a development directory inside its
    /// `autostart` is refused as well.
    pub xdg_config_home: Option<PathBuf>,
    /// `APPIMAGE`, set by the AppImage runtime to the image's own path:
    /// the stable launcher, where the executable is a temporary mount.
    pub appimage: Option<OsString>,
    /// The running executable.
    pub current_exe: Result<PathBuf, String>,
    /// `PIPETTE_DEV_AUTOSTART_DIR`; `None` in a build without the
    /// development tools, which never reads it.
    pub dev_dir: Option<OsString>,
}

impl Environment {
    /// The environment of this process. `packaged` is whether this is a
    /// build that gets bundled, `dev_tools` whether it has the development
    /// tools, the only builds that read `PIPETTE_DEV_AUTOSTART_DIR`.
    pub fn of_process(packaged: bool, dev_tools: bool) -> Self {
        Self::from_vars(
            packaged,
            dev_tools,
            |name| std::env::var_os(name),
            std::env::home_dir(),
            std::env::current_exe().map_err(|err| err.to_string()),
        )
    }

    /// The environment from the variables `var` gives, the home directory
    /// and the executable.
    fn from_vars(
        packaged: bool,
        dev_tools: bool,
        var: impl Fn(&str) -> Option<OsString>,
        home: Option<PathBuf>,
        current_exe: Result<PathBuf, String>,
    ) -> Self {
        Self {
            os: Os::current(),
            packaged,
            home,
            xdg_config_home: var("XDG_CONFIG_HOME").map(PathBuf::from),
            appimage: var("APPIMAGE"),
            current_exe,
            dev_dir: if dev_tools { var(DEV_DIR_VARIABLE) } else { None },
        }
    }

    /// The program the entry starts: `APPIMAGE` when it is set, even to
    /// the empty string (the Electron build's `??`), else the executable.
    fn exec(&self) -> Result<OsString, String> {
        match &self.appimage {
            Some(appimage) => Ok(appimage.clone()),
            None => self.current_exe.clone().map(PathBuf::into_os_string),
        }
    }

    /// The autostart directories a development directory must stay out
    /// of: `.config/autostart` of the home directory and `autostart` of
    /// `XDG_CONFIG_HOME`, each when absolute.
    fn real_autostart_dirs(&self) -> Vec<PathBuf> {
        let homes = self.home.iter().map(|home| home.join(".config").join("autostart"));
        let configs = self.xdg_config_home.iter().map(|config| config.join("autostart"));
        homes.chain(configs).filter(|dir| dir.is_absolute()).collect()
    }
}

/// Where a change of `autoLaunch` goes.
#[derive(Debug, PartialEq, Eq)]
enum Target {
    /// The desktop entry in this directory: the real
    /// `$HOME/.config/autostart`, or the development directory.
    Directory(PathBuf),
    /// The login item of Windows or macOS.
    LoginItem,
    /// Nowhere, with this warning.
    Skip(String),
    /// Nowhere, with this error.
    Refused(String),
    /// Nowhere, silently: a system the Electron build registers nothing on.
    Nothing,
}

/// Registers the app to start at sign-in when `enabled`, else unregisters
/// it, as `applyAutoLaunch` does: at every launch and on every change of
/// `autoLaunch`. Failures are logged, never returned.
pub fn apply(enabled: bool, env: &Environment) {
    run(target(AUTOSTART_APPLIES, env), enabled, env);
}

/// The target for `env` when the build may register itself (`applies`).
/// A development directory comes first, so a build that has one never
/// reaches the real entry; a directory that is refused is not replaced by
/// the real one.
fn target(applies: bool, env: &Environment) -> Target {
    if let Some(dir) = &env.dev_dir {
        if env.os != Os::Linux {
            return Target::Skip(format!("auto-launch skipped: {DEV_DIR_VARIABLE} is read on Linux only"));
        }
        return match dev_dir::check(dir, &env.real_autostart_dirs()) {
            Ok(dir) => Target::Directory(dir),
            Err(reason) => Target::Refused(format!("auto-launch: {reason}")),
        };
    }
    if !applies {
        return Target::Skip("auto-launch skipped: this build does not start at sign-in".to_owned());
    }
    if !env.packaged {
        return Target::Skip("auto-launch skipped: unpackaged build".to_owned());
    }
    match env.os {
        Os::Linux => match &env.home {
            Some(home) => Target::Directory(home.join(".config").join("autostart")),
            None => Target::Refused(format!("{}no home directory", linux::FAILURE)),
        },
        Os::Windows | Os::MacOs => Target::LoginItem,
        Os::Other => Target::Nothing,
    }
}

fn run(target: Target, enabled: bool, env: &Environment) {
    match target {
        Target::Directory(dir) => linux::apply(&dir, enabled, || env.exec()),
        Target::LoginItem => login_item(enabled, env),
        Target::Skip(message) => log::warn!("{message}"),
        Target::Refused(message) => log::error!("{message}"),
        Target::Nothing => {}
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn login_item(enabled: bool, env: &Environment) {
    other::apply(enabled, env.current_exe.as_deref().map(std::path::Path::new));
}

/// No build for these systems resolves to a login item ([`Os::current`]).
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn login_item(_enabled: bool, _env: &Environment) {
    log::warn!("auto-launch skipped: no login item on this system");
}
