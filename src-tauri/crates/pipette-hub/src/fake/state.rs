// SPDX-License-Identifier: GPL-2.0-or-later
//! The records of the in-memory Hub and the failures injected into its
//! answers, deterministic as scripts/fake-hub/hub-state.ts is:
//!
//! - every id (accounts, posts, packs, key labels) is UUID-shaped from one
//!   counter: `00000000-0000-4000-8000-000000000001`, …;
//! - every write moves the clock one second on from
//!   2026-01-01T00:00:00.000Z, with the Hub's SQLite formats:
//!   `2026-01-01 00:00:01.000Z` for `updated_at` (and `created_at` of
//!   packs and key labels), `2026-01-01 00:00:01` for a post's
//!   `created_at`;
//! - a Hub JWT is `<header>.<payload>.<signature>` with the Hub's payload
//!   (`sub`, `email`, `role`, `exp`, `iat`) and a counter as its
//!   signature; a JWT the fake did not issue is 401;
//! - a private share token is `pt_v1_` and 43 characters from a counter;
//! - the Hub's built-in account (the owner of its built-in key labels) is
//!   there from the start.
//!
//! The answers' fields are in the order of the Hub's.

use pipette_js_json::{Object, Value, stringify};

use super::object;

/// 2026-01-01T00:00:00.000Z.
pub const CLOCK_START_MS: i64 = 1_767_225_600_000;
const CLOCK_STEP_MS: i64 = 1000;
const JWT_MAX_AGE_S: i64 = 7 * 24 * 60 * 60;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// The owner of the Hub's built-in key labels.
pub const SYSTEM_USER_ID: &str = "00000000-0000-0000-0000-000000000001";

const THEME_PREVIEW_KEYS: [&str; 7] =
    ["surface", "content", "accent", "key-bg", "key-label", "success", "danger"];

#[derive(Debug, Clone)]
pub struct User {
    pub id: String,
    pub email: String,
    pub display_name: Option<String>,
    pub active: bool,
}

#[derive(Debug, Clone)]
pub struct PostFile {
    pub file_type: String,
    pub original_filename: String,
    pub file_size: usize,
}

/// What an upload sets on a post.
#[derive(Debug, Clone)]
pub struct PostContent {
    pub title: String,
    pub keyboard_name: Option<String>,
    pub post_type: String,
    pub files: Vec<PostFile>,
    pub keyboard_uid: Option<String>,
    pub total_keystrokes: Option<f64>,
    pub range_from_ms: Option<f64>,
    pub range_to_ms: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct Post {
    pub id: String,
    pub uploaded_by: String,
    pub download_count: u64,
    pub created_at: String,
    pub updated_at: String,
    pub content: PostContent,
    /// The share token and expiry of a private post.
    pub private: Option<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackKind {
    I18n,
    Theme,
}

#[derive(Debug, Clone)]
pub struct Pack {
    pub id: String,
    pub name: String,
    pub version: String,
    /// The uploaded JSON text, as the Hub keeps it.
    pub pack_json: String,
    pub uploaded_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct KeyLabel {
    pub id: String,
    pub name: String,
    /// An object of strings.
    pub map: Value,
    pub composite_labels: Option<Value>,
    pub keymap_applicable: bool,
    pub uploaded_by: String,
    pub created_at: String,
    pub updated_at: String,
}

/// An answer the next requests get instead of theirs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fault {
    pub status: u16,
    pub retry_after: Option<String>,
    /// `{"ok":false,"error":…}` with the Hub's text for the status when
    /// absent.
    pub body: Option<String>,
    pub count: usize,
    /// Only requests of this route (`auth.token`, `keyLabels.list`, …)
    /// fail; any API route when absent.
    pub only: Option<String>,
}

impl Fault {
    /// `count` answers of `status` with the default body.
    pub fn new(status: u16, count: usize) -> Self {
        Self { status, retry_after: None, body: None, count, only: None }
    }

    pub fn retry_after(mut self, retry_after: &str) -> Self {
        self.retry_after = Some(retry_after.to_owned());
        self
    }

    pub fn body(mut self, body: &str) -> Self {
        self.body = Some(body.to_owned());
        self
    }

    pub fn only(mut self, op: &str) -> Self {
        self.only = Some(op.to_owned());
        self
    }
}

/// `faultBody`: the Hub's text for the status.
pub fn fault_body(status: u16) -> String {
    let error = match status {
        400 => "Bad request",
        401 => "Invalid or expired token",
        403 => "Account is deactivated",
        404 => "Not found",
        409 => "Conflict",
        413 => "Request body too large",
        429 => "Too many requests",
        500 => "Internal server error",
        _ => "Injected failure",
    };
    stringify(&object([("ok", Value::Bool(false)), ("error", Value::from(error))]))
}

/// Days since 1970-01-01 to a civil date (Howard Hinnant's
/// `civil_from_days`).
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

/// `new Date(ms).toISOString()`.
pub fn iso(ms: i64) -> String {
    let (year, month, day) = civil_from_days(ms.div_euclid(DAY_MS));
    let in_day = ms.rem_euclid(DAY_MS);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1000 % 60,
        in_day % 1000
    )
}

/// `2026-01-01 00:00:01.000Z`
fn sql_iso_stamp(ms: i64) -> String {
    iso(ms).replacen('T', " ", 1)
}

/// `2026-01-01 00:00:01`
fn sql_datetime_stamp(ms: i64) -> String {
    iso(ms)[..19].replacen('T', " ", 1)
}

/// `Buffer.from(text).toString('base64url')`.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..=chunk.len() {
            out.push(char::from(ALPHABET[(n >> (18 - 6 * i) & 63) as usize]));
        }
    }
    out
}

