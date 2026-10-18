// SPDX-License-Identifier: GPL-2.0-or-later
//! The autostart tests of src/main/__tests__/app-behavior.test.ts, and the
//! guards that keep a build away from the real entry: only a distributed
//! build without an isolated userData directory writes or removes it, and a
//! development directory is refused when it reaches a real autostart
//! directory. Every test runs on a temporary HOME.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use log::{Level, LevelFilter, Log, Metadata, Record};

use crate::linux::{FAILURE, desktop_entry};
use crate::{DEV_DIR_VARIABLE, Environment, Os, Target, apply, target};

thread_local! {
    static RECORDS: RefCell<Vec<(Level, String)>> = const { RefCell::new(Vec::new()) };
}

/// Keeps each thread's records apart, so tests running in parallel do not
/// see each other's. The crate logs on the calling thread.
struct Capture;

impl Log for Capture {
    fn enabled(&self, _: &Metadata<'_>) -> bool {
        true
    }
    fn log(&self, record: &Record<'_>) {
        RECORDS.with(|r| r.borrow_mut().push((record.level(), record.args().to_string())));
    }
    fn flush(&self) {}
}

/// Starts capturing this thread's log records afresh.
pub(crate) fn capture() {
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| {
        log::set_logger(&Capture).expect("no other logger is installed");
        log::set_max_level(LevelFilter::Trace);
    });
    RECORDS.with(|r| r.borrow_mut().clear());
}

pub(crate) fn records() -> Vec<(Level, String)> {
    RECORDS.with(|r| r.borrow().clone())
}

const EXE: &str = "/opt/Pipette/pipette";

/// A packaged Linux build on `home` (also `$HOME` and the passwd home),
/// with `home/session` as its userData directory, where development
/// directories may go.
fn linux_env(home: &Path) -> Environment {
    Environment {
        os: Os::Linux,
        packaged: true,
        home: Some(home.to_path_buf()),
        home_var: Some(home.as_os_str().to_owned()),
        passwd_home: Some(home.to_path_buf()),
        xdg_config_home: None,
        appimage: None,
        current_exe: Ok(PathBuf::from(EXE)),
        dev_dir: None,
        user_data: home.join("session"),
        user_data_override: false,
    }
}

fn real_entry(home: &Path) -> PathBuf {
    home.join(".config").join("autostart").join("pipette.desktop")
}

