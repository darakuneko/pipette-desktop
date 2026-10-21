// SPDX-License-Identifier: GPL-2.0-or-later
//! `local/typing-analytics/sync_state.json`: which device the cache was
//! built for, and the upload and reconcile bookkeeping of the sync pass.
//!
//! Read with revision 3 as it is, revisions 2
//! and 1 moved to 3 (2 keeps `uploaded` and `reconciled_at`, 1 starts both
//! empty), anything else or any field of the wrong type is no state, and
//! only the known fields are kept. Written as `JSON.stringify(state,
//! null, 2)` with the fields in that order, through a temp file and a
//! rename.
//!
//! `day_uploads` is optional, so it stays under revision 3: a build that
//! drops it costs only one upload of each day. A bad one reads as empty
//! rather than as no state, so it never loses `uploaded`.

use std::path::{Path, PathBuf};

use pipette_js_json::{JsString, Object, Value};
use pipette_time::is_utc_day;

/// The revision this build writes (`SYNC_STATE_REV`).
pub const SYNC_STATE_REV: f64 = 3.0;

#[derive(Clone, Debug, PartialEq)]
pub struct TypingSyncState {
    pub my_device_id: JsString,
    /// `{uid}|{ownHash}` → the UTC days this device uploaded. Kept as the
    /// JSON value it was read as (an object, or an array, which the
    /// check lets through too), so it is written back the
    /// same.
    pub uploaded: Value,
    /// `{uid}|{ownHash}` → the time of the last reconcile, or null while
    /// one is pending; kept as read, like `uploaded`.
    pub reconciled_at: Value,
    pub last_synced_at: f64,
    /// `{uid}|{ownHash}` → UTC day → what the last upload of the day sent
    /// and where it went (an object; the sync reads and checks the
    /// entries). Kept as read.
    pub day_uploads: Value,
}

/// `local/typing-analytics/sync_state.json` under the userData directory.
pub fn sync_state_path(user_data: &Path) -> PathBuf {
    user_data.join("local").join("typing-analytics").join("sync_state.json")
}

impl TypingSyncState {
    /// Nothing uploaded or reconciled, never synced.
    pub fn empty(my_device_id: &str) -> Self {
        Self {
            my_device_id: my_device_id.into(),
            uploaded: Value::Object(Object::new()),
            reconciled_at: Value::Object(Object::new()),
            last_synced_at: 0.0,
            day_uploads: Value::Object(Object::new()),
        }
    }

    /// The state of a parsed file; `None` for anything the rules above do
    /// not take.
    pub fn from_value(raw: &Value) -> Option<Self> {
        let object = raw.as_object()?;
        let Some(Value::String(my_device_id)) = object.get("my_device_id") else { return None };
        let last_synced_at = match object.get("last_synced_at") {
            Some(Value::Number(n)) if n.is_finite() => *n,
            _ => return None,
        };
        let (uploaded, reconciled_at) = match object.get("_rev") {
            Some(Value::Number(rev)) if *rev == SYNC_STATE_REV || *rev == 2.0 => {
                let uploaded = object.get("uploaded").filter(|v| is_uploaded_record(v))?;
                let reconciled_at = object.get("reconciled_at").filter(|v| is_reconciled_at_record(v))?;
                (uploaded.clone(), reconciled_at.clone())
            }
            Some(Value::Number(rev)) if *rev == 1.0 => {
                (Value::Object(Object::new()), Value::Object(Object::new()))
            }
            _ => return None,
        };
        let day_uploads = match object.get("day_uploads") {
            Some(value @ Value::Object(_)) => value.clone(),
            _ => Value::Object(Object::new()),
        };
        Some(Self {
            my_device_id: my_device_id.clone(),
            uploaded,
            reconciled_at,
            last_synced_at,
            day_uploads,
        })
    }

