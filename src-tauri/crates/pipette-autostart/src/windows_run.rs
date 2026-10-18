// SPDX-License-Identifier: GPL-2.0-or-later
//! The Windows login item: a value in the current user's Run key, as
//! Electron's `app.setLoginItemSettings({ openAtLogin })` writes one.
//!
//! - On: the value `Pipette` holds the executable's path in double quotes
//!   (an unquoted path with a space would start another program), and the
//!   value of the same name under `Explorer\StartupApproved\Run`, where Task
//!   Manager records an entry the user turned off, is removed, as Electron
//!   does for an item it turns on.
//! - Off: both values are removed.
//! - Either way, the values the Electron build registered (named after its
//!   AppUserModelID, likely `electron.app.Pipette`) are removed with their
//!   StartupApproved values, so one item is left and it starts this build.
//!   They are found by what they start: `Pipette.exe` in a folder Pipette
//!   was installed in (this executable's, the Electron build's default
//!   folders, the folder its uninstall entry names), or `Pipette.exe`
//!   anywhere under a name starting with `electron.app.`. The file name is
//!   compared without case, so a value under another name that starts this
//!   build's own `pipette.exe` from its folder goes too (a second item
//!   starting this build). Any other value is left alone.
//!
//! The decision is [`plan`], a pure function the tests run on every system;
//! the registry calls are the `system` module (Windows only).

/// The name of this build's value: the product name.
pub(crate) const VALUE_NAME: &str = crate::PRODUCT_NAME;

/// The file name of the Electron build's executable.
const ELECTRON_EXE: &str = "Pipette.exe";

/// The start of Electron's default AppUserModelID, the value name its login
/// item gets when the app sets none.
const ELECTRON_NAME_PREFIX: &str = "electron.app.";

/// One registry change, in the order [`plan`] lists them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Change {
    /// Writes a string value in the Run key.
    SetRun { name: String, data: String },
    /// Removes a value from the Run key (none there is no error).
    RemoveRun(String),
    /// Removes a value from `StartupApproved\Run` (none there is no error).
    RemoveApproved(String),
}

/// The changes that turn this build's item on (`enabled`) or off for `exe`,
/// given the Run key's `values` (name and string data; `None` for a value
/// that is not a string) and the folders the Electron build was installed
/// in. This build's value comes first, so an interruption after it leaves
/// the item starting this build; the Electron build's values follow.
pub(crate) fn plan(
    enabled: bool,
    exe: &str,
    values: &[(String, Option<String>)],
    electron_dirs: &[String],
) -> Vec<Change> {
    let own = if enabled {
        Change::SetRun { name: VALUE_NAME.to_owned(), data: quoted(exe) }
    } else {
        Change::RemoveRun(VALUE_NAME.to_owned())
    };
    let mut changes = vec![own, Change::RemoveApproved(VALUE_NAME.to_owned())];
    let mut dirs: Vec<String> = electron_dirs.iter().map(|dir| normalized(dir)).collect();
    if let Some((dir, _)) = split_dir(exe) {
        dirs.push(normalized(dir));
    }
    for (name, data) in values {
        if data.as_deref().is_some_and(|data| is_electron_value(name, data, &dirs)) {
            changes.push(Change::RemoveRun(name.clone()));
            changes.push(Change::RemoveApproved(name.clone()));
        }
    }
    changes
}

/// `path` in double quotes.
pub(crate) fn quoted(path: &str) -> String {
    format!("\"{path}\"")
}

/// Whether the value `name` with `data` is one the Electron build
/// registered: not this build's own, and starting `Pipette.exe` in one of
/// `dirs` (normalized) or anywhere under Electron's default name.
fn is_electron_value(name: &str, data: &str, dirs: &[String]) -> bool {
    if name.eq_ignore_ascii_case(VALUE_NAME) {
        return false;
    }
    let Some((dir, file)) = program(data).and_then(split_dir) else {
        return false;
    };
    if !file.eq_ignore_ascii_case(ELECTRON_EXE) {
        return false;
    }
    let electron_name = name
        .get(..ELECTRON_NAME_PREFIX.len())
        .is_some_and(|start| start.eq_ignore_ascii_case(ELECTRON_NAME_PREFIX));
    electron_name || dirs.contains(&normalized(dir))
}

