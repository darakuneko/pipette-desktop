// SPDX-License-Identifier: GPL-2.0-or-later
//! The arguments of the resets and deletes as the renderer sends them, checked,
//! with their messages. `None` is an argument the renderer left out
//! (`undefined`).

use pipette_entry_store::is_safe_key;
use serde_json::Value;

/// The keyboards a reset of Drive removes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyboardTargets {
    All,
    /// These uids; an empty list removes none.
    Uids(Vec<String>),
    None,
}

/// `SyncResetTargets`: what a reset of Drive removes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncResetTargets {
    pub keyboards: KeyboardTargets,
    pub favorites: bool,
    pub i18n_packs: bool,
    pub theme_packs: bool,
    pub key_labels: bool,
    pub typing_test_texts: bool,
}

/// `LocalResetTargets`: what a reset of this machine's data removes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalResetTargets {
    pub keyboards: bool,
    pub favorites: bool,
    pub app_settings: bool,
    pub i18n_packs: bool,
    pub theme_packs: bool,
}

/// The fields of an argument `typeof … === 'object'` accepts (an array has
/// none the handlers read); `None` for anything else.
fn fields(value: Option<&Value>) -> Option<Option<&serde_json::Map<String, Value>>> {
    match value? {
        Value::Object(map) => Some(Some(map)),
        Value::Array(_) => Some(None),
        _ => None,
    }
}

/// An optional boolean field: absent is false, anything but a boolean is
/// refused.
fn optional_bool(
    map: Option<&serde_json::Map<String, Value>>,
    key: &str,
    message: impl FnOnce() -> String,
) -> Result<bool, String> {
    match map.and_then(|map| map.get(key)) {
        None => Ok(false),
        Some(Value::Bool(on)) => Ok(*on),
        Some(_) => Err(message()),
    }
}

fn bool_field(map: Option<&serde_json::Map<String, Value>>, key: &str) -> Option<bool> {
    map.and_then(|map| map.get(key)).and_then(Value::as_bool)
}

impl SyncResetTargets {
    pub fn from_json(value: Option<&Value>) -> Result<Self, String> {
        let map = fields(value).ok_or("Invalid targets")?;
        // The uids themselves are checked last, as the handler checks them.
        let mut uids_valid = true;
        let keyboards = match map.and_then(|map| map.get("keyboards")) {
            Some(Value::Bool(true)) => KeyboardTargets::All,
            Some(Value::Bool(false)) => KeyboardTargets::None,
            Some(Value::Array(items)) => {
                uids_valid = items.iter().all(|item| item.as_str().is_some_and(is_safe_key));
                KeyboardTargets::Uids(items.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            }
            _ => return Err("Invalid targets: keyboards must be boolean or string[]".to_owned()),
        };
        let has_keyboards = match map.and_then(|map| map.get("keyboards")) {
            Some(Value::Array(items)) => !items.is_empty(),
            other => other == Some(&Value::Bool(true)),
        };
        let favorites = bool_field(map, "favorites").ok_or("Invalid targets: favorites must be boolean")?;
        let optional =
            |key: &str| optional_bool(map, key, || format!("Invalid targets: {key} must be boolean"));
        let targets = Self {
            i18n_packs: optional("i18nPacks")?,
            theme_packs: optional("themePacks")?,
            key_labels: optional("keyLabels")?,
            typing_test_texts: optional("typingTestTexts")?,
            keyboards,
            favorites,
        };
        if !has_keyboards
            && !targets.favorites
            && !targets.i18n_packs
            && !targets.theme_packs
            && !targets.key_labels
            && !targets.typing_test_texts
        {
            return Err("No targets selected".to_owned());
        }
        if !uids_valid {
            return Err("Invalid keyboard UID".to_owned());
        }
        Ok(targets)
    }
}

impl LocalResetTargets {
    pub fn from_json(value: Option<&Value>) -> Result<Self, String> {
        let map = fields(value).ok_or("Invalid targets")?;
        let (Some(keyboards), Some(favorites), Some(app_settings)) =
            (bool_field(map, "keyboards"), bool_field(map, "favorites"), bool_field(map, "appSettings"))
        else {
            return Err("Invalid targets: expected boolean fields".to_owned());
        };
        let i18n_packs =
            optional_bool(map, "i18nPacks", || "Invalid targets: i18nPacks must be boolean".into())?;
        let theme_packs =
            optional_bool(map, "themePacks", || "Invalid targets: themePacks must be boolean".into())?;
        if !keyboards && !favorites && !app_settings && !i18n_packs && !theme_packs {
            return Err("No targets selected".to_owned());
        }
        Ok(Self { keyboards, favorites, app_settings, i18n_packs, theme_packs })
    }

    /// Every target is selected: the reset cancels every pending unit.
    pub fn all_selected(&self) -> bool {
        self.keyboards && self.favorites && self.app_settings && self.i18n_packs && self.theme_packs
    }
}

/// A uid the renderer sent: a string of word characters and `-`.
pub fn uid_arg(value: Option<&Value>) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .filter(|uid| is_safe_key(uid))
        .map(str::to_owned)
        .ok_or("Invalid uid".into())
}

