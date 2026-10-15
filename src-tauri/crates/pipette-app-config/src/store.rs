// SPDX-License-Identifier: GPL-2.0-or-later
//! The store: what src/main/app-config.ts does with electron-store, on the
//! same file.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use pipette_js_json::{Object, Value};

use crate::AppConfigError;
use crate::defaults::DEFAULTS;
use crate::file::{INTERNAL_KEY, read_store, write_store};

/// The file name in the userData directory (electron-store's `name`).
pub const CONFIG_FILE_NAME: &str = "config.json";

type Listener = Box<dyn Fn(&str, &Value) + Send + Sync>;

/// `<userData>/config.json`. Nothing is cached: every read reads the file,
/// and every write reads it, changes it and writes all of it, as conf does.
/// One lock orders the operations of this process.
pub struct AppConfigStore {
    path: PathBuf,
    lock: Mutex<()>,
    listeners: Mutex<Vec<Listener>>,
}

impl AppConfigStore {
    /// Opens the config of the userData directory `dir` the way the
    /// Electron main process starts:
    /// - the defaults are merged in shallowly (`Object.assign({}, defaults,
    ///   file)`), and the result is written only when a default key is
    ///   missing: keys out of the defaults' order alone do not cause a write;
    /// - the `language` migration of `loadAppConfig` runs once.
    ///
    /// Unlike electron-store, which throws (and the Electron build fails to
    /// start), a file that is not JSON is renamed to
    /// `config.json.corrupt-<epoch ms>` with a warning and the config starts
    /// from the defaults. Other errors are logged; the store then reports
    /// them on each call.
    pub fn open(dir: &Path) -> Self {
        let store =
            Self { path: dir.join(CONFIG_FILE_NAME), lock: Mutex::new(()), listeners: Mutex::default() };
        if let Err(err) = store.start() {
            log::error!("[app-config] failed to load {}: {err}", store.path.display());
        }
        store
    }

    fn start(&self) -> Result<(), AppConfigError> {
        let file = match read_store(&self.path) {
            Err(AppConfigError::Parse(err)) => {
                self.set_corrupt_file_aside(&err)?;
                Object::new()
            }
            result => result?,
        };
        let mut with_defaults = DEFAULTS.values.clone();
        for (key, value) in file.iter() {
            with_defaults.insert(key.clone(), value.clone());
        }
        if DEFAULTS.values.keys().any(|key| key.as_str().is_some_and(|key| !file.contains_key(key))) {
            let _guard = self.lock();
            write_store(&self.path, with_defaults)?;
        }
        self.migrate_language()
    }

    fn set_corrupt_file_aside(&self, err: &pipette_js_json::ParseError) -> Result<(), AppConfigError> {
        let epoch_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
        let aside = self.path.with_file_name(format!("{CONFIG_FILE_NAME}.corrupt-{epoch_ms}"));
        std::fs::rename(&self.path, &aside)?;
        log::warn!(
            "[app-config] {} is not valid JSON ({err}); moved it to {} and starting from the defaults",
            self.path.display(),
            aside.display()
        );
        Ok(())
    }

