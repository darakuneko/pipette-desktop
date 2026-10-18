// SPDX-License-Identifier: GPL-2.0-or-later
//! Refusing to start while the Electron build runs on the same userData
//! directory: the reason goes to stderr and into a native message box
//! (English, as the app has no translations before the page loads), then
//! the process exits with 1. Without a display the message box is skipped.

use std::path::Path;

/// The title of the message box.
const TITLE: &str = "Pipette";

/// Why the app does not start: the Electron build (process `pid`, when
/// known) holds `dir`.
pub fn electron_running(dir: &Path, pid: Option<u32>) -> String {
    let process = pid.map(|pid| format!(" (process {pid})")).unwrap_or_default();
    format!(
        "Pipette can't start because an older version of Pipette{process} is running with the same data \
         folder:\n{}\n\nQuit the older version, then start Pipette again.",
        dir.display()
    )
}

/// Why the app does not start: `dir` could not be locked against the
/// Electron build.
#[cfg(target_os = "windows")]
pub fn lock_failed(dir: &Path, err: &dyn std::fmt::Display) -> String {
    format!("Pipette can't start because its data folder can't be locked:\n{}\n\n{err}", dir.display())
}

/// Reports `message` and ends the process.
pub fn refuse(message: &str) -> ! {
    eprintln!("cannot start: {message}");
    show(message);
    std::process::exit(1);
}

fn show(message: &str) {
    // rfd shows its GTK dialogs on a thread of its own that waits forever
    // when GTK cannot start, so the display is tried here first.
    #[cfg(target_os = "linux")]
    if gtk::init().is_err() {
        return;
    }
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title(TITLE)
        .set_description(message)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_message_names_the_folder_and_the_process() {
        let dir = std::env::temp_dir().join("pipette-desktop");
        let message = electron_running(&dir, Some(4242));
        assert!(message.contains(" (process 4242) "), "{message}");
        assert!(message.contains(&dir.display().to_string()), "{message}");
        assert!(!electron_running(&dir, None).contains("process"));
    }
}
