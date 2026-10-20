// SPDX-License-Identifier: GPL-2.0-or-later
//! Starting the app at sign-in: on Linux the desktop entry
//! `$HOME/.config/autostart/pipette.desktop` (src/linux.rs), on Windows the
//! current user's Run key (src/windows_run.rs), on macOS the login item
//! (src/macos.rs). The entry is the one the 0.4 build wrote, taken
//! over on purpose: a distributed build points it at itself, or removes it.
//!
//! Only a distributed build reaches the real entry (`packaged`, from
//! `is_distributed_build` of pipette-fs), and not while
//! `PIPETTE_USER_DATA_DIR` names a userData directory of its own (a run on
//! a copy of the data, an isolated session). A development tools' build
//! writes only into the directory it is given in `PIPETTE_DEV_AUTOSTART_DIR`
//! (src/dev_dir.rs); every other build logs a warning and does nothing.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use pipette_fs::{USER_DATA_DIR_ENV, user_data_override};

mod dev_dir;
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod passwd;
// The plan is pure and tested everywhere; the registry calls are Windows only.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
mod windows_run;

#[cfg(test)]
mod golden_tests;
#[cfg(test)]
mod tests;

pub use dev_dir::VARIABLE as DEV_DIR_VARIABLE;

/// The operating system, which decides how the app is registered
/// (`Other`: a system nothing is registered on).
pub use pipette_fs::Platform as Os;

/// The product name: the login item's name on Windows and macOS.
const PRODUCT_NAME: &str = "Pipette";

/// What deciding and writing the registration reads from the process.
#[derive(Clone, Debug)]
pub struct Environment {
    pub os: Os,
    /// Whether this is a distributed build (`is_distributed_build` of
    /// pipette-fs). An unpackaged build is skipped: its executable is not
    /// the app.
    pub packaged: bool,
    /// Whether `PIPETTE_USER_DATA_DIR` is set to a value: the app runs on a
    /// userData directory of its own and leaves the real entry alone.
    pub user_data_override: bool,
    /// The home directory: `$HOME`, else the user's entry in the system's
    /// user database (Node's `os.homedir()`). The real entry lives in its
    /// `.config/autostart`; `XDG_CONFIG_HOME` does not move it.
    pub home: Option<PathBuf>,
    /// `$HOME` as it is set, so a relative or empty value is seen.
    pub home_var: Option<OsString>,
    /// The home directory of the current user in /etc/passwd, which
    /// `$HOME` may hide.
    pub passwd_home: Option<PathBuf>,
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
    /// The app's userData directory, which a development directory must
    /// be inside.
    pub user_data: PathBuf,
}

impl Environment {
    /// The environment of this process. `packaged` is whether this is a
    /// distributed build, `dev_tools` whether it has the development
    /// tools, the only builds that read `PIPETTE_DEV_AUTOSTART_DIR`.
    pub fn of_process(packaged: bool, dev_tools: bool, user_data: &Path) -> Self {
        Self {
            home: std::env::home_dir(),
            passwd_home: passwd::home_of_process(),
            current_exe: std::env::current_exe().map_err(|err| err.to_string()),
            ..Self::from_vars(packaged, dev_tools, |name| std::env::var_os(name), user_data)
        }
    }

    /// The environment from the variables `var` gives, with no home
    /// directory known and no executable.
    fn from_vars(
        packaged: bool,
        dev_tools: bool,
        var: impl Fn(&str) -> Option<OsString>,
        user_data: &Path,
    ) -> Self {
        Self {
            os: Os::current(),
            packaged,
            user_data_override: user_data_override(var(USER_DATA_DIR_ENV)).is_some(),
            home: None,
            home_var: var("HOME"),
            passwd_home: None,
            xdg_config_home: var("XDG_CONFIG_HOME").map(PathBuf::from),
            appimage: var("APPIMAGE"),
            current_exe: Err("no executable".to_owned()),
            dev_dir: if dev_tools { var(DEV_DIR_VARIABLE) } else { None },
            user_data: user_data.to_path_buf(),
        }
    }

    /// The program the entry starts: `APPIMAGE` when it is set, even to
    /// the empty string, else the executable.
    fn exec(&self) -> Result<OsString, String> {
        match &self.appimage {
            Some(appimage) => Ok(appimage.clone()),
            None => self.current_exe.clone().map(PathBuf::into_os_string),
        }
    }

