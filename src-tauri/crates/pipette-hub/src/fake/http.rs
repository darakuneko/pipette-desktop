// SPDX-License-Identifier: GPL-2.0-or-later
//! The request and answer of an in-memory Hub route and what the routes
//! share (scripts/fake-hub/hub-http.ts): the envelopes, the JSON and
//! multipart bodies read as the Hub's framework reads them, the bearer
//! check and the page parameters.

use pipette_js_json::{Value, js_string, stringify};

use super::object;
use super::state::{State, User};
use crate::js::js_trim;
use crate::retry_after::js_number;

pub struct Request<'a> {
    /// The query's pairs, decoded.
    pub query: Vec<(String, String)>,
    pub authorization: Option<&'a str>,
    pub content_type: &'a str,
    pub body: &'a [u8],
}

impl Request<'_> {
    /// `URLSearchParams.get`.
    pub fn query(&self, key: &str) -> Option<&str> {
        self.query.iter().find(|(name, _)| name == key).map(|(_, value)| value.as_str())
    }
}

pub struct Answer {
    pub status: u16,
    pub body: String,
    pub retry_after: Option<String>,
    pub content_type: &'static str,
}

pub fn answer_json(status: u16, value: &Value) -> Answer {
    Answer { status, body: stringify(value), retry_after: None, content_type: "application/json" }
}

pub fn ok(data: Value) -> Answer {
    ok_with(200, data)
}

pub fn ok_with(status: u16, data: Value) -> Answer {
    answer_json(status, &object([("ok", Value::Bool(true)), ("data", data)]))
}

pub fn fail(status: u16, error: &str) -> Answer {
    answer_json(status, &object([("ok", Value::Bool(false)), ("error", Value::from(error))]))
}

/// The body as JSON (`Buffer.toString('utf8')`, no BOM handling); `None`
/// when it does not parse.
pub fn read_json(request: &Request<'_>) -> Option<Value> {
    pipette_js_json::parse(&String::from_utf8_lossy(request.body)).ok()
}

/// The body of a route that takes a JSON object, or the Hub's refusal.
pub fn read_json_object(request: &Request<'_>) -> Result<pipette_js_json::Object, Answer> {
    match read_json(request) {
        None => Err(fail(400, "Invalid JSON")),
        Some(Value::Object(object)) => Ok(object),
        Some(_) => Err(fail(400, "Request body must be a JSON object")),
    }
}

/// The Hub's `parseJsonBody`: an object with an `error` field reads as the
/// parse failure it stands for.
pub fn read_json_body(request: &Request<'_>) -> Result<Value, Answer> {
    match read_json(request) {
        None => Err(fail(400, "Invalid JSON")),
        Some(Value::Object(object)) if object.contains_key("error") => {
            Err(fail(400, &js_string(object.get("error"))))
        }
        Some(value) => Ok(value),
    }
}

#[derive(Debug, Clone)]
pub struct FormFile {
    pub filename: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub enum FormValue {
    Text(String),
    File(FormFile),
}

/// The parts of a multipart/form-data body by name (the last one of a name
/// wins, in the place of the first): a part with a filename is a file, any
/// other a text field. Any other body has no fields.
pub fn read_form(request: &Request<'_>) -> Vec<(String, FormValue)> {
    let mut form: Vec<(String, FormValue)> = Vec::new();
    let Some(boundary) = form_boundary(request.content_type) else { return form };
    let delimiter = format!("--{boundary}");
    let mut pieces = split(request.body, delimiter.as_bytes()).into_iter().skip(1);
    for piece in pieces.by_ref() {
        if piece.starts_with(b"--") {
            break;
        }
        let Some(split_at) = find(piece, b"\r\n\r\n") else { continue };
        if !piece.starts_with(b"\r\n") {
            continue;
        }
        let headers: String = piece[2.min(split_at)..split_at].iter().map(|b| char::from(*b)).collect();
        let end = if piece.ends_with(b"\r\n") { piece.len() - 2 } else { piece.len() };
        let content = piece[split_at + 4..end.max(split_at + 4)].to_vec();
        let header = |name: &str| {
            headers.split(['\r', '\n']).find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case(name).then(|| value.to_owned())
            })
        };
        let disposition = header("content-disposition").unwrap_or_default();
        let Some(name) = quoted(&disposition, "name") else { continue };
        let value = match quoted(&disposition, "filename") {
            None => FormValue::Text(String::from_utf8_lossy(&content).into_owned()),
            Some(filename) => FormValue::File(FormFile {
                // The header was read as latin1; the name is UTF-8.
                filename: String::from_utf8_lossy(&filename.chars().map(|c| c as u8).collect::<Vec<u8>>())
                    .into_owned(),
                bytes: content,
            }),
        };
        match form.iter_mut().find(|(key, _)| *key == name) {
            Some(entry) => entry.1 = value,
            None => form.push((name, value)),
        }
    }
    form
}

