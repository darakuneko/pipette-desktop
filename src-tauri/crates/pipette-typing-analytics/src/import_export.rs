// SPDX-License-Identifier: GPL-2.0-or-later
//! Plain-text export and import of the per-day JSONL files
//! (src/main/typing-analytics/import-export.ts, and the import flow of
//! src/main/sync/sync-ipc.ts).
//!
//! The export copies the day files this device owns for a keyboard into
//! files named after their cloud sync unit
//! (`keyboards_{uid}_devices_{hash}_days_{YYYY-MM-DD}.jsonl`), which the
//! user can edit and bring back through the import.
//!
//! The import is restrictive (typing data is recorded, never invented). A
//! file is accepted only when its name matches the export pattern, its day
//! is not today (UTC: the recorder owns that file), no earlier file of the
//! batch targeted the same day, a file by that name exists locally or in
//! the cloud listing, its body parses whole (no empty file, no broken line,
//! at least one row with a time) and every row's time is inside the day.
//! An accepted file replaces the local one, the local file's delete marks
//! kept after the imported rows, so the LWW merge keeps deleted data
//! deleted unless the import holds a newer copy. The replace runs on the
//! flush chain, the writer of this device's own files, and marks again the
//! rows inside this device's own deleted ranges.

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use pipette_entry_store::is_js_whitespace;
use pipette_js_json::Value;

use crate::Error;
use crate::data_ops::{DataOps, blocking};
use crate::jsonl::paths::{device_day_jsonl_path, list_device_days, utc_day_boundary_ms, utc_day_from_ms};
use crate::jsonl::row::{JsonlRow, RowKind};

/// One export file's name, parsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportFileRef {
    pub uid: String,
    pub machine_hash: String,
    pub utc_day: String,
    pub file_name: String,
}

pub fn export_file_name_for(uid: &str, machine_hash: &str, utc_day: &str) -> String {
    format!("keyboards_{uid}_devices_{machine_hash}_days_{utc_day}.jsonl")
}

/// What `.` of a JavaScript regular expression matches: anything but a
/// line terminator.
fn any_char(c: char) -> bool {
    !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `YYYY-MM-DD.jsonl`, the digits ASCII.
fn day_suffix(text: &str) -> Option<&str> {
    let day = text.strip_suffix(".jsonl")?;
    let shape = day.len() == 10
        && day
            .bytes()
            .enumerate()
            .all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    shape.then_some(day)
}

/// `parseExportFileName`: the base name of `name` against
/// `/^keyboards_(.+?)_devices_(.+?)_days_(\d{4}-\d{2}-\d{2})\.jsonl$/`, the
/// lazy groups taking the shortest text that lets the rest match.
pub fn parse_export_file_name(name: &Path) -> Option<ExportFileRef> {
    let file_name = name.file_name()?.to_string_lossy().into_owned();
    let rest = file_name.strip_prefix("keyboards_")?;
    for (i, _) in rest.char_indices().skip(1) {
        let uid = &rest[..i];
        let Some(after) = rest[i..].strip_prefix("_devices_") else { continue };
        if !uid.chars().all(any_char) {
            return None;
        }
        for (j, _) in after.char_indices().skip(1) {
            let hash = &after[..j];
            let Some(day) = after[j..].strip_prefix("_days_").and_then(day_suffix) else { continue };
            if !hash.chars().all(any_char) {
                break;
            }
            return Some(ExportFileRef {
                uid: uid.to_owned(),
                machine_hash: hash.to_owned(),
                utc_day: day.to_owned(),
                file_name: file_name.clone(),
            });
        }
    }
    None
}

/// `exportTypingDataForKeyboard`: copies the day files of (`uid`,
/// `own_hash`) whose day is in `days` into `destination`, creating it, and
/// returns how many it wrote. A day that vanished since the listing (a
/// delete running at the same time) is skipped. The text is copied as
/// UTF-8 text, as `readFile`/`writeFile` with `'utf-8'` copy it.
pub fn export_typing_data_for_keyboard(
    user_data: &Path,
    uid: &str,
    own_hash: &str,
    destination: &Path,
    days: &HashSet<String>,
) -> io::Result<u64> {
    std::fs::create_dir_all(destination)?;
    let mut written = 0;
    for day in list_device_days(user_data, uid, own_hash).into_iter().filter(|day| days.contains(day)) {
        let copied = std::fs::read(device_day_jsonl_path(user_data, uid, own_hash, &day)).and_then(|bytes| {
            let text = String::from_utf8_lossy(&bytes);
            std::fs::write(destination.join(export_file_name_for(uid, own_hash, &day)), text.as_bytes())
        });
        match copied {
            Ok(()) => written += 1,
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
    }
    Ok(written)
}

/// Why the import refused a file (`ImportRejectReason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    InvalidFilename,
    LiveDayLocked,
    DuplicateInBatch,
    NoMatchingTarget,
    EmptyOrInvalidContent,
    RowsOutsideDayWindow,
    ReadError,
    DeletedRangesUnreadable,
}

impl RejectReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidFilename => "invalid-filename",
            Self::LiveDayLocked => "live-day-locked",
            Self::DuplicateInBatch => "duplicate-in-batch",
            Self::NoMatchingTarget => "no-matching-target",
            Self::EmptyOrInvalidContent => "empty-or-invalid-content",
            Self::RowsOutsideDayWindow => "rows-outside-day-window",
            Self::ReadError => "read-error",
            Self::DeletedRangesUnreadable => "deleted-ranges-unreadable",
        }
    }
}

