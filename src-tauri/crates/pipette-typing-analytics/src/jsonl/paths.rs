// SPDX-License-Identifier: GPL-2.0-or-later
//! Where the JSONL masters and the deleted-range files live and the UTC
//! calendar days that name the day files:
//!
//! `{userData}/sync/keyboards/{uid}/devices/{machineHash}/{YYYY-MM-DD}.jsonl`
//!
//! The listings read a directory the way Node's `readdir` with file types
//! does: an entry is a file or a directory by its own type (a symbolic
//! link is neither), and a directory that cannot be read lists nothing
//! (except in [`try_list_device_days`], which reports it).
//! Names are compared as JavaScript compares strings, by UTF-16 code units.
//! A name that is not UTF-8 is skipped; Node would list it with U+FFFD in
//! place of the bad bytes, a path that leads nowhere.

use std::cmp::Ordering;
use std::fs::{DirEntry, FileType};
use std::io;
use std::path::{Path, PathBuf};

const JSONL_EXT: &str = ".jsonl";

/// The base name of the deleted-ranges file in a device directory, and its
/// key in the unit's sync bundle. Not a `.jsonl` name, so the day listings
/// never pick it up.
pub const DELETED_RANGES_FILENAME: &str = "deleted-ranges.json";

const DELETED_RANGES_APPLIED_FILENAME: &str = "deleted-ranges-applied.json";

const MS_PER_DAY: i64 = 86_400_000;

/// `userData/sync/keyboards`: one directory per keyboard uid.
pub fn keyboards_root(user_data: &Path) -> PathBuf {
    user_data.join("sync").join("keyboards")
}

/// `userData/sync/keyboards/{uid}/devices`.
pub fn devices_dir(user_data: &Path, uid: &str) -> PathBuf {
    keyboards_root(user_data).join(uid).join("devices")
}

/// The directory of one device's day files of one keyboard.
pub fn device_day_dir(user_data: &Path, uid: &str, machine_hash: &str) -> PathBuf {
    devices_dir(user_data, uid).join(machine_hash)
}

/// The day file of one (keyboard, device, UTC day).
pub fn device_day_jsonl_path(user_data: &Path, uid: &str, machine_hash: &str, utc_day: &str) -> PathBuf {
    device_day_dir(user_data, uid, machine_hash).join(format!("{utc_day}{JSONL_EXT}"))
}

/// The deleted-ranges file of one (keyboard, device).
pub fn deleted_ranges_path(user_data: &Path, uid: &str, machine_hash: &str) -> PathBuf {
    device_day_dir(user_data, uid, machine_hash).join(DELETED_RANGES_FILENAME)
}

/// The ids of the deleted ranges this device has applied to its own day
/// files of `uid`. Local only, never a sync unit; it sits in the device's
/// own directory, so a reset of the keyboard removes it with the day files.
pub fn deleted_ranges_applied_path(user_data: &Path, uid: &str, machine_hash: &str) -> PathBuf {
    device_day_dir(user_data, uid, machine_hash).join(DELETED_RANGES_APPLIED_FILENAME)
}

/// JavaScript's `a < b` order of strings.
pub(crate) fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// The entries of `dir` with UTF-8 names and their types; none when the
/// directory cannot be read.
fn entries(dir: &Path) -> Vec<(String, FileType)> {
    let Ok(read) = std::fs::read_dir(dir) else { return Vec::new() };
    read.filter_map(Result::ok)
        .filter_map(|entry: DirEntry| {
            let file_type = entry.file_type().ok()?;
            Some((entry.file_name().into_string().ok()?, file_type))
        })
        .collect()
}

fn subdirectories(dir: &Path) -> impl Iterator<Item = String> {
    entries(dir).into_iter().filter(|(_, t)| t.is_dir()).map(|(name, _)| name)
}

/// The day a `{YYYY-MM-DD}.jsonl` file name names.
fn day_of_filename(name: &str) -> Option<&str> {
    let day = name.strip_suffix(JSONL_EXT)?;
    is_utc_day(day).then_some(day)
}

/// [`entries`] of an opened directory, but an error reading an entry or
/// an entry's type is reported instead of skipped.
fn try_entries(read: std::fs::ReadDir) -> io::Result<Vec<(String, FileType)>> {
    let mut found = Vec::new();
    for entry in read {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if let Ok(name) = entry.file_name().into_string() {
            found.push((name, file_type));
        }
    }
    Ok(found)
}

/// The days of the day files among `entries`, ascending.
fn days_of(entries: Vec<(String, FileType)>) -> Vec<String> {
    let mut days: Vec<String> = entries
        .into_iter()
        .filter(|(_, t)| t.is_file())
        .filter_map(|(name, _)| day_of_filename(&name).map(str::to_owned))
        .collect();
    days.sort();
    days
}

