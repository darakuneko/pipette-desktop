// SPDX-License-Identifier: GPL-2.0-or-later
//! The HTTP GET client: the [`HttpClient`] trait, the real client on
//! reqwest, and [`Http`], the shared handle the app manages.

use std::error::Error as _;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// A finished response. `ok()` is `Response.ok` of fetch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    /// The body of a successful (2xx) response. The real client does not
    /// read the body of any other response and leaves this empty: no caller
    /// uses it (src/main/download-util.ts and the Hub dataset fetchers stop
    /// at `!response.ok`).
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Why a request got no response. Each is a rejected `net.fetch` for the
/// Electron code these requests come from, except [`HttpError::TooLarge`],
/// which a byte size check there reports.
#[derive(Debug, thiserror::Error)]
pub enum HttpError {
    #[error("the request timed out")]
    Timeout,
    #[error("the response body is larger than {limit} bytes")]
    TooLarge { limit: u64 },
    /// Anything else: a bad URL, DNS, the connection, TLS, too many
    /// redirects. The message is reqwest's, with its causes.
    #[error("{0}")]
    Network(String),
}

pub type HttpFuture<'a> = Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + 'a>>;

/// GETs a URL. Run on the Tokio runtime (Tauri's async runtime).
pub trait HttpClient: Send + Sync {
    fn get_bytes<'a>(&'a self, url: &'a str) -> HttpFuture<'a>;
}

/// A closure answers at once, for the tests of the code that takes a
/// client.
impl<F: Fn(&str) -> Result<HttpResponse, HttpError> + Send + Sync> HttpClient for F {
    fn get_bytes<'a>(&'a self, url: &'a str) -> HttpFuture<'a> {
        Box::pin(std::future::ready(self(url)))
    }
}

/// The client the app manages: cheap to clone, any client behind it.
#[derive(Clone)]
pub struct Http(Arc<dyn HttpClient>);

impl Http {
    pub fn new(client: impl HttpClient + 'static) -> Self {
        Self(Arc::new(client))
    }
}

impl HttpClient for Http {
    fn get_bytes<'a>(&'a self, url: &'a str) -> HttpFuture<'a> {
        self.0.get_bytes(url)
    }
}

/// The bounds of every request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Until the connection (and the TLS handshake) is up.
    pub connect_timeout: Duration,
    /// From the start of the request until the whole body is in, redirects
    /// included.
    pub total_timeout: Duration,
    /// The largest body taken; a larger one is [`HttpError::TooLarge`]
    /// before more of it is read than this.
    pub max_body_bytes: u64,
}

impl Limits {
    /// 30 seconds to connect, 120 seconds in all, 64 MiB: well above the
    /// largest download (a word list or an Aozora Bunko archive of a few
    /// megabytes) on a slow line, and far below what would strain memory.
    pub const DEFAULT: Self = Self {
        connect_timeout: Duration::from_secs(30),
        total_timeout: Duration::from_secs(120),
        max_body_bytes: 64 * 1024 * 1024,
    };
}

/// The real client. reqwest follows up to 10 redirects, as fetch follows
/// 20, and reads the proxy from the environment (and from the system
/// settings on Windows and macOS). The reqwest client is built on the first
/// request, so the app's start does not pay for it.
pub struct ReqwestClient {
    limits: Limits,
    user_agent: String,
    client: OnceLock<reqwest::Client>,
}

impl ReqwestClient {
    pub fn new(limits: Limits, user_agent: impl Into<String>) -> Self {
        Self { limits, user_agent: user_agent.into(), client: OnceLock::new() }
    }

    fn client(&self) -> Result<&reqwest::Client, HttpError> {
        if let Some(client) = self.client.get() {
            return Ok(client);
        }
        // reqwest takes the process's default crypto provider. Installing
        // fails only when one is already installed, which is then used.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder()
            .user_agent(&self.user_agent)
            .connect_timeout(self.limits.connect_timeout)
            .timeout(self.limits.total_timeout)
            .build()
            .map_err(network_error)?;
        // A request racing this one may have set it first; either is fine.
        Ok(self.client.get_or_init(|| client))
    }

    async fn get(&self, url: &str) -> Result<HttpResponse, HttpError> {
        let mut response = self.client()?.get(url).send().await.map_err(request_error)?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            return Ok(HttpResponse { status, body: Vec::new() });
        }
        let limit = self.limits.max_body_bytes;
        let declared = response.content_length();
        if declared.is_some_and(|length| length > limit) {
            return Err(too_large(url, limit));
        }
        // Up to the declared length, never more than the limit up front.
        let mut body = Vec::with_capacity(usize::try_from(declared.unwrap_or(0)).unwrap_or(0));
        while let Some(chunk) = response.chunk().await.map_err(request_error)? {
            if (body.len() + chunk.len()) as u64 > limit {
                return Err(too_large(url, limit));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(HttpResponse { status, body })
    }
}

impl HttpClient for ReqwestClient {
    fn get_bytes<'a>(&'a self, url: &'a str) -> HttpFuture<'a> {
        Box::pin(async move {
            let result = self.get(url).await;
            if let Err(err @ HttpError::Timeout) = &result {
                log::warn!("GET {url}: {err} (after {:?} at most)", self.limits.total_timeout);
            }
            result
        })
    }
}

fn too_large(url: &str, limit: u64) -> HttpError {
    let err = HttpError::TooLarge { limit };
    log::warn!("GET {url}: {err}");
    err
}

fn request_error(err: reqwest::Error) -> HttpError {
    if err.is_timeout() { HttpError::Timeout } else { network_error(err) }
}

/// The error's message followed by each of its causes.
fn network_error(err: reqwest::Error) -> HttpError {
    let mut message = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    HttpError::Network(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<T>(future: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
    }

    #[test]
    fn ok_is_a_2xx_status() {
        let response = |status| HttpResponse { status, body: Vec::new() };
        assert!(response(200).ok());
        assert!(response(299).ok());
        assert!(!response(199).ok());
        assert!(!response(300).ok());
        assert!(!response(404).ok());
    }

    #[test]
    fn a_closure_answers_through_the_shared_handle() {
        let http = Http::new(|url: &str| match url {
            "https://a/" => Ok(HttpResponse { status: 200, body: b"a".to_vec() }),
            _ => Err(HttpError::Network(format!("no route to {url}"))),
        });
        let copy = http.clone();
        assert_eq!(block_on(copy.get_bytes("https://a/")).unwrap().body, b"a");
        assert_eq!(block_on(http.get_bytes("https://b/")).unwrap_err().to_string(), "no route to https://b/");
    }

    #[test]
    fn the_default_limits_are_30_seconds_to_connect_120_in_all_and_64_mib() {
        assert_eq!(Limits::DEFAULT.connect_timeout, Duration::from_secs(30));
        assert_eq!(Limits::DEFAULT.total_timeout, Duration::from_secs(120));
        assert_eq!(Limits::DEFAULT.max_body_bytes, 67_108_864);
    }

    #[test]
    fn a_network_error_carries_its_causes() {
        let client = ReqwestClient::new(Limits::DEFAULT, "pipette-test");
        let Err(HttpError::Network(message)) = block_on(client.get_bytes("http://[::1/")) else {
            panic!("an unparsable URL got through");
        };
        assert!(message.starts_with("builder error"), "{message}");
        assert!(message.contains(": "), "no cause in {message}");
    }
}
