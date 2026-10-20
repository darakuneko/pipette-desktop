// SPDX-License-Identifier: GPL-2.0-or-later
//! What the handlers of the language and theme packs do the same way:
//! reading their
//! arguments, and writing a pack where an export's save dialog answers.

use std::path::PathBuf;

use pipette_entry_store::{Entry, safe_filename};
use pipette_js_json::{JsString, Object, Value};

use crate::result::{ErrorCode, PackError, PackResult};

/// An IPC argument; `None` is `undefined`.
pub type Arg<'a> = Option<&'a Value>;

/// What a handler answers besides `success`: its `data`, if any.
pub type Answer = PackResult<Option<Value>>;

pub(crate) fn string(arg: Arg<'_>) -> Option<&JsString> {
    match arg {
        Some(Value::String(s)) => Some(s),
        _ => None,
    }
}

pub(crate) fn id_arg(id: Arg<'_>) -> PackResult<&JsString> {
    string(id).ok_or_else(|| PackError::not_found("Invalid id"))
}

pub(crate) fn name_arg(name: Arg<'_>) -> PackResult<&JsString> {
    string(name).ok_or_else(|| PackError::new(ErrorCode::InvalidName, "Invalid name"))
}

/// The ids of a reorder: a list of strings.
pub(crate) fn ordered_ids_arg(ordered_ids: Arg<'_>) -> PackResult<Vec<JsString>> {
    let ids: Option<Vec<JsString>> = match ordered_ids {
        Some(Value::Array(list)) => list.iter().map(|id| string(Some(id)).cloned()).collect(),
        _ => None,
    };
    ids.ok_or_else(|| PackError::new(ErrorCode::InvalidFile, "Invalid order list"))
}

/// The options object of an import; anything else reads as `{}`.
pub(crate) fn options_arg(options: Arg<'_>) -> Object {
    match options {
        Some(Value::Object(object)) => object.clone(),
        _ => Object::new(),
    }
}

/// A thrown error the handler catches as `IO_ERROR`.
pub(crate) fn caught(err: PackError) -> PackError {
    PackError::io(err.message)
}

pub(crate) fn entries(metas: Vec<Entry>) -> Value {
    Value::Array(metas.into_iter().map(Value::from).collect())
}

/// What an export of a pack is called: the default file name's prefix
/// (`{prefix}-{safe name}.json`) and the name `safeFilename` falls back to.
pub(crate) struct ExportName {
    pub prefix: &'static str,
    pub fallback: &'static str,
}

/// Writes the text of a pack read as `read` answers (its meta's name and
/// the text) where `choose` answers, given the default file name; `None`
/// cancels. Any failure to read the pack answers `NOT_FOUND` with its text.
/// `Err` is the error the handler throws, for a meta whose name is not a
/// string.
pub(crate) fn export(
    read: PackResult<(Option<Value>, String)>,
    file: &ExportName,
    choose: impl FnOnce(&str) -> Option<PathBuf>,
) -> Result<Answer, String> {
    let (name, text) = match read {
        Ok(read) => read,
        Err(err) => return Ok(Err(PackError::not_found(err.message))),
    };
    // The handler cleans the name with `String.prototype.replace`.
    let name = match name {
        Some(Value::String(name)) => name,
        None => return Err("TypeError: Cannot read properties of undefined (reading 'replace')".to_owned()),
        Some(Value::Null) => {
            return Err("TypeError: Cannot read properties of null (reading 'replace')".to_owned());
        }
        Some(_) => return Err("TypeError: name.replace is not a function".to_owned()),
    };
    let default_name =
        format!("{}-{}.json", file.prefix, safe_filename(&name.to_string_lossy(), file.fallback));
    let Some(path) = choose(&default_name) else { return Ok(Err(PackError::io("cancelled"))) };
    if let Err(err) = std::fs::write(&path, text) {
        return Ok(Err(PackError::from_io(&err)));
    }
    let mut data = Object::new();
    data.insert("filePath", path.to_string_lossy().as_ref().into());
    Ok(Ok(Some(data.into())))
}
