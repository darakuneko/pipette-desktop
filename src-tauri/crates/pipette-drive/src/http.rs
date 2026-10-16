// SPDX-License-Identifier: GPL-2.0-or-later
//! [`HttpDrive`]: one attempt of each Drive operation as an HTTP request,
//! the same requests src/main/sync/google-drive.ts sends (method, path,
//! query, headers, body). The access token is asked for before every
//! attempt, so a refreshed one is picked up by the next.

use std::future::Future;
use std::pin::Pin;

use pipette_net::{
    GoogleEndpoints, HttpError, HttpReply, HttpRequest, HttpRequester, Limits, Method, ReqwestClient,
};
use serde::Deserialize;

use crate::{DriveApi, DriveError, DriveFile, DriveFuture, FileList, ListQuery, UploadedFile};

/// The `fields` of a listing.
pub const LIST_FIELDS: &str = "nextPageToken, files(id, name, modifiedTime, createdTime)";
/// The boundary of the multipart create; the content of a sync file is
/// JSON, which never has a line that starts with it.
const BOUNDARY: &str = "---pipette-sync-boundary";
const NOT_AUTHENTICATED: &str = "Not authenticated with Google Drive";

pub type TokenFuture<'a> = Pin<Box<dyn Future<Output = Result<Option<String>, String>> + Send + 'a>>;

/// The access token of the signed-in account (`getAccessToken` of
/// google-auth.ts): `None` when no one is signed in, an error message
/// when the token could not be had.
pub trait AccessTokenSource: Send + Sync {
    fn access_token(&self) -> TokenFuture<'_>;
}

/// A closure answers at once, for the tests.
impl<F: Fn() -> Result<Option<String>, String> + Send + Sync> AccessTokenSource for F {
    fn access_token(&self) -> TokenFuture<'_> {
        Box::pin(std::future::ready(self()))
    }
}

/// The Drive API over HTTP.
pub struct HttpDrive<R, T> {
    requester: R,
    tokens: T,
    /// `DRIVE_API` of google-drive.ts, without a trailing slash.
    api: String,
    /// `UPLOAD_API` of google-drive.ts, without a trailing slash.
    upload: String,
}

impl<T: AccessTokenSource> HttpDrive<ReqwestClient, T> {
    /// The client for `endpoints` with the Drive limits: 30 s to connect,
    /// 60 s without data and 10 minutes for the whole request, so a
    /// stalled request does not hold the sync lock for ever; it fails as a
    /// request without an answer and is retried like one.
    pub fn for_endpoints(endpoints: &GoogleEndpoints, tokens: T, user_agent: impl Into<String>) -> Self {
        Self::new(
            endpoints.client(Limits::DRIVE, user_agent),
            tokens,
            endpoints.drive_api.clone(),
            endpoints.drive_upload.clone(),
        )
    }
}

impl<R: HttpRequester, T: AccessTokenSource> HttpDrive<R, T> {
    pub fn new(requester: R, tokens: T, api: impl Into<String>, upload: impl Into<String>) -> Self {
        Self { requester, tokens, api: api.into(), upload: upload.into() }
    }