/// `boundary=` of a multipart/form-data Content-Type, quoted or not.
fn form_boundary(content_type: &str) -> Option<String> {
    let lower = content_type.to_ascii_lowercase();
    if !lower.starts_with("multipart/form-data;") {
        return None;
    }
    let at = lower.find("boundary=")? + "boundary=".len();
    let rest = &content_type[at..];
    let rest = rest.strip_prefix('"').unwrap_or(rest);
    let end = rest.find(['"', ';']).unwrap_or(rest.len());
    (end > 0).then(|| rest[..end].to_owned())
}

/// `key="value"` in a Content-Disposition, `key` starting a word.
fn quoted(disposition: &str, key: &str) -> Option<String> {
    let marker = format!("{key}=\"");
    let mut from = 0;
    while let Some(at) = disposition[from..].find(&marker) {
        let start = from + at;
        let word_start = start == 0
            || !disposition[..start]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
        let value_start = start + marker.len();
        if word_start {
            let value = &disposition[value_start..];
            return value.find('"').map(|end| value[..end].to_owned());
        }
        from = value_start;
    }
    None
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}

fn split<'a>(haystack: &'a [u8], delimiter: &[u8]) -> Vec<&'a [u8]> {
    let mut pieces = Vec::new();
    let mut rest = haystack;
    while let Some(at) = find(rest, delimiter) {
        pieces.push(&rest[..at]);
        rest = &rest[at + delimiter.len()..];
    }
    pieces.push(rest);
    pieces
}

pub fn form_text<'a>(form: &'a [(String, FormValue)], name: &str) -> Option<&'a str> {
    form.iter().find(|(key, _)| key == name).and_then(|(_, value)| match value {
        FormValue::Text(text) => Some(text.as_str()),
        FormValue::File(_) => None,
    })
}

pub fn form_file<'a>(form: &'a [(String, FormValue)], name: &str) -> Option<&'a FormFile> {
    form.iter().find(|(key, _)| key == name).and_then(|(_, value)| match value {
        FormValue::File(file) => Some(file),
        FormValue::Text(_) => None,
    })
}

/// Whether the form has a part of this name.
pub fn form_has(form: &[(String, FormValue)], name: &str) -> bool {
    form.iter().any(|(key, _)| key == name)
}

/// The account of the request's bearer JWT, or the Hub's refusal.
pub fn authenticate(state: &State, request: &Request<'_>) -> Result<User, Answer> {
    let token = request
        .authorization
        .and_then(|header| header.strip_prefix("Bearer "))
        .filter(|token| !token.is_empty());
    let Some(token) = token else { return Err(fail(401, "Authentication required")) };
    let Some((_, user_id)) = state.jwts.iter().find(|(jwt, _)| jwt == token) else {
        return Err(fail(401, "Invalid or expired token"));
    };
    match state.user_by_id(user_id) {
        Some(user) if user.active => Ok(user.clone()),
        _ => Err(fail(403, "Account is deactivated")),
    }
}

/// `page` (1 and up) and `per_page` (1 to 100, 20 when absent).
pub fn pagination(request: &Request<'_>) -> (f64, f64) {
    let number = |key: &str, fallback: f64| {
        let value = request.query(key).map_or(0.0, js_number);
        if value.is_nan() || value == 0.0 { fallback } else { value }
    };
    (number("page", 1.0).max(1.0), number("per_page", 20.0).clamp(1.0, 100.0))
}

/// `records.slice(offset, offset + perPage)`.
pub fn page_of<T: Clone>(records: &[T], page: f64, per_page: f64) -> Vec<T> {
    let offset = ((page - 1.0) * per_page).trunc();
    let to_index =
        |n: f64| if n.is_finite() { (n.max(0.0) as usize).min(records.len()) } else { records.len() };
    let (start, end) = (to_index(offset), to_index((offset + per_page).trunc()));
    records[start..end.max(start)].to_vec()
}

/// `stringOrNull`: a trimmed string, `None` when empty or not a string.
pub fn string_or_null(value: Option<&str>) -> Option<String> {
    value.map(js_trim).filter(|text| !text.is_empty())
}
