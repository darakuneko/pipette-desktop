// SPDX-License-Identifier: GPL-2.0-or-later
//! `day_uploads` of `sync_state.json`: per own day, what its last upload sent
//! and where it went, so a pass sends a day again only when something changed.
//!
//! Drive's `version` is compared rather than `modifiedTime`, because any
//! client can set `modifiedTime` while only Drive moves `version` (and it
//! moves on every change, a new `modifiedTime` included). Anything missing or
//! unreadable in the record means changed, so a bad record costs one upload.

use pipette_drive::{DriveFile, UploadedFile};
use pipette_js_json::{Object, Value};
use pipette_sync_format::content_hash;
use pipette_sync_runtime::RemoteRevision;

use crate::format::SYNC_FORMAT_VERSION;
use crate::typing_remote::set;

/// The SHA-256 of the `data.jsonl` text of a day bundle; `None` when the
/// bundle has no such text.
pub fn day_content_sha256(bundle: &Object) -> Option<String> {
    Some(content_hash(bundle.get("files")?.as_object()?.get("data.jsonl")?.as_str()?))
}

/// One day's entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DayUpload {
    pub sha256: String,
    /// The Drive file the upload wrote, with the `modifiedTime` Drive
    /// answered (recorded as handled when a later pass skips the day).
    pub file: RemoteRevision,
    pub version: u64,
    /// The password-check the upload's pass validated.
    pub password_check: RemoteRevision,
    pub format: u64,
}

impl DayUpload {
    /// The entry of an upload that sent `sha256` and that Drive answered
    /// with `uploaded`; `None` when Drive answered no version.
    pub fn new(sha256: String, uploaded: &UploadedFile, password_check: RemoteRevision) -> Option<Self> {
        Some(Self {
            sha256,
            file: RemoteRevision { id: uploaded.id.clone(), modified_time: uploaded.modified_time.clone() },
            version: uploaded.version?,
            password_check,
            format: SYNC_FORMAT_VERSION,
        })
    }

    fn to_value(&self) -> Value {
        let object: Object = [
            ("sha256", Value::from(self.sha256.as_str())),
            ("file_id", self.file.id.as_str().into()),
            // Drive's int64, kept as its text.
            ("version", self.version.to_string().as_str().into()),
            ("modified_time", self.file.modified_time.as_str().into()),
            ("password_check_id", self.password_check.id.as_str().into()),
            ("password_check_modified_time", self.password_check.modified_time.as_str().into()),
            ("format", Value::Number(self.format as f64)),
        ]
        .into_iter()
        .collect();
        Value::Object(object)
    }

    fn from_value(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
        let format = match object.get("format") {
            Some(Value::Number(n)) if n.fract() == 0.0 && *n >= 0.0 => *n as u64,
            _ => return None,
        };
        Some(Self {
            sha256: text("sha256")?,
            file: RemoteRevision { id: text("file_id")?, modified_time: text("modified_time")? },
            version: text("version")?.parse().ok()?,
            password_check: RemoteRevision {
                id: text("password_check_id")?,
                modified_time: text("password_check_modified_time")?,
            },
            format,
        })
    }

    /// Whether the day is unchanged since this upload, for a pass that
    /// would write `file` (the copy its listing picks for the day's name)
    /// under `password_check`. A record newer than the listing still counts:
    /// the download and the upload of one pass share one listing, so a day
    /// the download sent shows its earlier revision, and this device is the
    /// only writer of its days.
    pub fn is_unchanged(&self, sha256: &str, file: &DriveFile, password_check: &RemoteRevision) -> bool {
        self.matches_but_version(sha256, file, password_check)
            && file.version.is_some_and(|listed| self.version >= listed)
    }

    /// Everything [`Self::is_unchanged`] compares except the version.
    pub fn matches_but_version(
        &self,
        sha256: &str,
        file: &DriveFile,
        password_check: &RemoteRevision,
    ) -> bool {
        self.sha256 == sha256
            && self.format == SYNC_FORMAT_VERSION
            && *password_check == self.password_check
            && self.file.id == file.id
    }
}

/// The entry of `utc_day` under `key`; `None` when there is none or it
/// cannot be read.
pub fn day_upload(day_uploads: &Value, key: &str, utc_day: &str) -> Option<DayUpload> {
    DayUpload::from_value(day_uploads.as_object()?.get(key)?.as_object()?.get(utc_day)?)
}

fn days_of(day_uploads: &Value, key: &str) -> Option<Object> {
    day_uploads.as_object()?.get(key)?.as_object().cloned()
}

/// Sets (or, with `None`, removes) the entry of `utc_day` under `key`;
/// whether that changed anything.
pub fn set_day_upload(day_uploads: &mut Value, key: &str, utc_day: &str, upload: Option<&DayUpload>) -> bool {
    let mut days = days_of(day_uploads, key).unwrap_or_default();
    let changed = match upload {
        Some(upload) => {
            let value = upload.to_value();
            days.get(utc_day) != Some(&value) && {
                days.insert(utc_day, value);
                true
            }
        }
        None => days.remove(utc_day).is_some(),
    };
    if changed {
        put_days(day_uploads, key, days);
    }
    changed
}

