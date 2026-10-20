// SPDX-License-Identifier: GPL-2.0-or-later
//! The loopback redirect of the sign-in: a listener on 127.0.0.1 that
//! waits for the browser to come back with the authorization code.
//!
//! Each connection gets [`READ_TIMEOUT`] to send its request head, at most
//! [`MAX_HEAD_BYTES`]; only the request line is read. The first request
//! whose `state` matches and that carries a `code` or an `error` is taken
//! and answered with a page for the browser; every other request is
//! answered 400 and the wait goes on. A request with an `error` must carry
//! the state too, so an unrelated request cannot end the sign-in. The
//! listener closes once a request is taken.

use std::net::Ipv4Addr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use zeroize::Zeroizing;

/// How long a connection may take to send its request head, and to take
/// the answer.
pub const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// The largest request head read.
pub const MAX_HEAD_BYTES: usize = 8 * 1024;

const SUCCESS_PAGE: &str =
    "<html><body><h1>Authorization successful</h1><p>You can close this window.</p></body></html>";
const FAILURE_PAGE: &str =
    "<html><body><h1>Authorization failed</h1><p>You can close this window.</p></body></html>";
const INVALID_PAGE: &str = "<html><body><h1>Invalid request</h1></body></html>";

/// What the browser came back with.
#[derive(Debug, PartialEq, Eq)]
pub enum Callback {
    Code(Zeroizing<String>),
    /// The `error` parameter.
    Error(String),
}

/// A listener on 127.0.0.1 on a free port.
pub struct Loopback {
    listener: TcpListener,
    port: u16,
}

impl Loopback {
    pub async fn bind() -> std::io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let port = listener.local_addr()?.port();
        Ok(Self { listener, port })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Serves the redirect until a request carries `expected_state` with a
    /// code or an error, which it returns; the listener closes then.
    pub async fn wait(self, expected_state: &str) -> Callback {
        self.wait_with(expected_state, READ_TIMEOUT).await
    }

    /// [`Loopback::wait`] with another per-connection time limit.
    pub async fn wait_with(self, expected_state: &str, read_timeout: Duration) -> Callback {
        let (sender, mut taken) = mpsc::channel::<Callback>(1);
        let claimed = Arc::new(AtomicBool::new(false));
        let expected: Arc<str> = Arc::from(expected_state);
        loop {
            tokio::select! {
                biased;
                Some(callback) = taken.recv() => return callback,
                accepted = self.listener.accept() => match accepted {
                    Ok((stream, _)) => {
                        let connection = Connection {
                            expected: Arc::clone(&expected),
                            claimed: Arc::clone(&claimed),
                            sender: sender.clone(),
                            read_timeout,
                        };
                        tokio::spawn(connection.serve(stream));
                    }
                    Err(err) => {
                        // Out of file descriptors and the like: wait a moment
                        // rather than spin.
                        log::warn!("[google-auth] the loopback listener could not accept: {err}");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                },
            }
        }
    }
}

struct Connection {
    expected: Arc<str>,
    claimed: Arc<AtomicBool>,
    sender: mpsc::Sender<Callback>,
    read_timeout: Duration,
}

impl Connection {
    async fn serve(self, mut stream: TcpStream) {
        let head = match tokio::time::timeout(self.read_timeout, read_head(&mut stream)).await {
            Ok(Ok(head)) => head,
            // Silent, or gone: nothing to answer.
            Ok(Err(_)) | Err(_) => return,
        };
        let callback = head.and_then(|head| take(&head, &self.expected));
        let page = match callback {
            Some(callback) if !self.claimed.swap(true, Ordering::SeqCst) => {
                let page = if matches!(callback, Callback::Code(_)) { SUCCESS_PAGE } else { FAILURE_PAGE };
                // The flow goes on as soon as the request is taken; the page
                // is written after.
                let _ = self.sender.send(callback).await;
                (200, page)
            }
            _ => (400, INVALID_PAGE),
        };
        let _ = tokio::time::timeout(self.read_timeout, respond(&mut stream, page)).await;
    }
}

/// The request head, up to the empty line; `None` for one past
/// [`MAX_HEAD_BYTES`] or one cut off before its request line ended.
async fn read_head(stream: &mut TcpStream) -> std::io::Result<Option<Vec<u8>>> {
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(head.windows(2).any(|pair| pair == b"\r\n").then_some(head));
        }
        head.extend_from_slice(&chunk[..read]);
        if head.len() > MAX_HEAD_BYTES {
            return Ok(None);
        }
        if head.windows(4).any(|window| window == b"\r\n\r\n") {
            return Ok(Some(head));
        }
    }
}