    /// The file's text.
    pub fn to_text(&self) -> String {
        let mut object = Object::new();
        object.insert("_rev", Value::Number(SYNC_STATE_REV));
        object.insert("my_device_id", Value::String(self.my_device_id.clone()));
        object.insert("uploaded", self.uploaded.clone());
        object.insert("reconciled_at", self.reconciled_at.clone());
        object.insert("last_synced_at", Value::Number(self.last_synced_at));
        if self.day_uploads.as_object().is_some_and(|record| !record.is_empty()) {
            object.insert("day_uploads", self.day_uploads.clone());
        }
        pipette_js_json::stringify_with_gap(&Value::Object(object), "  ")
    }
}

/// The values of an object, or the elements of an array (`Object.values`).
fn values(value: &Value) -> Option<Vec<&Value>> {
    match value {
        Value::Object(object) => Some(object.iter().map(|(_, v)| v).collect()),
        Value::Array(items) => Some(items.iter().collect()),
        _ => None,
    }
}

fn is_uploaded_record(value: &Value) -> bool {
    values(value).is_some_and(|days| {
        days.iter().all(|list| match list {
            Value::Array(days) => days.iter().all(|day| day.as_str().is_some_and(is_utc_day)),
            _ => false,
        })
    })
}

fn is_reconciled_at_record(value: &Value) -> bool {
    values(value).is_some_and(|times| {
        times.iter().all(|time| match time {
            Value::Null => true,
            Value::Number(n) => n.is_finite(),
            _ => false,
        })
    })
}

/// The state in `user_data`, or `None` when the file is
/// missing, cannot be read, is not JSON or is not a state.
pub fn load_sync_state(user_data: &Path) -> Option<TypingSyncState> {
    try_load_sync_state(user_data).ok().flatten()
}

/// The state in `user_data`; `Ok(None)` only when the file is missing
/// (`NotFound`). A file that cannot be read, is not JSON or is not a state
/// is an error, so a caller that deletes by the state can tell it from a
/// device that has no state yet.
pub fn try_load_sync_state(user_data: &Path) -> std::io::Result<Option<TypingSyncState>> {
    let bytes = match std::fs::read(sync_state_path(user_data)) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    let invalid =
        |what: &str| std::io::Error::new(std::io::ErrorKind::InvalidData, format!("sync_state.json {what}"));
    // Each invalid sequence reads as U+FFFD.
    let parsed =
        pipette_js_json::parse(&String::from_utf8_lossy(&bytes)).map_err(|_| invalid("is not JSON"))?;
    TypingSyncState::from_value(&parsed).map(Some).ok_or_else(|| invalid("is not a typing sync state"))
}

