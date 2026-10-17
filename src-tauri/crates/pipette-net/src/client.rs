// SPDX-License-Identifier: GPL-2.0-or-later
//! The HTTP client: the [`HttpClient`] trait of the GETs, the
//! [`HttpRequester`] trait of the requests with a method, headers and a
//! body, the real client on reqwest for both, and [`Http`], the shared
//! handle the app manages.

use std::error::Error as _;
use std::future::Future;
use std::net::{Ipv4Addr, Ipv6Addr};
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
    /// A client limited to the loopback interface
    /// ([`ReqwestClient::loopback_only`]) refused the destination of the
    /// request or of one of its redirects, before connecting to it.
    #[error("refused a request to {0}: only 127.0.0.1 and ::1 are allowed")]
    Refused(String),
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

/// The methods of [`HttpRequest`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl Method {
    /// The method's name on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Patch => "PATCH",
            Method::Delete => "DELETE",
        }
    }
}

/// A request with a method, headers and a body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    /// Sent in this order.
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

/// A finished response to an [`HttpRequest`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpReply {
    pub status: u16,
    /// The `Retry-After` header, when present and readable as text.
    pub retry_after: Option<String>,
    /// The `Content-Type` header, when present and readable as text.
    pub content_type: Option<String>,
    /// The whole body of a 2xx response (up to the client's limit, past
    /// which the request fails); of any other response, the first
    /// [`ERROR_BODY_LIMIT`] bytes, for its error message.
    pub body: Vec<u8>,
}

impl HttpReply {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// How much of the body of a response that is not 2xx is kept.
pub const ERROR_BODY_LIMIT: usize = 64 * 1024;

pub type RequestFuture<'a> = Pin<Box<dyn Future<Output = Result<HttpReply, HttpError>> + Send + 'a>>;

/// Sends a request with a method, headers and a body. Run on the Tokio
/// runtime.
pub trait HttpRequester: Send + Sync {
    fn request(&self, request: HttpRequest) -> RequestFuture<'_>;
}

/// A closure answers at once, for the tests of the code that takes a
/// requester.
impl<F: Fn(HttpRequest) -> Result<HttpReply, HttpError> + Send + Sync> HttpRequester for F {
    fn request(&self, request: HttpRequest) -> RequestFuture<'_> {
        Box::pin(std::future::ready(self(request)))
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
    /// The longest wait for the next bytes of the response: a server that
    /// stops sending fails here, however long the body has been coming in.
    pub read_timeout: Duration,
    /// From the start of the request until the whole body is in, redirects
    /// included: a safety net for a server that keeps trickling bytes.
    pub total_timeout: Duration,
    /// The largest body taken; a larger one is [`HttpError::TooLarge`]
    /// before more of it is read than this.
    pub max_body_bytes: u64,
}

impl Limits {
    /// 30 seconds to connect, 60 seconds without a byte, 30 minutes in all,
    /// 64 MiB. The largest word list of language-manifest.json is
    /// about 12.3 MB, which takes about 2 minutes at 0.8 Mbps and about 20
    /// minutes at 80 kbps; Electron's `net.fetch` has no time limit, so a
    /// slow line must not be what fails a download. 64 MiB stays far below
    /// what would strain memory.
    pub const DEFAULT: Self = Self {
        connect_timeout: Duration::from_secs(30),
        read_timeout: Duration::from_secs(60),
        total_timeout: Duration::from_secs(30 * 60),
        max_body_bytes: 64 * 1024 * 1024,
    };

    /// The Drive requests of the sync: 30 seconds to connect, 60 seconds
    /// without a byte, 10 minutes in all, 256 MiB. Electron's Drive
    /// requests have no time limit; a request that never ends would hold
    /// the sync lock, so it ends here and the next pass tries again. A
    /// sync file is a whole store or a keyboard's day, far below the size
    /// limit.
    pub const DRIVE: Self = Self {
        connect_timeout: Duration::from_secs(30),
        read_timeout: Duration::from_secs(60),
        total_timeout: Duration::from_secs(10 * 60),
        max_body_bytes: 256 * 1024 * 1024,
    };
}

/// The most of a body's declared length allocated up front; a larger body
/// grows the buffer as it arrives, so a false `Content-Length` does not
/// reserve memory for bytes that never come.
const MAX_INITIAL_CAPACITY: u64 = 8 * 1024 * 1024;

/// As many redirects as reqwest's default policy follows.
const MAX_REDIRECTS: usize = 10;

/// Where a client may send its requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Destinations {
    Any,
    /// 127.0.0.1 and ::1 only, written as IP addresses: no host name, so
    /// no lookup decides where a request goes.
    Loopback,
}

