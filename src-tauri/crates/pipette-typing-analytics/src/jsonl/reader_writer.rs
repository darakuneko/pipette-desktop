// SPDX-License-Identifier: GPL-2.0-or-later
//! Appending rows to a per-day JSONL master (jsonl-writer.ts) and reading
//! them back (jsonl-reader.ts).
//!
//! A device only ever appends to its own day files, so the writer takes no
//! lock: the files are append-only and every row ends with a newline, so a
//! write cut short by a crash leaves at most one partial last line, which
//! the reader skips and the next append closes off.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::Path;

use pipette_js_json::{JsString, Value};

use super::row::{JsonlRow, serialize_row};

/// `appendRowsToFile(path, rows)`: creates the parent directories and the
/// file as needed and appends each row's line in one write in append mode.
/// When the file ends without a newline (a line cut short), a newline goes
/// first so the first new row does not join the fragment. No rows is a
/// no-op that creates nothing.
pub fn append_rows_to_file(path: &Path, rows: &[Value]) -> io::Result<()> {
    append_lines_to_file(path, rows.iter().map(serialize_row).collect())
}

/// [`append_rows_to_file`] for rows already serialized: `lines` is the
/// text of whole lines, each ending with a newline.
pub fn append_lines_to_file(path: &Path, mut lines: String) -> io::Result<()> {
    if lines.is_empty() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = OpenOptions::new().read(true).append(true).create(true).open(path)?;
    let size = file.metadata()?.len();
    if size > 0 {
        let mut last = [0u8; 1];
        file.seek(SeekFrom::Start(size - 1))?;
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            lines.insert(0, '\n');
        }
    }
    file.write_all(lines.as_bytes())
}

/// What [`read_rows`] read.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadResult {
    pub rows: Vec<JsonlRow>,
    /// The id of the last row in `rows`; the `after_id` asked for when
    /// there is none.
    pub last_id: Option<JsString>,
    /// The file ended mid-line (its last byte is not `\n`); that line is
    /// never read.
    pub partial_line_skipped: bool,
}

/// `readRows(path, { afterId, mustExist })`: the rows of the file, or only
/// the rows after the first row whose id is `after_id` (none when no row
/// has it). Lines end at `\n`, `\r\n` or a lone `\r`, as Node's readline
/// splits them; invalid lines and those `parseRow` rejects are dropped;
/// the bytes are read as UTF-8 with U+FFFD for an invalid sequence.
///
/// A file that cannot be opened reads as empty unless `must_exist` is set,
/// for a caller that listed the file and must not take an unreadable file
/// for one without rows; then it is an error. An error while reading an
/// opened file is always an error, and so is a directory at `path`: Node
/// opens it and fails the read with EISDIR, which Linux does too, while
/// Windows already refuses to open it.
///
/// The whole file is read at once and its last byte decides whether the
/// last line is complete, so a row appended while the file is being read
/// is either read whole or not at all.
pub fn read_rows(path: &Path, after_id: Option<&JsString>, must_exist: bool) -> io::Result<ReadResult> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(err) if must_exist => return Err(err),
        Err(_) if path.is_dir() => return Err(io::Error::from(io::ErrorKind::IsADirectory)),
        Err(_) => {
            return Ok(ReadResult {
                rows: Vec::new(),
                last_id: after_id.cloned(),
                partial_line_skipped: false,
            });
        }
    };
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let terminated = bytes.last().is_none_or(|&last| last == b'\n');
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = split_lines(&text);
    let partial_line_skipped = !terminated && lines.pop().is_some();

    let mut rows = Vec::new();
    let mut passed = after_id.is_none();
    for line in lines {
        let Some(row) = JsonlRow::parse(line) else { continue };
        if !passed {
            passed = after_id == Some(row.id());
            continue;
        }
        rows.push(row);
    }
    let last_id = rows.last().map(|row| row.id().clone()).or_else(|| after_id.cloned());
    Ok(ReadResult { rows, last_id, partial_line_skipped })
}

/// The lines of `text` as Node's readline emits them: each ends at `\n`,
/// `\r\n` or a lone `\r`, and text after the last break is one more line.
fn split_lines(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => {
                lines.push(&text[start..i]);
                start = i + 1;
            }
            b'\r' => {
                lines.push(&text[start..i]);
                if bytes.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if start < bytes.len() {
        lines.push(&text[start..]);
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, updated_at: f64) -> Value {
        let line = format!(
            r#"{{"id":"{id}","kind":"session","updated_at":{updated_at},"payload":{{"id":"{id}","scopeId":"s","startMs":1,"endMs":2}}}}"#
        );
        pipette_js_json::parse(&line).unwrap()
    }

    fn ids(result: &ReadResult) -> Vec<String> {
        result.rows.iter().map(|row| row.id().to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn lines_end_at_lf_crlf_and_lone_cr() {
        assert_eq!(split_lines("a\nb\r\nc\rd\n"), vec!["a", "b", "c", "d"]);
        assert_eq!(split_lines("a\r"), vec!["a"]);
        assert_eq!(split_lines("a\n\nb"), vec!["a", "", "b"]);
        assert!(split_lines("").is_empty());
    }

    #[test]
    fn appending_nothing_creates_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/dir/day.jsonl");
        append_rows_to_file(&path, &[]).unwrap();
        assert!(!dir.path().join("nested").exists());
        append_rows_to_file(&path, &[session("a", 1.0)]).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn appends_keep_order_and_close_a_truncated_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("day.jsonl");
        std::fs::write(&path, format!("{}{{\"id\":\"char|trunc", serialize_row(&session("a", 1.0)))).unwrap();
        append_rows_to_file(&path, &[session("b", 2.0)]).unwrap();
        append_rows_to_file(&path, &[session("c", 3.0)]).unwrap();
        let read = read_rows(&path, None, false).unwrap();
        assert_eq!(ids(&read), ["a", "b", "c"]);
        assert!(!read.partial_line_skipped);
    }

    #[test]
    fn reads_after_an_id_and_skips_a_partial_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("day.jsonl");
        let missing = read_rows(&path, Some(&"prev".into()), false).unwrap();
        assert!(missing.rows.is_empty());
        assert_eq!(missing.last_id, Some("prev".into()));
        assert!(read_rows(&path, None, true).is_err());

        let text: String = ["a", "b", "c"].iter().map(|id| serialize_row(&session(id, 1.0))).collect();
        std::fs::write(&path, format!("{text}{{ garbled\n{}", serialize_row(&session("d", 1.0)).trim_end()))
            .unwrap();
        let read = read_rows(&path, Some(&"a".into()), false).unwrap();
        assert_eq!(ids(&read), ["b", "c"]);
        assert_eq!(read.last_id, Some("c".into()));
        assert!(read.partial_line_skipped);
        let past = read_rows(&path, Some(&"zz".into()), false).unwrap();
        assert!(past.rows.is_empty());
        assert_eq!(past.last_id, Some("zz".into()));
    }

    #[test]
    fn a_directory_is_an_error_on_every_system() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("day.jsonl");
        std::fs::create_dir(&path).unwrap();
        for must_exist in [false, true] {
            let err = read_rows(&path, None, must_exist).unwrap_err();
            if !must_exist {
                assert_eq!(err.kind(), io::ErrorKind::IsADirectory);
            }
        }
    }
}
