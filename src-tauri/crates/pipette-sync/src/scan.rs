// SPDX-License-Identifier: GPL-2.0-or-later
//! What is on Drive, read without merging it (src/main/sync/sync-scan.ts):
//! the data files behind the guard and the password-check, the ones the
//! stored password cannot open (`listUndecryptableFiles`), the Data
//! modal's scan of what Drive holds (`scanRemoteData`) and one unit's
//! bundle (`fetchRemoteBundle`).

use std::sync::Arc;

use futures_util::StreamExt;
use futures_util::stream;
use pipette_drive::DriveFile;
use pipette_drive::canonical::Listing;
use pipette_drive::trash_names::parse_trash_file;
use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::{
    KEY_LABEL_SYNC_UNIT, StoreContext, TYPING_TEXT_SYNC_UNIT, active_keyboard_names, read_keyboard_meta_index,
};
use pipette_sync_format::drive_names::{drive_file_name, is_data_file_name, sync_unit_from_file_name};
use serde::Serialize;
use zeroize::Zeroizing;

use crate::codec::EnvelopeCodec;
use crate::execute::SYNC_CONCURRENCY;
use crate::preflight::{Preflight, PreflightError};

const I18N_INDEX_SYNC_UNIT: &str = "i18n/index";
const THEME_INDEX_SYNC_UNIT: &str = "themes/index";
const I18N_PACK_PREFIX: &str = "i18n/packs/";
const THEME_PACK_PREFIX: &str = "themes/packs/";

/// `UndecryptableFile`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndecryptableFile {
    pub file_id: String,
    pub file_name: String,
    pub sync_unit: Option<String>,
}

/// `fetchValidatedDataFiles`: the stored password and the data files of
/// one listing, once the guard passed and the password opens the
/// password-check (created when Drive has none). `None` without
/// credentials.
pub async fn fetch_validated_data_files(
    preflight: &Arc<Preflight>,
) -> Result<Option<(Zeroizing<String>, Vec<DriveFile>)>, PreflightError> {
    let Ok(password) = preflight.require_sync_credentials().await else { return Ok(None) };
    preflight.assert_no_local_password_change().await?;
    let generation = preflight.sync_format_generation();
    let listing = preflight.drive().list_files(None).await?;
    preflight.assert_sync_allowed(Some((&listing, generation))).await?;
    preflight.validate_password_check(&password, &listing, generation).await?;
    let data_files = listing.into_iter().filter(|file| is_data_file_name(&file.name)).collect();
    Ok(Some((password, data_files)))
}

/// `findUndecryptableFiles`: those of `data_files` `password` does not
/// open, in listed order (the Electron build answers them in the order
/// their checks end). Trash files are not checked: the sync never reads
/// them.
async fn find_undecryptable_files(
    preflight: &Preflight,
    codec: &dyn EnvelopeCodec,
    password: &Zeroizing<String>,
    data_files: &[DriveFile],
) -> Vec<UndecryptableFile> {
    let drive = preflight.drive();
    let checks: Vec<_> = data_files
        .iter()
        .filter(|file| parse_trash_file(&file.id, &file.name).is_none())
        .enumerate()
        .map(|(index, file)| {
            let password = password.clone();
            async move {
                let opens = match drive.download(&file.id).await {
                    Ok(content) => codec.open(content, password).await.is_ok(),
                    Err(_) => false,
                };
                (!opens).then(|| {
                    let file = UndecryptableFile {
                        file_id: file.id.clone(),
                        file_name: file.name.clone(),
                        sync_unit: sync_unit_from_file_name(&file.name),
                    };
                    (index, file)
                })
            }
        })
        .collect();
    // The next file starts as soon as any check ends; the answer keeps the
    // listed order.
    let mut found: Vec<(usize, UndecryptableFile)> = stream::iter(checks)
        .buffer_unordered(SYNC_CONCURRENCY)
        .filter_map(std::future::ready)
        .collect()
        .await;
    found.sort_by_key(|(index, _)| *index);
    found.into_iter().map(|(_, file)| file).collect()
}

/// `listUndecryptableFiles`: the data files the stored password does not
/// open; empty without credentials.
pub async fn list_undecryptable_files(
    preflight: &Arc<Preflight>,
    codec: &dyn EnvelopeCodec,
) -> Result<Vec<UndecryptableFile>, PreflightError> {
    let Some((password, data_files)) = fetch_validated_data_files(preflight).await? else {
        return Ok(Vec::new());
    };
    Ok(find_undecryptable_files(preflight, codec, &password, &data_files).await)
}

