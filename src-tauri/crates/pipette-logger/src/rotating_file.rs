// SPDX-License-Identifier: GPL-2.0-or-later
//! The log files and their rotation, as in src/main/logger.ts: before each
//! write, a current file that has reached the size limit is rotated.
//!
//! The current file stays open, and its size is counted as lines are
//! appended. Before each line the path is checked with one `stat`: when
//! `pipette-0.log` was deleted, renamed or replaced, the next line goes to a
//! new `pipette-0.log`, as it does with the per-line open of the TypeScript
//! logger. Only one process writes a userData
//! directory's logs: the app's single-instance check stops a second app
//! process, and src/main.rs refuses to start while the Electron build holds
//! the directory. Rotation still never loses a line to another writer: a
//! rename that fails is skipped and the line goes to whatever
//! `pipette-0.log` is then.

use std::fs::File;
use std::io::Write;
use std::path::PathBuf;

/// The size at which `pipette-0.log` is rotated before the next write.
pub const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;

/// `pipette-0.log` through `pipette-4.log`.
const MAX_GENERATIONS: usize = 5;

fn log_file_name(generation: usize) -> String {
    format!("pipette-{generation}.log")
}

/// The current file, open, and its size.
struct Current {
    file: File,
    size: u64,
    id: FileId,
}