    /// Sends one request with the access token; a reply that is not 2xx is
    /// a [`DriveError::Status`].
    async fn send(
        &self,
        method: Method,
        url: String,
        content_type: Option<&str>,
        body: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, DriveError> {
        let token = match self.tokens.access_token().await {
            Ok(Some(token)) => token,
            Ok(None) => return Err(DriveError::Auth(NOT_AUTHENTICATED.to_owned())),
            Err(message) => return Err(DriveError::Auth(message)),
        };
        let mut headers = vec![("Authorization".to_owned(), format!("Bearer {token}"))];
        if let Some(content_type) = content_type {
            headers.push(("Content-Type".to_owned(), content_type.to_owned()));
        }
        let reply =
            self.requester.request(HttpRequest { method, url, headers, body }).await.map_err(network)?;
        into_body(reply)
    }

    async fn create_file(&self, name: String, content: String, fields: &str) -> Result<Vec<u8>, DriveError> {
        let url = format!("{}/files?uploadType=multipart&fields={fields}", self.upload);
        let content_type = format!("multipart/related; boundary={BOUNDARY}");
        let body = multipart_body(&name, &content);
        self.send(Method::Post, url, Some(&content_type), Some(body.into_bytes())).await
    }
}

/// A timeout or a failed connection may pass on the next attempt; an
/// answer over the size limit or a refused destination will not.
fn network(err: HttpError) -> DriveError {
    match err {
        HttpError::TooLarge { .. } | HttpError::Refused(_) => DriveError::Rejected(err.to_string()),
        HttpError::Timeout | HttpError::Network(_) => DriveError::Network(err.to_string()),
    }
}

fn into_body(reply: HttpReply) -> Result<Vec<u8>, DriveError> {
    if reply.ok() {
        return Ok(reply.body);
    }
    Err(DriveError::Status {
        status: reply.status,
        body: String::from_utf8_lossy(&reply.body).into_owned(),
        retry_after: reply.retry_after,
    })
}

/// The metadata part (the name in appDataFolder) and the content part of a
/// create, as google-drive.ts writes them.
fn multipart_body(name: &str, content: &str) -> String {
    let metadata = serde_json::json!({ "name": name, "parents": ["appDataFolder"] });
    [
        &format!("--{BOUNDARY}"),
        "Content-Type: application/json; charset=UTF-8",
        "",
        &metadata.to_string(),
        &format!("--{BOUNDARY}"),
        "Content-Type: application/json",
        "",
        content,
        &format!("--{BOUNDARY}--"),
    ]
    .join("\r\n")
}

/// `application/x-www-form-urlencoded` as `URLSearchParams` writes it.
fn form_encode(pairs: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (index, (key, value)) in pairs.iter().enumerate() {
        if index > 0 {
            out.push('&');
        }
        encode_component(&mut out, key);
        out.push('=');
        encode_component(&mut out, value);
    }
    out
}

fn encode_component(out: &mut String, text: &str) {
    for byte in text.bytes() {
        match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => out.push(char::from(byte)),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
}

fn parse<'a, T: Deserialize<'a>>(body: &'a [u8]) -> Result<T, DriveError> {
    serde_json::from_slice(body).map_err(|err| DriveError::BadResponse(err.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileJson {
    id: String,
    name: String,
    modified_time: String,
    created_time: Option<String>,
}

impl From<FileJson> for DriveFile {
    fn from(file: FileJson) -> Self {
        Self {
            id: file.id,
            name: file.name,
            modified_time: file.modified_time,
            created_time: file.created_time,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListJson {
    #[serde(default)]
    files: Vec<FileJson>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadedJson {
    id: String,
    modified_time: String,
}

impl From<UploadedJson> for UploadedFile {
    fn from(file: UploadedJson) -> Self {
        Self { id: file.id, modified_time: file.modified_time }
    }
}

#[derive(Deserialize)]
struct IdJson {
    id: String,
}

impl<R: HttpRequester, T: AccessTokenSource> DriveApi for HttpDrive<R, T> {
    fn list_page(&self, query: ListQuery) -> DriveFuture<'_, FileList> {
        Box::pin(async move {
            let page_size = query.page_size.to_string();
            let mut params =
                vec![("spaces", "appDataFolder"), ("fields", LIST_FIELDS), ("pageSize", &page_size)];
            // Drive's query language: the value in single quotes, a quote in
            // it escaped with a backslash. An empty filter lists everything.
            let filter = query
                .name_contains
                .as_deref()
                .filter(|part| !part.is_empty())
                .map(|part| format!("name contains '{}'", part.replace('\'', "\\'")));
            if let Some(filter) = &filter {
                params.push(("q", filter));
            }
            if let Some(token) = query.page_token.as_deref().filter(|token| !token.is_empty()) {
                params.push(("pageToken", token));
            }
            let url = format!("{}/files?{}", self.api, form_encode(&params));
            let body = self.send(Method::Get, url, None, None).await?;
            let list: ListJson = parse(&body)?;
            Ok(FileList {
                files: list.files.into_iter().map(DriveFile::from).collect(),
                next_page_token: list.next_page_token.filter(|token| !token.is_empty()),
            })
        })
    }

    fn download(&self, id: String) -> DriveFuture<'_, Vec<u8>> {
        Box::pin(async move {
            let url = format!("{}/files/{id}?{}", self.api, form_encode(&[("alt", "media")]));
            self.send(Method::Get, url, None, None).await
        })
    }

    fn create(&self, name: String, content: String) -> DriveFuture<'_, UploadedFile> {
        Box::pin(async move {
            let body = self.create_file(name, content, "id,modifiedTime").await?;
            Ok(parse::<UploadedJson>(&body)?.into())
        })
    }

    fn create_raw(&self, name: String, content: String) -> DriveFuture<'_, String> {
        Box::pin(async move {
            let body = self.create_file(name, content, "id").await?;
            Ok(parse::<IdJson>(&body)?.id)
        })
    }

    fn update(&self, id: String, content: String) -> DriveFuture<'_, UploadedFile> {
        Box::pin(async move {
            // `fields` is asked for: the default answer to a media upload
            // has no modifiedTime.
            let url = format!("{}/files/{id}?uploadType=media&fields=id,modifiedTime", self.upload);
            let body =
                self.send(Method::Patch, url, Some("application/json"), Some(content.into_bytes())).await?;
            Ok(parse::<UploadedJson>(&body)?.into())
        })
    }

    fn rename(&self, id: String, name: String) -> DriveFuture<'_, DriveFile> {
        Box::pin(async move {
            let url = format!("{}/files/{id}?fields=id,name,modifiedTime", self.api);
            let body = serde_json::json!({ "name": name }).to_string().into_bytes();
            let answer = self.send(Method::Patch, url, Some("application/json"), Some(body)).await?;
            Ok(parse::<FileJson>(&answer)?.into())
        })
    }

    fn delete(&self, id: String) -> DriveFuture<'_, ()> {
        Box::pin(async move {
            self.send(Method::Delete, format!("{}/files/{id}", self.api), None, None).await?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_a_query_as_url_search_params_does() {
        assert_eq!(
            form_encode(&[("fields", LIST_FIELDS), ("q", "name contains 'a\\'b'")]),
            "fields=nextPageToken%2C+files%28id%2C+name%2C+modifiedTime%2C+createdTime%29\
             &q=name+contains+%27a%5C%27b%27"
        );
        assert_eq!(form_encode(&[("x", "~é*-._")]), "x=%7E%C3%A9*-._");
    }

    #[test]
    fn writes_the_multipart_body_of_google_drive_ts() {
        assert_eq!(
            multipart_body("a.enc", "{\"v\":1}"),
            "-----pipette-sync-boundary\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n\
             {\"name\":\"a.enc\",\"parents\":[\"appDataFolder\"]}\r\n-----pipette-sync-boundary\r\n\
             Content-Type: application/json\r\n\r\n{\"v\":1}\r\n-----pipette-sync-boundary--"
        );
    }
}
