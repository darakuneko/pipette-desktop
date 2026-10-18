// SPDX-License-Identifier: GPL-2.0-or-later
//! Refusing to start while the Electron build runs on the same userData
//! directory: the reason goes to stderr and into a native message box
//! (English, as the app has no translations before the page loads), then
//! the process exits with 1. Without a display the message box is skipped.

use std::path::Path;

/// The title of the message box.
const TITLE: &str = "Pipette";

/// Why the app does not start: the Electron build (process `pid`, when
/// known) holds `dir`, as its lock file `lock` says.
pub fn electron_running(dir: &Path, pid: Option<u32>, lock: &Path) -> String {
    let process = pid.map(|pid| format!(" (process {pid})")).unwrap_or_default();
    format!(
        "Pipette can't start because an older version of Pipette{process} is running with the same data \
         folder:\n{}\n\nQuit the older version, then start Pipette again. If no older version of Pipette is \
         running, its lock file was left behind: remove\n{}\nand start Pipette again.",
        dir.display(),
        lock.display()
    )
}

/// Why the app does not start: the lock file `lock` in the data folder could
/// not be opened to lock the folder against the Electron build.
#[cfg(target_os = "windows")]
pub fn lock_failed(lock: &Path, err: &dyn std::fmt::Display) -> String {
    format!(
        "Pipette can't start because it can't open the lock file of its data folder:\n{}\n\n{err}",
        lock.display()
    )
}

/// Reports `message` and ends the process.
pub fn refuse(message: &str) -> ! {
    eprintln!("cannot start: {message}");
    show(message);
    std::process::exit(1);
}

/// GTK's message dialog, shown on this (the main) thread. rfd shows its GTK
/// dialogs from a thread of its own, which waits forever when GTK cannot
/// start or when this thread already owns GTK's main context.
#[cfg(target_os = "linux")]
fn show(message: &str) {
    use gtk::prelude::*;
    if gtk::init().is_err() {
        return;
    }
    let dialog = gtk::MessageDialog::new(
        None::<&gtk::Window>,
        gtk::DialogFlags::MODAL,
        gtk::MessageType::Error,
        gtk::ButtonsType::Ok,
        message,
    );
    dialog.set_title(TITLE);
    dialog.run();
    dialog.close();
}

#[cfg(not(target_os = "linux"))]
fn show(message: &str) {
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
    fn the_message_names_the_folder_the_process_and_the_lock_file() {
        let dir = std::env::temp_dir().join("pipette-desktop");
        let lock = dir.join("SingletonLock");
        let message = electron_running(&dir, Some(4242), &lock);
        assert!(message.contains(" (process 4242) "), "{message}");
        assert!(message.contains(&format!("{}\n", dir.display())), "{message}");
        assert!(message.contains(&format!("remove\n{}\n", lock.display())), "{message}");
        assert!(!electron_running(&dir, None, &lock).contains("(process"));
    }
}