    /// The autostart directories a development directory must stay out
    /// of: `.config/autostart` of `$HOME`, of the passwd home and of
    /// [`Self::home`], and `autostart` of `XDG_CONFIG_HOME`, each when
    /// absolute. An error, so the development directory is refused, when
    /// `$HOME` is set but not absolute or /etc/passwd has no home for the
    /// user: the real directory is then not known independently of `$HOME`
    /// (a user only a directory service knows cannot use one).
    fn real_autostart_dirs(&self) -> Result<Vec<PathBuf>, String> {
        if let Some(home) = &self.home_var
            && !Path::new(home).is_absolute()
        {
            return Err(format!(
                "{DEV_DIR_VARIABLE} cannot be checked: HOME is not an absolute path: {}",
                Path::new(home).display()
            ));
        }
        let homes: Vec<PathBuf> =
            [self.home_var.as_ref().map(PathBuf::from), self.passwd_home.clone(), self.home.clone()]
                .into_iter()
                .flatten()
                .filter(|home| home.is_absolute())
                .collect();
        if !self.passwd_home.as_ref().is_some_and(|home| home.is_absolute()) {
            return Err(format!(
                "{DEV_DIR_VARIABLE} cannot be checked: /etc/passwd has no home directory for the user"
            ));
        }
        let configs = self
            .xdg_config_home
            .iter()
            .filter(|config| config.is_absolute())
            .map(|config| config.join("autostart"));
        Ok(homes.iter().map(|home| home.join(".config").join("autostart")).chain(configs).collect())
    }
}

/// Where a change of `autoLaunch` goes.
#[derive(Debug, PartialEq, Eq)]
enum Target {
    /// The desktop entry in the real `$HOME/.config/autostart`, written as
    /// the 0.4 build wrote it.
    Directory(PathBuf),
    /// The desktop entry in the development directory, resolved: written
    /// through a temporary file and a rename, and only over (or removing)
    /// a regular file with no other link (src/linux.rs).
    DevDirectory(dev_dir::Checked),
    /// The login item of Windows (the Run key) or macOS.
    LoginItem,
    /// Nowhere, with this warning.
    Skip(String),
    /// Nowhere, with this error.
    Refused(String),
    /// Nowhere, silently: a system nothing is registered on.
    Nothing,
}

/// Registers the app to start at sign-in when `enabled`, else unregisters
/// it: at every launch and on every change of `autoLaunch`. Failures are
/// logged, never returned.
pub fn apply(enabled: bool, env: &Environment) {
    run(target(env), enabled, env);
}

/// The target for `env`. A development directory comes first, so a build that has one never
/// reaches the real entry; a directory that is refused is not replaced by
/// the real one. Then only a distributed build without
/// `PIPETTE_USER_DATA_DIR` reaches it.
fn target(env: &Environment) -> Target {
    if let Some(dir) = &env.dev_dir {
        if env.os != Os::Linux {
            return Target::Skip(format!("auto-launch skipped: {DEV_DIR_VARIABLE} is read on Linux only"));
        }
        let checked = env.real_autostart_dirs().and_then(|real| dev_dir::check(dir, &real, &env.user_data));
        return match checked {
            Ok(dir) => Target::DevDirectory(dir),
            Err(reason) => Target::Refused(format!("auto-launch: {reason}")),
        };
    }
    if env.user_data_override {
        return Target::Skip(format!("auto-launch skipped: {USER_DATA_DIR_ENV} is set"));
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
        Target::DevDirectory(checked) => linux::apply_guarded(&checked, enabled, || env.exec()),
        Target::LoginItem => login_item(enabled, env),
        Target::Skip(message) => log::warn!("{message}"),
        Target::Refused(message) => log::error!("{message}"),
        Target::Nothing => {}
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn login_item(enabled: bool, env: &Environment) {
    // The login item is the signed-in user's own, so a test run on Windows
    // or macOS must stop before it; the tests compare the call instead.
    if cfg!(test) {
        panic!("a test reached the OS's login item");
    }
    let exe = env.current_exe.as_deref().map_err(String::as_str);
    #[cfg(target_os = "windows")]
    windows_run::system::apply(enabled, exe);
    #[cfg(target_os = "macos")]
    macos::apply(enabled, exe);
}

/// No build for these systems resolves to a login item ([`Os::current`]).
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn login_item(_enabled: bool, _env: &Environment) {
    log::warn!("auto-launch skipped: no login item on this system");
}
