// SPDX-License-Identifier: GPL-2.0-or-later
//! The log files and their rotation, as in src/main/logger.ts.

use std::io::Write;
use std::path::{Path, PathBuf};

/// The size at which `pipette-0.log` is rotated before the next write.
pub const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;

/// `pipette-0.log` through `pipette-4.log`.
pub const MAX_GENERATIONS: usize = 5;

/// `pipette-<generation>.log`.
pub fn log_file_name(generation: usize) -> String {
    format!("pipette-{generation}.log")
}

/// The current file and its older generations in one directory.
pub struct RotatingFile {
    dir: PathBuf,
    max_size: u64,
}

impl RotatingFile {
    /// `dir` must exist. `max_size` is [`MAX_FILE_SIZE`] outside tests.
    pub fn new(dir: PathBuf, max_size: u64) -> Self {
        Self { dir, max_size }
    }

    fn path(&self, generation: usize) -> PathBuf {
        self.dir.join(log_file_name(generation))
    }

    /// Rotates when the current file has reached the size limit, then
    /// appends `line` to it.
    pub fn append(&self, line: &str) -> std::io::Result<()> {
        if self.should_rotate() {
            self.rotate()?;
        }
        std::fs::OpenOptions::new().create(true).append(true).open(self.path(0))?.write_all(line.as_bytes())
    }

    fn should_rotate(&self) -> bool {
        std::fs::metadata(self.path(0)).is_ok_and(|meta| meta.len() >= self.max_size)
    }

    fn rotate(&self) -> std::io::Result<()> {
        remove_if_present(&self.path(MAX_GENERATIONS - 1))?;
        for generation in (0..MAX_GENERATIONS - 1).rev() {
            let from = self.path(generation);
            if from.exists() {
                std::fs::rename(from, self.path(generation + 1))?;
            }
        }
        Ok(())
    }
}

fn remove_if_present(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pipette-logger-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read(dir: &Path, generation: usize) -> Option<String> {
        std::fs::read_to_string(dir.join(log_file_name(generation))).ok()
    }

    #[test]
    fn lines_are_appended_to_generation_zero() {
        let dir = log_dir("append");
        let file = RotatingFile::new(dir.clone(), MAX_FILE_SIZE);
        file.append("a\n").unwrap();
        file.append("b\n").unwrap();
        assert_eq!(read(&dir, 0).as_deref(), Some("a\nb\n"));
        assert_eq!(read(&dir, 1), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_file_at_the_limit_is_rotated_before_the_write() {
        let dir = log_dir("rotate");
        let file = RotatingFile::new(dir.clone(), 4);
        file.append("123\n").unwrap();
        // Exactly at the limit: rotated before this line.
        file.append("abc\n").unwrap();
        assert_eq!(read(&dir, 0).as_deref(), Some("abc\n"));
        assert_eq!(read(&dir, 1).as_deref(), Some("123\n"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_file_under_the_limit_is_not_rotated() {
        let dir = log_dir("under");
        let file = RotatingFile::new(dir.clone(), 5);
        file.append("123\n").unwrap();
        file.append("x\n").unwrap();
        assert_eq!(read(&dir, 0).as_deref(), Some("123\nx\n"));
        assert_eq!(read(&dir, 1), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_oldest_generation_is_dropped() {
        let dir = log_dir("drop");
        let file = RotatingFile::new(dir.clone(), 1);
        for line in ["0\n", "1\n", "2\n", "3\n", "4\n", "5\n", "6\n"] {
            file.append(line).unwrap();
        }
        let generations: Vec<_> = (0..MAX_GENERATIONS).map(|g| read(&dir, g)).collect();
        assert_eq!(generations, ["6\n", "5\n", "4\n", "3\n", "2\n"].map(|s| Some(s.to_owned())).to_vec());
        assert_eq!(read(&dir, MAX_GENERATIONS), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_gap_in_the_generations_is_kept() {
        let dir = log_dir("gap");
        std::fs::write(dir.join(log_file_name(0)), "zero\n").unwrap();
        std::fs::write(dir.join(log_file_name(2)), "two\n").unwrap();
        RotatingFile::new(dir.clone(), 1).append("new\n").unwrap();
        assert_eq!(read(&dir, 0).as_deref(), Some("new\n"));
        assert_eq!(read(&dir, 1).as_deref(), Some("zero\n"));
        assert_eq!(read(&dir, 2), None);
        assert_eq!(read(&dir, 3).as_deref(), Some("two\n"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