/// Writes `state` through a temp file and a rename,
/// creating the directory.
pub fn save_sync_state(user_data: &Path, state: &TypingSyncState) -> std::io::Result<()> {
    let path = sync_state_path(user_data);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    pipette_fs::write_file_atomic(&path, state.to_text().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Option<TypingSyncState> {
        TypingSyncState::from_value(&pipette_js_json::parse(text).unwrap())
    }

    #[test]
    fn writes_the_fields_in_order_with_two_spaces() {
        let state = TypingSyncState { last_synced_at: 5.0, ..TypingSyncState::empty("dev") };
        assert_eq!(
            state.to_text(),
            "{\n  \"_rev\": 3,\n  \"my_device_id\": \"dev\",\n  \"uploaded\": {},\n  \"reconciled_at\": {},\n  \
             \"last_synced_at\": 5\n}"
        );
    }

    #[test]
    fn keeps_the_day_uploads_and_reads_a_file_without_them() {
        let without = parse(
            r#"{"_rev":3,"my_device_id":"d","uploaded":{"u|h":["2026-01-01"]},"reconciled_at":{},"last_synced_at":7}"#,
        )
        .unwrap();
        assert_eq!(without.day_uploads, Value::Object(Object::new()));
        assert!(!without.to_text().contains("day_uploads"));

        let text = r#"{"_rev":3,"my_device_id":"d","uploaded":{},"reconciled_at":{},"last_synced_at":7,"day_uploads":{"u|h":{"2026-01-01":{"sha256":"x"}}}}"#;
        let with = parse(text).unwrap();
        assert_eq!(parse(&with.to_text()).unwrap(), with);
        assert!(with.to_text().ends_with(
            "\"last_synced_at\": 7,\n  \"day_uploads\": {\n    \"u|h\": {\n      \"2026-01-01\": {\n        \"sha256\": \"x\"\n      }\n    }\n  }\n}"
        ));

        // A field of the wrong type is no record, not a lost state.
        let bad = parse(r#"{"_rev":3,"my_device_id":"d","uploaded":{"u|h":["2026-01-01"]},"reconciled_at":{},"last_synced_at":7,"day_uploads":[1]}"#).unwrap();
        assert_eq!(bad, without);
    }

    #[test]
    fn moves_older_revisions_to_3() {
        let v2 = parse(
            r#"{"_rev":2,"my_device_id":"d","read_pointers":{"x":1},"uploaded":{"u|h":["2026-01-01"]},"reconciled_at":{"u|h":null},"last_synced_at":7}"#,
        )
        .unwrap();
        assert_eq!(v2.uploaded.as_object().unwrap().len(), 1);
        assert!(!v2.to_text().contains("read_pointers"));
        let v1 = parse(r#"{"_rev":1,"my_device_id":"d","uploaded":"anything","last_synced_at":7}"#).unwrap();
        assert_eq!(v1, TypingSyncState { last_synced_at: 7.0, ..TypingSyncState::empty("d") });
    }

    #[test]
    fn refuses_unknown_revisions_and_fields_of_the_wrong_type() {
        for text in [
            r#"{"_rev":4,"my_device_id":"d","uploaded":{},"reconciled_at":{},"last_synced_at":0}"#,
            r#"{"_rev":"3","my_device_id":"d","uploaded":{},"reconciled_at":{},"last_synced_at":0}"#,
            r#"{"_rev":3,"my_device_id":1,"uploaded":{},"reconciled_at":{},"last_synced_at":0}"#,
            r#"{"_rev":3,"my_device_id":"d","uploaded":{},"reconciled_at":{},"last_synced_at":1e400}"#,
            r#"{"_rev":3,"my_device_id":"d","uploaded":{"k":["0050-01-01"]},"reconciled_at":{},"last_synced_at":0}"#,
            r#"{"_rev":3,"my_device_id":"d","uploaded":{},"reconciled_at":{"k":"1"},"last_synced_at":0}"#,
            r#"{"_rev":3,"my_device_id":"d","reconciled_at":{},"last_synced_at":0}"#,
            r#"[]"#,
        ] {
            assert_eq!(parse(text), None, "{text}");
        }
    }

    #[test]
    fn saves_and_loads() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_sync_state(dir.path()), None);
        let state = TypingSyncState { last_synced_at: 1.5e21, ..TypingSyncState::empty("dev") };
        save_sync_state(dir.path(), &state).unwrap();
        assert_eq!(load_sync_state(dir.path()), Some(state));
        std::fs::write(sync_state_path(dir.path()), "{").unwrap();
        assert_eq!(load_sync_state(dir.path()), None);
    }

    #[test]
    fn try_load_tells_a_missing_state_from_one_that_cannot_be_used() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(try_load_sync_state(dir.path()).unwrap(), None);
        let state = TypingSyncState::empty("dev");
        save_sync_state(dir.path(), &state).unwrap();
        assert_eq!(try_load_sync_state(dir.path()).unwrap(), Some(state));
        for text in [
            "{",
            "[]",
            r#"{"_rev":4,"my_device_id":"d","uploaded":{},"reconciled_at":{},"last_synced_at":0}"#,
            r#"{"_rev":3,"my_device_id":"d","uploaded":{"k":"x"},"reconciled_at":{},"last_synced_at":0}"#,
        ] {
            std::fs::write(sync_state_path(dir.path()), text).unwrap();
            assert!(try_load_sync_state(dir.path()).is_err(), "{text}");
            assert_eq!(load_sync_state(dir.path()), None, "{text}");
        }
        // A directory where the file goes cannot be read.
        std::fs::remove_file(sync_state_path(dir.path())).unwrap();
        std::fs::create_dir(sync_state_path(dir.path())).unwrap();
        assert!(try_load_sync_state(dir.path()).is_err());
        assert_eq!(load_sync_state(dir.path()), None);
    }
}