/// Drops the entries under `key` of the days `keep` rejects; whether any
/// went.
pub fn retain_day_uploads(day_uploads: &mut Value, key: &str, keep: impl Fn(&str) -> bool) -> bool {
    let Some(days) = days_of(day_uploads, key) else { return false };
    let kept: Object = days
        .iter()
        .filter(|(day, _)| day.as_str().is_some_and(&keep))
        .map(|(day, value)| (day.clone(), value.clone()))
        .collect();
    if kept.len() == days.len() {
        return false;
    }
    put_days(day_uploads, key, kept);
    true
}

/// `record[key] = days`, or no key when `days` is empty.
fn put_days(day_uploads: &mut Value, key: &str, days: Object) {
    if days.is_empty() {
        if let Value::Object(record) = day_uploads {
            record.remove(key);
        }
    } else {
        set(day_uploads, key, Value::Object(days));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check() -> RemoteRevision {
        RemoteRevision { id: "pc".into(), modified_time: "t0".into() }
    }

    fn file(id: &str, version: Option<u64>) -> DriveFile {
        DriveFile { id: id.into(), name: "n".into(), modified_time: "t".into(), created_time: None, version }
    }

    fn upload() -> DayUpload {
        let uploaded = UploadedFile { id: "f".into(), modified_time: "t5".into(), version: Some(5) };
        DayUpload::new("sha".into(), &uploaded, check()).unwrap()
    }

    #[test]
    fn hashes_the_day_text_of_a_bundle() {
        let files: Object = [("data.jsonl", Value::from("abc"))].into_iter().collect();
        let bundle: Object = [("files", Value::Object(files))].into_iter().collect();
        assert_eq!(
            day_content_sha256(&bundle).as_deref(),
            Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        );
        assert_eq!(day_content_sha256(&Object::new()), None);
    }

    #[test]
    fn is_unchanged_only_when_everything_matches() {
        let upload = upload();
        let same = file("f", Some(5));
        assert!(upload.is_unchanged("sha", &same, &check()));
        assert!(
            upload.is_unchanged("sha", &file("f", Some(4)), &check()),
            "a listing from before the upload"
        );

        assert!(!upload.is_unchanged("other", &same, &check()), "the content changed");
        assert!(!upload.is_unchanged("sha", &file("g", Some(5)), &check()), "another file");
        assert!(!upload.is_unchanged("sha", &file("f", Some(6)), &check()), "written since");
        assert!(!upload.is_unchanged("sha", &file("f", None), &check()), "no version");
        let other_check = RemoteRevision { id: "pc".into(), modified_time: "t1".into() };
        assert!(!upload.is_unchanged("sha", &same, &other_check), "the password-check changed");
        let older_format = DayUpload { format: SYNC_FORMAT_VERSION - 1, ..upload.clone() };
        assert!(!older_format.is_unchanged("sha", &same, &check()), "another format");
    }

    #[test]
    fn records_nothing_without_a_version() {
        let uploaded = UploadedFile { id: "f".into(), modified_time: "t".into(), version: None };
        assert_eq!(DayUpload::new("sha".into(), &uploaded, check()), None);
    }

    #[test]
    fn sets_reads_and_drops_the_entries() {
        let mut record = Value::Object(Object::new());
        assert!(set_day_upload(&mut record, "u|h", "2026-01-01", Some(&upload())));
        assert!(!set_day_upload(&mut record, "u|h", "2026-01-01", Some(&upload())), "the same entry");
        assert!(set_day_upload(&mut record, "u|h", "2026-01-02", Some(&upload())));
        assert_eq!(day_upload(&record, "u|h", "2026-01-01"), Some(upload()));
        assert_eq!(day_upload(&record, "u|x", "2026-01-01"), None);

        assert!(retain_day_uploads(&mut record, "u|h", |day| day == "2026-01-02"));
        assert!(!retain_day_uploads(&mut record, "u|h", |day| day == "2026-01-02"));
        assert_eq!(day_upload(&record, "u|h", "2026-01-01"), None);
        assert!(set_day_upload(&mut record, "u|h", "2026-01-02", None));
        assert!(!set_day_upload(&mut record, "u|h", "2026-01-02", None));
        assert_eq!(record, Value::Object(Object::new()));
    }

    #[test]
    fn an_unreadable_entry_is_none() {
        let mut record = Value::Object(Object::new());
        set_day_upload(&mut record, "u|h", "2026-01-01", Some(&upload()));
        let mut days = days_of(&record, "u|h").unwrap();
        days.insert("2026-01-01", Value::from("not an entry"));
        set(&mut record, "u|h", Value::Object(days));
        assert_eq!(day_upload(&record, "u|h", "2026-01-01"), None);
        assert_eq!(day_upload(&Value::Array(Vec::new()), "u|h", "2026-01-01"), None);
    }
}
