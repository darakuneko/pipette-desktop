// SPDX-License-Identifier: GPL-2.0-or-later
//! Reading the files chosen in a pack import dialog (shared by the language
//! and theme packs). Each file is read on its own, so one
//! that cannot be read never stops the others. The text is handed to the
//! page, which parses it with its own `JSON.parse` (the shim builds
//! `{filePath, raw, fileSizeBytes}` or `{…, parseError}` of it).

use std::path::Path;

/// One chosen file: its text and size, or why it could not be read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ImportFileRead {
    /// The text as `readFile(…, 'utf-8')` reads it (each invalid sequence
    /// as U+FFFD, a byte order mark kept) and its UTF-8 length
    /// (`Buffer.byteLength(text, 'utf-8')`).
    Text { text: String, size: usize },
    /// The read failed: the error's text.
    Failed(String),
}

/// Reads the chosen file `path`.
pub fn read_import_file(path: &Path) -> ImportFileRead {
    match std::fs::read(path) {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let size = text.len();
            ImportFileRead::Text { text, size }
        }
        Err(err) => ImportFileRead::Failed(format!("Error: {err}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_the_bytes_of_the_text_read() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("pack.json");
        // A byte order mark (kept, 3 bytes) and one invalid byte (U+FFFD, 3 bytes).
        std::fs::write(&path, b"\xef\xbb\xbf{\"a\":\"\xff\"}").unwrap();
        let ImportFileRead::Text { text, size } = read_import_file(&path) else { panic!() };
        assert_eq!(text, "\u{feff}{\"a\":\"\u{fffd}\"}");
        assert_eq!(size, 14);
    }

    #[test]
    fn a_file_that_cannot_be_read_fails_alone() {
        let dir = tempfile::TempDir::new().unwrap();
        assert!(matches!(read_import_file(&dir.path().join("none.json")), ImportFileRead::Failed(_)));
    }
}