    /// `migrateLanguage` of src/main/app-config.ts: `en` and anything that is
    /// not a `pack:` id or `builtin:en` (strings or not) becomes `builtin:en`;
    /// `ja` also sets `oneShotNotice: 'ja-removed'`, in a second write.
    fn migrate_language(&self) -> Result<(), AppConfigError> {
        let raw = self.get("language")?;
        let kept = match &raw {
            // A lone surrogate after the ASCII prefix still starts with it.
            Some(Value::String(s)) => s == "builtin:en" || s.to_string_lossy().starts_with("pack:"),
            _ => false,
        };
        if kept {
            return Ok(());
        }
        self.set("language", "builtin:en".into())?;
        if raw.as_ref().and_then(Value::as_str) == Some("ja") {
            self.set("oneShotNotice", "ja-removed".into())?;
        }
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn lock(&self) -> MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The whole config (`loadAppConfig()`, the `appConfigGetAll` answer).
    /// Empty when the file is gone; the defaults are not merged in again.
    pub fn get_all(&self) -> Result<Object, AppConfigError> {
        let _guard = self.lock();
        read_store(&self.path)
    }

    pub fn get(&self, key: &str) -> Result<Option<Value>, AppConfigError> {
        Ok(self.get_all()?.get(key).cloned())
    }

    /// `store.set(key, value)`: writes even when the value is the same. A
    /// new key goes last, unless it is an array index. Only top-level keys:
    /// a key conf would read as a property path is refused, as is
    /// `__internal__`.
    pub fn set(&self, key: &str, value: Value) -> Result<(), AppConfigError> {
        check_key(key)?;
        let _guard = self.lock();
        let mut store = read_store(&self.path)?;
        store.insert(key, value);
        write_store(&self.path, store)
    }

    /// The `appConfigSet` IPC handler: a key outside
    /// `SETTABLE_APP_CONFIG_KEYS` is ignored; otherwise the value (the
    /// renderer's `JSON.stringify` of it, `None` for `undefined`) is set and
    /// the listeners are told, even when it did not change.
    pub fn set_from_renderer(&self, key: &str, value_json: Option<&str>) -> Result<(), AppConfigError> {
        if !DEFAULTS.is_settable(key) {
            return Ok(());
        }
        let value_json = value_json.ok_or(AppConfigError::Undefined)?;
        let value = pipette_js_json::parse(value_json).map_err(AppConfigError::InvalidValue)?;
        self.set(key, value.clone())?;
        let listeners = self.listeners.lock().unwrap_or_else(PoisonError::into_inner);
        for listener in listeners.iter() {
            listener(key, &value);
        }
        Ok(())
    }

    /// `store.clear()`: the defaults only, plus the current `__internal__`.
    pub fn clear(&self) -> Result<(), AppConfigError> {
        self.replace(DEFAULTS.values.clone())
    }

    /// `saveAppConfig(config)`: `config` as the whole content, plus the
    /// current `__internal__` when it has none.
    pub fn replace(&self, config: Object) -> Result<(), AppConfigError> {
        let _guard = self.lock();
        write_store(&self.path, config)
    }

    /// `onAppConfigChange`: `listener` gets each key and value
    /// [`set_from_renderer`](Self::set_from_renderer) stores, and nothing
    /// else.
    pub fn subscribe(&self, listener: impl Fn(&str, &Value) + Send + Sync + 'static) {
        self.listeners.lock().unwrap_or_else(PoisonError::into_inner).push(Box::new(listener));
    }
}

/// The path segments dot-prop refuses to follow.
const DISALLOWED_SEGMENTS: [&str; 3] = ["__proto__", "prototype", "constructor"];

fn check_key(key: &str) -> Result<(), AppConfigError> {
    if key == INTERNAL_KEY || key.starts_with(&format!("{INTERNAL_KEY}.")) {
        return Err(AppConfigError::ReservedKey);
    }
    if key.contains(['.', '[', ']', '\\']) || DISALLOWED_SEGMENTS.contains(&key) {
        return Err(AppConfigError::PathKey(key.to_owned()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tempfile::TempDir;

    use super::*;

    #[test]
    fn refuses_keys_conf_reads_as_paths() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        let store = AppConfigStore::open(&dir);
        for key in ["a.b", "a[0]", "a\\.b", "__proto__", "constructor", "prototype"] {
            assert!(matches!(store.set(key, Value::Null), Err(AppConfigError::PathKey(_))), "{key}");
        }
        assert!(matches!(store.set("__internal__.x", Value::Null), Err(AppConfigError::ReservedKey)));
    }

    #[test]
    fn only_renderer_sets_reach_the_listeners() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().to_path_buf();
        let store = AppConfigStore::open(&dir);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        store.subscribe(move |key, value| sink.lock().unwrap().push((key.to_owned(), value.clone())));
        store.set("zoomFactor", 120.0.into()).unwrap();
        store.clear().unwrap();
        store.set_from_renderer("windowState", Some("{}")).unwrap();
        store.set_from_renderer("zoomFactor", Some("150")).unwrap();
        store.set_from_renderer("zoomFactor", Some("150")).unwrap();
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen, [("zoomFactor".to_owned(), 150.0.into()), ("zoomFactor".to_owned(), 150.0.into())]);
    }
}