pub struct State {
    pub users: Vec<User>,
    pub posts: Vec<Post>,
    pub private_posts: Vec<Post>,
    pub i18n: Vec<Pack>,
    pub themes: Vec<Pack>,
    pub key_labels: Vec<KeyLabel>,
    /// Each JWT the fake issued and the account it is for.
    pub jwts: Vec<(String, String)>,
    next_id: u64,
    next_token: u64,
    pub clock_ms: i64,
    faults: Vec<Fault>,
}

impl Default for State {
    fn default() -> Self {
        Self {
            users: vec![User {
                id: SYSTEM_USER_ID.to_owned(),
                email: "pipette@pipette-hub.system".to_owned(),
                display_name: Some("pipette".to_owned()),
                active: true,
            }],
            posts: Vec::new(),
            private_posts: Vec::new(),
            i18n: Vec::new(),
            themes: Vec::new(),
            key_labels: Vec::new(),
            jwts: Vec::new(),
            next_id: 0,
            next_token: 0,
            clock_ms: CLOCK_START_MS,
            faults: Vec::new(),
        }
    }
}

impl State {
    pub fn inject(&mut self, fault: Fault) {
        if fault.count > 0 {
            self.faults.push(fault);
        }
    }

    /// The injected answer for a request of `op`, if one is due: its
    /// status, body and `Retry-After`.
    pub fn take_fault(&mut self, op: &str) -> Option<(u16, String, Option<String>)> {
        let index =
            self.faults.iter().position(|fault| fault.only.as_deref().is_none_or(|only| only == op))?;
        let fault = &mut self.faults[index];
        fault.count -= 1;
        let answer = (
            fault.status,
            fault.body.clone().unwrap_or_else(|| fault_body(fault.status)),
            fault.retry_after.clone(),
        );
        if fault.count == 0 {
            self.faults.remove(index);
        }
        Some(answer)
    }

    pub fn new_id(&mut self) -> String {
        self.next_id += 1;
        format!("00000000-0000-4000-8000-{:012}", self.next_id)
    }

    /// Moves the clock on for a write; its time in milliseconds.
    pub fn tick(&mut self) -> i64 {
        self.clock_ms += CLOCK_STEP_MS;
        self.clock_ms
    }

    /// `updated_at` when given, else the next tick, in the Hub's format.
    pub fn stamp(&mut self, updated_at: Option<&str>) -> String {
        match updated_at {
            Some(stamp) => stamp.to_owned(),
            None => sql_iso_stamp(self.tick()),
        }
    }

    pub fn user_by_id(&self, id: &str) -> Option<&User> {
        self.users.iter().find(|user| user.id == id)
    }

    pub fn user_by_email(&self, email: &str) -> Option<&User> {
        self.users.iter().find(|user| user.email == email)
    }

    pub fn user_by_email_mut(&mut self, email: &str) -> Option<&mut User> {
        self.users.iter_mut().find(|user| user.email == email)
    }

    /// Another account with this display name, the ASCII case ignored (as
    /// SQLite's `lower()` compares).
    pub fn display_name_taken(&self, name: &str, except_id: Option<&str>) -> bool {
        self.users.iter().any(|user| {
            Some(user.id.as_str()) != except_id
                && user.display_name.as_ref().is_some_and(|n| n.eq_ignore_ascii_case(name))
        })
    }