/// What tells two files apart: the device and inode on unix. Elsewhere there
/// is no cheap stable id, and [`Current::is_at`] falls back on the length.
#[derive(PartialEq, Eq)]
struct FileId(#[cfg(unix)] (u64, u64));

fn file_id(meta: &std::fs::Metadata) -> FileId {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        FileId((meta.dev(), meta.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        FileId()
    }
}

impl Current {
    /// Whether the file at the path (`meta`) is still the open one. Without
    /// a file id, a file shorter than what was written to the open one is
    /// taken as a new file.
    fn is_at(&self, meta: &std::fs::Metadata) -> bool {
        if cfg!(unix) { file_id(meta) == self.id } else { meta.len() >= self.size }
    }
}

/// The current file and its older generations in one directory.
pub struct RotatingFile {
    dir: PathBuf,
    max_size: u64,
    current: Option<Current>,
}

impl RotatingFile {
    /// `dir` must exist. `max_size` is [`MAX_FILE_SIZE`] outside tests. The
    /// file is opened on the first append.
    pub fn new(dir: PathBuf, max_size: u64) -> Self {
        Self { dir, max_size, current: None }
    }

    fn path(&self, generation: usize) -> PathBuf {
        self.dir.join(log_file_name(generation))
    }

    /// Rotates when the current file has reached the size limit, then
    /// appends `line` to it. On an error the file is opened again for the
    /// next line.
    pub fn append(&mut self, line: &str) -> std::io::Result<()> {
        if self.current_size()? >= self.max_size {
            self.current = None;
            self.rotate();
            self.current_size()?;
        }
        let result = self.write(line.as_bytes());
        if result.is_err() {
            self.current = None;
        }
        result
    }

    /// The size of `pipette-0.log`, opening it when it is not open or the
    /// path no longer leads to the open file.
    fn current_size(&mut self) -> std::io::Result<u64> {
        let path = self.path(0);
        if let Some(current) = &self.current {
            match std::fs::metadata(&path) {
                Ok(meta) if current.is_at(&meta) => return Ok(current.size),
                _ => self.current = None,
            }
        }
        let file = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
        let meta = file.metadata()?;
        let (size, id) = (meta.len(), file_id(&meta));
        self.current = Some(Current { file, size, id });
        Ok(size)
    }

    /// Appends to the file [`Self::current_size`] opened or checked just
    /// before.
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        let Some(current) = self.current.as_mut() else {
            return Err(std::io::Error::other("the log file is not open"));
        };
        current.file.write_all(bytes)?;
        current.size += bytes.len() as u64;
        Ok(())
    }

    /// Drops the oldest generation and moves each other one up. Each step is
    /// best effort: a file another writer already moved or removed is
    /// skipped.
    fn rotate(&self) {
        let _ = std::fs::remove_file(self.path(MAX_GENERATIONS - 1));
        for generation in (0..MAX_GENERATIONS - 1).rev() {
            let from = self.path(generation);
            if from.exists() {
                let _ = std::fs::rename(from, self.path(generation + 1));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

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
        let mut file = RotatingFile::new(dir.clone(), MAX_FILE_SIZE);
        file.append("a\n").unwrap();
        file.append("b\n").unwrap();
        assert_eq!(read(&dir, 0).as_deref(), Some("a\nb\n"));
        assert_eq!(read(&dir, 1), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_file_at_the_limit_is_rotated_before_the_write() {
        let dir = log_dir("rotate");
        let mut file = RotatingFile::new(dir.clone(), 4);
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
        let mut file = RotatingFile::new(dir.clone(), 5);
        file.append("123\n").unwrap();
        file.append("x\n").unwrap();
        assert_eq!(read(&dir, 0).as_deref(), Some("123\nx\n"));
        assert_eq!(read(&dir, 1), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_existing_file_counts_toward_the_limit() {
        let dir = log_dir("existing");
        std::fs::write(dir.join(log_file_name(0)), "1234").unwrap();
        RotatingFile::new(dir.clone(), 4).append("new\n").unwrap();
        assert_eq!(read(&dir, 0).as_deref(), Some("new\n"));
        assert_eq!(read(&dir, 1).as_deref(), Some("1234"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_oldest_generation_is_dropped() {
        let dir = log_dir("drop");
        let mut file = RotatingFile::new(dir.clone(), 1);
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

    /// Another writer rotated first: the line goes to a new
    /// `pipette-0.log`, and nothing is lost.
    #[test]
    fn a_rotation_done_by_another_writer_loses_no_line() {
        let dir = log_dir("race");
        let mut file = RotatingFile::new(dir.clone(), 4);
        file.append("old\n").unwrap();
        std::fs::rename(dir.join(log_file_name(0)), dir.join(log_file_name(1))).unwrap();
        file.append("new\n").unwrap();
        assert_eq!(read(&dir, 0).as_deref(), Some("new\n"));
        assert_eq!(read(&dir, 1).as_deref(), Some("old\n"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_file_deleted_while_open_is_created_again() {
        let dir = log_dir("deleted");
        let mut file = RotatingFile::new(dir.clone(), MAX_FILE_SIZE);
        file.append("a\n").unwrap();
        std::fs::remove_file(dir.join(log_file_name(0))).unwrap();
        file.append("b\n").unwrap();
        assert_eq!(read(&dir, 0).as_deref(), Some("b\n"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_file_renamed_away_while_open_is_left_alone() {
        let dir = log_dir("renamed");
        let mut file = RotatingFile::new(dir.clone(), MAX_FILE_SIZE);
        file.append("a\n").unwrap();
        std::fs::rename(dir.join(log_file_name(0)), dir.join("moved.log")).unwrap();
        file.append("b\n").unwrap();
        assert_eq!(read(&dir, 0).as_deref(), Some("b\n"));
        assert_eq!(std::fs::read_to_string(dir.join("moved.log")).unwrap(), "a\n");
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A rename that fails (here every target is a non-empty directory) is
    /// skipped and the line is still written.
    #[test]
    fn a_failed_rename_does_not_drop_the_line() {
        let dir = log_dir("blocked");
        for generation in 1..MAX_GENERATIONS {
            std::fs::create_dir_all(dir.join(log_file_name(generation)).join("inside")).unwrap();
        }
        let mut file = RotatingFile::new(dir.clone(), 4);
        file.append("old\n").unwrap();
        file.append("new\n").unwrap();
        assert_eq!(read(&dir, 0).as_deref(), Some("old\nnew\n"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
