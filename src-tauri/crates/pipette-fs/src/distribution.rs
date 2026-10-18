// SPDX-License-Identifier: GPL-2.0-or-later
//! Whether this process runs a build that was handed out to users: a
//! release build without the development tools, started from the
//! executable a release ships. Only such a build opens the Electron build's
//! userData directory by default and registers itself to start at sign-in;
//! every other build (debug, development tools, a release built in a source
//! tree, the e2e runs) keeps to a directory of its own and to no real
//! autostart entry.
//!
//! The executable a release ships:
//! - Linux: any executable outside a Cargo target directory. When
//!   `APPIMAGE` is set it must also lie inside `APPDIR`, the mount of the
//!   AppImage the runtime started: a variable inherited from an AppImage
//!   that started some other program does not count. Any AppImage run as an
//!   AppImage is distributed, a locally built one included.
//! - Windows: the installed `pipette.exe`, next to the `uninstall.exe` the
//!   NSIS installer writes into the installation folder.
//! - macOS: the executable inside an application bundle
//!   (`<name>.app/Contents/MacOS/`).
//!
//! On every system an executable inside a Cargo target directory is not
//! one. A target directory is told by what Cargo keeps at its root
//! (`.rustc_info.json`, or a `CACHEDIR.TAG` Cargo wrote), not by its name, so
//! a `CARGO_TARGET_DIR` of any name is one and an installation under a folder
//! that happens to be called `target` is not.

use std::ffi::OsStr;
use std::io::Read;
use std::path::Path;

/// The system the predicate is evaluated for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Windows,
    MacOs,
    /// A system no release is built for.
    Other,
}

impl Platform {
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

/// The uninstaller the NSIS installer writes next to the installed
/// executable (`WriteUninstaller "$INSTDIR\uninstall.exe"` of Tauri's
/// installer template).
const WINDOWS_UNINSTALLER: &str = "uninstall.exe";

/// The file Cargo keeps at the root of every target directory.
const CARGO_RUSTC_INFO: &str = ".rustc_info.json";

/// The cache directory tag Cargo writes at the root of a target directory,
/// and the words that tell Cargo's apart from other programs' tags.
const CACHEDIR_TAG: &str = "CACHEDIR.TAG";
const CARGO_TAG_MARK: &str = "created by cargo";

/// What the predicate reads besides the executable's path.
pub(crate) struct Context<'a> {
    /// `APPIMAGE` and `APPDIR` as the process has them.
    pub(crate) appimage: Option<&'a OsStr>,
    pub(crate) appdir: Option<&'a Path>,
    /// Whether a file exists.
    pub(crate) is_file: &'a dyn Fn(&Path) -> bool,
    /// The start of a file's text, `None` when it cannot be read.
    pub(crate) read_start: &'a dyn Fn(&Path) -> Option<String>,
}