    pub fn create_user(&mut self, email: &str, display_name: Option<String>) -> User {
        let user = User { id: self.new_id(), email: email.to_owned(), display_name, active: true };
        self.users.push(user.clone());
        user
    }

    pub fn issue_jwt(&mut self, user: &User) -> String {
        self.next_token += 1;
        let iat = self.clock_ms.div_euclid(1000);
        let header = base64url(br#"{"alg":"HS256","typ":"JWT"}"#);
        let payload = stringify(&object([
            ("sub", Value::from(user.id.as_str())),
            ("email", Value::from(user.email.as_str())),
            ("role", Value::from("user")),
            ("exp", Value::Number((iat + JWT_MAX_AGE_S) as f64)),
            ("iat", Value::Number(iat as f64)),
        ]));
        let signature = base64url(format!("fake-hub-jwt-{}", self.next_token).as_bytes());
        let jwt = format!("{header}.{}.{signature}", base64url(payload.as_bytes()));
        self.jwts.push((jwt.clone(), user.id.clone()));
        jwt
    }

    /// A new share token.
    pub fn private_token(&mut self) -> String {
        self.next_token += 1;
        format!("pt_v1_fakeprivatetoken{:027}", self.next_token)
    }

    /// The expiry `days` from the clock.
    pub fn expires_at(&self, days: i64) -> String {
        iso(self.clock_ms + days * DAY_MS)
    }

    pub fn new_post(&mut self, content: PostContent, uploaded_by: &str, updated_at: Option<&str>) -> Post {
        let ms = self.tick();
        Post {
            id: self.new_id(),
            uploaded_by: uploaded_by.to_owned(),
            download_count: 0,
            created_at: sql_datetime_stamp(ms),
            updated_at: updated_at.map_or_else(|| sql_iso_stamp(ms), str::to_owned),
            content,
            private: None,
        }
    }

    fn display_name_of(&self, id: &str) -> Value {
        self.user_by_id(id).and_then(|user| user.display_name.as_deref()).map_or(Value::Null, Value::from)
    }

    /// A post in the shape of the Hub's answers.
    pub fn public_post(&self, post: &Post) -> Value {
        let text = |value: &Option<String>| value.as_deref().map_or(Value::Null, Value::from);
        let number = |value: Option<f64>| value.map_or(Value::Null, Value::Number);
        let mut files = post.content.files.clone();
        files.sort_by(|a, b| a.file_type.cmp(&b.file_type));
        let files = files
            .iter()
            .map(|file| {
                object([
                    ("file_type", Value::from(file.file_type.as_str())),
                    ("original_filename", Value::from(file.original_filename.as_str())),
                    ("file_size", Value::Number(file.file_size as f64)),
                ])
            })
            .collect();
        object([
            ("id", Value::from(post.id.as_str())),
            ("title", Value::from(post.content.title.as_str())),
            ("keyboard_name", text(&post.content.keyboard_name)),
            ("uploaded_by", Value::from(post.uploaded_by.as_str())),
            ("download_count", Value::Number(post.download_count as f64)),
            ("created_at", Value::from(post.created_at.as_str())),
            ("updated_at", Value::from(post.updated_at.as_str())),
            ("post_type", Value::from(post.content.post_type.as_str())),
            ("keyboard_uid", text(&post.content.keyboard_uid)),
            ("total_keystrokes", number(post.content.total_keystrokes)),
            ("range_from_ms", number(post.content.range_from_ms)),
            ("range_to_ms", number(post.content.range_to_ms)),
            ("uploader_name", self.display_name_of(&post.uploaded_by)),
            ("files", Value::Array(files)),
        ])
    }

    /// The posts of `user_id`, the most recently updated first.
    pub fn posts_of(&self, user_id: &str) -> Vec<&Post> {
        by_updated_desc(self.posts.iter().filter(|post| post.uploaded_by == user_id).collect(), |post| {
            &post.updated_at
        })
    }

    pub fn packs(&self, kind: PackKind) -> &Vec<Pack> {
        match kind {
            PackKind::I18n => &self.i18n,
            PackKind::Theme => &self.themes,
        }
    }

    pub fn packs_mut(&mut self, kind: PackKind) -> &mut Vec<Pack> {
        match kind {
            PackKind::I18n => &mut self.i18n,
            PackKind::Theme => &mut self.themes,
        }
    }

    pub fn pack_summary(&self, kind: PackKind, pack: &Pack) -> Value {
        let mut fields = Object::new();
        fields.insert("id", Value::from(pack.id.as_str()));
        fields.insert("name", Value::from(pack.name.as_str()));
        fields.insert("version", Value::from(pack.version.as_str()));
        if kind == PackKind::Theme {
            let body = theme_body(&pack.pack_json);
            if let Some(scheme) = body.get("colorScheme") {
                fields.insert("colorScheme", scheme.clone());
            }
            let colors = body.get("colors").and_then(Value::as_object);
            let preview = THEME_PREVIEW_KEYS
                .iter()
                .map(|key| match colors.and_then(|colors| colors.get(key)) {
                    Some(color) if color.is_truthy() => color.clone(),
                    _ => Value::from("#cccccc"),
                })
                .collect();
            fields.insert("preview_colors", Value::Array(preview));
        }
        fields.insert("uploaded_by", Value::from(pack.uploaded_by.as_str()));
        fields.insert("uploader_name", self.display_name_of(&pack.uploaded_by));
        fields.insert("created_at", Value::from(pack.created_at.as_str()));
        fields.insert("updated_at", Value::from(pack.updated_at.as_str()));
        Value::Object(fields)
    }

    pub fn pack_detail(&self, kind: PackKind, pack: &Pack) -> Value {
        let Value::Object(mut fields) = self.pack_summary(kind, pack) else {
            unreachable!("a summary is an object")
        };
        let body = match kind {
            PackKind::I18n => i18n_body(&pack.pack_json),
            PackKind::Theme => theme_body(&pack.pack_json),
        };
        fields.insert("pack", Value::Object(body));
        Value::Object(fields)
    }

    pub fn public_key_label(&self, label: &KeyLabel) -> Value {
        object([
            ("id", Value::from(label.id.as_str())),
            ("name", Value::from(label.name.as_str())),
            ("map", label.map.clone()),
            ("composite_labels", label.composite_labels.clone().unwrap_or(Value::Null)),
            ("keymap_applicable", Value::Bool(label.keymap_applicable)),
            ("uploaded_by", Value::from(label.uploaded_by.as_str())),
            ("uploader_name", self.display_name_of(&label.uploaded_by)),
            ("created_at", Value::from(label.created_at.as_str())),
            ("updated_at", Value::from(label.updated_at.as_str())),
        ])
    }
}

/// Newest `updated_at` first; among equal stamps the later record first.
pub fn by_updated_desc<T>(records: Vec<T>, updated_at: impl Fn(&T) -> &String) -> Vec<T> {
    let mut indexed: Vec<(usize, T)> = records.into_iter().enumerate().collect();
    indexed.sort_by(|(ia, a), (ib, b)| updated_at(b).cmp(updated_at(a)).then(ib.cmp(ia)));
    indexed.into_iter().map(|(_, record)| record).collect()
}

fn parse_object(raw: &str) -> Option<Object> {
    match pipette_js_json::parse(raw) {
        Ok(Value::Object(object)) => Some(object),
        _ => None,
    }
}

/// The `pack` of a stored language pack export.
fn i18n_body(raw: &str) -> Object {
    match parse_object(raw).and_then(|mut export| export.remove("pack")) {
        Some(Value::Object(pack)) => pack,
        _ => [("name", Value::from("")), ("version", Value::from(""))].into_iter().collect(),
    }
}

/// A stored theme pack body; the Hub's stand-in when it does not parse.
fn theme_body(raw: &str) -> Object {
    parse_object(raw).unwrap_or_else(|| {
        [
            ("name", Value::from("")),
            ("version", Value::from("")),
            ("colorScheme", Value::from("light")),
            ("colors", Value::Object(Object::new())),
        ]
        .into_iter()
        .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps_and_tokens_have_the_node_fakes_shapes() {
        assert_eq!(iso(CLOCK_START_MS + 1000), "2026-01-01T00:00:01.000Z");
        assert_eq!(sql_iso_stamp(CLOCK_START_MS + 1000), "2026-01-01 00:00:01.000Z");
        assert_eq!(sql_datetime_stamp(CLOCK_START_MS + 61_000), "2026-01-01 00:01:01");
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(base64url(b"fake-hub-jwt-1"), "ZmFrZS1odWItand0LTE");
        assert_eq!(base64url(br#"{"alg":"HS256","typ":"JWT"}"#), "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
        let mut state = State::default();
        assert_eq!(state.new_id(), "00000000-0000-4000-8000-000000000001");
        assert_eq!(state.private_token().len(), 49);
        assert_eq!(fault_body(429), r#"{"ok":false,"error":"Too many requests"}"#);
    }
}