/// Every file and directory under `root` with the files' bytes, symbolic
/// links as their targets.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Option<Vec<u8>>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Option<Vec<u8>>>) {
        for entry in fs::read_dir(dir).expect("read the directory") {
            let path = entry.expect("entry").path();
            let rel = path.strip_prefix(root).expect("inside").to_path_buf();
            let meta = fs::symlink_metadata(&path).expect("metadata");
            if meta.is_symlink() {
                out.insert(
                    rel,
                    Some(fs::read_link(&path).expect("link").into_os_string().into_encoded_bytes()),
                );
            } else if meta.is_dir() {
                out.insert(rel, None);
                walk(root, &path, out);
            } else {
                out.insert(rel, Some(fs::read(&path).expect("read")));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

// --- app-behavior.test.ts: applyAutoLaunch ---

#[test]
fn is_a_no_op_when_unpackaged() {
    let home = tempfile::tempdir().expect("HOME");
    let env = Environment { packaged: false, ..linux_env(home.path()) };
    capture();
    apply(true, &env);
    assert!(!real_entry(home.path()).exists());
    assert_eq!(records(), [(Level::Warn, "auto-launch skipped: unpackaged build".to_owned())]);
}

#[test]
fn windows_and_macos_use_the_login_item_and_write_no_file() {
    for os in [Os::Windows, Os::MacOs] {
        let home = tempfile::tempdir().expect("HOME");
        let env = Environment { os, ..linux_env(home.path()) };
        assert_eq!(target(&env), Target::LoginItem);
        assert!(snapshot(home.path()).is_empty());
    }
}

#[test]
fn writes_the_entry_with_the_executable_by_default() {
    let home = tempfile::tempdir().expect("HOME");
    capture();
    apply(true, &linux_env(home.path()));
    let entry = fs::read(real_entry(home.path())).expect("the entry");
    assert_eq!(
        entry,
        b"[Desktop Entry]\nType=Application\nName=Pipette\nComment=Vial-compatible keyboard configurator\nExec=\"/opt/Pipette/pipette\"\nX-GNOME-Autostart-enabled=true\n"
    );
    assert!(records().is_empty());
}

#[test]
fn prefers_appimage_over_the_executable_even_when_empty() {
    for (appimage, exec) in
        [("/opt/Pipette.AppImage", "Exec=\"/opt/Pipette.AppImage\"\n"), ("", "Exec=\"\"\n")]
    {
        let home = tempfile::tempdir().expect("HOME");
        let env = Environment { appimage: Some(OsString::from(appimage)), ..linux_env(home.path()) };
        apply(true, &env);
        let entry = fs::read_to_string(real_entry(home.path())).expect("the entry");
        assert!(entry.contains(exec), "{entry}");
    }
}

#[test]
fn removes_the_entry_when_disabled() {
    let home = tempfile::tempdir().expect("HOME");
    let env = linux_env(home.path());
    apply(true, &env);
    assert!(real_entry(home.path()).exists());
    apply(false, &env);
    assert!(!real_entry(home.path()).exists());
}

#[test]
fn disabling_an_entry_that_never_existed_logs_nothing() {
    let home = tempfile::tempdir().expect("HOME");
    capture();
    apply(false, &linux_env(home.path()));
    assert!(records().is_empty());
}

#[test]
fn an_executable_that_cannot_be_found_is_logged() {
    let home = tempfile::tempdir().expect("HOME");
    let env = Environment { current_exe: Err("gone".to_owned()), ..linux_env(home.path()) };
    capture();
    apply(true, &env);
    assert!(!real_entry(home.path()).exists());
    assert_eq!(records(), [(Level::Error, format!("{FAILURE}gone"))]);
}

#[cfg(unix)]
#[test]
fn the_path_bytes_are_written_as_they_are() {
    use std::os::unix::ffi::OsStringExt;
    let exec = OsString::from_vec(b"/opt/\xffPipette".to_vec());
    let needle = b"Exec=\"/opt/\xffPipette\"\n";
    assert!(desktop_entry(&exec).windows(needle.len()).any(|w| w == needle));
}

// --- Which builds reach the real entry ---

/// A HOME holding the user's real entry, another program's entry, the
/// userData directories of both builds, and `session`, the userData
/// directory of [`linux_env`].
fn populated_home() -> tempfile::TempDir {
    let home = tempfile::tempdir().expect("HOME");
    let config = home.path().join(".config");
    fs::create_dir_all(config.join("autostart")).expect("autostart");
    fs::write(real_entry(home.path()), "the Electron build's entry\n").expect("entry");
    fs::write(config.join("autostart").join("other.desktop"), "someone else\n").expect("other");
    for name in ["pipette-desktop", "app.pipette.desktop", "custom-user-data"] {
        fs::create_dir_all(config.join(name)).expect("userData");
        fs::write(config.join(name).join("config.json"), "{\"autoLaunch\":true}").expect("config");
    }
    fs::create_dir(home.path().join("session")).expect("session");
    home
}

/// The environment of a Linux build on `home` that is `packaged` or not,
/// with or without the development tools, given `PIPETTE_USER_DATA_DIR`
/// (`user_data`) and `XDG_CONFIG_HOME` (`xdg`).
fn process_env(
    home: &Path,
    packaged: bool,
    dev_tools: bool,
    user_data: Option<&Path>,
    xdg: Option<&Path>,
) -> Environment {
    let vars: BTreeMap<&str, OsString> = [
        ("HOME", Some(home.as_os_str().to_owned())),
        ("PIPETTE_USER_DATA_DIR", user_data.map(|dir| dir.as_os_str().to_owned())),
        ("XDG_CONFIG_HOME", xdg.map(|dir| dir.as_os_str().to_owned())),
    ]
    .into_iter()
    .filter_map(|(name, value)| Some((name, value?)))
    .collect();
    let env = Environment::from_vars(
        packaged,
        dev_tools,
        |name| vars.get(name).cloned(),
        user_data.unwrap_or(home),
    );
    Environment { os: Os::Linux, home: Some(home.to_path_buf()), current_exe: Ok(PathBuf::from(EXE)), ..env }
}

/// Applies on, off and on again and checks that nothing under `home`
/// changed and `warning` was logged each time.
fn assert_untouched(env: &Environment, home: &Path, warning: &str) {
    let before = snapshot(home);
    for enabled in [true, false, true] {
        capture();
        apply(enabled, env);
        assert_eq!(records(), [(Level::Warn, warning.to_owned())]);
        assert_eq!(snapshot(home), before, "{env:?}");
    }
}

#[test]
fn a_build_that_is_not_distributed_writes_and_removes_nothing() {
    let home = populated_home();
    let config = home.path().join(".config");
    for dev_tools in [false, true] {
        for xdg in [None, Some(config.as_path())] {
            let env = process_env(home.path(), false, dev_tools, None, xdg);
            assert_untouched(&env, home.path(), "auto-launch skipped: unpackaged build");
        }
    }
}

#[test]
fn a_build_on_a_user_data_directory_of_its_own_writes_and_removes_nothing() {
    // Wherever the variable points, the Electron directory included: a run
    // on a copy of the data or an isolated session never reaches the
    // entry of the user it runs as.
    let home = populated_home();
    let config = home.path().join(".config");
    for user_data in ["app.pipette.desktop", "pipette-desktop", "custom-user-data"] {
        for packaged in [true, false] {
            for xdg in [None, Some(config.as_path())] {
                let env = process_env(home.path(), packaged, false, Some(&config.join(user_data)), xdg);
                assert_untouched(&env, home.path(), "auto-launch skipped: PIPETTE_USER_DATA_DIR is set");
            }
        }
    }
    for os in [Os::Windows, Os::MacOs] {
        let env = Environment { os, ..process_env(home.path(), true, false, Some(&config.join("x")), None) };
        assert_eq!(
            target(&env),
            Target::Skip("auto-launch skipped: PIPETTE_USER_DATA_DIR is set".to_owned())
        );
    }
}

#[test]
fn an_empty_user_data_variable_counts_as_unset() {
    let home = populated_home();
    let vars = |name: &str| (name == "PIPETTE_USER_DATA_DIR").then(OsString::new);
    let env = Environment::from_vars(true, false, vars, home.path());
    assert!(!env.user_data_override);
}

#[test]
fn only_a_distributed_build_without_an_isolated_user_data_reaches_the_login_item() {
    let home = populated_home();
    let isolated = home.path().join("session");
    for os in [Os::Windows, Os::MacOs] {
        for packaged in [true, false] {
            for user_data in [None, Some(isolated.as_path())] {
                let env = Environment { os, ..process_env(home.path(), packaged, false, user_data, None) };
                let reaches = target(&env) == Target::LoginItem;
                assert_eq!(reaches, packaged && user_data.is_none(), "{os:?} {packaged} {user_data:?}");
            }
        }
    }
}

#[test]
fn the_distributed_build_takes_the_shared_entry_over() {
    let home = populated_home();
    let before = snapshot(home.path());
    let env = process_env(home.path(), true, false, None, None);
    capture();
    apply(true, &env);
    assert!(records().is_empty(), "{:?}", records());
    assert_eq!(fs::read(real_entry(home.path())).expect("the entry"), desktop_entry(EXE.as_ref()));
    apply(false, &env);
    assert!(!real_entry(home.path()).exists());
    // Nothing else changed: another program's entry, the userData
    // directories.
    let mut expected = before;
    expected.remove(&Path::new(".config").join("autostart").join("pipette.desktop"));
    assert_eq!(snapshot(home.path()), expected);
}

#[test]
fn a_build_without_the_development_tools_ignores_the_directory_variable() {
    let home = populated_home();
    let dev = home.path().join("session").join("dev-autostart");
    let vars = |name: &str| (name == DEV_DIR_VARIABLE).then(|| dev.clone().into_os_string());
    let env = Environment::from_vars(true, false, vars, home.path());
    assert_eq!(env.dev_dir, None);
    let env = Environment {
        os: Os::Linux,
        home: Some(home.path().to_path_buf()),
        current_exe: Ok(PathBuf::from(EXE)),
        ..env
    };
    // A distributed build: the real entry, never the variable's directory.
    assert_eq!(target(&env), Target::Directory(home.path().join(".config").join("autostart")));
    apply(true, &env);
    apply(false, &env);
    assert!(!dev.exists());
}

// --- PIPETTE_DEV_AUTOSTART_DIR ---
// Only Linux writes into a development directory (the guarded module of
// src/linux.rs), so the tests that reach the write run there alone; the
// checks before it run everywhere.

fn dev_env(home: &Path, dir: impl Into<OsString>) -> Environment {
    Environment { dev_dir: Some(dir.into()), ..linux_env(home) }
}

fn session(home: &Path) -> PathBuf {
    home.join("session")
}

/// Applies on and off and checks that nothing under `home` changed and an
/// error starting with `reason` was logged each time.
fn assert_refused(env: &Environment, home: &Path, reason: &str) {
    let before = snapshot(home);
    for enabled in [true, false] {
        capture();
        apply(enabled, env);
        let logs = records();
        assert_eq!(logs.len(), 1, "{logs:?}");
        assert_eq!(logs[0].0, Level::Error);
        assert!(logs[0].1.starts_with(&format!("auto-launch: {DEV_DIR_VARIABLE} {reason}")), "{}", logs[0].1);
        assert_eq!(snapshot(home), before);
    }
    // A distributed build does not fall back to the real entry either.
    assert!(matches!(target(env), Target::Refused(_)));
}

/// Applies a target checked earlier on and off and checks that nothing
/// under `home` changed and each time an error containing `reason` was
/// logged.
#[cfg(target_os = "linux")]
fn assert_not_used(checked: &crate::dev_dir::Checked, env: &Environment, home: &Path, reason: &str) {
    let before = snapshot(home);
    for enabled in [true, false] {
        capture();
        crate::run(Target::DevDirectory(checked.clone()), enabled, env);
        let logs = records();
        assert_eq!(logs.len(), 1, "{logs:?}");
        assert!(logs[0].1.starts_with(FAILURE) && logs[0].1.contains(reason), "{logs:?}");
        assert_eq!(snapshot(home), before);
    }
}

#[cfg(target_os = "linux")]
fn checked_target(env: &Environment) -> crate::dev_dir::Checked {
    match target(env) {
        Target::DevDirectory(checked) => checked,
        other => panic!("the directory is refused: {other:?}"),
    }
}

#[cfg(target_os = "linux")]
#[test]
fn the_development_directory_gets_the_entry_and_loses_it() {
    let home = populated_home();
    let dev = session(home.path()).join("autostart");
    let env = dev_env(home.path(), &dev);
    let real = fs::read(real_entry(home.path())).expect("the real entry");
    capture();
    apply(true, &env);
    assert_eq!(fs::read(dev.join("pipette.desktop")).expect("the entry"), desktop_entry(EXE.as_ref()));
    apply(true, &env);
    apply(false, &env);
    assert!(!dev.join("pipette.desktop").exists());
    apply(false, &env);
    assert!(records().is_empty(), "{:?}", records());
    assert_eq!(fs::read(real_entry(home.path())).expect("the real entry"), real);
}

#[test]
fn a_relative_directory_is_refused() {
    let home = populated_home();
    for dir in ["session/autostart", "", "./autostart"] {
        assert_refused(&dev_env(home.path(), dir), home.path(), "must be an absolute path");
    }
}

#[test]
fn a_directory_with_dot_components_is_refused() {
    let home = populated_home();
    let base = home.path().display().to_string();
    for dir in [
        format!("{base}/session/../.config/autostart"),
        format!("{base}/./.config/autostart"),
        format!("{base}/session/a/."),
        format!("{base}/session/a/.."),
    ] {
        assert_refused(&dev_env(home.path(), dir), home.path(), "must not contain . or .. components");
    }
}

#[test]
fn the_development_directory_must_be_inside_user_data() {
    let home = populated_home();
    let real = home.path().join(".config").join("autostart");
    for dir in [
        real.clone(),
        real.join("sub"),
        PathBuf::from(format!("{}//", real.display())),
        session(home.path()),
        home.path().join("session-other"),
    ] {
        assert_refused(&dev_env(home.path(), dir), home.path(), "must be inside the userData directory");
    }
    let missing = Environment {
        user_data: home.path().join("missing"),
        ..dev_env(home.path(), home.path().join("missing").join("a"))
    };
    assert_refused(&missing, home.path(), "cannot be checked");
}

#[test]
fn a_user_data_directory_holding_a_real_autostart_directory_is_refused() {
    let home = populated_home();
    let config = home.path().join(".config");
    for user_data in [home.path().to_path_buf(), config.clone(), config.join("autostart")] {
        let env = Environment { user_data: user_data.clone(), ..dev_env(home.path(), user_data.join("dev")) };
        assert_refused(&env, home.path(), "cannot be used: the userData directory");
    }
    let xdg = tempfile::tempdir().expect("XDG_CONFIG_HOME");
    let env = Environment {
        xdg_config_home: Some(xdg.path().to_path_buf()),
        user_data: xdg.path().to_path_buf(),
        ..dev_env(home.path(), xdg.path().join("autostart"))
    };
    assert_refused(&env, home.path(), "cannot be used: the userData directory");
    assert!(snapshot(xdg.path()).is_empty());
}

#[test]
fn a_directory_inside_a_real_autostart_directory_is_refused() {
    let home = populated_home();
    let user_data = home.path().join(".config").join("autostart").join("user-data");
    fs::create_dir(&user_data).expect("userData");
    let env = Environment { user_data: user_data.clone(), ..dev_env(home.path(), user_data.join("dev")) };
    assert_refused(&env, home.path(), "resolves to the real autostart directory");
    let xdg = tempfile::tempdir().expect("XDG_CONFIG_HOME");
    let user_data = xdg.path().join("autostart").join("user-data");
    fs::create_dir_all(&user_data).expect("userData");
    let env = Environment {
        xdg_config_home: Some(xdg.path().to_path_buf()),
        user_data: user_data.clone(),
        ..dev_env(home.path(), user_data.join("dev"))
    };
    assert_refused(&env, xdg.path(), "resolves to the real autostart directory");
}

#[test]
fn the_passwd_home_is_protected_when_home_points_elsewhere() {
    let fake_home = populated_home();
    let passwd_home = populated_home();
    let user_data = passwd_home.path().join(".config").join("autostart").join("user-data");
    fs::create_dir(&user_data).expect("userData");
    let env = Environment {
        passwd_home: Some(passwd_home.path().to_path_buf()),
        user_data: user_data.clone(),
        ..dev_env(fake_home.path(), user_data.join("dev"))
    };
    assert_refused(&env, passwd_home.path(), "resolves to the real autostart directory");
}

#[test]
fn a_relative_or_empty_home_or_no_passwd_home_refuses_the_directory() {
    let home = populated_home();
    let dev = session(home.path()).join("autostart");
    for home_var in ["relative/home", ""] {
        let env = Environment { home_var: Some(OsString::from(home_var)), ..dev_env(home.path(), &dev) };
        assert_refused(&env, home.path(), "cannot be checked: HOME is not an absolute path");
    }
    // `$HOME` as the only source: a user only a directory service knows.
    let env = Environment { passwd_home: None, ..dev_env(home.path(), &dev) };
    assert_refused(&env, home.path(), "cannot be checked: /etc/passwd has no home directory for the user");
}

#[cfg(unix)]
#[test]
fn a_link_into_the_real_directory_is_refused() {
    use std::os::unix::fs::symlink;
    let home = populated_home();
    let session = session(home.path());
    symlink(home.path().join(".config").join("autostart"), session.join("to-autostart")).expect("link");
    symlink(home.path().join(".config"), session.join("to-config")).expect("link");
    for dir in [
        session.join("to-autostart"),
        session.join("to-autostart").join("missing"),
        session.join("to-config").join("autostart"),
    ] {
        assert_refused(&dev_env(home.path(), dir), home.path(), "must be inside the userData directory");
    }
}

#[cfg(unix)]
#[test]
fn an_entry_that_links_into_the_real_directory_is_refused() {
    use std::os::unix::fs::symlink;
    let home = populated_home();
    let dev = session(home.path()).join("autostart");
    fs::create_dir(&dev).expect("dev");
    symlink(real_entry(home.path()), dev.join("pipette.desktop")).expect("link");
    assert_refused(&dev_env(home.path(), &dev), home.path(), "resolves to the real autostart directory");
}

#[cfg(unix)]
#[test]
fn a_dangling_link_is_refused() {
    use std::os::unix::fs::symlink;
    let home = populated_home();
    let session = session(home.path());
    symlink(home.path().join("nowhere"), session.join("dangling")).expect("link");
    assert_refused(
        &dev_env(home.path(), session.join("dangling").join("autostart")),
        home.path(),
        "cannot be resolved",
    );
}

#[test]
fn the_development_directory_is_read_on_linux_only() {
    let home = populated_home();
    let before = snapshot(home.path());
    for os in [Os::Windows, Os::MacOs, Os::Other] {
        let env = Environment { os, ..dev_env(home.path(), session(home.path()).join("autostart")) };
        capture();
        apply(true, &env);
        assert_eq!(
            records(),
            [(Level::Warn, format!("auto-launch skipped: {DEV_DIR_VARIABLE} is read on Linux only"))]
        );
        assert_eq!(snapshot(home.path()), before);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn an_entry_swapped_for_a_link_after_the_check_is_not_written_through() {
    use std::os::unix::fs::symlink;
    let home = populated_home();
    let dev = session(home.path()).join("autostart");
    fs::create_dir(&dev).expect("dev");
    let env = dev_env(home.path(), &dev);
    let checked = checked_target(&env);
    symlink(real_entry(home.path()), dev.join("pipette.desktop")).expect("link");
    assert_not_used(&checked, &env, home.path(), "not a regular file of its own");
}

#[cfg(target_os = "linux")]
#[test]
fn a_directory_swapped_for_a_link_after_the_check_is_not_used() {
    use std::os::unix::fs::symlink;
    let home = populated_home();
    let dev = session(home.path()).join("autostart");
    let env = dev_env(home.path(), &dev);
    let checked = checked_target(&env);
    symlink(home.path().join(".config").join("autostart"), &dev).expect("link");
    assert_not_used(&checked, &env, home.path(), "");
}

#[cfg(target_os = "linux")]
#[test]
fn a_parent_swapped_for_a_link_after_the_check_is_not_used() {
    use std::os::unix::fs::symlink;
    let home = populated_home();
    // The checked directory existed, with its device and inode noted.
    let parent = session(home.path()).join("a");
    fs::create_dir_all(parent.join("autostart")).expect("dev");
    let env = dev_env(home.path(), parent.join("autostart"));
    let checked = checked_target(&env);
    assert!(checked.id.is_some());
    // The parent now leads to the real `.config`, whose `autostart` is a
    // directory, so opening the checked path without following its last
    // part would still land in the real directory.
    fs::remove_dir_all(&parent).expect("remove");
    symlink(home.path().join(".config"), &parent).expect("link");
    assert_not_used(&checked, &env, home.path(), "changed after it was checked");
    // A directory that did not exist at the check is pinned by its path.
    fs::remove_file(&parent).expect("unlink");
    let fresh = dev_env(home.path(), parent.join("autostart"));
    let checked = checked_target(&fresh);
    assert!(checked.id.is_none());
    symlink(home.path().join(".config"), &parent).expect("link");
    assert_not_used(&checked, &fresh, home.path(), "changed after it was checked");
}

#[cfg(target_os = "linux")]
#[test]
fn a_hard_linked_entry_is_refused() {
    let home = populated_home();
    let dev = session(home.path()).join("autostart");
    fs::create_dir(&dev).expect("dev");
    fs::hard_link(real_entry(home.path()), dev.join("pipette.desktop")).expect("hard link");
    let env = dev_env(home.path(), &dev);
    let before = snapshot(home.path());
    for enabled in [true, false] {
        capture();
        apply(enabled, &env);
        let logs = records();
        assert!(logs.len() == 1 && logs[0].1.contains("not a regular file of its own"), "{logs:?}");
        assert_eq!(snapshot(home.path()), before);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn the_entry_replaces_a_plain_file_and_leaves_no_temporary_file() {
    let home = populated_home();
    let dev = session(home.path()).join("autostart");
    fs::create_dir(&dev).expect("dev");
    fs::write(dev.join("pipette.desktop"), "old\n").expect("old entry");
    apply(true, &dev_env(home.path(), &dev));
    let names: Vec<_> = fs::read_dir(&dev).expect("dir").map(|e| e.expect("entry").file_name()).collect();
    assert_eq!(names, [OsString::from("pipette.desktop")]);
    assert_eq!(fs::read(dev.join("pipette.desktop")).expect("entry"), desktop_entry(EXE.as_ref()));
}