/// The machine hashes under `{uid}/devices/` with a deleted-ranges file
/// (anything at that path), sorted.
pub fn list_deleted_ranges_hashes(user_data: &Path, uid: &str) -> Vec<String> {
    let mut hashes: Vec<String> = subdirectories(&devices_dir(user_data, uid))
        .filter(|hash| deleted_ranges_path(user_data, uid, hash).try_exists().unwrap_or(false))
        .collect();
    hashes.sort_by(|a, b| cmp_utf16(a, b));
    hashes
}

/// The UTC days with a day file of (`uid`, `machine_hash`), ascending.
pub fn list_device_days(user_data: &Path, uid: &str, machine_hash: &str) -> Vec<String> {
    days_of(entries(&device_day_dir(user_data, uid, machine_hash)))
}

/// [`list_device_days`], but a directory that cannot be read is an error
/// rather than no days: only a missing directory (`NotFound`) lists none.
/// For a caller that acts on the days missing locally, where an empty
/// listing would read as "every day was removed".
pub fn try_list_device_days(user_data: &Path, uid: &str, machine_hash: &str) -> io::Result<Vec<String>> {
    // Only the open is "no directory". A NotFound while reading the entries
    // (one removed during the listing) is an error like any other, so the
    // days not read yet are not taken as removed.
    let read = match std::fs::read_dir(device_day_dir(user_data, uid, machine_hash)) {
        Ok(read) => read,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    Ok(days_of(try_entries(read)?))
}

/// One day file found by [`list_all_device_day_jsonl_files`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceDayJsonlRef {
    pub uid: String,
    pub machine_hash: String,
    pub utc_day: String,
    pub path: PathBuf,
}

/// Every day file of every keyboard and device, sorted by (uid, machine
/// hash, day), so a cache rebuild replays each device's days in order.
pub fn list_all_device_day_jsonl_files(user_data: &Path) -> Vec<DeviceDayJsonlRef> {
    let mut refs = Vec::new();
    for uid in subdirectories(&keyboards_root(user_data)) {
        for machine_hash in subdirectories(&devices_dir(user_data, &uid)) {
            let dir = device_day_dir(user_data, &uid, &machine_hash);
            for utc_day in days_of(entries(&dir)) {
                let path = device_day_jsonl_path(user_data, &uid, &machine_hash, &utc_day);
                refs.push(DeviceDayJsonlRef {
                    uid: uid.clone(),
                    machine_hash: machine_hash.clone(),
                    utc_day,
                    path,
                });
            }
        }
    }
    refs.sort_by(|a, b| {
        cmp_utf16(&a.uid, &b.uid)
            .then_with(|| cmp_utf16(&a.machine_hash, &b.machine_hash))
            .then_with(|| a.utc_day.cmp(&b.utc_day))
    });
    refs
}

// --- UTC days -------------------------------------------------------------

/// The UTC calendar day of a time as `YYYY-MM-DD`, the
/// year padded to four characters as `padStart` pads `String(year)`
/// (`10000-01-01`, `00-1-01-01`). A time a `Date` cannot hold gives
/// `0NaN-NaN-NaN`, as there.
pub fn utc_day_from_ms(ms: f64) -> String {
    // new Date(ms): TimeClip truncates toward zero.
    let time = ms.trunc();
    if !time.is_finite() || time.abs() > pipette_time::MAX_TIME_MS as f64 {
        return "0NaN-NaN-NaN".into();
    }
    // In range, so a whole number of at most 54 bits.
    let iso = pipette_time::iso_8601_millis(time as i64);
    let date = iso.split('T').next().unwrap_or_default();
    let (year, month_day) = date.split_at(date.len() - "-MM-DD".len());
    let year: i64 = year.parse().unwrap_or_default();
    format!("{year:0>4}{month_day}")
}

/// Whether `text` is `YYYY-MM-DD` naming a day of the Gregorian calendar
/// that reads back as the same text (so the years 0000 to 0099 are not).
pub fn is_utc_day(text: &str) -> bool {
    pipette_time::is_utc_day(text)
}

/// A text that is not a UTC day.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Invalid UTC day: {0}")]
pub struct InvalidUtcDay(pub String);

