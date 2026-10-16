// SPDX-License-Identifier: GPL-2.0-or-later
//! The language store of src/main/language-store.ts: the word lists of each
//! provider (`local/downloads/languages/{provider}/{name}.json`), the Hub
//! overrides of the bundled datasets (`local/typing-test-dataset.json`),
//! and the session's "update available" answers. Machine-local: nothing
//! here is a sync unit.
//!
//! A provider from a `lang_*` call is a path segment, so only a registered
//! one is used (anything else is the default provider). The dataset check
//! and update take any non-empty provider: an unregistered one works only
//! with an override of its own in the file, which the store never drops.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use pipette_entry_store::is_safe_path_segment;
use pipette_js_json::{JsString, Object, Value};
use pipette_net::Http;

use crate::dataset::{Dataset, Model, effective_dataset, file_size};
use crate::download::{FetchFailure, fetch_verified_bytes, size_mismatch_detail};
use crate::hub::{fetch_dataset, fetch_dataset_version};
use crate::providers::{DEFAULT_PROVIDER, is_bundled, is_registered};
use crate::text::decode_utf8;

const CATALOG_ERROR: &str = "Dataset uses the catalog model; use the catalog import flow instead";

/// Why a call failed rather than answered.
#[derive(Debug, thiserror::Error)]
pub enum DatasetError {
    /// A provider with neither a bundled default nor an override.
    #[error("Unknown typing-test provider: {0}")]
    UnknownProvider(String),
    #[error(transparent)]
    Io(#[from] io::Error),
    /// An overrides file nested deeper than pipette-js-json reads.
    /// `JSON.parse` reads it, so every call that needs the overrides fails
    /// rather than reading it as empty (and an update never replaces it).
    #[error("{0}: nested too deeply to read")]
    TooDeep(PathBuf),
    /// The blocking task of the call did not finish.
    #[error("{0}")]
    Task(String),
}

/// The answer of a dataset check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateCheck {
    pub provider: String,
    pub update_available: bool,
}

/// The answer of a dataset update (`TypingDatasetSyncResult`).
#[derive(Debug, Clone, PartialEq)]
pub struct DatasetUpdate {
    pub provider: String,
    pub changed: bool,
    pub from_version: JsString,
    pub to_version: Option<JsString>,
}

impl DatasetUpdate {
    /// `{provider, changed, fromVersion, toVersion?}` as JSON text.
    pub fn to_json(&self) -> String {
        let mut object = Object::new();
        object.insert("provider", self.provider.as_str().into());
        object.insert("changed", self.changed.into());
        object.insert("fromVersion", Value::String(self.from_version.clone()));
        if let Some(to) = &self.to_version {
            object.insert("toVersion", Value::String(to.clone()));
        }
        pipette_js_json::stringify(&Value::Object(object))
    }
}

/// The store. Cheap to clone; the clones share the caches.
#[derive(Clone)]
pub struct LanguageStore(Arc<Inner>);

