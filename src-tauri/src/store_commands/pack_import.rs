// SPDX-License-Identifier: GPL-2.0-or-later
//! The import dialog of the language and theme packs: a multi-selection open
//! dialog whose files are read one by one, a file that cannot be read failing
//! alone. The answer carries each file's text; the shim parses it into the
//! `{filePath, raw, fileSizeBytes}` or `{…, parseError}` the renderer gets.

use pipette_pack_stores::{ImportFileRead, read_import_file};
use serde::Serialize;
use ts_rs::TS;

use crate::dialog::{DialogKind, DialogRequest, Dialogs, FileFilter};

/// What a pack import dialog answers: no files when cancelled.
#[derive(Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PackImportRead {
    canceled: bool,
    files: Vec<PackImportFileRead>,
}

/// One chosen file: its text and UTF-8 size, or why it could not be read.
#[derive(Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PackImportFileRead {
    file_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    file_size_bytes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    read_error: Option<String>,
}

/// The filters of the pack dialogs: JSON files, or all files.
pub(crate) fn json_filters() -> Vec<FileFilter> {
    vec![FileFilter::new("JSON", &["json"]), FileFilter::all_files()]
}

/// Shows the import dialog titled `title` and reads the chosen files.
pub(crate) fn read_chosen_packs(dialogs: &Dialogs, title: &str) -> PackImportRead {
    let request =
        DialogRequest { kind: DialogKind::OpenMany, title: title.to_owned(), filters: json_filters() };
    let paths = dialogs.show_many(request);
    let files = paths
        .iter()
        .map(|path| {
            let file_path = path.to_string_lossy().into_owned();
            match read_import_file(path) {
                ImportFileRead::Text { text, size } => {
                    // A file read whole into memory stays far below 4 GiB.
                    let size = u32::try_from(size).unwrap_or(u32::MAX);
                    PackImportFileRead {
                        file_path,
                        text: Some(text),
                        file_size_bytes: Some(size),
                        read_error: None,
                    }
                }
                ImportFileRead::Failed(error) => PackImportFileRead {
                    file_path,
                    text: None,
                    file_size_bytes: None,
                    read_error: Some(error),
                },
            }
        })
        .collect();
    PackImportRead { canceled: paths.is_empty(), files }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use super::*;

    #[test]
    fn reads_each_chosen_file_on_its_own() {
        let dir = tempfile::TempDir::new().unwrap();
        let good = dir.path().join("good.json");
        std::fs::write(&good, "{\"name\":\"A\"}").unwrap();
        let missing = dir.path().join("missing.json");
        let asked = Arc::new(Mutex::new(None));
        let seen = Arc::clone(&asked);
        let chosen = vec![good.clone(), missing.clone()];
        let dialogs = Dialogs::new(move |request: DialogRequest| {
            *seen.lock().unwrap() = Some(request);
            chosen.clone()
        });

        let read = read_chosen_packs(&dialogs, "Import Language Pack");

        let request = asked.lock().unwrap().take().unwrap();
        assert_eq!(request.kind, DialogKind::OpenMany);
        assert_eq!(request.title, "Import Language Pack");
        assert_eq!(request.filters, [FileFilter::new("JSON", &["json"]), FileFilter::all_files()]);
        assert!(!read.canceled);
        assert_eq!(
            read.files[0],
            PackImportFileRead {
                file_path: good.to_string_lossy().into_owned(),
                text: Some("{\"name\":\"A\"}".to_owned()),
                file_size_bytes: Some(12),
                read_error: None,
            }
        );
        assert_eq!(read.files[1].file_path, missing.to_string_lossy());
        assert!(read.files[1].read_error.is_some());
        assert_eq!(read.files[1].text, None);
    }

    #[test]
    fn a_cancelled_dialog_reads_nothing() {
        let dialogs = Dialogs::new(|_: DialogRequest| Vec::<PathBuf>::new());
        assert_eq!(
            read_chosen_packs(&dialogs, "Import"),
            PackImportRead { canceled: true, files: Vec::new() }
        );
    }
}
