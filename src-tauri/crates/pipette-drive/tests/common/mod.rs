// SPDX-License-Identifier: GPL-2.0-or-later
//! What the tests share: a [`RetryEnv`] with a fixed clock and jitter that
//! records its waits, and an HTTP front for the in-memory Drive that
//! answers the requests of `HttpDrive` as the Node fake Drive
//! (scripts/fake-drive/server.ts) answers them and logs each in the shape
//! of the recorded request log.

#![allow(clippy::unwrap_used, dead_code)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pipette_drive::fake::InMemoryDrive;
use pipette_drive::http::HttpDrive;
use pipette_drive::retry::{RetryEnv, SleepFuture};
use pipette_drive::{DriveApi, DriveError, DriveFile, ListQuery};
use pipette_net::{HttpError, HttpReply, HttpRequest, HttpRequester, Method, RequestFuture};
use serde_json::{Value, json};

pub const API: &str = "https://www.googleapis.com/drive/v3";
pub const UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3";
const ORIGIN: &str = "https://www.googleapis.com";

/// A fixed clock and jitter; records each wait in milliseconds.
pub struct TestEnv {
    pub now_ms: i64,
    pub random: f64,
    pub quitting: AtomicBool,
    /// Quitting begins during the next wait.
    pub quit_on_next_wait: AtomicBool,
    pub sleeps: Mutex<Vec<f64>>,
}

impl TestEnv {
    pub fn new(now_ms: i64, random: f64) -> Arc<Self> {
        Arc::new(Self {
            now_ms,
            random,
            quitting: AtomicBool::new(false),
            quit_on_next_wait: AtomicBool::new(false),
            sleeps: Mutex::new(Vec::new()),
        })
    }

    pub fn sleeps(&self) -> Vec<f64> {
        self.sleeps.lock().unwrap().clone()
    }
}

impl RetryEnv for TestEnv {
    fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    fn now_ms(&self) -> i64 {
        self.now_ms
    }

    fn random(&self) -> f64 {
        self.random
    }

    fn sleep(&self, duration: Duration) -> SleepFuture<'_> {
        self.sleeps.lock().unwrap().push(duration.as_secs_f64() * 1000.0);
        if self.quit_on_next_wait.swap(false, Ordering::SeqCst) {
            self.quitting.store(true, Ordering::SeqCst);
        }
        Box::pin(std::future::ready(()))
    }
}

/// The access token the requests get; `None` for signed out.
#[derive(Clone)]
pub struct Token(pub Arc<Mutex<Option<String>>>);

impl Token {
    pub fn new(value: &str) -> Self {
        Self(Arc::new(Mutex::new(Some(value.to_owned()))))
    }

    pub fn set(&self, value: Option<&str>) {
        *self.0.lock().unwrap() = value.map(str::to_owned);
    }

    pub fn source(&self) -> impl Fn() -> Result<Option<String>, String> + Send + Sync + use<> {
        let token = Arc::clone(&self.0);
        move || Ok(token.lock().unwrap().clone())
    }
}

/// The in-memory Drive behind HTTP, with the log of the requests.
pub struct DriveServer {
    pub drive: InMemoryDrive,
    pub log: Mutex<Vec<Value>>,
    pub token: Token,
}

#[derive(Clone)]
pub struct ServerHandle(pub Arc<DriveServer>);

impl DriveServer {
    pub fn start(token: Token) -> ServerHandle {
        ServerHandle(Arc::new(Self { drive: InMemoryDrive::new(), log: Mutex::new(Vec::new()), token }))
    }
}

impl ServerHandle {
    /// An `HttpDrive` that sends to this server.
    pub fn http_drive(&self) -> HttpDrive<ServerHandle, impl Fn() -> Result<Option<String>, String> + use<>> {
        HttpDrive::new(self.clone(), self.0.token.source(), API, UPLOAD)
    }

    pub fn take_log(&self) -> Vec<Value> {
        std::mem::take(&mut *self.0.log.lock().unwrap())
    }
}

fn decode_component(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => out.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap();
                out.push(u8::from_str_radix(hex, 16).unwrap());
                index += 2;
            }
            byte => out.push(byte),
        }
        index += 1;
    }
    String::from_utf8(out).unwrap()
}