/// The half-open `[start, end)` of a UTC day.
pub fn utc_day_boundary_ms(utc_day: &str) -> Result<(i64, i64), InvalidUtcDay> {
    if !is_utc_day(utc_day) {
        return Err(InvalidUtcDay(utc_day.to_owned()));
    }
    // A date-only ES date time string is read as UTC midnight.
    let start =
        pipette_time::parse_date_time_string(utc_day).ok_or_else(|| InvalidUtcDay(utc_day.to_owned()))?;
    Ok((start, start + MS_PER_DAY))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composes_the_device_paths() {
        let root = Path::new("/u");
        assert_eq!(devices_dir(root, "0xAABB"), Path::new("/u/sync/keyboards/0xAABB/devices"));
        assert_eq!(
            device_day_jsonl_path(root, "0xAABB", "hash-a", "2026-04-19"),
            Path::new("/u/sync/keyboards/0xAABB/devices/hash-a/2026-04-19.jsonl")
        );
        assert_eq!(
            deleted_ranges_path(root, "kb", "h"),
            Path::new("/u/sync/keyboards/kb/devices/h/deleted-ranges.json")
        );
    }

    #[test]
    fn utc_days_flip_at_midnight() {
        assert_eq!(utc_day_from_ms(0.0), "1970-01-01");
        assert_eq!(utc_day_from_ms(1_776_643_199_999.0), "2026-04-19");
        assert_eq!(utc_day_from_ms(1_776_643_200_000.0), "2026-04-20");
        assert_eq!(utc_day_from_ms(-0.5), "1970-01-01");
        assert_eq!(utc_day_boundary_ms("2026-04-19"), Ok((1_776_556_800_000, 1_776_643_200_000)));
        assert_eq!(utc_day_boundary_ms("2026-02-29"), Err(InvalidUtcDay("2026-02-29".into())));
    }

    #[test]
    fn lists_only_day_files_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let day_dir = device_day_dir(dir.path(), "0xAABB", "hash-a");
        std::fs::create_dir_all(day_dir.join("2026-04-20.jsonl")).unwrap();
        for name in
            ["2026-04-19.jsonl", "2026-04-17.jsonl", "README.txt", "2026-13-01.jsonl", "2026-02-29.jsonl"]
        {
            std::fs::write(day_dir.join(name), "").unwrap();
        }
        assert_eq!(list_device_days(dir.path(), "0xAABB", "hash-a"), ["2026-04-17", "2026-04-19"]);
        assert!(list_device_days(dir.path(), "0xAABB", "missing").is_empty());
    }

    #[test]
    fn try_list_device_days_lists_the_same_days_and_nothing_for_a_missing_directory() {
        let dir = tempfile::tempdir().unwrap();
        let day_dir = device_day_dir(dir.path(), "0xAABB", "hash-a");
        std::fs::create_dir_all(day_dir.join("2026-04-20.jsonl")).unwrap();
        for name in ["2026-04-19.jsonl", "2026-04-17.jsonl", "README.txt"] {
            std::fs::write(day_dir.join(name), "").unwrap();
        }
        assert_eq!(
            try_list_device_days(dir.path(), "0xAABB", "hash-a").unwrap(),
            ["2026-04-17", "2026-04-19"]
        );
        assert!(try_list_device_days(dir.path(), "0xAABB", "missing").unwrap().is_empty());
        assert!(try_list_device_days(dir.path(), "no-such-keyboard", "hash-a").unwrap().is_empty());
    }

    #[test]
    fn try_list_device_days_fails_on_a_directory_it_cannot_read() {
        let dir = tempfile::tempdir().unwrap();
        // A file where the device directory goes.
        let day_dir = device_day_dir(dir.path(), "0xAABB", "hash-a");
        std::fs::create_dir_all(day_dir.parent().unwrap()).unwrap();
        std::fs::write(&day_dir, "").unwrap();
        assert!(try_list_device_days(dir.path(), "0xAABB", "hash-a").is_err());
        assert!(list_device_days(dir.path(), "0xAABB", "hash-a").is_empty());
        // A file where a parent directory goes. Windows reports that path as
        // not found (ERROR_PATH_NOT_FOUND), which lists no days.
        #[cfg(unix)]
        assert!(try_list_device_days(&day_dir, "0xAABB", "hash-a").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn try_list_device_days_fails_on_a_directory_without_read_permission() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let day_dir = device_day_dir(dir.path(), "0xAABB", "hash-a");
        std::fs::create_dir_all(&day_dir).unwrap();
        std::fs::write(day_dir.join("2026-04-19.jsonl"), "").unwrap();
        std::fs::set_permissions(&day_dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root reads it anyway; there is nothing to check then.
        let readable = std::fs::read_dir(&day_dir).is_ok();
        let listed = try_list_device_days(dir.path(), "0xAABB", "hash-a");
        std::fs::set_permissions(&day_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        if !readable {
            assert!(listed.is_err());
        }
    }
}