/// `ImportResult`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImportResult {
    pub imported: u64,
    pub rejections: Vec<(String, RejectReason)>,
}

impl ImportResult {
    /// `{ imported, rejections: [{ fileName, reason }] }`.
    pub fn to_js(&self) -> Value {
        let rejections = self
            .rejections
            .iter()
            .map(|(file_name, reason)| {
                [("fileName", Value::from(file_name.as_str())), ("reason", Value::from(reason.as_str()))]
                    .into_iter()
                    .collect::<pipette_js_json::Object>()
                    .into()
            })
            .collect();
        [("imported", Value::Number(self.imported as f64)), ("rejections", Value::Array(rejections))]
            .into_iter()
            .collect::<pipette_js_json::Object>()
            .into()
    }
}

/// Whether the cloud holds a file of the export name (`cloudHasFile`).
pub type CloudHasFile = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// The time of a row the day check reads: the minute start, a session's
/// start; `None` for scope rows.
fn row_timestamp(row: &JsonlRow) -> Option<f64> {
    let field = match row.kind() {
        RowKind::Scope => return None,
        RowKind::Session => "startMs",
        _ => "minuteTs",
    };
    match row.value().as_object()?.get("payload")?.as_object()?.get(field)? {
        Value::Number(ms) => Some(*ms),
        _ => None,
    }
}

/// `parseRowsFromBody`: every non-empty line parsed, or `None` when there
/// is none or one fails: a silent partial overwrite of a day file is the
/// worst outcome here.
fn parse_rows_from_body(body: &str) -> Option<Vec<JsonlRow>> {
    let rows =
        body.split('\n').filter(|line| !line.is_empty()).map(JsonlRow::parse).collect::<Option<Vec<_>>>()?;
    (!rows.is_empty()).then_some(rows)
}

/// Every row's time inside the day; a session's end may spill over.
fn rows_fall_inside_day(rows: &[JsonlRow], day: &str) -> bool {
    let Ok((start, end)) = utc_day_boundary_ms(day) else { return false };
    rows.iter().filter_map(row_timestamp).all(|ts| ts >= start as f64 && ts < end as f64)
}

/// `String.prototype.trim`.
fn js_trim(line: &str) -> &str {
    line.trim_matches(|c: char| u16::try_from(u32::from(c)).is_ok_and(is_js_whitespace))
}