/// `SyncDataScanResult`: what Drive holds, by category, from the file
/// names alone; each list in the order its first file was listed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SyncDataScanResult {
    pub keyboards: Vec<String>,
    /// The local name of each listed keyboard that has one, as the names
    /// file holds it.
    pub keyboard_names: Vec<(String, Value)>,
    pub favorites: Vec<String>,
    pub i18n_packs: Vec<String>,
    pub theme_packs: Vec<String>,
    pub key_labels: bool,
    pub typing_test_texts: bool,
    /// The i18n index or a pack is on Drive: the index can outlive every
    /// pack it listed (all deleted and collected), and is still something
    /// a reset removes.
    pub has_i18n_data: bool,
    pub has_themes_data: bool,
    pub undecryptable: Vec<UndecryptableFile>,
}

fn strings(list: &[String]) -> Value {
    Value::Array(list.iter().map(|item| Value::from(item.as_str())).collect())
}

impl SyncDataScanResult {
    /// The answer as the renderer gets it, in the key order of the Electron
    /// build.
    pub fn to_json(&self) -> String {
        let mut names = Object::new();
        for (uid, name) in &self.keyboard_names {
            names.insert(uid.as_str(), name.clone());
        }
        let undecryptable = self
            .undecryptable
            .iter()
            .map(|file| {
                let mut entry = Object::new();
                entry.insert("fileId", file.file_id.as_str().into());
                entry.insert("fileName", file.file_name.as_str().into());
                entry.insert("syncUnit", file.sync_unit.as_deref().map_or(Value::Null, Value::from));
                Value::Object(entry)
            })
            .collect();
        let mut result = Object::new();
        result.insert("keyboards", strings(&self.keyboards));
        result.insert("keyboardNames", Value::Object(names));
        result.insert("favorites", strings(&self.favorites));
        result.insert("i18nPacks", strings(&self.i18n_packs));
        result.insert("themePacks", strings(&self.theme_packs));
        result.insert("keyLabels", self.key_labels.into());
        result.insert("typingTestTexts", self.typing_test_texts.into());
        result.insert("hasI18nData", self.has_i18n_data.into());
        result.insert("hasThemesData", self.has_themes_data.into());
        result.insert("undecryptable", Value::Array(undecryptable));
        pipette_js_json::stringify(&Value::Object(result))
    }
}

fn push_new(list: &mut Vec<String>, item: &str) {
    if !item.is_empty() && !list.iter().any(|known| known == item) {
        list.push(item.to_owned());
    }
}

/// The categories of `data_files`, from their names.
fn categorize(data_files: &[DriveFile]) -> SyncDataScanResult {
    let mut result = SyncDataScanResult::default();
    let (mut i18n_index, mut themes_index) = (false, false);
    for file in data_files {
        let Some(unit) = sync_unit_from_file_name(&file.name) else { continue };
        if unit.starts_with("keyboards/") {
            push_new(&mut result.keyboards, unit.split('/').nth(1).unwrap_or(""));
        } else if unit.starts_with("favorites/") {
            push_new(&mut result.favorites, unit.split('/').nth(1).unwrap_or(""));
        } else if let Some(id) = unit.strip_prefix(I18N_PACK_PREFIX) {
            push_new(&mut result.i18n_packs, id);
        } else if let Some(id) = unit.strip_prefix(THEME_PACK_PREFIX) {
            push_new(&mut result.theme_packs, id);
        } else if unit == KEY_LABEL_SYNC_UNIT {
            result.key_labels = true;
        } else if unit == TYPING_TEXT_SYNC_UNIT {
            result.typing_test_texts = true;
        } else if unit == I18N_INDEX_SYNC_UNIT {
            i18n_index = true;
        } else if unit == THEME_INDEX_SYNC_UNIT {
            themes_index = true;
        }
    }
    result.has_i18n_data = i18n_index || !result.i18n_packs.is_empty();
    result.has_themes_data = themes_index || !result.theme_packs.is_empty();
    result
}

/// The names the local names file gives `uids`; none when it cannot be
/// read. Only read: nothing is downloaded or written for a missing name.
async fn local_keyboard_names(ctx: &StoreContext, uids: Vec<String>) -> Vec<(String, Value)> {
    let ctx = ctx.clone();
    let read = tokio::task::spawn_blocking(move || {
        let index = read_keyboard_meta_index(&ctx).ok()?;
        let Some(Value::Array(entries)) = index.get("entries") else { return None };
        let names = active_keyboard_names(entries).ok()?;
        Some(uids.into_iter().filter_map(|uid| names.get(&uid).cloned().map(|name| (uid, name))).collect())
    });
    read.await.ok().flatten().unwrap_or_default()
}

