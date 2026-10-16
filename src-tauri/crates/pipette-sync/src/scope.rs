// SPDX-License-Identifier: GPL-2.0-or-later
//! Which units a sync of a scope covers (src/main/sync/sync-scope.ts), and
//! the scopes the renderer may ask for (`validateSyncScope` of
//! src/main/sync/sync-ipc.ts).
//!
//! - `'all'`: every unit; a download takes a keyboard's units only for the
//!   keyboards that have a local directory (lazy);
//! - `'favorites'`: the favorites and the global units (keyboard names,
//!   key labels, typing-test texts);
//! - `{ keyboard }`: that keyboard's units and the global ones, analytics
//!   and run logs included (the manual sync and the Data modal);
//! - `{ favorites: true, keyboard }`: both, without the analytics days and
//!   run logs (the connect-time download);
//! - `'packs'`: the language and theme packs only.
//!
//! The packs follow only `'all'` and `'packs'`.

use std::collections::HashSet;
use std::path::Path;

use pipette_entry_store::is_safe_key;
use pipette_keyboard_stores::{KEY_LABEL_SYNC_UNIT, KEYBOARD_META_SYNC_UNIT, TYPING_TEXT_SYNC_UNIT};
use serde_json::Value;

use crate::units::{is_analytics_sync_unit, is_run_log_sync_unit};

const I18N_SYNC_UNIT_PREFIX: &str = "i18n/";
const THEME_SYNC_UNIT_PREFIX: &str = "themes/";

/// `SyncScope` of src/shared/types/sync.ts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SyncScope {
    All,
    Favorites,
    Packs,
    Keyboard(String),
    /// The connect-time download (`{ favorites: true, keyboard }`).
    FavoritesAndKeyboard(String),
}

impl SyncScope {
    /// `validateSyncScope`: the scope `raw` names, `None` for one the
    /// renderer may not ask for. The keyboard must be a safe key; an
    /// object with a keyboard and `favorites` other than `true` is the
    /// keyboard alone.
    pub fn from_json(raw: &Value) -> Option<Self> {
        match raw {
            Value::String(name) => match name.as_str() {
                "all" => Some(Self::All),
                "favorites" => Some(Self::Favorites),
                "packs" => Some(Self::Packs),
                _ => None,
            },
            Value::Object(object) => {
                let Some(Value::String(keyboard)) = object.get("keyboard") else { return None };
                if !is_safe_key(keyboard) {
                    return None;
                }
                if object.get("favorites") == Some(&Value::Bool(true)) {
                    Some(Self::FavoritesAndKeyboard(keyboard.clone()))
                } else {
                    Some(Self::Keyboard(keyboard.clone()))
                }
            }
            _ => None,
        }
    }
}

fn is_pack_unit(unit: &str) -> bool {
    unit.starts_with(I18N_SYNC_UNIT_PREFIX) || unit.starts_with(THEME_SYNC_UNIT_PREFIX)
}

/// `matchesScope`: whether `scope` covers `unit` (`None`: a file name that
/// is no unit, which only `'all'` covers).
pub fn matches_scope(unit: Option<&str>, scope: &SyncScope) -> bool {
    if *scope == SyncScope::All {
        return true;
    }
    let Some(unit) = unit else { return false };
    // Before the global units below: a pack pull takes nothing else.
    if *scope == SyncScope::Packs {
        return is_pack_unit(unit);
    }
    if [KEYBOARD_META_SYNC_UNIT, KEY_LABEL_SYNC_UNIT, TYPING_TEXT_SYNC_UNIT].contains(&unit) {
        return true;
    }
    if is_pack_unit(unit) {
        return false;
    }
    let in_keyboard = |uid: &str| unit.starts_with(&format!("keyboards/{uid}/"));
    match scope {
        SyncScope::Favorites => unit.starts_with("favorites/"),
        SyncScope::FavoritesAndKeyboard(uid) => unit.starts_with("favorites/") || in_keyboard(uid),
        SyncScope::Keyboard(uid) => in_keyboard(uid),
        SyncScope::All | SyncScope::Packs => unreachable!("handled above"),
    }
}