struct Inner {
    user_data: PathBuf,
    http: Http,
    /// The Hub API base URL, read on every request.
    hub_base: Box<dyn Fn() -> String + Send + Sync>,
    /// The overrides file as read, until an update replaces it.
    overrides: Mutex<Option<Arc<Value>>>,
    /// Held from reading the overrides to writing them back, so two updates
    /// never write over each other's provider.
    write: Mutex<()>,
    /// The session's check answers by provider.
    update_checks: Mutex<HashMap<String, bool>>,
    /// The one-time move of the legacy downloads, which the `lang_*` calls
    /// wait for.
    migration: tokio::sync::OnceCell<()>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `isSafeName`: not empty, and no `/` or `\`.
fn is_safe_name(name: &str) -> bool {
    !name.is_empty() && !name.contains(['/', '\\'])
}

/// Whether `segment` joined onto a directory names an entry directly in
/// that directory on every OS: [`is_safe_path_segment`] (no separator, not
/// `.` or `..`), no NUL, no drive prefix (`C:` joins as a drive-relative
/// path on Windows) and exactly one normal path component. Every path built
/// from a provider or a word list name goes through this.
pub(crate) fn is_one_segment(segment: &str) -> bool {
    let drive_prefix = matches!(segment.as_bytes(), [letter, b':', ..] if letter.is_ascii_alphabetic());
    is_safe_path_segment(segment)
        && !segment.contains('\0')
        && !drive_prefix
        && matches!(Path::new(segment).components().collect::<Vec<_>>().as_slice(), [Component::Normal(_)])
}

/// A word list name the handlers accept (`isSafeName`) whose file name
/// is also one path segment ([`is_one_segment`]).
fn is_valid_name(name: &str) -> bool {
    is_safe_name(name) && is_one_segment(&language_file_name(name))
}

fn language_file_name(name: &str) -> String {
    format!("{name}.json")
}

/// `resolveProvider`: a registered provider, else the default one.
fn resolve_provider(provider: Option<&str>) -> String {
    provider.filter(|p| is_registered(p)).unwrap_or(DEFAULT_PROVIDER).to_owned()
}

/// The provider of a dataset check or update: any non-empty one.
fn dataset_provider(provider: Option<&str>) -> String {
    provider.filter(|p| !p.is_empty()).unwrap_or(DEFAULT_PROVIDER).to_owned()
}

/// `getStatus`.
fn status(name: Option<&str>, provider: &str, downloaded: &HashSet<String>) -> &'static str {
    match name {
        Some(name) if is_bundled(provider, name) => "bundled",
        Some(name) if downloaded.contains(name) => "downloaded",
        _ => "not-downloaded",
    }
}

/// `validateLanguageData`: an object with a string `name` and a non-empty
/// list of string `words`.
fn is_language_data(value: &Value) -> bool {
    let Value::Object(data) = value else { return false };
    matches!(data.get("name"), Some(Value::String(_)))
        && matches!(data.get("words"), Some(Value::Array(words))
            if !words.is_empty() && words.iter().all(|w| matches!(w, Value::String(_))))
}

/// `getDownloadedSet`: the names of the `.json` entries in `dir`.
fn downloaded_set(dir: &Path) -> HashSet<String> {
    let Ok(entries) = fs::read_dir(dir) else { return HashSet::new() };
    entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_string_lossy().strip_suffix(".json").map(str::to_owned))
        .collect()
}

/// `clearDownloadedLanguages`: removes every `.json` file in `dir`,
/// ignoring the ones that cannot be removed.
fn clear_downloaded(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().ends_with(".json") {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// `migrateLegacyDownloads`: moves the `.json` files directly in `root`
/// (from before the per-provider directories) into the default provider's
/// directory. Best effort: a file that cannot be moved stays.
fn migrate_legacy_downloads(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else { return };
    let legacy: Vec<_> = entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && name.ends_with(".json")
                && is_one_segment(&name)
        })
        .map(|entry| entry.file_name())
        .collect();
    if legacy.is_empty() {
        return;
    }
    let dest = root.join(DEFAULT_PROVIDER);
    if let Err(err) = fs::create_dir_all(&dest) {
        log::warn!("Legacy download migration failed: {err}");
        return;
    }
    for name in legacy {
        let _ = fs::rename(root.join(&name), dest.join(&name));
    }
}

/// `{...overrides}`: an array's elements under their index keys.
fn spread(overrides: &Value) -> Object {
    match overrides {
        Value::Object(object) => object.clone(),
        Value::Array(items) => {
            items.iter().enumerate().map(|(i, item)| (i.to_string(), item.clone())).collect()
        }
        _ => Object::new(),
    }
}

impl Inner {
    fn languages_root(&self) -> PathBuf {
        self.user_data.join("local").join("downloads").join("languages")
    }

    /// The provider's word list directory; `None` for a provider that is
    /// not one path segment.
    fn languages_dir(&self, provider: &str) -> Option<PathBuf> {
        is_one_segment(provider).then(|| self.languages_root().join(provider))
    }

    /// The file of a word list; `None` unless both names are one path
    /// segment.
    fn language_file(&self, provider: &str, name: &str) -> Option<PathBuf> {
        let file = language_file_name(name);
        if !is_one_segment(&file) {
            return None;
        }
        self.languages_dir(provider).map(|dir| dir.join(file))
    }

    fn overrides_path(&self) -> PathBuf {
        self.user_data.join("local").join("typing-test-dataset.json")
    }

    /// `loadOverrides`: the file's object or array, else an empty object
    /// (no file, not JSON, any other value). Read once, then cached.
    fn overrides(&self) -> Result<Arc<Value>, DatasetError> {
        let mut cache = lock(&self.overrides);
        if let Some(overrides) = cache.as_ref() {
            return Ok(Arc::clone(overrides));
        }
        let path = self.overrides_path();
        let empty = Value::Object(Object::new());
        let value = match fs::read(&path) {
            Ok(bytes) => match pipette_js_json::parse(&String::from_utf8_lossy(&bytes)) {
                Ok(value @ (Value::Object(_) | Value::Array(_))) => value,
                Err(err) if err.is_nesting_too_deep() => return Err(DatasetError::TooDeep(path)),
                Ok(_) | Err(_) => empty,
            },
            Err(_) => empty,
        };
        let value = Arc::new(value);
        *cache = Some(Arc::clone(&value));
        Ok(value)
    }

    /// The effective version of `provider`'s dataset.
    fn current_version(&self, provider: &str) -> Result<JsString, DatasetError> {
        let overrides = self.overrides()?;
        effective_dataset(&overrides, provider)
            .map(|dataset| dataset.version.clone())
            .ok_or_else(|| DatasetError::UnknownProvider(provider.to_owned()))
    }

    /// Runs `f` on the dataset in effect for a registered `provider`.
    fn with_dataset<T>(&self, provider: &str, f: impl FnOnce(Dataset<'_>) -> T) -> Result<T, DatasetError> {
        let overrides = self.overrides()?;
        let dataset = effective_dataset(&overrides, provider)
            .ok_or_else(|| DatasetError::UnknownProvider(provider.to_owned()))?;
        Ok(f(dataset))
    }

    /// Stores `fresh` as `provider`'s override, keeping every other entry
    /// of the file where it is, then removes the provider's downloads.
    fn apply_update(&self, provider: &str, fresh: Object) -> Result<(), DatasetError> {
        let _write = lock(&self.write);
        let mut next = spread(&*self.overrides()?);
        next.insert(provider, Value::Object(fresh));
        let next = Value::Object(next);
        let path = self.overrides_path();
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        pipette_fs::write_file_atomic(&path, pipette_js_json::stringify(&next).as_bytes())?;
        *lock(&self.overrides) = Some(Arc::new(next));
        // A provider that is not one path segment has no directory of its
        // own to clear.
        if let Some(dir) = self.languages_dir(provider) {
            clear_downloaded(&dir);
        }
        Ok(())
    }
}

impl LanguageStore {
    /// A store on `user_data` whose requests go through `http`, with the
    /// Hub API base URL from `hub_base`.
    pub fn new(
        user_data: impl Into<PathBuf>,
        http: Http,
        hub_base: impl Fn() -> String + Send + Sync + 'static,
    ) -> Self {
        Self(Arc::new(Inner {
            user_data: user_data.into(),
            http,
            hub_base: Box::new(hub_base),
            overrides: Mutex::new(None),
            write: Mutex::new(()),
            update_checks: Mutex::new(HashMap::new()),
            migration: tokio::sync::OnceCell::new(),
        }))
    }

    /// Runs `f` on the runtime's blocking pool.
    async fn blocking<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Inner) -> Result<T, DatasetError> + Send + 'static,
    ) -> Result<T, DatasetError> {
        let inner = Arc::clone(&self.0);
        tokio::task::spawn_blocking(move || f(&inner))
            .await
            .map_err(|err| DatasetError::Task(err.to_string()))?
    }

    /// Moves the legacy downloads the first time it is called; later calls
    /// wait for that move. The app calls it at start.
    pub async fn migrated(&self) {
        self.0
            .migration
            .get_or_init(|| async {
                let root = self.0.languages_root();
                let _ = tokio::task::spawn_blocking(move || migrate_legacy_downloads(&root)).await;
            })
            .await;
    }

    /// `LANG_LIST`: the manifest entries of the provider's dataset, each
    /// with its `status`.
    pub async fn list(&self, provider: Option<&str>) -> Result<Vec<Value>, DatasetError> {
        self.migrated().await;
        let provider = resolve_provider(provider);
        self.blocking(move |inner| {
            let downloaded =
                inner.languages_dir(&provider).map(|dir| downloaded_set(&dir)).unwrap_or_default();
            inner.with_dataset(&provider, |dataset| {
                dataset
                    .languages
                    .iter()
                    .map(|entry| {
                        // Every entry is an object (a manifest entry).
                        let mut entry = entry.as_object().cloned().unwrap_or_default();
                        let name = entry.get("name").and_then(Value::as_str);
                        let status = status(name, &provider, &downloaded);
                        entry.insert("status", status.into());
                        Value::Object(entry)
                    })
                    .collect()
            })
        })
        .await
    }

    /// `LANG_GET`: the downloaded word list as JSON text (the file's text,
    /// which reads back as the object Electron answers), or `None` for a
    /// bundled language, a catalog dataset, or a missing or invalid file.
    pub async fn get(&self, name: &str, provider: Option<&str>) -> Result<Option<String>, DatasetError> {
        if !is_valid_name(name) {
            return Ok(None);
        }
        self.migrated().await;
        let provider = resolve_provider(provider);
        if is_bundled(&provider, name) {
            return Ok(None);
        }
        let name = name.to_owned();
        self.blocking(move |inner| {
            if inner.with_dataset(&provider, |dataset| dataset.model)? == Some(Model::Catalog) {
                return Ok(None);
            }
            let Some(Ok(bytes)) = inner.language_file(&provider, &name).map(fs::read) else {
                return Ok(None);
            };
            let text = String::from_utf8_lossy(&bytes).into_owned();
            Ok(pipette_js_json::parse(&text).ok().filter(is_language_data).map(|_| text))
        })
        .await
    }

    /// `LANG_DOWNLOAD`: fetches `{downloadUrlBase}/{name}.json`, checks its
    /// size and content, and writes the text. `Err` is the handler's error.
    pub async fn download(&self, name: &str, provider: Option<&str>) -> Result<(), String> {
        if !is_valid_name(name) {
            return Err("Invalid language name".to_owned());
        }
        self.migrated().await;
        let provider = resolve_provider(provider);
        if is_bundled(&provider, name) {
            return Err("Language is bundled".to_owned());
        }
        let owned = (provider.clone(), name.to_owned());
        let target = self
            .blocking(move |inner| {
                let (provider, name) = owned;
                inner.with_dataset(&provider, |dataset| {
                    if dataset.model == Some(Model::Catalog) {
                        return Err(CATALOG_ERROR.to_owned());
                    }
                    let entry = dataset.entry(&name).ok_or_else(|| "Unknown language".to_owned())?;
                    let url = format!("{}/{name}.json", dataset.download_url_base.to_string_lossy());
                    Ok((url, file_size(entry)))
                })
            })
            .await
            .map_err(|err| format!("Error: {err}"))?;
        let (url, size) = target?;

        let bytes =
            fetch_verified_bytes(&self.0.http, &url, size).await.map_err(|failure| match failure {
                FetchFailure::Http(status) => format!("HTTP {status}"),
                FetchFailure::SizeMismatch { expected, actual } => {
                    let detail = size_mismatch_detail(expected, actual);
                    log::warn!("Language {provider}/{name}: {detail}");
                    format!("Integrity check failed: {detail}")
                }
                FetchFailure::Network(err) => {
                    log::warn!("Failed to download language {provider}/{name}: {err}");
                    err.to_string()
                }
            })?;

        let name = name.to_owned();
        self.blocking(move |inner| Ok(write_language(inner, &provider, &name, &bytes)))
            .await
            .map_err(|err| format!("Error: {err}"))?
    }

    /// `LANG_DELETE`: removes the downloaded word list. `Err` is the
    /// handler's error.
    pub async fn delete(&self, name: &str, provider: Option<&str>) -> Result<(), String> {
        if !is_valid_name(name) {
            return Err("Invalid language name".to_owned());
        }
        self.migrated().await;
        let provider = resolve_provider(provider);
        if is_bundled(&provider, name) {
            return Err("Cannot delete bundled language".to_owned());
        }
        let name = name.to_owned();
        self.blocking(move |inner| {
            if inner.with_dataset(&provider, |dataset| dataset.model)? == Some(Model::Catalog) {
                return Ok(Err(CATALOG_ERROR.to_owned()));
            }
            let Some(path) = inner.language_file(&provider, &name) else {
                return Ok(Err("Invalid language name".to_owned()));
            };
            Ok(match fs::remove_file(path) {
                Ok(()) => {
                    log::info!("Deleted language: {provider}/{name}");
                    Ok(())
                }
                Err(err) => Err(format!("Error: {err}")),
            })
        })
        .await
        .map_err(|err| format!("Error: {err}"))?
    }

    /// `TYPING_DATASET_CHECK`: whether the Hub has another version of the
    /// provider's dataset. The first answer of each provider is kept for
    /// the session; a Hub that cannot be asked answers `false` without it.
    pub async fn check(&self, provider: Option<&str>) -> Result<UpdateCheck, DatasetError> {
        let provider = dataset_provider(provider);
        if let Some(&update_available) = lock(&self.0.update_checks).get(&provider) {
            return Ok(UpdateCheck { provider, update_available });
        }
        let current = self.current_version(&provider).await?;
        let hub_base = (self.0.hub_base)();
        let Some(hub_version) = fetch_dataset_version(&self.0.http, &hub_base, &provider).await else {
            return Ok(UpdateCheck { provider, update_available: false });
        };
        let update_available = hub_version != current;
        lock(&self.0.update_checks).insert(provider.clone(), update_available);
        Ok(UpdateCheck { provider, update_available })
    }

    /// `TYPING_DATASET_UPDATE`: when the Hub has another version, fetches
    /// the dataset, stores it as the provider's override and removes the
    /// provider's downloads (fetched from the old version's URLs).
    pub async fn update(&self, provider: Option<&str>) -> Result<DatasetUpdate, DatasetError> {
        let provider = dataset_provider(provider);
        let current = self.current_version(&provider).await?;
        let unchanged = |provider: String, current: JsString| DatasetUpdate {
            provider,
            changed: false,
            from_version: current,
            to_version: None,
        };
        let hub_base = (self.0.hub_base)();
        match fetch_dataset_version(&self.0.http, &hub_base, &provider).await {
            Some(hub_version) if hub_version != current => {}
            _ => return Ok(unchanged(provider, current)),
        }
        let Some(fresh) = fetch_dataset(&self.0.http, &hub_base, &provider).await else {
            return Ok(unchanged(provider, current));
        };
        let to_version = match fresh.get("version") {
            Some(Value::String(version)) if *version != current => version.clone(),
            _ => return Ok(unchanged(provider, current)),
        };
        let owned = provider.clone();
        self.blocking(move |inner| inner.apply_update(&owned, fresh)).await?;
        lock(&self.0.update_checks).insert(provider.clone(), false);
        log::info!(
            "Typing dataset {provider}: updated {} -> {}",
            current.to_string_lossy(),
            to_version.to_string_lossy()
        );
        Ok(DatasetUpdate { provider, changed: true, from_version: current, to_version: Some(to_version) })
    }

    async fn current_version(&self, provider: &str) -> Result<JsString, DatasetError> {
        let provider = provider.to_owned();
        self.blocking(move |inner| inner.current_version(&provider)).await
    }

    /// Runs `f` on the dataset in effect for `provider`, on the blocking
    /// pool (`getEffectiveDataset`).
    pub(crate) async fn read_dataset<T: Send + 'static>(
        &self,
        provider: &'static str,
        f: impl FnOnce(Dataset<'_>) -> T + Send + 'static,
    ) -> Result<T, DatasetError> {
        self.blocking(move |inner| inner.with_dataset(provider, f)).await
    }

    /// The client the store's requests go through.
    pub(crate) fn http(&self) -> &Http {
        &self.0.http
    }
}

/// The checked text of a fetched word list, written to its file.
fn write_language(inner: &Inner, provider: &str, name: &str, bytes: &[u8]) -> Result<(), String> {
    let text = decode_utf8(bytes);
    let data = pipette_js_json::parse(&text).map_err(|err| {
        log::warn!("Failed to download language {provider}/{name}: SyntaxError: {err}");
        format!("SyntaxError: {err}")
    })?;
    if !is_language_data(&data) {
        return Err("Invalid language data".to_owned());
    }
    let (Some(dir), Some(path)) = (inner.languages_dir(provider), inner.language_file(provider, name)) else {
        return Err("Invalid language name".to_owned());
    };
    let written =
        fs::create_dir_all(&dir).and_then(|()| pipette_fs::write_file_atomic(&path, text.as_bytes()));
    if let Err(err) = written {
        log::warn!("Failed to download language {provider}/{name}: {err}");
        return Err(format!("Error: {err}"));
    }
    log::info!("Downloaded language: {provider}/{name}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_segment_names_one_entry_of_its_directory_on_every_os() {
        for bad in ["C:", "C:foo", "c:\\x", "\\\\server\\x", "/abs", "a/b", "..", ".", "", "a\0b"] {
            assert!(!is_one_segment(bad), "{bad:?}");
        }
        for good in ["monkeytype", "german.json", "...json", "a b?#c.json", "x.json.json", "日本語"] {
            assert!(is_one_segment(good), "{good:?}");
        }
    }

    #[test]
    fn a_name_is_valid_when_its_file_name_is_one_segment() {
        assert!(is_valid_name("german"));
        assert!(is_valid_name(".."));
        assert!(!is_valid_name("C:"));
        assert!(!is_valid_name("a/b"));
        assert!(!is_valid_name(""));
    }
}
