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
//! - Linux: run from an AppImage (`APPIMAGE` is set), or from anywhere that
//!   is not a Cargo target directory.
//! - Windows: the installed `pipette.exe`, next to the `uninstall.exe` the
//!   NSIS installer writes into the installation folder.
//! - macOS: the executable inside an application bundle
//!   (`<name>.app/Contents/MacOS/`).
//!
//! On every system an executable inside a Cargo target directory (a
//! directory named `target`, or one holding Cargo's `.rustc_info.json`, which
//! a `CARGO_TARGET_DIR` elsewhere also gets) is not one, except on Linux when
//! `APPIMAGE` is set: `tauri build` leaves its bundles there too.

use std::ffi::OsStr;
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
pub const WINDOWS_UNINSTALLER: &str = "uninstall.exe";

/// The file Cargo keeps at the root of every target directory.
const CARGO_TARGET_MARK: &str = ".rustc_info.json";

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
    is_distributed_executable(Platform::current(), &exe, std::env::var_os("APPIMAGE").as_deref(), |path| {
        path.is_file()
    })
}

/// Whether `exe` on `platform` is the executable a release ships (see the
/// module documentation), with `appimage` the value of `APPIMAGE` and
/// `is_file` telling whether a file exists.
pub fn is_distributed_executable(
    platform: Platform,
    exe: &Path,
    appimage: Option<&OsStr>,
    is_file: impl Fn(&Path) -> bool,
) -> bool {
    if !exe.is_absolute() {
        return false;
    }
    match platform {
        Platform::Linux => appimage.is_some_and(|value| !value.is_empty()) || !in_cargo_target(exe, &is_file),
        Platform::Windows => {
            exe.parent().is_some_and(|dir| is_file(&dir.join(WINDOWS_UNINSTALLER)))
                && !in_cargo_target(exe, &is_file)
        }
        Platform::MacOs => in_app_bundle(exe) && !in_cargo_target(exe, &is_file),
        Platform::Other => false,
    }
}

