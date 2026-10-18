// SPDX-License-Identifier: GPL-2.0-or-later
//! The fallback order of `ActiveWindow::app_name` with scripted lookups, and
//! the fakes the golden tests share.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;

/// A native lookup that gives the same answer every time.
pub(crate) enum FakeNative {
    Throws,
    NoWindow,
    Window(JsString, JsString),
}

impl FakeNative {
    pub fn window(application: &str, title: &str) -> Self {
        FakeNative::Window(application.into(), title.into())
    }
}

impl NativeBackend for FakeNative {
    fn active_window(&mut self) -> Result<Option<WindowInfo>, NativeError> {
        match self {
            FakeNative::Throws => Err("Failed to get active window".into()),
            FakeNative::NoWindow => Ok(None),
            FakeNative::Window(application, title) => {
                Ok(Some(WindowInfo { application: application.clone(), title: title.clone() }))
            }
        }
    }
}

/// One run of the command runner: the program, its arguments and timeout.
pub(crate) type Run = (String, Vec<String>, Duration);

/// A command runner that records its runs and gives `stdout` (`None`: the
/// command fails).
#[derive(Clone)]
pub(crate) struct FakeRunner {
    pub stdout: Option<String>,
    pub runs: Arc<Mutex<Vec<Run>>>,
}

impl FakeRunner {
    pub fn new(stdout: Option<&str>) -> Self {
        Self { stdout: stdout.map(str::to_owned), runs: Arc::default() }
    }

    pub fn runs(&self) -> Vec<Run> {
        self.runs.lock().map(|runs| runs.clone()).unwrap_or_default()
    }
}

impl CommandRunner for FakeRunner {
    fn run(&self, program: &str, args: &[&str], timeout: Duration) -> Option<String> {
        if let Ok(mut runs) = self.runs.lock() {
            runs.push((program.to_owned(), args.iter().map(|&arg| arg.to_owned()).collect(), timeout));
        }
        self.stdout.clone()
    }
}

const SHELL_REPLY: &str = "('{\"wm_class\":\"org.gnome.Shell\"}',)\n";

pub(crate) fn lookup(native: Option<FakeNative>, gdbus: Option<&FakeRunner>) -> ActiveWindow {
    ActiveWindow::new(
        native.map(|native| Box::new(native) as Box<dyn NativeBackend>),
        gdbus.map(|runner| GnomeFocusedWindow::new(Box::new(runner.clone()))),
    )
}

#[test]
fn application_name_comes_first_and_skips_the_query() {
    let runner = FakeRunner::new(Some(SHELL_REPLY));
    let mut active = lookup(Some(FakeNative::window(" Code ", "main.ts")), Some(&runner));
    assert_eq!(active.app_name(), Some("Code".into()));
    assert!(runner.runs().is_empty());
}

#[test]
fn title_is_used_when_the_application_is_empty() {
    let runner = FakeRunner::new(Some(SHELL_REPLY));
    let mut active = lookup(Some(FakeNative::window("\u{1} ", " Title ")), Some(&runner));
    assert_eq!(active.app_name(), Some("Title".into()));
    assert!(runner.runs().is_empty());
}

#[test]
fn every_native_miss_goes_to_the_query() {
    let natives =
        [None, Some(FakeNative::Throws), Some(FakeNative::NoWindow), Some(FakeNative::window(" ", "\t"))];
    for native in natives {
        let runner = FakeRunner::new(Some(SHELL_REPLY));
        let mut active = lookup(native, Some(&runner));
        assert_eq!(active.app_name(), Some("Shell".into()));
        let runs = runner.runs();
        assert_eq!(runs.len(), 1);
        let (program, args, timeout) = &runs[0];
        assert_eq!(program, GDBUS_COMMAND[0]);
        assert_eq!(args, &GDBUS_COMMAND[1..]);
        assert_eq!(*timeout, Duration::from_millis(500));
    }
}

#[test]
fn a_failed_query_has_no_name() {
    // Other Wayland compositors, GNOME without the extension, no session bus
    // or no gdbus: the command fails.
    let runner = FakeRunner::new(None);
    let mut active = lookup(Some(FakeNative::Throws), Some(&runner));
    assert_eq!(active.app_name(), None);
    assert_eq!(runner.runs().len(), 1);
}

#[test]
fn without_the_query_a_native_miss_has_no_name() {
    assert_eq!(lookup(None, None).app_name(), None);
    assert_eq!(lookup(Some(FakeNative::NoWindow), None).app_name(), None);
    assert_eq!(lookup(Some(FakeNative::window("", "")), None).app_name(), None);
}

#[test]
fn native_errors_warn_once_and_only_without_the_query() {
    let mut active = lookup(Some(FakeNative::Throws), None);
    assert_eq!(active.app_name(), None);
    assert!(active.warned);
    let mut linux = lookup(Some(FakeNative::Throws), Some(&FakeRunner::new(None)));
    linux.app_name();
    assert!(!linux.warned);
}

#[test]
fn the_current_os_has_the_x11_lookup_and_the_query_on_linux_only() {
    // Not asked for a name: on Linux that would open the desktop's display.
    let active = ActiveWindow::for_current_os();
    assert_eq!(matches!(active.native, Native::NotLoaded(_)), cfg!(target_os = "linux"));
    assert_eq!(active.focused_window.is_some(), cfg!(target_os = "linux"));
}

#[test]
fn the_native_lookup_is_loaded_once_at_the_first_name() {
    let loads = Arc::new(Mutex::new(0));
    let counter = Arc::clone(&loads);
    let load: NativeLoader = Box::new(move || {
        *counter.lock().unwrap() += 1;
        Ok(Box::new(FakeNative::window("App", "")) as Box<dyn NativeBackend>)
    });
    let mut active = ActiveWindow::with_loader(load, None);
    assert_eq!(*loads.lock().unwrap(), 0);
    assert_eq!(active.app_name(), Some("App".into()));
    assert_eq!(active.app_name(), Some("App".into()));
    assert_eq!(*loads.lock().unwrap(), 1);
    assert!(!active.warned);
}

#[test]
fn a_native_lookup_that_fails_to_load_warns_once_and_is_not_retried() {
    let loads = Arc::new(Mutex::new(0));
    let counter = Arc::clone(&loads);
    let load: NativeLoader = Box::new(move || {
        *counter.lock().unwrap() += 1;
        Err("Failed to open display".into())
    });
    let runner = FakeRunner::new(Some(SHELL_REPLY));
    let mut active = ActiveWindow::with_loader(load, Some(GnomeFocusedWindow::new(Box::new(runner.clone()))));
    assert_eq!(active.app_name(), Some("Shell".into()));
    assert_eq!(active.app_name(), Some("Shell".into()));
    assert_eq!(*loads.lock().unwrap(), 1);
    assert_eq!(runner.runs().len(), 2);
    assert!(active.warned);
}
