// SPDX-License-Identifier: GPL-2.0-or-later
//! The Win32 calls of the active window lookup, made as
//! `@paymoapp/active-window` makes them: the foreground window's title and
//! process; for a UWP app's frame window, the first child window whose
//! process has a package; the name from that process's executable
//! (app_name.rs). There is no lookup when there is no foreground window,
//! its process cannot be opened, or a UWP frame has no packaged child.
//!
//! The title is read with `InternalGetWindowText`, which never sends the
//! window a message. `GetWindowText` reads the same text without a message
//! for another process's window, but sends `WM_GETTEXT` to a window of this
//! process, and the lookup runs off the main thread: while the main thread
//! waits on the lookup's caller (the quit sequence at sign-out does), that
//! message would never be answered.

use std::ptr;

use windows_sys::Win32::Foundation::{
    APPMODEL_ERROR_NO_PACKAGE, CloseHandle, HANDLE, HWND, LPARAM, MAX_PATH,
};
use windows_sys::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows_sys::Win32::Storage::Packaging::Appx::GetPackageFamilyName;
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetForegroundWindow, GetWindowThreadProcessId, InternalGetWindowText,
};
use windows_sys::core::BOOL;

use crate::ActiveWindowInfo;
use crate::app_name;

/// The longest title read, in UTF-16 units. Only the first few hundred
/// units are ever kept; the buffer doubles from 256 up to this.
const MAX_TITLE_UNITS: usize = 1 << 15;

pub(crate) fn active_window() -> Option<ActiveWindowInfo> {
    // SAFETY: GetForegroundWindow has no preconditions.
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_null() {
        return None;
    }
    let title = window_title(hwnd);
    let mut path = Process::of_window(hwnd)?.image_path();
    if app_name::is_uwp_frame_host(&path) {
        path = packaged_child_path(hwnd)?;
    }
    let application = app_name::application_name(file_description(&path), &path);
    Some(ActiveWindowInfo { application, title })
}

/// The title of `hwnd`, empty when it has none or the window is gone.
pub(crate) fn window_title(hwnd: HWND) -> Vec<u16> {
    let mut capacity = 256;
    loop {
        let mut buffer = vec![0u16; capacity];
        // SAFETY: the buffer holds `capacity` units, which is what the call
        // may write (the NUL included); a handle that is no window answers 0.
        let copied = unsafe { InternalGetWindowText(hwnd, buffer.as_mut_ptr(), capacity as i32) };
        let copied = usize::try_from(copied).unwrap_or(0).min(capacity);
        if copied + 1 < capacity || capacity >= MAX_TITLE_UNITS {
            buffer.truncate(copied);
            return buffer;
        }
        capacity *= 2;
    }
}

/// A process opened for querying, closed on drop.
struct Process(HANDLE);

impl Process {
    /// The process of `hwnd`, when it can be opened.
    fn of_window(hwnd: HWND) -> Option<Self> {
        let mut pid = 0u32;
        // SAFETY: `pid` outlives the call; a handle that is no window leaves
        // it 0, which no process can be opened as.
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        // SAFETY: OpenProcess has no preconditions; it answers null on
        // failure.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        (!handle.is_null()).then(|| Self(handle))
    }

    /// The full path of the process's executable, empty when it cannot be
    /// read (a path longer than `MAX_PATH` included, as for the binding).
    fn image_path(&self) -> Vec<u16> {
        let mut buffer = vec![0u16; MAX_PATH as usize];
        let mut len = MAX_PATH;
        // SAFETY: the process handle is open; the buffer holds `len` units
        // and the call writes back how many it used.
        if unsafe { QueryFullProcessImageNameW(self.0, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut len) }
            == 0
        {
            return Vec::new();
        }
        buffer.truncate(len as usize);
        buffer
    }

    /// Whether the process belongs to a package: asked for the length of
    /// its package family name, anything but "no package" counts.
    fn has_package(&self) -> bool {
        let mut len = 0u32;
        // SAFETY: the process handle is open; with a length of 0 and no
        // buffer the call only reports the length it needs.
        unsafe { GetPackageFamilyName(self.0, &mut len, ptr::null_mut()) != APPMODEL_ERROR_NO_PACKAGE }
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        // SAFETY: the handle was opened by OpenProcess and is closed once.
        unsafe { CloseHandle(self.0) };
    }
}

/// The executable of the first child window of the UWP frame `hwnd` whose
/// process has a package.
fn packaged_child_path(hwnd: HWND) -> Option<Vec<u16>> {
    let mut found: Option<Vec<u16>> = None;
    // SAFETY: the callback matches WNDENUMPROC, and the pointer it gets is
    // to `found`, which outlives the enumeration (EnumChildWindows returns
    // after its last callback).
    unsafe {
        EnumChildWindows(hwnd, Some(find_packaged_child), &mut found as *mut Option<Vec<u16>> as LPARAM)
    };
    found
}

unsafe extern "system" fn find_packaged_child(hwnd: HWND, found: LPARAM) -> BOOL {
    // SAFETY: `found` is the pointer packaged_child_path passed, to an
    // Option nothing else touches during the enumeration.
    let found = unsafe { &mut *(found as *mut Option<Vec<u16>>) };
    let Some(process) = Process::of_window(hwnd) else { return 1 };
    if !process.has_package() {
        return 1;
    }
    *found = Some(process.image_path());
    0
}

