// SPDX-License-Identifier: GPL-2.0-or-later
//! The merge of a keyboard's settings file: last writer wins on the
//! file's `_updatedAt`, under the uid's lock (the lock the settings writes
//! of the app take too, which check the file's etag before they write).

use pipette_js_json::Value;
use pipette_time::date_value_ms;

use super::{MergeEnv, MergeError, prop};

/// The time of `value` in ms, 0 for a missing, falsy or invalid one, so a
/// corrupt time always loses.
fn safe_timestamp(value: Option<&Value>) -> f64 {
    value.filter(|v| v.is_truthy()).and_then(date_value_ms).unwrap_or(0.0)
}

/// `JSON.parse(text)._updatedAt` of the local file; 0 when it cannot be
/// read.
fn local_time(text: Option<String>) -> f64 {
    match text.map(|t| pipette_js_json::parse(&t)) {
        Some(Ok(Value::Object(settings))) => safe_timestamp(settings.get("_updatedAt")),
        _ => 0.0,
    }
}

/// What `fs.writeFile` writes for a value that is not a string: an array is
/// an iterable whose items are written one after another, a string item as
/// its UTF-8; any other item, and any other value, is a TypeError (the
/// temporary file is removed, so nothing is written). Node writes the bytes
/// of an array item or of an object item with a `length`; those fail here
/// instead, which only text no device writes can reach.
pub(super) fn written_bytes(value: &Value) -> Result<Vec<u8>, MergeError> {
    let refuse =
        || MergeError::Type("The \"data\" argument must be of type string or an instance of Buffer".into());
    let Value::Array(items) = value else { return Err(refuse()) };
    let mut out = Vec::new();
    for item in items {
        let Value::String(s) = item else { return Err(refuse()) };
        out.extend_from_slice(s.to_string_lossy().as_bytes());
    }
    Ok(out)
}

pub(super) fn merge_settings(
    env: &MergeEnv<'_>,
    unit: &str,
    uid: &str,
    bundle: &Value,
) -> Result<bool, MergeError> {
    let dir = env.ctx.sync_dir().join("keyboards").join(uid);
    std::fs::create_dir_all(&dir)?;
    let files = prop(bundle, "files")?;
    let content = match files {
        None => {
            return Err(MergeError::Type(
                "Cannot read properties of undefined (reading 'pipette_settings.json')".into(),
            ));
        }
        Some(files) => prop(files, "pipette_settings.json")?,
    };
    // `JSON.parse(remoteContent)` reads `String(value)` of a value that is
    // not a string, and the winner is written as `fs.writeFile` writes it.
    let (content, bytes) = match content {
        Some(Value::String(s)) if !s.is_empty() => {
            let text = s.to_string_lossy().into_owned();
            let bytes = Ok(text.clone().into_bytes());
            (text, bytes)
        }
        // A falsy value: nothing to merge.
        None | Some(Value::Null | Value::String(_) | Value::Bool(false)) => return Ok(false),
        Some(Value::Number(n)) if *n == 0.0 || n.is_nan() => return Ok(false),
        Some(value) => (pipette_js_json::js_string(Some(value)), written_bytes(value)),
    };

    env.ctx.locks().with_write_lock(uid, || {
        let path = dir.join("pipette_settings.json");
        let local = local_time(std::fs::read(&path).ok().map(|b| String::from_utf8_lossy(&b).into_owned()));
        let remote = match pipette_js_json::parse(&content) {
            Ok(Value::Null) => {
                return Err(MergeError::Type("Cannot read properties of null (reading '_updatedAt')".into()));
            }
            Ok(Value::Object(settings)) => safe_timestamp(settings.get("_updatedAt")),
            Ok(_) => 0.0,
            Err(err) => return Err(MergeError::Type(format!("SyntaxError: {err}"))),
        };
        if remote > local {
            pipette_fs::write_file_atomic(&path, &bytes?)?;
            env.events.unit_applied(unit);
            return Ok(false);
        }
        Ok(local > remote)
    })
}