/// Whether a directory above `exe` is a Cargo target directory.
fn in_cargo_target(exe: &Path, is_file: &impl Fn(&Path) -> bool) -> bool {
    exe.ancestors().skip(1).any(|dir| {
        dir.file_name().is_some_and(|name| name.eq_ignore_ascii_case("target"))
            || is_file(&dir.join(CARGO_TARGET_MARK))
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
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    use super::*;

    /// The predicate over a file system holding `files`.
    fn distributed(platform: Platform, exe: &str, appimage: Option<&str>, files: &[&str]) -> bool {
        let files: BTreeSet<PathBuf> = files.iter().map(PathBuf::from).collect();
        is_distributed_executable(platform, Path::new(exe), appimage.map(OsStr::new), |path| {
            files.contains(path)
        })
    }

    // The tables use Unix paths, which are not absolute on Windows; the
    // Windows branch has its own test there.
    #[cfg(unix)]
    #[test]
    fn linux_distributes_an_appimage_or_an_executable_outside_a_target_directory() {
        use Platform::Linux;
        let rustc_info = "/work/out/.rustc_info.json";
        let cases: &[(&str, Option<&str>, &[&str], bool)] = &[
            // The AppImage's mount, extracted images, a copy elsewhere.
            ("/tmp/.mount_PipetXyz/usr/bin/pipette", Some("/home/u/Pipette.AppImage"), &[], true),
            ("/tmp/.mount_PipetXyz/usr/bin/pipette", None, &[], true),
            ("/home/u/squashfs-root/usr/bin/pipette", None, &[], true),
            ("/opt/pipette/pipette", None, &[], true),
            // Release builds in a source tree.
            ("/home/u/pipette-desktop/src-tauri/target/release/pipette", None, &[], false),
            (
                "/home/u/pipette-desktop/src-tauri/target/release/bundle/appimage/Pipette.AppDir/usr/bin/pipette",
                None,
                &[],
                false,
            ),
            ("/home/u/Target/release/pipette", None, &[], false),
            // A CARGO_TARGET_DIR that is not named target.
            ("/work/out/release/pipette", None, &[rustc_info], false),
            ("/work/out/release/pipette", Some(""), &[rustc_info], false),
            // APPIMAGE is set by the AppImage runtime only.
            (
                "/home/u/pipette-desktop/src-tauri/target/release/pipette",
                Some("/x/Pipette.AppImage"),
                &[],
                true,
            ),
            // Not a path the executable could have.
            ("relative/pipette", Some("/x/Pipette.AppImage"), &[], false),
        ];
        for (exe, appimage, files, want) in cases {
            assert_eq!(distributed(Linux, exe, *appimage, files), *want, "{exe} {appimage:?}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_distributes_the_installed_executable() {
        use Platform::Windows;
        let installed = r"C:\Users\u\AppData\Local\Pipette\pipette.exe";
        let uninstaller = r"C:\Users\u\AppData\Local\Pipette\uninstall.exe";
        assert!(distributed(Windows, installed, None, &[uninstaller]));
        assert!(!distributed(Windows, installed, None, &[]));
        let built = r"C:\src\pipette-desktop\src-tauri\target\release\pipette.exe";
        let built_uninstaller = r"C:\src\pipette-desktop\src-tauri\target\release\uninstall.exe";
        assert!(!distributed(Windows, built, None, &[built_uninstaller]));
        // APPIMAGE means nothing there.
        assert!(!distributed(Windows, installed, Some("x"), &[]));
    }

    #[cfg(unix)]
    #[test]
    fn the_windows_branch_with_unix_paths() {
        // `C:\…` is not an absolute path on Unix; the Unix form of the same
        // layout checks the branch here.
        use Platform::Windows;
        assert!(distributed(Windows, "/c/Pipette/pipette.exe", None, &["/c/Pipette/uninstall.exe"]));
        assert!(!distributed(Windows, "/c/Pipette/pipette.exe", None, &[]));
        assert!(!distributed(
            Windows,
            "/src/target/release/pipette.exe",
            None,
            &["/src/target/release/uninstall.exe"]
        ));
    }

    #[cfg(unix)]
    #[test]
    fn macos_distributes_the_executable_of_an_application_bundle() {
        use Platform::MacOs;
        let cases: &[(&str, &[&str], bool)] = &[
            ("/Applications/Pipette.app/Contents/MacOS/pipette", &[], true),
            ("/Users/u/Downloads/Pipette.APP/Contents/MacOS/pipette", &[], true),
            ("/Volumes/Pipette/Pipette.app/Contents/MacOS/pipette", &[], true),
            (
                "/Users/u/src/src-tauri/target/release/bundle/macos/Pipette.app/Contents/MacOS/pipette",
                &[],
                false,
            ),
            (
                "/out/release/bundle/macos/Pipette.app/Contents/MacOS/pipette",
                &["/out/.rustc_info.json"],
                false,
            ),
            ("/Users/u/src/src-tauri/target/release/pipette", &[], false),
            ("/usr/local/bin/pipette", &[], false),
            ("/Applications/Pipette/Contents/MacOS/pipette", &[], false),
            ("/Applications/Pipette.app/MacOS/pipette", &[], false),
        ];
        for (exe, files, want) in cases {
            assert_eq!(distributed(MacOs, exe, None, files), *want, "{exe}");
        }
    }

    #[test]
    fn other_systems_never_distribute() {
        let exe = std::env::temp_dir().join("pipette");
        assert!(!is_distributed_executable(Platform::Other, &exe, Some(OsStr::new("/x")), |_| true));
    }

    #[test]
    fn a_build_with_the_development_tools_or_a_debug_build_is_never_distributed() {
        assert!(!is_distributed_build(false));
    }

    #[test]
    fn this_test_binary_is_not_distributed() {
        // It runs from Cargo's target directory.
        assert!(!is_distributed_build(true));
    }
}
