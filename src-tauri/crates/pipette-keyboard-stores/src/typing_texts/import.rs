// SPDX-License-Identifier: GPL-2.0-or-later
//! The import of a text file, as `importFromDialog` /
//! `confirmImportOverwrite` of src/main/typing-test-text-store.ts do it once
//! the dialog has answered: a file named like a live text is held until the
//! user confirms the overwrite.

use std::fs;
use std::path::Path;
use std::sync::PoisonError;

use pipette_entry_store::{Entry, js_trim};
use pipette_js_json::{JsString, Value};

use super::{
    TypingTextError, TypingTextErrorCode, TypingTextSave, TypingTextStore, find_active_by_name, read_index,
    store_dir,
};
use crate::StoreContext;

/// The largest file an import reads, in bytes.
pub const TYPING_TEXT_MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;

/// The name of a text imported from a file whose name gives none.
const DEFAULT_NAME: &str = "Imported text";

/// An import whose name collided with a live text, read but not saved.
/// One at a time: a newer import replaces it.
pub(super) struct PendingImport {
    name: JsString,
    text: JsString,
    existing_id: JsString,
}

/// The name of a text imported from `path`: the file name without its
/// last extension (`/\.[^/.]+$/`), trimmed, or [`DEFAULT_NAME`].
fn name_of(path: &Path) -> JsString {
    let file_name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = match file_name.rfind('.') {
        Some(dot) if dot + 1 < file_name.len() && !file_name[dot + 1..].contains('/') => &file_name[..dot],
        _ => file_name.as_str(),
    };
    let name = js_trim(&JsString::from(stem));
    if name.is_empty() { JsString::from(DEFAULT_NAME) } else { name }
}

/// The text of the file: strict UTF-8 with one leading byte order mark
/// dropped (`new TextDecoder('utf-8', { fatal: true })`).
fn decode(bytes: &[u8]) -> Option<&str> {
    let text = std::str::from_utf8(bytes).ok()?;
    Some(text.strip_prefix('\u{feff}').unwrap_or(text))
}

impl TypingTextStore {
    /// Imports the file the user picked (`TYPING_TEST_TEXT_IMPORT` once its
    /// dialog answered). A file over [`TYPING_TEXT_MAX_FILE_BYTES`] is not
    /// read. A name a live text has (ignoring case) is held for
    /// [`Self::confirm_import`] and answered as `DUPLICATE_NAME` with the
    /// name as the error; any other import drops a held one and saves.
    pub fn import_file(&self, ctx: &StoreContext, path: &Path) -> Result<Entry, TypingTextError> {
        if fs::metadata(path)?.len() > TYPING_TEXT_MAX_FILE_BYTES {
            return Err(TypingTextError::refused(
                TypingTextErrorCode::TooLarge,
                "File exceeds the size limit",
            ));
        }
        let bytes = fs::read(path)?;
        let text = decode(&bytes).ok_or_else(|| {
            TypingTextError::refused(TypingTextErrorCode::NotUtf8, "File must be UTF-8 encoded")
        })?;
        let name = name_of(path);

        let entries = read_index(&store_dir(ctx))?;
        let existing = find_active_by_name(&entries, &Value::String(name.clone()), None)?;
        let mut pending = self.state.pending.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(existing) = existing {
            let message = name.to_string_lossy().into_owned();
            *pending = Some(PendingImport {
                name,
                text: text.into(),
                existing_id: existing.id().cloned().unwrap_or_else(|| JsString::from("")),
            });
            return Err(TypingTextError::refused(TypingTextErrorCode::DuplicateName, &message));
        }
        *pending = None;
        drop(pending);
        self.save(
            ctx,
            &TypingTextSave { id: None, name, text: text.into(), source: None, keep_current_name: false },
        )
    }

    /// Saves the import held by [`Self::import_file`] over the text it
    /// collided with, keeping that text's current name
    /// (`TYPING_TEST_TEXT_IMPORT_CONFIRM`).
    pub fn confirm_import(&self, ctx: &StoreContext) -> Result<Entry, TypingTextError> {
        let held = self.state.pending.lock().unwrap_or_else(PoisonError::into_inner).take();
        let held = held.ok_or_else(|| {
            TypingTextError::refused(TypingTextErrorCode::NotFound, "No pending import to confirm")
        })?;
        self.save(
            ctx,
            &TypingTextSave {
                id: Some(held.existing_id),
                name: held.name,
                text: held.text,
                source: None,
                keep_current_name: true,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_name_drops_the_last_extension_and_is_trimmed() {
        let name = |file: &str| name_of(Path::new("/in").join(file).as_path()).to_string_lossy().into_owned();
        assert_eq!(name("poem.txt"), "poem");
        assert_eq!(name("a.b.c"), "a.b");
        assert_eq!(name("dot."), "dot.");
        assert_eq!(name("noext"), "noext");
        assert_eq!(name(" spaced .txt"), "spaced");
        assert_eq!(name(".bashrc"), DEFAULT_NAME);
        assert_eq!(name("\u{3000}.txt"), DEFAULT_NAME);
    }

    #[test]
    fn utf8_is_strict_and_drops_one_byte_order_mark() {
        assert_eq!(decode(b"\xef\xbb\xbfhi"), Some("hi"));
        assert_eq!(decode(b"\xef\xbb\xbf\xef\xbb\xbfhi"), Some("\u{feff}hi"));
        assert_eq!(decode(b"\x82\xa0"), None);
        assert_eq!(decode(b"\xed\xa0\x80"), None);
        assert_eq!(decode(b""), Some(""));
    }
}
