// SPDX-License-Identifier: GPL-2.0-or-later
//! `set_file_enabled` on the installed logger: the files start disabled,
//! enabling writes lines without a restart, disabling removes every
//! generation and writes nothing more, enabling again starts a new
//! `pipette-0.log`, and the home folder in a line is written as `~`. A test binary of its own, since a process has one logger.

use std::path::Path;

#[test]
fn the_files_follow_the_switch() {
    let dir = std::env::temp_dir().join(format!("pipette-logger-enabled-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    pipette_logger::init(dir.clone(), Some(Path::new("/home/pipette-test-user"))).unwrap();
    let current = dir.join("pipette-0.log");

    log::info!(target: "pipette_app", "while disabled");
    assert!(!current.exists());

    pipette_logger::set_file_enabled(true).unwrap();
    log::info!(target: "pipette_app", "opened /home/pipette-test-user/config.json");
    let text = std::fs::read_to_string(&current).unwrap();
    assert!(text.ends_with("[INFO] opened ~/config.json\n") && !text.contains("disabled"), "{text}");

    std::fs::write(dir.join("pipette-1.log"), "older\n").unwrap();
    std::fs::write(dir.join("pipette-4.log"), "oldest\n").unwrap();
    pipette_logger::set_file_enabled(false).unwrap();
    for generation in 0..5 {
        assert!(!dir.join(format!("pipette-{generation}.log")).exists(), "pipette-{generation}.log");
    }
    log::info!(target: "pipette_app", "disabled again");
    assert!(!current.exists());

    pipette_logger::set_file_enabled(true).unwrap();
    log::info!(target: "pipette_app", "enabled again");
    let text = std::fs::read_to_string(&current).unwrap();
    assert!(text.ends_with("[INFO] enabled again\n") && !text.contains("config.json"), "{text}");

    std::fs::remove_dir_all(dir).unwrap();
}