/// The callback `head` carries for `expected_state`, if any.
fn take(head: &[u8], expected_state: &str) -> Option<Callback> {
    let line = head.split(|&byte| byte == b'\n').next()?;
    let line = std::str::from_utf8(line).ok()?.trim_end_matches('\r');
    let target = line.split(' ').nth(1)?;
    let query = target.split_once('?').map_or("", |(_, query)| query);
    let query = query.split_once('#').map_or(query, |(query, _)| query);
    let first = |name: &str| {
        form_urlencoded::parse(query.as_bytes())
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    let state = first("state")?;
    if !constant_time_eq(state.as_bytes(), expected_state.as_bytes()) {
        return None;
    }
    if let Some(error) = first("error").filter(|error| !error.is_empty()) {
        return Some(Callback::Error(error));
    }
    first("code").filter(|code| !code.is_empty()).map(|code| Callback::Code(Zeroizing::new(code)))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |diff, (x, y)| diff | (x ^ y)) == 0
}

async fn respond(stream: &mut TcpStream, (status, page): (u16, &str)) -> std::io::Result<()> {
    let reason = if status == 200 { "OK" } else { "Bad Request" };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    stream.write_all(response.as_bytes()).await?;
    stream.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head(target: &str) -> Vec<u8> {
        format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").into_bytes()
    }

    fn code(text: &str) -> Option<Callback> {
        Some(Callback::Code(Zeroizing::new(text.to_owned())))
    }

    #[test]
    fn takes_a_code_with_the_expected_state() {
        assert_eq!(take(&head("/?code=abc&state=s1"), "s1"), code("abc"));
        assert_eq!(take(&head("/?state=s1&code=a%2Fb+c"), "s1"), code("a/b c"));
        assert_eq!(take(&head("/?code=first&code=second&state=s1"), "s1"), code("first"));
        assert_eq!(take(&head("/callback?code=abc&state=s1#frag"), "s1"), code("abc"));
    }

    #[test]
    fn refuses_a_wrong_or_missing_state() {
        assert_eq!(take(&head("/?code=abc&state=s2"), "s1"), None);
        assert_eq!(take(&head("/?code=abc"), "s1"), None);
        assert_eq!(take(&head("/?code=abc&state="), "s1"), None);
        assert_eq!(take(&head("/?code=abc&state=s1x"), "s1"), None);
    }

    #[test]
    fn takes_an_error_only_with_the_expected_state() {
        assert_eq!(
            take(&head("/?error=access_denied&state=s1"), "s1"),
            Some(Callback::Error("access_denied".into()))
        );
        // An error without the expected state is refused.
        assert_eq!(take(&head("/?error=access_denied"), "s1"), None);
        assert_eq!(take(&head("/?error=access_denied&state=other"), "s1"), None);
        // An error wins over a code.
        assert_eq!(take(&head("/?code=abc&error=x&state=s1"), "s1"), Some(Callback::Error("x".into())));
    }

    #[test]
    fn refuses_a_request_without_a_code() {
        assert_eq!(take(&head("/?state=s1"), "s1"), None);
        assert_eq!(take(&head("/?code=&state=s1"), "s1"), None);
        assert_eq!(take(&head("/?error=&state=s1"), "s1"), None);
        assert_eq!(take(&head("/favicon.ico"), "s1"), None);
        assert_eq!(take(b"garbage", "s1"), None);
        assert_eq!(take(b"\xff\xfe /?code=a&state=s1 HTTP/1.1\r\n\r\n", "s1"), None);
    }
}
