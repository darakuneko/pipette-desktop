// SPDX-License-Identifier: GPL-2.0-or-later
//! The file commands of the shim (src/tauri-shim/api/files.ts): save and
//! export through a save dialog, open a layout or a JSON file through an
//! open dialog, and write a set of CSV files into a chosen directory. Each
//! command fixes its own dialog (title, default file name, filters) with the
//! values of the Electron main process (src/main/file-io.ts); the page only
//! passes the content and a name to clean, and for the open dialogs of
//! `loadLayout` and `sideloadJson` a title and the extensions, which are
//! checked here. The results and their error strings are those of
//! file-io.ts: a dialog the user closes answers `{ success: false, error:
//! 'cancelled' }`, and a failed read or write answers the error's message.
//!
//! Files are written in place, as Electron's `writeFile` does, and read as
//! UTF-8 with each invalid sequence replaced by U+FFFD, as its
//! `readFile(path, 'utf-8')` does.

use std::path::Path;

use pipette_entry_store::sanitize_filename;
use serde::Serialize;
use serde_json::Value;
use tauri::State;
use ts_rs::TS;

use crate::command_error::CommandError;
use crate::dialog::{DialogKind, DialogRequest, Dialogs, FileFilter};

const CANCELLED: &str = "cancelled";

/// What a save or an export answers.
#[derive(Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileSaveResult {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    error: Option<String>,
}

impl FileSaveResult {
    fn failed(error: impl Into<String>) -> Self {
        Self { success: false, file_path: None, error: Some(error.into()) }
    }
}

/// What opening a file answers: its text in `data`.
#[derive(Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileOpenResult {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    error: Option<String>,
}

impl FileOpenResult {
    fn failed(error: impl Into<String>) -> Self {
        Self { success: false, data: None, file_path: None, error: Some(error.into()) }
    }
}

/// What writing a CSV bundle answers: the directory and the files written,
/// also those written before a write failed.
#[derive(Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CsvBundleResult {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    dir_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    files: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    error: Option<String>,
}

impl CsvBundleResult {
    fn failed(error: impl Into<String>) -> Self {
        Self { success: false, dir_path: None, files: None, error: Some(error.into()) }
    }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `<sanitized name><suffix>` for a name that is not empty, `fallback`
/// otherwise (an empty name is falsy in the Electron handlers).
fn default_name(name: Option<&str>, suffix: &str, fallback: &str) -> String {
    match name {
        Some(name) if !name.is_empty() => format!("{}{suffix}", sanitize_filename(name)),
        _ => fallback.to_owned(),
    }
}

/// The save dialog of a save or an export, with the values of its Electron
/// handler.
struct SaveDialog {
    title: &'static str,
    /// Appended to the cleaned name the page passes.
    suffix: &'static str,
    /// The default name when the page passes none.
    fallback: &'static str,
    filter: (&'static str, &'static str),
}

const LAYOUT_SAVE: SaveDialog = SaveDialog {
    title: "Export Layout",
    suffix: ".vil",
    fallback: "keyboard.vil",
    filter: ("Vial Layout", "vil"),
};
const KEYMAP_C_SAVE: SaveDialog = SaveDialog {
    title: "Export keymap.c",
    suffix: "_keymap.c",
    fallback: "keymap.c",
    filter: ("C Source", "c"),
};
const PDF_SAVE: SaveDialog = SaveDialog {
    title: "Export Keymap PDF",
    suffix: ".pdf",
    fallback: "keymap.pdf",
    filter: ("PDF Document", "pdf"),
};
const CSV_SAVE: SaveDialog = SaveDialog {
    title: "Export CSV",
    suffix: ".csv",
    fallback: "typing-test-history.csv",
    filter: ("CSV", "csv"),
};
const JSON_SAVE: SaveDialog =
    SaveDialog { title: "Export JSON", suffix: ".json", fallback: "export.json", filter: ("JSON", "json") };

/// Asks where to save, starting from the default name for `name`, and
/// writes `contents` there.
fn save_with_dialog(
    dialogs: &Dialogs,
    dialog: &SaveDialog,
    name: Option<&str>,
    contents: &[u8],
) -> FileSaveResult {
    let (filter_name, extension) = dialog.filter;
    let request = DialogRequest {
        kind: DialogKind::SaveFile { default_name: default_name(name, dialog.suffix, dialog.fallback) },
        title: dialog.title.to_owned(),
        filters: vec![FileFilter::new(filter_name, &[extension]), FileFilter::all_files()],
    };
    write_with_dialog(dialogs, request, contents)
}

/// Shows the save dialog `request` and writes `contents` where the user
/// chose.
pub(crate) fn write_with_dialog(
    dialogs: &Dialogs,
    request: DialogRequest,
    contents: &[u8],
) -> FileSaveResult {
    let Some(path) = dialogs.show(request) else { return FileSaveResult::failed(CANCELLED) };
    match std::fs::write(&path, contents) {
        Ok(()) => FileSaveResult { success: true, file_path: Some(path_text(&path)), error: None },
        Err(err) => FileSaveResult::failed(err.to_string()),
    }
}

/// Asks for a file and reads it as text.
pub(crate) fn open_with_dialog(dialogs: &Dialogs, request: DialogRequest) -> FileOpenResult {
    let Some(path) = dialogs.show(request) else { return FileOpenResult::failed(CANCELLED) };
    match std::fs::read(&path) {
        Ok(bytes) => FileOpenResult {
            success: true,
            data: Some(String::from_utf8_lossy(&bytes).into_owned()),
            file_path: Some(path_text(&path)),
            error: None,
        },
        Err(err) => FileOpenResult::failed(err.to_string()),
    }
}

/// The entries of a CSV bundle, `[{ name, content }, ...]` with string
/// fields, checked as the Electron handler checks them.
fn csv_bundle_entries(files: Option<&Value>) -> Result<Vec<(&str, &str)>, &'static str> {
    let list = files.and_then(Value::as_array).filter(|list| !list.is_empty()).ok_or("no files")?;
    list.iter()
        .map(|file| {
            match (file.get("name").and_then(Value::as_str), file.get("content").and_then(Value::as_str)) {
                (Some(name), Some(content)) => Ok((name, content)),
                _ => Err("invalid file entry"),
            }
        })
        .collect()
}