/// The query of `url` as decoded [name, value] pairs, in order.
pub fn query_pairs(url: &str) -> Vec<(String, String)> {
    let Some((_, query)) = url.split_once('?') else { return Vec::new() };
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
            (decode_component(name), decode_component(value))
        })
        .collect()
}

fn json_or_text(text: &str) -> Value {
    match serde_json::from_str::<Value>(text) {
        Ok(value) => json!({ "json": value }),
        Err(_) => json!({ "text": text }),
    }
}

fn header<'a>(request: &'a HttpRequest, name: &str) -> Option<&'a str> {
    request.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
}

/// The parts of a multipart body: (Content-Type, content).
pub fn multipart_parts(body: &str, boundary: &str) -> Vec<(String, String)> {
    let pieces: Vec<&str> = body.split(&format!("--{boundary}")).collect();
    assert!(pieces.len() >= 3 && pieces[0].is_empty() && pieces[pieces.len() - 1] == "--", "{body}");
    pieces[1..pieces.len() - 1]
        .iter()
        .map(|piece| {
            let split = piece.find("\r\n\r\n").unwrap();
            assert!(piece.starts_with("\r\n") && piece.ends_with("\r\n"), "{piece:?}");
            let content_type = piece[2..split]
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-type").then(|| value.trim_start().to_owned())
                })
                .unwrap_or_default();
            (content_type, piece[split + 4..piece.len() - 2].to_owned())
        })
        .collect()
}

fn boundary(content_type: &str) -> Option<&str> {
    content_type.split_once("boundary=").map(|(_, rest)| rest.split(';').next().unwrap_or(rest))
}

/// The log entry of `request`, in the shape of the recorded request log.
pub fn log_entry(request: &HttpRequest) -> Value {
    let method = request.method.as_str();
    let path = request.url.strip_prefix(ORIGIN).unwrap().split('?').next().unwrap();
    let mut query = query_pairs(&request.url);
    query.sort();
    let mut entry = json!({ "method": method, "path": path, "query": query });
    let content_type = header(request, "Content-Type");
    if let Some(content_type) = content_type {
        let bare =
            content_type.split_once(';').filter(|(_, rest)| rest.trim_start().starts_with("boundary="));
        entry["contentType"] = json!(bare.map_or(content_type, |(bare, _)| bare));
    }
    if let Some(body) = &request.body {
        let text = std::str::from_utf8(body).unwrap();
        entry["body"] = match content_type.and_then(boundary) {
            Some(boundary) => {
                let parts: Vec<Value> = multipart_parts(text, boundary)
                    .into_iter()
                    .map(|(content_type, content)| {
                        let mut part = json_or_text(&content);
                        part["contentType"] = json!(content_type);
                        part
                    })
                    .collect();
                json!({ "parts": parts })
            }
            None => json_or_text(text),
        };
    }
    entry
}

/// `name contains '…'` with `\'` for a quote.
fn name_contains(q: &str) -> String {
    let inner = q.strip_prefix("name contains '").and_then(|rest| rest.strip_suffix('\'')).unwrap();
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        out.push(if c == '\\' { chars.next().unwrap() } else { c });
    }
    out
}

pub fn file_json(file: &DriveFile) -> Value {
    let mut value = json!({ "id": file.id, "name": file.name, "modifiedTime": file.modified_time });
    if let Some(created) = &file.created_time {
        value["createdTime"] = json!(created);
    }
    value
}

fn ok(body: Value) -> HttpReply {
    HttpReply {
        status: 200,
        retry_after: None,
        content_type: Some("application/json".into()),
        body: body.to_string().into_bytes(),
    }
}