/// The ids of a delete: a non-empty list of strings.
pub fn file_ids_arg(value: Option<&Value>) -> Result<Vec<String>, String> {
    let ids = value.and_then(Value::as_array).filter(|ids| !ids.is_empty()).ok_or("No files specified")?;
    ids.iter().map(|id| id.as_str().map(str::to_owned).ok_or("Invalid file ID".to_owned())).collect()
}

/// The id of a restore: a non-empty string.
pub fn file_id_arg(value: Option<&Value>) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .ok_or("Invalid file ID".into())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn sync(value: Value) -> Result<SyncResetTargets, String> {
        SyncResetTargets::from_json(Some(&value))
    }

    fn local(value: Value) -> Result<LocalResetTargets, String> {
        LocalResetTargets::from_json(Some(&value))
    }

    #[test]
    fn checks_the_sync_targets_in_the_order_of_the_handler() {
        assert_eq!(SyncResetTargets::from_json(None), Err("Invalid targets".into()));
        assert_eq!(sync(json!(null)), Err("Invalid targets".into()));
        assert_eq!(sync(json!([])), Err("Invalid targets: keyboards must be boolean or string[]".into()));
        assert_eq!(
            sync(json!({ "keyboards": "all" })),
            Err("Invalid targets: keyboards must be boolean or string[]".into())
        );
        assert_eq!(
            sync(json!({ "keyboards": true })),
            Err("Invalid targets: favorites must be boolean".into())
        );
        assert_eq!(
            sync(json!({ "keyboards": false, "favorites": false, "keyLabels": "yes" })),
            Err("Invalid targets: keyLabels must be boolean".into())
        );
        assert_eq!(
            sync(json!({ "keyboards": false, "favorites": false, "typingTestTexts": 1 })),
            Err("Invalid targets: typingTestTexts must be boolean".into())
        );
        assert_eq!(
            sync(
                json!({ "keyboards": false, "favorites": false, "keyLabels": false, "typingTestTexts": false })
            ),
            Err("No targets selected".into())
        );
        assert_eq!(sync(json!({ "keyboards": [], "favorites": false })), Err("No targets selected".into()));
        assert_eq!(
            sync(json!({ "keyboards": ["uid1", "../x"], "favorites": false })),
            Err("Invalid keyboard UID".into())
        );
        assert_eq!(
            sync(json!({ "keyboards": ["uid1", 2], "favorites": false })),
            Err("Invalid keyboard UID".into())
        );
        let targets = sync(json!({ "keyboards": ["uid1"], "favorites": true, "themePacks": true })).unwrap();
        assert_eq!(targets.keyboards, KeyboardTargets::Uids(vec!["uid1".into()]));
        assert!(targets.favorites && targets.theme_packs && !targets.i18n_packs);
    }

    #[test]
    fn checks_the_local_targets_in_the_order_of_the_handler() {
        assert_eq!(local(json!("x")), Err("Invalid targets".into()));
        assert_eq!(
            local(json!({ "keyboards": true, "favorites": false })),
            Err("Invalid targets: expected boolean fields".into())
        );
        assert_eq!(
            local(json!({ "keyboards": true, "favorites": false, "appSettings": false, "i18nPacks": null })),
            Err("Invalid targets: i18nPacks must be boolean".into())
        );
        assert_eq!(
            local(json!({ "keyboards": false, "favorites": false, "appSettings": false })),
            Err("No targets selected".into())
        );
        let all = local(
            json!({ "keyboards": true, "favorites": true, "appSettings": true, "i18nPacks": true, "themePacks": true }),
        );
        assert!(all.unwrap().all_selected());
        assert!(
            !local(json!({ "keyboards": true, "favorites": true, "appSettings": true }))
                .unwrap()
                .all_selected()
        );
    }

    #[test]
    fn checks_the_ids_and_uids() {
        assert_eq!(uid_arg(Some(&json!("0xAB_c-1"))), Ok("0xAB_c-1".into()));
        assert_eq!(uid_arg(Some(&json!("../x"))), Err("Invalid uid".into()));
        assert_eq!(uid_arg(None), Err("Invalid uid".into()));
        assert_eq!(file_ids_arg(Some(&json!(["a", ""]))), Ok(vec!["a".into(), String::new()]));
        assert_eq!(file_ids_arg(Some(&json!([]))), Err("No files specified".into()));
        assert_eq!(file_ids_arg(Some(&json!("a"))), Err("No files specified".into()));
        assert_eq!(file_ids_arg(Some(&json!(["a", 1]))), Err("Invalid file ID".into()));
        assert_eq!(file_id_arg(Some(&json!(42))), Err("Invalid file ID".into()));
        assert_eq!(file_id_arg(Some(&json!(""))), Err("Invalid file ID".into()));
    }
}