/// The file name of a bundle entry: the cleaned name, with `.csv` added
/// unless it already ends so (in any case).
fn csv_file_name(name: &str) -> String {
    let safe = sanitize_filename(name);
    if safe.to_lowercase().ends_with(".csv") { safe } else { format!("{safe}.csv") }
}

/// Asks for a directory once and writes every file of `files` into it. As
/// with the Electron handler, which starts every write at once, a failed
/// write does not stop the others; the result is then the first error and
/// the files that were written.
fn export_csv_bundle(dialogs: &Dialogs, files: Option<&Value>) -> CsvBundleResult {
    let entries = match csv_bundle_entries(files) {
        Ok(entries) => entries,
        Err(error) => return CsvBundleResult::failed(error),
    };
    let request = DialogRequest {
        kind: DialogKind::OpenFolder,
        title: "Export CSV bundle".to_owned(),
        filters: Vec::new(),
    };
    let Some(dir) = dialogs.show(request) else { return CsvBundleResult::failed(CANCELLED) };
    let mut written = Vec::new();
    let mut first_error = None;
    for (name, content) in entries {
        let path = dir.join(csv_file_name(name));
        match std::fs::write(&path, content) {
            Ok(()) => written.push(path_text(&path)),
            Err(err) => {
                first_error.get_or_insert_with(|| err.to_string());
            }
        }
    }
    match first_error {
        None => CsvBundleResult {
            success: true,
            dir_path: Some(path_text(&dir)),
            files: Some(written),
            error: None,
        },
        Some(error) => {
            CsvBundleResult { success: false, dir_path: None, files: Some(written), error: Some(error) }
        }
    }
}

/// The longest title the page may give an open dialog.
const MAX_TITLE_CHARS: usize = 200;

/// The page's title for an open dialog if it is a plausible one: not too
/// long, without control characters (GTK refuses a title with NUL).
/// Anything else falls back to `fallback`, as a title that is not a string
/// does in the Electron handlers.
fn page_title(title: Option<&str>, fallback: &str) -> String {
    match title {
        Some(title) if title.chars().count() <= MAX_TITLE_CHARS && !title.chars().any(char::is_control) => {
            title.to_owned()
        }
        Some(title) => {
            log::warn!("[file] ignored the dialog title {title:?}");
            fallback.to_owned()
        }
        None => fallback.to_owned(),
    }
}

const MAX_EXTENSIONS: usize = 8;
const MAX_EXTENSION_CHARS: usize = 16;

/// Whether `extensions` is a plausible filter: 1 to 8 extensions of ASCII
/// letters, digits, `.`, `_` and `-`.
fn valid_extensions(extensions: &[String]) -> bool {
    (1..=MAX_EXTENSIONS).contains(&extensions.len())
        && extensions.iter().all(|ext| {
            (1..=MAX_EXTENSION_CHARS).contains(&ext.len())
                && ext.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        })
}

/// Opens a layout: the page's extensions if they are plausible, `vil`
/// otherwise.
fn load_layout(dialogs: &Dialogs, title: Option<&str>, extensions: Option<Vec<String>>) -> FileOpenResult {
    let extensions = match extensions {
        Some(extensions) if valid_extensions(&extensions) => extensions,
        Some(extensions) => {
            log::warn!("[file] ignored the layout extensions {extensions:?}");
            vec!["vil".to_owned()]
        }
        None => vec!["vil".to_owned()],
    };
    let name = if extensions.iter().any(|ext| ext == "pipette") { "Pipette Layout" } else { "Vial Layout" };
    let request = DialogRequest {
        kind: DialogKind::OpenFile,
        title: page_title(title, "Import Layout"),
        filters: vec![FileFilter { name: name.to_owned(), extensions }, FileFilter::all_files()],
    };
    open_with_dialog(dialogs, request)
}