impl DriveServer {
    async fn answer(&self, request: HttpRequest) -> Result<HttpReply, DriveError> {
        let path = request.url.strip_prefix(ORIGIN).unwrap().split('?').next().unwrap().to_owned();
        let params = query_pairs(&request.url);
        let param = |name: &str| params.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone());
        let body = || String::from_utf8(request.body.clone().unwrap_or_default()).unwrap();
        let file_id = path
            .strip_prefix("/drive/v3/files/")
            .or_else(|| path.strip_prefix("/upload/drive/v3/files/"))
            .map(str::to_owned);
        let fields = param("fields");
        match (request.method, path.as_str(), file_id) {
            (Method::Get, "/drive/v3/files", None) => {
                assert_eq!(param("spaces").as_deref(), Some("appDataFolder"));
                assert_eq!(fields.as_deref(), Some(pipette_drive::http::LIST_FIELDS));
                let page = self
                    .drive
                    .list_page(ListQuery {
                        name_contains: param("q").map(|q| name_contains(&q)),
                        page_token: param("pageToken"),
                        page_size: param("pageSize").unwrap().parse().unwrap(),
                    })
                    .await?;
                let mut answer = json!({ "files": page.files.iter().map(file_json).collect::<Vec<_>>() });
                if let Some(token) = page.next_page_token {
                    answer["nextPageToken"] = json!(token);
                }
                Ok(ok(answer))
            }
            (Method::Get, _, Some(id)) if path.starts_with("/drive/") => {
                assert_eq!(param("alt").as_deref(), Some("media"));
                let content = self.drive.download(id).await?;
                Ok(HttpReply { status: 200, retry_after: None, content_type: None, body: content })
            }
            (Method::Post, "/upload/drive/v3/files", None) => {
                assert_eq!(param("uploadType").as_deref(), Some("multipart"));
                let content_type = header(&request, "Content-Type").unwrap();
                let parts = multipart_parts(&body(), boundary(content_type).unwrap());
                assert_eq!(parts.len(), 2);
                let metadata: Value = serde_json::from_str(&parts[0].1).unwrap();
                assert_eq!(metadata["parents"], json!(["appDataFolder"]));
                let name = metadata["name"].as_str().unwrap().to_owned();
                let content = parts[1].1.clone();
                match fields.as_deref() {
                    Some("id") => Ok(ok(json!({ "id": self.drive.create_raw(name, content).await? }))),
                    Some("id,modifiedTime") => {
                        let file = self.drive.create(name, content).await?;
                        Ok(ok(json!({ "id": file.id, "modifiedTime": file.modified_time })))
                    }
                    other => panic!("create fields {other:?}"),
                }
            }
            (Method::Patch, _, Some(id)) if path.starts_with("/upload/") => {
                assert_eq!(param("uploadType").as_deref(), Some("media"));
                assert_eq!(fields.as_deref(), Some("id,modifiedTime"));
                let file = self.drive.update(id, body()).await?;
                Ok(ok(json!({ "id": file.id, "modifiedTime": file.modified_time })))
            }
            (Method::Patch, _, Some(id)) => {
                assert_eq!(fields.as_deref(), Some("id,name,modifiedTime"));
                let name: Value = serde_json::from_str(&body()).unwrap();
                let file = self.drive.rename(id, name["name"].as_str().unwrap().to_owned()).await?;
                Ok(ok(json!({ "id": file.id, "name": file.name, "modifiedTime": file.modified_time })))
            }
            (Method::Delete, _, Some(id)) => {
                self.drive.delete(id).await?;
                Ok(HttpReply { status: 204, retry_after: None, content_type: None, body: Vec::new() })
            }
            other => panic!("unexpected request {other:?}"),
        }
    }
}

impl HttpRequester for ServerHandle {
    fn request(&self, request: HttpRequest) -> RequestFuture<'_> {
        Box::pin(async move {
            let expected = self.0.token.0.lock().unwrap().clone().map(|token| format!("Bearer {token}"));
            assert_eq!(header(&request, "Authorization").map(str::to_owned), expected);
            self.0.log.lock().unwrap().push(log_entry(&request));
            match self.0.answer(request).await {
                Ok(reply) => Ok(reply),
                Err(DriveError::Status { status, body, retry_after }) => {
                    Ok(HttpReply { status, retry_after, content_type: None, body: body.into_bytes() })
                }
                Err(DriveError::Network(message)) => Err(HttpError::Network(message)),
                Err(other) => panic!("the in-memory Drive answered {other:?}"),
            }
        })
    }
}