/// Whether `url` parses as a URL whose host is 127.0.0.1 or ::1, written
/// as an IP address (no host name, so no lookup decides where it goes).
pub fn is_loopback_url(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|parsed| is_loopback(&parsed))
}

/// Whether `url` is on 127.0.0.1 or ::1.
pub(crate) fn is_loopback(url: &reqwest::Url) -> bool {
    match url.host_str() {
        Some(host) => {
            host.parse::<Ipv4Addr>().is_ok_and(|ip| ip == Ipv4Addr::LOCALHOST)
                || host
                    .strip_prefix('[')
                    .and_then(|host| host.strip_suffix(']'))
                    .and_then(|host| host.parse::<Ipv6Addr>().ok())
                    .is_some_and(|ip| ip == Ipv6Addr::LOCALHOST)
        }
        None => false,
    }
}

/// Why a redirect from `previous` (the URLs requested so far, the first
/// one first) to `next` is not followed: too many hops, or a step down from
/// https to anything else, which would send the rest of the request in the
/// clear.
fn redirect_refusal(previous: &[reqwest::Url], next: &reqwest::Url) -> Option<&'static str> {
    // `previous` starts with the URL first requested, which is no redirect.
    if previous.len() > MAX_REDIRECTS {
        Some("too many redirects")
    } else if next.scheme() != "https" && previous.iter().any(|url| url.scheme() == "https") {
        Some("refused a redirect from https to a URL that is not https")
    } else {
        None
    }
}

/// The error of a redirect off the loopback interface, which the loopback
/// client refuses; [`ReqwestClient::request_error`] finds it in the error's
/// causes and reports [`HttpError::Refused`] with the host.
#[derive(Debug, thiserror::Error)]
#[error("refused a redirect to {0}")]
struct RedirectRefused(String);

/// Whether a body past the limit fails the request or is cut there.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Overflow {
    Fail,
    Truncate,
}

/// The real client. It follows up to 10 redirects (fetch follows 20) but
/// none from https to plain http, and reads the proxy from the environment
/// (and from the system settings on Windows and macOS). The reqwest client
/// is built on the first request, so the app's start does not pay for it.
pub struct ReqwestClient {
    limits: Limits,
    user_agent: String,
    destinations: Destinations,
    client: OnceLock<reqwest::Client>,
}

impl ReqwestClient {
    pub fn new(limits: Limits, user_agent: impl Into<String>) -> Self {
        Self {
            limits,
            user_agent: user_agent.into(),
            destinations: Destinations::Any,
            client: OnceLock::new(),
        }
    }

    /// A client that sends requests only to 127.0.0.1 and ::1, written as
    /// IP addresses, and refuses any other destination, of the request or
    /// of a redirect, before connecting to it. It uses no proxy. For the
    /// fake servers the tests point the sync at: nothing it sends can reach
    /// another machine.
    pub fn loopback_only(limits: Limits, user_agent: impl Into<String>) -> Self {
        Self { destinations: Destinations::Loopback, ..Self::new(limits, user_agent) }
    }

    /// Refuses `url` when this client may not send to it.
    fn check_destination(&self, url: &str) -> Result<(), HttpError> {
        if self.destinations == Destinations::Any {
            return Ok(());
        }
        match reqwest::Url::parse(url) {
            Ok(parsed) if is_loopback(&parsed) => Ok(()),
            Ok(parsed) => Err(HttpError::Refused(parsed.host_str().unwrap_or("").to_owned())),
            Err(_) => Err(HttpError::Refused(url.to_owned())),
        }
    }