/// Whether this process is a distributed build. `release_without_dev_tools`
/// is the app crate's `cfg!(release_profile) && !cfg!(feature = "dev-tools")`;
/// the rest is read from the process. An executable whose path cannot be
/// read counts as not distributed.
pub fn is_distributed_build(release_without_dev_tools: bool) -> bool {
    if !release_without_dev_tools {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let appimage = std::env::var_os("APPIMAGE");
    // The executable's path has its links resolved; so must the mount's.
    let appdir = std::env::var_os("APPDIR").and_then(|dir| std::fs::canonicalize(dir).ok());
    let context = Context {
        appimage: appimage.as_deref(),
        appdir: appdir.as_deref(),
        is_file: &|path| path.is_file(),
        read_start: &read_start,
    };
    is_distributed_executable(Platform::current(), &exe, &context)
}

/// The first KiB of `path` as text.
fn read_start(path: &Path) -> Option<String> {
    let mut text = String::new();
    std::fs::File::open(path).ok()?.take(1024).read_to_string(&mut text).ok()?;
    Some(text)
}

/// Whether `exe` on `platform` is the executable a release ships (see the
/// module documentation).
pub(crate) fn is_distributed_executable(platform: Platform, exe: &Path, context: &Context<'_>) -> bool {
    if !exe.is_absolute() || in_cargo_target(exe, context) {
        return false;
    }
    match platform {
        Platform::Linux => match context.appimage.filter(|value| !value.is_empty()) {
            Some(_) => context.appdir.is_some_and(|dir| dir.is_absolute() && exe.starts_with(dir)),
            None => true,
        },
        Platform::Windows => {
            exe.parent().is_some_and(|dir| (context.is_file)(&dir.join(WINDOWS_UNINSTALLER)))
        }
        Platform::MacOs => in_app_bundle(exe),
        Platform::Other => false,
    }
}

/// Whether a directory above `exe` is a Cargo target directory.
fn in_cargo_target(exe: &Path, context: &Context<'_>) -> bool {
    exe.ancestors().skip(1).any(|dir| {
        (context.is_file)(&dir.join(CARGO_RUSTC_INFO))
            || (context.read_start)(&dir.join(CACHEDIR_TAG)).is_some_and(|tag| tag.contains(CARGO_TAG_MARK))
    })
}

/// Whether `exe` is `<name>.app/Contents/MacOS/<exe>`.
fn in_app_bundle(exe: &Path) -> bool {
    let mut parents = exe.ancestors().skip(1);
    let named = |dir: Option<&Path>, name: &str| {
        dir.and_then(Path::file_name).is_some_and(|dir| dir.eq_ignore_ascii_case(name))
    };
    named(parents.next(), "MacOS")
        && named(parents.next(), "Contents")
        && parents
            .next()
            .and_then(Path::extension)
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    use super::*;

    /// Cargo's tag, as it writes it.
    const CARGO_TAG: &str = "Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n# For information about cache directory tags see https://bford.info/cachedir/\n";

    /// Files (path and text) a case's file system holds.
    type Files<'a> = &'a [(&'a str, &'a str)];

    /// The executable, `APPIMAGE`, `APPDIR`, the files and the answer.
    type Case<'a> = (&'a str, Option<&'a str>, Option<&'a str>, Files<'a>, bool);

    /// The predicate over a file system holding `files` (path and text),
    /// with `APPIMAGE` and `APPDIR`.
    fn distributed(
        platform: Platform,
        exe: &str,
        appimage: Option<&str>,
        appdir: Option<&str>,
        files: &[(&str, &str)],
    ) -> bool {
        let files: BTreeMap<PathBuf, String> =
            files.iter().map(|(path, text)| (PathBuf::from(path), (*text).to_owned())).collect();
        let appdir = appdir.map(PathBuf::from);
        let context = Context {
            appimage: appimage.map(OsStr::new),
            appdir: appdir.as_deref(),
            is_file: &|path| files.contains_key(path),
            read_start: &|path| files.get(path).cloned(),
        };
        is_distributed_executable(platform, Path::new(exe), &context)
    }

    // The tables use Unix paths, which are not absolute on Windows; the
    // Windows branch has its own test there.
    #[cfg(unix)]
    #[test]
    fn linux_distributes_an_appimage_or_an_executable_outside_a_target_directory() {
        use Platform::Linux;
        let mount = "/tmp/.mount_PipetXyz";
        let in_mount = "/tmp/.mount_PipetXyz/usr/bin/pipette";
        let tree = "/home/u/pipette-desktop/src-tauri/target/release/pipette";
        let tree_marks: &[(&str, &str)] =
            &[("/home/u/pipette-desktop/src-tauri/target/.rustc_info.json", "{}")];
        let tag_only: &[(&str, &str)] = &[("/work/out/CACHEDIR.TAG", CARGO_TAG)];
        let other_tag: &[(&str, &str)] =
            &[("/home/u/.cache/CACHEDIR.TAG", "Signature: 8a477f597d28d172789f06886806bc55\n")];
        let cases: &[Case<'_>] = &[
            // The AppImage's mount, extracted images, a copy elsewhere.
            (in_mount, Some("/home/u/Pipette.AppImage"), Some(mount), &[], true),
            (in_mount, None, None, &[], true),
            ("/home/u/squashfs-root/usr/bin/pipette", None, None, &[], true),
            ("/opt/pipette/pipette", None, None, &[], true),
            // A folder that is merely called target.
            ("/home/u/target/Pipette/usr/bin/pipette", None, None, &[], true),
            // Another program's cache directory tag.
            ("/home/u/.cache/apps/pipette", None, None, other_tag, true),
            // Release builds in a source tree, the bundles of `tauri build`.
            (tree, None, None, tree_marks, false),
            (
                "/home/u/pipette-desktop/src-tauri/target/release/bundle/appimage/Pipette.AppDir/usr/bin/pipette",
                None,
                None,
                tree_marks,
                false,
            ),
            // A CARGO_TARGET_DIR of another name, told by either mark.
            ("/work/out/release/pipette", None, None, &[("/work/out/.rustc_info.json", "{}")], false),
            ("/work/out/release/pipette", None, None, tag_only, false),
            // A target directory wins over APPIMAGE.
            (tree, Some("/x/Pipette.AppImage"), Some("/home/u/pipette-desktop"), tree_marks, false),
            // APPIMAGE inherited by a program outside the AppImage's mount.
            ("/opt/pipette/pipette", Some("/x/Pipette.AppImage"), Some(mount), &[], false),
            ("/opt/pipette/pipette", Some("/x/Pipette.AppImage"), None, &[], false),
            ("/opt/pipette/pipette", Some(""), None, &[], true),
            // Not a path the executable could have.
            ("relative/pipette", Some("/x/Pipette.AppImage"), Some(mount), &[], false),
        ];
        for (exe, appimage, appdir, files, want) in cases {
            assert_eq!(
                distributed(Linux, exe, *appimage, *appdir, files),
                *want,
                "{exe} {appimage:?} {appdir:?}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_distributes_the_installed_executable() {
        use Platform::Windows;
        let installed = r"C:\Users\u\AppData\Local\Pipette\pipette.exe";
        let uninstaller = r"C:\Users\u\AppData\Local\Pipette\uninstall.exe";
        assert!(distributed(Windows, installed, None, None, &[(uninstaller, "")]));
        assert!(!distributed(Windows, installed, None, None, &[]));
        let under_target = r"D:\target\Pipette\pipette.exe";
        assert!(distributed(Windows, under_target, None, None, &[(r"D:\target\Pipette\uninstall.exe", "")]));
        let built = r"C:\src\pipette-desktop\src-tauri\target\release\pipette.exe";
        let marks = [
            (r"C:\src\pipette-desktop\src-tauri\target\release\uninstall.exe", ""),
            (r"C:\src\pipette-desktop\src-tauri\target\.rustc_info.json", "{}"),
        ];
        assert!(!distributed(Windows, built, None, None, &marks));
        // APPIMAGE means nothing there.
        assert!(!distributed(Windows, installed, Some("x"), None, &[]));
    }

    #[cfg(unix)]
    #[test]
    fn the_windows_branch_with_unix_paths() {
        // `C:\…` is not an absolute path on Unix; the Unix form of the same
        // layout checks the branch here.
        use Platform::Windows;
        assert!(distributed(
            Windows,
            "/c/Pipette/pipette.exe",
            None,
            None,
            &[("/c/Pipette/uninstall.exe", "")]
        ));
        assert!(!distributed(Windows, "/c/Pipette/pipette.exe", None, None, &[]));
        assert!(distributed(
            Windows,
            "/d/target/Pipette/pipette.exe",
            None,
            None,
            &[("/d/target/Pipette/uninstall.exe", "")]
        ));
        assert!(!distributed(
            Windows,
            "/src/target/release/pipette.exe",
            None,
            None,
            &[("/src/target/release/uninstall.exe", ""), ("/src/target/CACHEDIR.TAG", CARGO_TAG)]
        ));
    }

    #[cfg(unix)]
    #[test]
    fn macos_distributes_the_executable_of_an_application_bundle() {
        use Platform::MacOs;
        let cases: &[(&str, Files<'_>, bool)] = &[
            ("/Applications/Pipette.app/Contents/MacOS/pipette", &[], true),
            ("/Users/u/Downloads/Pipette.APP/Contents/MacOS/pipette", &[], true),
            ("/Volumes/Pipette/Pipette.app/Contents/MacOS/pipette", &[], true),
            ("/Users/u/target/Pipette.app/Contents/MacOS/pipette", &[], true),
            (
                "/Users/u/src/src-tauri/target/release/bundle/macos/Pipette.app/Contents/MacOS/pipette",
                &[("/Users/u/src/src-tauri/target/.rustc_info.json", "{}")],
                false,
            ),
            (
                "/out/release/bundle/macos/Pipette.app/Contents/MacOS/pipette",
                &[("/out/CACHEDIR.TAG", CARGO_TAG)],
                false,
            ),
            ("/usr/local/bin/pipette", &[], false),
            ("/Applications/Pipette/Contents/MacOS/pipette", &[], false),
            ("/Applications/Pipette.app/MacOS/pipette", &[], false),
        ];
        for (exe, files, want) in cases {
            assert_eq!(distributed(MacOs, exe, None, None, files), *want, "{exe}");
        }
    }

    #[test]
    fn other_systems_never_distribute() {
        let exe = std::env::temp_dir().join("pipette");
        assert!(!distributed(Platform::Other, &exe.display().to_string(), Some("/x"), None, &[]));
    }

    #[test]
    fn a_build_with_the_development_tools_or_a_debug_build_is_never_distributed() {
        assert!(!is_distributed_build(false));
    }

    #[test]
    fn this_test_binary_is_not_distributed() {
        // It runs from Cargo's target directory, which holds both marks.
        assert!(!is_distributed_build(true));
    }

    #[test]
    fn the_start_of_a_file_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let tag = dir.path().join(CACHEDIR_TAG);
        std::fs::write(&tag, CARGO_TAG).unwrap();
        assert!(read_start(&tag).is_some_and(|text| text.contains(CARGO_TAG_MARK)));
        assert_eq!(read_start(&dir.path().join("missing")), None);
    }
}