/// `listLocalKeyboardUids`: the directories under `sync/keyboards/` (not
/// following links); none when it cannot be read.
pub fn list_local_keyboard_uids(user_data: &Path) -> HashSet<String> {
    let Ok(entries) = std::fs::read_dir(user_data.join("sync").join("keyboards")) else {
        return HashSet::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect()
}

/// `shouldDownloadSyncUnit`: whether a download of `scope` merges the
/// Drive file of `unit`. The connect-time scope leaves the analytics days
/// and the run logs to the Analyze panel; `'all'` takes a keyboard's units
/// only for the keyboards in `local_uids`.
pub fn should_download_sync_unit(
    unit: Option<&str>,
    scope: &SyncScope,
    local_uids: &HashSet<String>,
) -> bool {
    let Some(unit) = unit.filter(|unit| !unit.is_empty()) else { return false };
    if !matches_scope(Some(unit), scope) {
        return false;
    }
    if matches!(scope, SyncScope::FavoritesAndKeyboard(_))
        && (is_analytics_sync_unit(unit) || is_run_log_sync_unit(unit))
    {
        return false;
    }
    if *scope == SyncScope::All && unit.starts_with("keyboards/") {
        return unit.split('/').nth(1).is_some_and(|uid| !uid.is_empty() && local_uids.contains(uid));
    }
    true
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn kb(uid: &str) -> SyncScope {
        SyncScope::Keyboard(uid.to_owned())
    }

    fn connect(uid: &str) -> SyncScope {
        SyncScope::FavoritesAndKeyboard(uid.to_owned())
    }

    #[test]
    fn validates_scopes_as_the_ipc_handler_does() {
        assert_eq!(SyncScope::from_json(&json!("all")), Some(SyncScope::All));
        assert_eq!(SyncScope::from_json(&json!("packs")), Some(SyncScope::Packs));
        assert_eq!(SyncScope::from_json(&json!({ "keyboard": "0x1" })), Some(kb("0x1")));
        assert_eq!(
            SyncScope::from_json(&json!({ "keyboard": "0x1", "favorites": true })),
            Some(connect("0x1"))
        );
        assert_eq!(SyncScope::from_json(&json!({ "keyboard": "0x1", "favorites": 1 })), Some(kb("0x1")));
        for bad in
            [json!("other"), json!({ "keyboard": "../x" }), json!({ "keyboard": 1 }), json!({}), json!(3)]
        {
            assert_eq!(SyncScope::from_json(&bad), None, "{bad}");
        }
    }

    #[test]
    fn scopes_match_their_units() {
        assert!(matches_scope(None, &SyncScope::All));
        assert!(!matches_scope(None, &SyncScope::Favorites));
        assert!(matches_scope(Some("favorites/macro"), &SyncScope::Favorites));
        assert!(!matches_scope(Some("keyboards/a/settings"), &SyncScope::Favorites));
        assert!(matches_scope(Some("keyboards/a/settings"), &kb("a")));
        assert!(!matches_scope(Some("keyboards/ab/settings"), &kb("a")));
        assert!(matches_scope(Some("favorites/macro"), &connect("a")));
        for global in ["meta/keyboard-names", "key-labels", "typing-test-texts"] {
            assert!(matches_scope(Some(global), &kb("a")));
            assert!(!matches_scope(Some(global), &SyncScope::Packs));
        }
        assert!(matches_scope(Some("themes/packs/x"), &SyncScope::Packs));
        assert!(!matches_scope(Some("i18n/index"), &SyncScope::Favorites));
        assert!(!matches_scope(Some("favorites/macro"), &SyncScope::Packs));
    }

    #[test]
    fn the_connect_time_download_leaves_analytics_and_run_logs() {
        let local: HashSet<String> = ["a".to_owned()].into();
        let day = Some("keyboards/a/devices/h/days/2026-04-19");
        let runs = Some("keyboards/a/runs");
        assert!(should_download_sync_unit(day, &SyncScope::All, &local));
        assert!(should_download_sync_unit(day, &kb("a"), &local));
        assert!(!should_download_sync_unit(day, &connect("a"), &local));
        assert!(!should_download_sync_unit(runs, &connect("a"), &local));
        assert!(should_download_sync_unit(
            Some("keyboards/a/devices/h/deleted-ranges"),
            &connect("a"),
            &local
        ));
        assert!(!should_download_sync_unit(Some("keyboards/b/settings"), &SyncScope::All, &local));
        assert!(should_download_sync_unit(Some("keyboards/b/settings"), &kb("b"), &local));
        assert!(!should_download_sync_unit(None, &SyncScope::All, &local));
    }
}