/// `readDeleteMarkLines`: the lines of the file at `path` that are delete
/// marks, verbatim; none when the file does not exist.
fn read_delete_mark_lines(path: &Path) -> io::Result<Vec<String>> {
    let content = match std::fs::read(path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    Ok(content
        .split('\n')
        .filter(|line| {
            JsonlRow::parse(line).is_some_and(|row| {
                matches!(row.value().as_object().and_then(|r| r.get("is_deleted")), Some(Value::Bool(true)))
            })
        })
        .map(str::to_owned)
        .collect())
}

/// `withLocalDeleteMarks`: `body` followed by the kept mark lines it does
/// not already hold (compared trimmed, so repeated imports do not pile up
/// copies), always ending with a newline: the reader drops a last line
/// without one as cut short by a crash.
fn with_local_delete_marks(body: &str, marks: &[String]) -> String {
    let body_lines: HashSet<&str> = body.split('\n').map(js_trim).collect();
    let missing: Vec<&str> =
        marks.iter().map(String::as_str).filter(|line| !body_lines.contains(js_trim(line))).collect();
    let mut text = body.to_owned();
    if !text.ends_with('\n') {
        text.push('\n');
    }
    if !missing.is_empty() {
        text.push_str(&missing.join("\n"));
        text.push('\n');
    }
    text
}

/// A file that passed the checks, to replace its target with.
struct Accepted {
    target: PathBuf,
    file_ref: ExportFileRef,
    body: String,
}

impl DataOps {
    /// `importTypingDataFiles`, then the rebuild of `importTypingFiles`
    /// (sync-ipc.ts): checks each of `paths` on its own, so one bad file
    /// does not stop the rest, replaces the accepted ones and rebuilds the
    /// cache when any was imported (a failed rebuild is logged). A failure
    /// while replacing a file fails the whole import, as there.
    pub async fn import_typing_files(
        self: &Arc<Self>,
        paths: Vec<PathBuf>,
        cloud_has_file: Option<CloudHasFile>,
    ) -> Result<ImportResult, Error> {
        let mut result = ImportResult::default();
        let today = utc_day_from_ms(self.analytics().now_ms() as f64);
        let user_data = self.analytics().user_data().to_path_buf();
        let mut seen_targets = HashSet::new();
        for path in paths {
            let Some(file_ref) = parse_export_file_name(&path) else {
                let base_name = path.file_name().map(|name| name.to_string_lossy().into_owned());
                result.rejections.push((base_name.unwrap_or_default(), RejectReason::InvalidFilename));
                continue;
            };
            if file_ref.utc_day == today {
                result.rejections.push((file_ref.file_name, RejectReason::LiveDayLocked));
                continue;
            }
            let target =
                device_day_jsonl_path(&user_data, &file_ref.uid, &file_ref.machine_hash, &file_ref.utc_day);
            if !seen_targets.insert(target.clone()) {
                result.rejections.push((file_ref.file_name, RejectReason::DuplicateInBatch));
                continue;
            }
            let cloud = cloud_has_file.clone();
            let accepted =
                match blocking(move || Ok::<_, Error>(check_file(path, target, file_ref, cloud))).await? {
                    Ok(accepted) => accepted,
                    Err(rejection) => {
                        result.rejections.push(rejection);
                        continue;
                    }
                };
            let file_name = accepted.file_ref.file_name.clone();
            let ops = self.clone();
            if self.on_chain(async move { ops.replace_day_file(accepted).await }).await? {
                result.imported += 1;
            } else {
                result.rejections.push((file_name, RejectReason::DeletedRangesUnreadable));
            }
        }
        if result.imported > 0 {
            let analytics = self.analytics().clone();
            let rebuilt = async {
                let ready = analytics.ready().await?;
                blocking(move || analytics.rebuild_now(&ready)).await
            };
            if let Err(err) = rebuilt.await {
                log::warn!(
                    "[sync-ipc] typing-analytics import: cache rebuild failed; will retry on next launch Error: {err}"
                );
            }
        }
        Ok(result)
    }

    /// Replaces one accepted file's target, on the flush chain: false when
    /// this device's deleted ranges could not be read, leaving the file as
    /// it is.
    async fn replace_day_file(&self, accepted: Accepted) -> Result<bool, Error> {
        let Accepted { target, file_ref, body } = accepted;
        let Ok(reapply) = self
            .prepare_own_deleted_ranges_reapply(&file_ref.uid, &file_ref.machine_hash, &file_ref.utc_day)
            .await
        else {
            return Ok(false);
        };
        blocking(move || -> io::Result<()> {
            if let Some(dir) = target.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let text = with_local_delete_marks(&body, &read_delete_mark_lines(&target)?);
            pipette_fs::write_file_atomic(&target, text.as_bytes())
        })
        .await?;
        reapply.run(self).await?;
        Ok(true)
    }
}

/// The checks of one file that read the disk: the accepted file, or its
/// rejection.
fn check_file(
    path: PathBuf,
    target: PathBuf,
    file_ref: ExportFileRef,
    cloud_has_file: Option<CloudHasFile>,
) -> Result<Accepted, (String, RejectReason)> {
    let reject = |reason| Err((file_ref.file_name.clone(), reason));
    let local_exists = std::fs::metadata(&target).is_ok();
    let cloud_exists = !local_exists && cloud_has_file.is_some_and(|has| has(&file_ref.file_name));
    if !local_exists && !cloud_exists {
        return reject(RejectReason::NoMatchingTarget);
    }
    let Ok(bytes) = std::fs::read(&path) else { return reject(RejectReason::ReadError) };
    let body = String::from_utf8_lossy(&bytes).into_owned();
    let Some(rows) =
        parse_rows_from_body(&body).filter(|rows| rows.iter().any(|r| row_timestamp(r).is_some()))
    else {
        return reject(RejectReason::EmptyOrInvalidContent);
    };
    if !rows_fall_inside_day(&rows, &file_ref.utc_day) {
        return reject(RejectReason::RowsOutsideDayWindow);
    }
    Ok(Accepted { target, file_ref, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(name: &str) -> Option<(String, String, String)> {
        parse_export_file_name(Path::new(name)).map(|r| (r.uid, r.machine_hash, r.utc_day))
    }

    #[test]
    fn parses_the_export_names_as_the_lazy_pattern_does() {
        let name = export_file_name_for("0xAABB", "hash-a", "2026-04-19");
        assert_eq!(
            parsed(&format!("/x/{name}")),
            Some(("0xAABB".into(), "hash-a".into(), "2026-04-19".into()))
        );
        assert_eq!(
            parsed("keyboards_a_devices_b_devices_c_days_2026-04-19.jsonl"),
            Some(("a".into(), "b_devices_c".into(), "2026-04-19".into()))
        );
        assert_eq!(
            parsed("keyboards_a_b_devices_h_days_x_days_2026-04-19.jsonl"),
            Some(("a_b".into(), "h_days_x".into(), "2026-04-19".into()))
        );
        for name in [
            "keyboards__devices_h_days_2026-04-19.jsonl",
            "keyboards_a_devices__days_2026-04-19.jsonl",
            "keyboards_a_devices_h_days_2026-4-19.jsonl",
            "keyboards_a_devices_h_days_2026-04-19.jsonl.enc",
            "keyboards_a\nb_devices_h_days_2026-04-19.jsonl",
            "notes.txt",
        ] {
            assert_eq!(parsed(name), None, "{name:?}");
        }
    }

    #[test]
    fn keeps_each_local_mark_once_and_ends_with_a_newline() {
        let marks = vec![r#"{"m":1}"#.to_owned(), r#"{"m":2}"#.to_owned()];
        assert_eq!(with_local_delete_marks("a", &[]), "a\n");
        assert_eq!(with_local_delete_marks("a\n {\"m\":1}\r\n", &marks), "a\n {\"m\":1}\r\n{\"m\":2}\n");
        assert_eq!(with_local_delete_marks("a\n", &marks), "a\n{\"m\":1}\n{\"m\":2}\n");
    }
}