/// The `FileDescription` of the executable at `path`, empty when it has no
/// version resource or no description in its first language.
pub(crate) fn file_description(path: &[u16]) -> Vec<u16> {
    let path: Vec<u16> = path.iter().copied().chain([0]).collect();
    // SAFETY: `path` is NUL-terminated; a null handle pointer is allowed.
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), ptr::null_mut()) };
    if size == 0 {
        return Vec::new();
    }
    let mut block = vec![0u8; size as usize];
    // SAFETY: `path` is NUL-terminated and the block holds the `size` bytes
    // the call may write.
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, block.as_mut_ptr().cast()) } == 0 {
        return Vec::new();
    }
    // The binding reads the first language whenever the value is not empty.
    let translation = query(&block, &app_name::translation_query())
        .filter(|&(_, len)| len != 0)
        .and_then(|(address, _)| app_name::within(&block, address, 4));
    let description = app_name::file_description_query(app_name::translation(translation));
    match query(&block, &description) {
        Some((address, units)) if units != 0 => app_name::within(&block, address, units as usize * 2)
            .map(app_name::string_value)
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// The address and length `VerQueryValueW` gives for `sub_block` (a
/// NUL-terminated query) in `block`: bytes for a binary value, UTF-16 units
/// for a string.
fn query(block: &[u8], sub_block: &[u16]) -> Option<(usize, u32)> {
    let mut value = ptr::null_mut();
    let mut len = 0u32;
    // SAFETY: `block` is a version-information block from
    // GetFileVersionInfoW that outlives the call, `sub_block` is
    // NUL-terminated, and the out pointers are to locals. The address given
    // back is only compared, never read through (app_name::within).
    let ok = unsafe { VerQueryValueW(block.as_ptr().cast(), sub_block.as_ptr(), &mut value, &mut len) };
    (ok != 0 && !value.is_null()).then_some((value as usize, len))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, SetForegroundWindow, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
    };

    use super::*;

    fn units(text: &str) -> Vec<u16> {
        text.encode_utf16().collect()
    }

    fn path_units(path: &std::path::Path) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str().encode_wide().collect()
    }

    fn this_exe() -> PathBuf {
        std::env::current_exe().expect("the test's own executable")
    }

    #[test]
    fn a_system_executable_is_named_by_its_description() {
        let windows = std::env::var_os("SystemRoot").expect("SystemRoot is set");
        let explorer = PathBuf::from(windows).join("explorer.exe");
        let path = path_units(&explorer);
        let description = file_description(&path);
        // The description is in the system's language ("Windows Explorer" in
        // English); any description names it rather than its file name.
        assert!(!description.is_empty());
        assert_ne!(description, units("explorer.exe"));
        assert_eq!(app_name::application_name(description.clone(), &path), description);
    }

    #[test]
    fn an_executable_without_a_version_resource_is_named_by_its_file() {
        let exe = this_exe();
        let path = path_units(&exe);
        assert_eq!(file_description(&path), units(""));
        let name = exe.file_name().expect("a file name").to_string_lossy().into_owned();
        assert!(name.ends_with(".exe"), "{name}");
        assert_eq!(app_name::application_name(file_description(&path), &path), units(&name));
    }

    #[test]
    fn a_missing_file_has_no_description() {
        assert_eq!(file_description(&units("C:\\no\\such\\file.exe")), units(""));
        assert_eq!(file_description(&[]), units(""));
    }

    #[test]
    fn a_handle_that_is_no_window_has_no_title() {
        assert_eq!(window_title(ptr::null_mut()), units(""));
    }

    /// A window of this thread, shown or hidden.
    struct TestWindow(HWND);

    impl TestWindow {
        fn new(title: &str, visible: bool) -> Self {
            let style = if visible { WS_OVERLAPPEDWINDOW | WS_VISIBLE } else { WS_OVERLAPPEDWINDOW };
            let title: Vec<u16> = title.encode_utf16().chain([0]).collect();
            // SAFETY: the STATIC class is registered by the system; every
            // pointer argument is a valid string or null.
            let hwnd = unsafe {
                CreateWindowExW(
                    0,
                    windows_sys::core::w!("STATIC"),
                    title.as_ptr(),
                    style,
                    0,
                    0,
                    320,
                    240,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null(),
                )
            };
            assert!(!hwnd.is_null(), "CreateWindowExW failed");
            Self(hwnd)
        }
    }

    impl Drop for TestWindow {
        fn drop(&mut self) {
            // SAFETY: the window belongs to this thread and is destroyed once.
            unsafe { DestroyWindow(self.0) };
        }
    }

    #[test]
    fn the_titles_of_this_process_s_windows_are_read_without_a_message() {
        let title = "pipette-native active window \u{3042}";
        // Hidden, so it never competes with the foreground test's window.
        let window = TestWindow::new(title, false);
        // This thread does not answer messages while it waits for the other
        // one: a title read with WM_GETTEXT would never come back.
        let hwnd = window.0 as usize;
        let read = std::thread::spawn(move || window_title(hwnd as HWND)).join().expect("the read");
        assert_eq!(read, units(title));
    }

    #[test]
    fn this_process_s_foreground_window_is_named_by_its_executable() {
        let title = "pipette-native foreground window";
        let window = TestWindow::new(title, true);
        // SAFETY: the window belongs to this thread.
        unsafe { SetForegroundWindow(window.0) };
        // SAFETY: GetForegroundWindow has no preconditions.
        let in_front = unsafe { GetForegroundWindow() } == window.0;
        // The lookup runs either way, off this thread, which answers no
        // messages meanwhile.
        let info = std::thread::spawn(active_window).join().expect("the lookup");
        if !in_front {
            eprintln!(
                "SKIPPED the name check: the session did not let the test's window come to the foreground (lookup: {:?})",
                info.as_ref().map(|info| String::from_utf16_lossy(&info.application))
            );
            return;
        }
        let name = this_exe().file_name().expect("a file name").to_string_lossy().into_owned();
        assert_eq!(info, Some(ActiveWindowInfo { application: units(&name), title: units(title) }));
    }
}