/// The program a command line starts: the quoted part when it starts with
/// a quote, else everything up to the first `.exe` followed by a space or
/// the end (a path with spaces is often written unquoted), else the first
/// word.
fn program(command: &str) -> Option<&str> {
    let command = command.trim_start();
    if let Some(rest) = command.strip_prefix('"') {
        return rest.find('"').map(|end| &rest[..end]).filter(|path| !path.is_empty());
    }
    let lower = command.to_ascii_lowercase();
    let mut from = 0;
    while let Some(at) = lower[from..].find(".exe") {
        let end = from + at + ".exe".len();
        if lower[end..].is_empty() || lower[end..].starts_with(' ') {
            return Some(&command[..end]);
        }
        from = end;
    }
    command.split(' ').next().filter(|word| !word.is_empty())
}

/// The folder and the file name of `path`.
fn split_dir(path: &str) -> Option<(&str, &str)> {
    let at = path.rfind(['\\', '/'])?;
    Some((&path[..at], &path[at + 1..])).filter(|(_, file)| !file.is_empty())
}

/// A folder path for comparison: no surrounding quotes, no `\\?\` prefix,
/// backslashes, no trailing separator, lower case (Windows compares paths
/// without case).
fn normalized(dir: &str) -> String {
    let dir = dir.trim().trim_matches('"');
    let dir = dir.strip_prefix(r"\\?\").unwrap_or(dir);
    dir.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// The folders the Electron build installs into by default:
/// electron-builder's per-user `%LOCALAPPDATA%\Programs\<name>` and its
/// per-machine `%ProgramFiles%\<name>`, `<name>` being the package name
/// (the name of the Electron build's userData directory too).
pub(crate) fn electron_default_dirs(
    local_app_data: Option<&str>,
    program_files: Option<&str>,
) -> Vec<String> {
    let name = pipette_fs::ELECTRON_USER_DATA_NAME;
    let mut dirs = Vec::new();
    if let Some(base) = local_app_data.filter(|base| !base.is_empty()) {
        dirs.push(format!(r"{base}\Programs\{name}"));
    }
    if let Some(base) = program_files.filter(|base| !base.is_empty()) {
        dirs.push(format!(r"{base}\{name}"));
    }
    dirs
}

#[cfg(target_os = "windows")]
pub(crate) mod system {
    //! The registry calls behind [`super::plan`].

    use std::path::Path;

    use windows_registry::{CURRENT_USER, Key, LOCAL_MACHINE};

    use super::{Change, electron_default_dirs, plan};

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    /// The uninstall entry electron-builder writes for the Electron build:
    /// the UUID v5 of its appId, as in src-tauri/windows/hooks.nsh.
    const ELECTRON_UNINSTALL: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Uninstall\ea2785fe-f9f8-5f54-9882-47312c59a4b9";
    /// `HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)`: no such key or value.
    const NOT_FOUND: i32 = 0x8007_0002_u32 as i32;

    /// Turns the item on or off for `exe` and removes the Electron build's.
    /// Every failure is logged as an error; the other changes still run.
    pub(crate) fn apply(enabled: bool, exe: Result<&Path, &str>) {
        let exe = exe.map_err(str::to_owned).and_then(|exe| {
            exe.to_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("the executable's path is not UTF-8: {}", exe.display()))
        });
        let exe = match exe {
            Ok(exe) => exe,
            Err(err) => {
                log::error!("auto-launch: failed to update the login item: {err}");
                return;
            }
        };
        // Unread values only keep the Electron build's values in place.
        let values = run_values().unwrap_or_else(|err| {
            log::error!("auto-launch: failed to read the Run key: {err}");
            Vec::new()
        });
        for change in plan(enabled, &exe, &values, &electron_dirs()) {
            if let Err(err) = make(&change) {
                log::error!("auto-launch: failed to update the login item ({change:?}): {err}");
            }
        }
    }

    /// The values of the current user's Run key; none when it does not
    /// exist.
    fn run_values() -> windows_registry::Result<Vec<(String, Option<String>)>> {
        let key = match CURRENT_USER.options().read().open(RUN) {
            Err(err) if err.code().0 == NOT_FOUND => return Ok(Vec::new()),
            other => other?,
        };
        Ok(key.values()?.map(|(name, value)| (name, String::try_from(value).ok())).collect())
    }

    /// The folders the Electron build may be installed in.
    fn electron_dirs() -> Vec<String> {
        let var = |name: &str| std::env::var(name).ok();
        let mut dirs = electron_default_dirs(var("LOCALAPPDATA").as_deref(), var("ProgramFiles").as_deref());
        for root in [CURRENT_USER, LOCAL_MACHINE] {
            if let Ok(location) =
                root.open(ELECTRON_UNINSTALL).and_then(|key| key.get_string("InstallLocation"))
            {
                dirs.push(location);
            }
        }
        dirs
    }

    fn make(change: &Change) -> windows_registry::Result<()> {
        match change {
            Change::SetRun { name, data } => CURRENT_USER.create(RUN)?.set_string(name, data),
            Change::RemoveRun(name) => remove(RUN, name),
            Change::RemoveApproved(name) => remove(APPROVED, name),
        }
    }

    /// Removes `name` from `path` under the current user; a key or value
    /// that is not there is already removed.
    fn remove(path: &str, name: &str) -> windows_registry::Result<()> {
        let removed: windows_registry::Result<Key> = CURRENT_USER.options().read().write().open(path);
        match removed.and_then(|key| key.remove_value(name)) {
            Err(err) if err.code().0 == NOT_FOUND => Ok(()),
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Users\u\AppData\Local\Pipette\pipette.exe";
    const ELECTRON_DIR: &str = r"C:\Users\u\AppData\Local\Programs\pipette-desktop";

    fn values(pairs: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
        pairs.iter().map(|(name, data)| ((*name).to_owned(), data.map(str::to_owned))).collect()
    }

    fn own(enabled: bool) -> Vec<Change> {
        plan(enabled, EXE, &[], &[])
    }

    #[test]
    fn on_writes_the_quoted_path_and_clears_the_task_manager_override() {
        assert_eq!(
            own(true),
            [
                Change::SetRun {
                    name: "Pipette".to_owned(),
                    data: r#""C:\Users\u\AppData\Local\Pipette\pipette.exe""#.to_owned()
                },
                Change::RemoveApproved("Pipette".to_owned()),
            ]
        );
    }

    #[test]
    fn off_removes_both_values() {
        assert_eq!(
            own(false),
            [Change::RemoveRun("Pipette".to_owned()), Change::RemoveApproved("Pipette".to_owned())]
        );
    }

    #[test]
    fn the_electron_values_go_after_this_builds_own_whether_on_or_off() {
        let run = values(&[
            ("electron.app.Pipette", Some(&format!(r#""{ELECTRON_DIR}\Pipette.exe""#))),
            ("OneDrive", Some(r#""C:\Program Files\Microsoft OneDrive\OneDrive.exe" /background"#)),
        ]);
        for enabled in [true, false] {
            let changes = plan(enabled, EXE, &run, &[ELECTRON_DIR.to_owned()]);
            assert_eq!(changes[..2], own(enabled)[..]);
            assert_eq!(
                changes[2..],
                [
                    Change::RemoveRun("electron.app.Pipette".to_owned()),
                    Change::RemoveApproved("electron.app.Pipette".to_owned())
                ]
            );
        }
    }

    #[test]
    fn electron_values_are_found_by_what_they_start() {
        let dirs = electron_default_dirs(Some(r"C:\Users\u\AppData\Local"), Some(r"C:\Program Files"));
        let electron =
            |name: &str, data: &str| plan(true, EXE, &values(&[(name, Some(data))]), &dirs).len() == 4;
        // Electron's quoted path, with arguments, in any case, with forward
        // slashes, unquoted, in the per-machine folder.
        assert!(electron("some name", r#""C:\Users\u\AppData\Local\Programs\pipette-desktop\Pipette.exe""#));
        assert!(electron("x", r#""c:\users\u\appdata\local\programs\PIPETTE-DESKTOP\pipette.EXE" --hidden"#));
        assert!(electron("x", "C:/Users/u/AppData/Local/Programs/pipette-desktop/Pipette.exe"));
        assert!(electron("x", r"C:\Users\u\AppData\Local\Programs\pipette-desktop\Pipette.exe --flag"));
        assert!(electron("x", r#""C:\Program Files\pipette-desktop\Pipette.exe""#));
        // This build's folder (the Electron build was installed into it).
        assert!(electron("x", r#""C:\Users\u\AppData\Local\Pipette\Pipette.exe""#));
        // Electron's default name, Pipette.exe anywhere.
        assert!(electron("electron.app.Pipette", r#""D:\Apps\Pipette\Pipette.exe""#));
        assert!(electron("ELECTRON.APP.pipette-desktop", r"D:\Apps\Pipette\Pipette.exe"));
        // An unquoted path with spaces.
        assert!(electron("electron.app.Pipette", r"D:\My Apps\Pipette\Pipette.exe"));
        // Not ours: another program, Pipette.exe elsewhere under another
        // name, this build's own value, a value that is not a string.
        assert!(!electron("OneDrive", r#""C:\Program Files\Microsoft OneDrive\OneDrive.exe" /background"#));
        assert!(!electron("Pipette Tools", r#""D:\Other\Pipette.exe""#));
        assert!(!electron("x", r#""C:\Users\u\AppData\Local\Programs\pipette-desktop\Pipette Updater.exe""#));
        assert!(!electron("x", r#""C:\Users\u\AppData\Local\Programs\pipette-desktop""#));
        assert!(!electron("x", ""));
        assert!(!electron("x", r#"""#));
        assert_eq!(plan(true, EXE, &values(&[("pipette", Some(r#""D:\x\Pipette.exe""#))]), &dirs).len(), 2);
        assert_eq!(plan(true, EXE, &values(&[("electron.app.Pipette", None)]), &dirs).len(), 2);
    }

    #[test]
    fn the_uninstall_entry_folder_counts_quoted_or_not() {
        for location in [r#""E:\Tools\Pipette""#, r"E:\Tools\Pipette\", r"\\?\E:\Tools\Pipette"] {
            let changes = plan(
                false,
                EXE,
                &values(&[("x", Some(r"E:\tools\pipette\Pipette.exe"))]),
                &[location.to_owned()],
            );
            assert_eq!(changes.len(), 4, "{location}");
        }
    }

    #[test]
    fn the_default_folders_follow_the_environment() {
        assert_eq!(
            electron_default_dirs(Some(r"C:\L"), Some(r"C:\P")),
            [r"C:\L\Programs\pipette-desktop".to_owned(), r"C:\P\pipette-desktop".to_owned()]
        );
        assert!(electron_default_dirs(None, Some("")).is_empty());
    }

    #[test]
    fn the_program_of_a_command_line() {
        assert_eq!(program(r#""C:\a b\x.exe" -y"#), Some(r"C:\a b\x.exe"));
        assert_eq!(program(r"C:\a b\x.exe -y"), Some(r"C:\a b\x.exe"));
        assert_eq!(program(r"C:\a.exe.d\x.exe"), Some(r"C:\a.exe.d\x.exe"));
        assert_eq!(program(r"C:\x.EXE"), Some(r"C:\x.EXE"));
        assert_eq!(program(r"C:\x.bat -y"), Some(r"C:\x.bat"));
        assert_eq!(program(r#""unterminated"#), None);
        assert_eq!(program("  "), None);
    }
}