/// Opens a JSON file and answers its text; the shim parses it.
fn sideload_json(dialogs: &Dialogs, title: Option<&str>) -> FileOpenResult {
    let request = DialogRequest {
        kind: DialogKind::OpenFile,
        title: page_title(title, "Load from JSON file"),
        filters: vec![FileFilter::new("JSON Files", &["json"]), FileFilter::all_files()],
    };
    open_with_dialog(dialogs, request)
}

/// Runs `run` (a dialog and the file access) on a blocking-task thread.
async fn blocking<T: Send + 'static>(
    dialogs: State<'_, Dialogs>,
    run: impl FnOnce(&Dialogs) -> T + Send + 'static,
) -> Result<T, CommandError> {
    let dialogs = dialogs.inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || run(&dialogs)).await?)
}

/// [`save_with_dialog`] on a blocking-task thread.
async fn save_command(
    dialogs: State<'_, Dialogs>,
    dialog: &'static SaveDialog,
    name: Option<String>,
    contents: Vec<u8>,
) -> Result<FileSaveResult, CommandError> {
    blocking(dialogs, move |dialogs| save_with_dialog(dialogs, dialog, name.as_deref(), &contents)).await
}

#[tauri::command]
pub async fn file_save_layout(
    dialogs: State<'_, Dialogs>,
    json: String,
    device_name: Option<String>,
) -> Result<FileSaveResult, CommandError> {
    save_command(dialogs, &LAYOUT_SAVE, device_name, json.into_bytes()).await
}

#[tauri::command]
pub async fn file_export_keymap_c(
    dialogs: State<'_, Dialogs>,
    content: String,
    device_name: Option<String>,
) -> Result<FileSaveResult, CommandError> {
    save_command(dialogs, &KEYMAP_C_SAVE, device_name, content.into_bytes()).await
}

/// `base64_data` is decoded as Node's `Buffer.from(data, 'base64')` does.
#[tauri::command]
pub async fn file_export_pdf(
    dialogs: State<'_, Dialogs>,
    base64_data: String,
    device_name: Option<String>,
) -> Result<FileSaveResult, CommandError> {
    save_command(dialogs, &PDF_SAVE, device_name, decode_base64_as_node(&base64_data)).await
}

#[tauri::command]
pub async fn file_export_csv(
    dialogs: State<'_, Dialogs>,
    content: String,
    default_name: Option<String>,
) -> Result<FileSaveResult, CommandError> {
    save_command(dialogs, &CSV_SAVE, default_name, content.into_bytes()).await
}

#[tauri::command]
pub async fn file_export_json(
    dialogs: State<'_, Dialogs>,
    content: String,
    default_name: Option<String>,
) -> Result<FileSaveResult, CommandError> {
    save_command(dialogs, &JSON_SAVE, default_name, content.into_bytes()).await
}

/// `files` is checked here rather than typed, so a malformed list answers
/// the Electron handler's error instead of failing the call.
#[tauri::command]
pub async fn file_export_csv_bundle(
    dialogs: State<'_, Dialogs>,
    files: Option<Value>,
) -> Result<CsvBundleResult, CommandError> {
    blocking(dialogs, move |dialogs| export_csv_bundle(dialogs, files.as_ref())).await
}

#[tauri::command]
pub async fn file_load_layout(
    dialogs: State<'_, Dialogs>,
    title: Option<String>,
    extensions: Option<Vec<String>>,
) -> Result<FileOpenResult, CommandError> {
    blocking(dialogs, move |dialogs| load_layout(dialogs, title.as_deref(), extensions)).await
}

#[tauri::command]
pub async fn file_sideload_json(
    dialogs: State<'_, Dialogs>,
    title: Option<String>,
) -> Result<FileOpenResult, CommandError> {
    blocking(dialogs, move |dialogs| sideload_json(dialogs, title.as_deref())).await
}

/// The value of a base64 character in either alphabet (`+/` or `-_`).
fn base64_value(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some(u32::from(c - b'A')),
        b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// Decodes `data` as Node's `Buffer.from(data, 'base64')`: it reads the low
/// byte of each UTF-16 code unit, takes both alphabets, skips any other
/// byte, stops at the first `=`, and a trailing group of 2 or 3 characters
/// gives 1 or 2 bytes (1 gives none).
fn decode_base64_as_node(data: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() / 4 * 3 + 2);
    let mut bits: u32 = 0;
    let mut count = 0;
    let low_bytes = data.encode_utf16().map(|unit| unit.to_le_bytes()[0]);
    for byte in low_bytes.take_while(|&b| b != b'=') {
        let Some(value) = base64_value(byte) else { continue };
        bits = (bits << 6) | value;
        count += 1;
        if count == 4 {
            out.extend_from_slice(&bits.to_be_bytes()[1..]);
            bits = 0;
            count = 0;
        }
    }
    match count {
        2 => out.push((bits >> 4) as u8),
        3 => out.extend_from_slice(&((bits >> 2) as u16).to_be_bytes()),
        _ => {}
    }
    out
}

#[cfg(test)]
mod tests;