/// `scanRemoteData`: what Drive holds and which of its files the stored
/// password does not open; empty without credentials.
pub async fn scan_remote_data(
    preflight: &Arc<Preflight>,
    codec: &dyn EnvelopeCodec,
    ctx: &StoreContext,
) -> Result<SyncDataScanResult, PreflightError> {
    let Some((password, data_files)) = fetch_validated_data_files(preflight).await? else {
        return Ok(SyncDataScanResult::default());
    };
    let mut result = categorize(&data_files);
    result.keyboard_names = local_keyboard_names(ctx, result.keyboards.clone()).await;
    result.undecryptable = find_undecryptable_files(preflight, codec, &password, &data_files).await;
    Ok(result)
}

/// `fetchRemoteBundle`: the plaintext of the chosen Drive copy of `unit`,
/// JSON the renderer parses; `None` without credentials, without a copy,
/// or when it cannot be downloaded, opened or parsed.
pub async fn fetch_remote_bundle(
    preflight: &Arc<Preflight>,
    codec: &dyn EnvelopeCodec,
    unit: &str,
) -> Result<Option<String>, PreflightError> {
    let Some((password, data_files)) = fetch_validated_data_files(preflight).await? else {
        return Ok(None);
    };
    let listing = Listing::new(data_files);
    let Some(file) = listing.pick_canonical(&drive_file_name(unit)) else { return Ok(None) };
    let Ok(content) = preflight.drive().download(&file.id).await else { return Ok(None) };
    let Ok(plaintext) = codec.open(content, password).await else { return Ok(None) };
    // Too deep for this parser is still JSON the renderer's parser reads.
    match pipette_js_json::parse(&plaintext) {
        Ok(_) => Ok(Some(plaintext)),
        Err(err) if err.is_nesting_too_deep() => Ok(Some(plaintext)),
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str) -> DriveFile {
        DriveFile {
            id: name.to_owned(),
            name: name.to_owned(),
            modified_time: "2025-01-01T00:00:00.000Z".to_owned(),
            created_time: None,
        }
    }

    #[test]
    fn categorizes_from_the_names_alone() {
        let files: Vec<DriveFile> = [
            "keyboards_uid1_settings.enc",
            "keyboards_uid1_snapshots.enc",
            "keyboards_uid-only_analyze_filters.enc",
            "favorites_tapDance.enc",
            "favorites_macro.enc",
            "themes_packs_pack-a.enc",
            "key-labels.enc",
            "unknown-file.enc",
        ]
        .into_iter()
        .map(file)
        .collect();
        let result = categorize(&files);
        assert_eq!(result.keyboards, ["uid1", "uid-only"]);
        assert_eq!(result.favorites, ["tapDance", "macro"]);
        assert_eq!(result.theme_packs, ["pack-a"]);
        assert!(result.key_labels && !result.typing_test_texts);
        assert!(result.has_themes_data && !result.has_i18n_data);
    }

    #[test]
    fn an_index_alone_still_has_data() {
        let result = categorize(&[file("i18n_index.enc"), file("themes_index.enc")]);
        assert!(result.i18n_packs.is_empty() && result.theme_packs.is_empty());
        assert!(result.has_i18n_data && result.has_themes_data);
        assert!(!categorize(&[]).has_i18n_data);
    }

    #[test]
    fn answers_in_the_shape_of_the_electron_build() {
        let result = SyncDataScanResult {
            keyboards: vec!["a".into()],
            keyboard_names: vec![("a".into(), "Board".into())],
            undecryptable: vec![UndecryptableFile {
                file_id: "f".into(),
                file_name: "x.enc".into(),
                sync_unit: None,
            }],
            ..SyncDataScanResult::default()
        };
        assert_eq!(
            result.to_json(),
            r#"{"keyboards":["a"],"keyboardNames":{"a":"Board"},"favorites":[],"i18nPacks":[],"themePacks":[],"keyLabels":false,"typingTestTexts":false,"hasI18nData":false,"hasThemesData":false,"undecryptable":[{"fileId":"f","fileName":"x.enc","syncUnit":null}]}"#
        );
    }
}
