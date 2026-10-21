// SPDX-License-Identifier: GPL-2.0-or-later
//! `remove_log_files` on the installed logger: every generation is removed
//! and the next line goes to a new `pipette-0.log`. A test binary of its own,
//! since a process has one logger.

#[test]
fn the_next_line_after_the_removal_starts_a_new_file() {
    let dir = std::env::temp_dir().join(format!("pipette-logger-remove-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    pipette_logger::init(dir.clone()).unwrap();
    std::fs::write(dir.join("pipette-1.log"), "older\n").unwrap();
    log::info!(target: "pipette_app", "before");

    pipette_logger::remove_log_files().unwrap();
    assert!(!dir.join("pipette-0.log").exists() && !dir.join("pipette-1.log").exists());

    log::info!(target: "pipette_app", "after");
    let current = std::fs::read_to_string(dir.join("pipette-0.log")).unwrap();
    assert!(current.ends_with("[INFO] after\n") && !current.contains("before"), "{current}");
    std::fs::remove_dir_all(dir).unwrap();
}