    fn client(&self) -> Result<&reqwest::Client, HttpError> {
        if let Some(client) = self.client.get() {
            return Ok(client);
        }
        // reqwest takes the process's default crypto provider. Installing
        // fails only when one is already installed, which is then used.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let destinations = self.destinations;
        let mut builder = reqwest::Client::builder()
            .user_agent(&self.user_agent)
            .connect_timeout(self.limits.connect_timeout)
            .read_timeout(self.limits.read_timeout)
            .timeout(self.limits.total_timeout)
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if destinations == Destinations::Loopback && !is_loopback(attempt.url()) {
                    let host = attempt.url().host_str().unwrap_or("").to_owned();
                    return attempt.error(RedirectRefused(host));
                }
                match redirect_refusal(attempt.previous(), attempt.url()) {
                    Some(reason) => attempt.error(reason),
                    None => attempt.follow(),
                }
            }));
        if destinations == Destinations::Loopback {
            builder = builder.no_proxy();
        }
        let client = builder.build().map_err(network_error)?;
        // A request racing this one may have set it first; either is fine.
        Ok(self.client.get_or_init(|| client))
    }

    async fn get(&self, url: &str) -> Result<HttpResponse, HttpError> {
        self.check_destination(url)?;
        let mut response = self.client()?.get(url).send().await.map_err(|err| self.request_error(err))?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            return Ok(HttpResponse { status, body: Vec::new() });
        }
        let body = self.read_body(&mut response, self.limits.max_body_bytes, Overflow::Fail).await?;
        Ok(HttpResponse { status, body })
    }

    async fn send(&self, request: HttpRequest) -> Result<HttpReply, HttpError> {
        self.check_destination(&request.url)?;
        let method = match request.method {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
            Method::Put => reqwest::Method::PUT,
            Method::Patch => reqwest::Method::PATCH,
            Method::Delete => reqwest::Method::DELETE,
        };
        let mut builder = self.client()?.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        let mut response = builder.send().await.map_err(|err| self.request_error(err))?;
        let status = response.status().as_u16();
        let header =
            |name| response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_owned);
        let retry_after = header(reqwest::header::RETRY_AFTER);
        let content_type = header(reqwest::header::CONTENT_TYPE);
        let body = if response.status().is_success() {
            self.read_body(&mut response, self.limits.max_body_bytes, Overflow::Fail).await?
        } else {
            self.read_body(&mut response, ERROR_BODY_LIMIT as u64, Overflow::Truncate).await?
        };
        Ok(HttpReply { status, retry_after, content_type, body })
    }

    /// The body up to `limit` bytes: past it, [`HttpError::TooLarge`] or
    /// the first `limit` bytes, as `overflow` says, without reading more.
    async fn read_body(
        &self,
        response: &mut reqwest::Response,
        limit: u64,
        overflow: Overflow,
    ) -> Result<Vec<u8>, HttpError> {
        let declared = response.content_length();
        if overflow == Overflow::Fail && declared.is_some_and(|length| length > limit) {
            return Err(HttpError::TooLarge { limit });
        }
        let capacity = declared.unwrap_or(0).min(limit).min(MAX_INITIAL_CAPACITY);
        let mut body = Vec::with_capacity(usize::try_from(capacity).unwrap_or(0));
        while let Some(chunk) = response.chunk().await.map_err(|err| self.request_error(err))? {
            if (body.len() + chunk.len()) as u64 > limit {
                if overflow == Overflow::Fail {
                    return Err(HttpError::TooLarge { limit });
                }
                let room = usize::try_from(limit).unwrap_or(usize::MAX) - body.len();
                body.extend_from_slice(&chunk[..room]);
                break;
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }

    fn request_error(&self, err: reqwest::Error) -> HttpError {
        if err.is_timeout() {
            return HttpError::Timeout;
        }
        if self.destinations == Destinations::Loopback && err.is_redirect() {
            let mut source = err.source();
            while let Some(cause) = source {
                if let Some(RedirectRefused(host)) = cause.downcast_ref::<RedirectRefused>() {
                    return HttpError::Refused(host.clone());
                }
                source = cause.source();
            }
        }
        network_error(err)
    }
}

impl HttpClient for ReqwestClient {
    fn get_bytes<'a>(&'a self, url: &'a str) -> HttpFuture<'a> {
        Box::pin(async move {
            let result = self.get(url).await;
            if let Err(err @ (HttpError::Timeout | HttpError::TooLarge { .. } | HttpError::Refused(_))) =
                &result
            {
                log::warn!("GET {url}: {err}");
            }
            result
        })
    }
}

impl HttpRequester for ReqwestClient {
    fn request(&self, request: HttpRequest) -> RequestFuture<'_> {
        Box::pin(async move {
            // The path only: a query may carry a token.
            let target = request.url.split('?').next().unwrap_or("").to_owned();
            let method = request.method;
            let result = self.send(request).await;
            if let Err(err @ (HttpError::Timeout | HttpError::TooLarge { .. } | HttpError::Refused(_))) =
                &result
            {
                log::warn!("{method:?} {target}: {err}");
            }
            result
        })
    }
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
    fn the_default_limits_are_30_s_to_connect_60_s_idle_30_min_in_all_and_64_mib() {
        assert_eq!(Limits::DEFAULT.connect_timeout, Duration::from_secs(30));
        assert_eq!(Limits::DEFAULT.read_timeout, Duration::from_secs(60));
        assert_eq!(Limits::DEFAULT.total_timeout, Duration::from_secs(1800));
        assert_eq!(Limits::DEFAULT.max_body_bytes, 67_108_864);
    }

    #[test]
    fn the_drive_limits_are_30_s_to_connect_60_s_idle_10_min_in_all_and_256_mib() {
        assert_eq!(Limits::DRIVE.connect_timeout, Duration::from_secs(30));
        assert_eq!(Limits::DRIVE.read_timeout, Duration::from_secs(60));
        assert_eq!(Limits::DRIVE.total_timeout, Duration::from_secs(600));
        assert_eq!(Limits::DRIVE.max_body_bytes, 268_435_456);
    }

    #[test]
    fn loopback_is_127_0_0_1_and_ipv6_loopback_only() {
        let url = |u: &str| reqwest::Url::parse(u).unwrap();
        assert!(is_loopback(&url("http://127.0.0.1:8080/a")));
        assert!(is_loopback(&url("https://[::1]/a")));
        // The URL parser writes these as 127.0.0.1.
        assert!(is_loopback(&url("http://127.1/")));
        assert!(is_loopback(&url("http://2130706433/")));
        for other in [
            "http://localhost/",
            "http://127.0.0.2/",
            "http://[::2]/",
            "https://www.googleapis.com/",
            "file:///tmp/x",
        ] {
            assert!(!is_loopback(&url(other)), "{other}");
            assert!(!is_loopback_url(other), "{other}");
        }
        assert!(is_loopback_url("http://127.0.0.1:9"));
        assert!(is_loopback_url("https://[::1]/a"));
        assert!(!is_loopback_url("not a url"));
        assert!(!is_loopback_url(""));
    }

    #[test]
    fn refuses_redirects_down_from_https_and_past_ten_hops() {
        let url = |u: &str| reqwest::Url::parse(u).unwrap();
        let https = url("https://a/x");
        let http = url("http://a/x");
        assert_eq!(redirect_refusal(std::slice::from_ref(&https), &url("https://b/y")), None);
        assert_eq!(redirect_refusal(std::slice::from_ref(&http), &url("http://b/y")), None);
        assert_eq!(redirect_refusal(std::slice::from_ref(&http), &url("https://b/y")), None);
        assert!(redirect_refusal(std::slice::from_ref(&https), &url("http://b/y")).is_some());
        // Down from an https hop after a plain start, too.
        assert!(redirect_refusal(&[http.clone(), https.clone()], &url("http://b/y")).is_some());

        // The first request and 9 redirects, then the 10th and the 11th.
        assert_eq!(redirect_refusal(&vec![http.clone(); 10], &http), None);
        assert_eq!(redirect_refusal(&vec![http.clone(); 11], &http), Some("too many redirects"));
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
