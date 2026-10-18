// SPDX-License-Identifier: GPL-2.0-or-later
//! The fetch over a requester: the time limit, a failed request, and the
//! real client against servers on 127.0.0.1 (a notice server, and one that
//! redirects off the loopback interface). Nothing here leaves the machine.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use pipette_net::{HttpError, HttpReply, HttpRequest, RequestFuture};

use super::*;

/// A requester that never answers.
struct Silent;

impl HttpRequester for Silent {
    fn request(&self, _request: HttpRequest) -> RequestFuture<'_> {
        Box::pin(std::future::pending())
    }
}

#[tokio::test(start_paused = true)]
async fn the_fetch_ends_after_ten_seconds() {
    let started = tokio::time::Instant::now();
    let result = fetch_notifications(&Silent, NOTIFICATION_ENDPOINT, 0).await;
    assert_eq!(result, NotificationFetchResult::failed(TIMED_OUT));
    assert_eq!(started.elapsed(), FETCH_TIMEOUT);
}

#[tokio::test]
async fn a_failed_request_is_a_failed_fetch() {
    let offline =
        |_: HttpRequest| -> Result<HttpReply, HttpError> { Err(HttpError::Network("offline".to_owned())) };
    let result = fetch_notifications(&offline, NOTIFICATION_ENDPOINT, 0).await;
    assert_eq!(result, NotificationFetchResult::failed("offline"));
}

#[tokio::test]
async fn posts_the_query_to_the_url_and_reads_the_answer() {
    let seen = Arc::new(Mutex::new(None));
    let requester = {
        let seen = Arc::clone(&seen);
        move |request: HttpRequest| -> Result<HttpReply, HttpError> {
            *seen.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(request);
            Ok(HttpReply {
                status: 200,
                retry_after: None,
                content_type: Some("application/json".to_owned()),
                body: br#"{"notifications":[]}"#.to_vec(),
            })
        }
    };
    let result = fetch_notifications(&requester, "http://127.0.0.1:9", 1_792_281_600_000).await;
    assert_eq!(result, NotificationFetchResult::fetched(vec![]));
    let request = seen.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
    assert_eq!(request.map(|request| request.body), Some(Some(request_body(1_792_281_600_000).into_bytes())));
}

/// What a one-shot server on 127.0.0.1 received: the request line, the
/// headers (names in lowercase) and the body.
#[derive(Debug, Default)]
struct Received {
    request_line: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

/// Serves one request on 127.0.0.1 with `response` (a whole HTTP/1.1
/// response) and hands back what it received. Gives up after 10 seconds
/// without a connection.
fn serve_once(response: String) -> (String, JoinHandle<Received>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap_or_else(|err| panic!("bind: {err}"));
    let url = format!("http://{}/", listener.local_addr().unwrap_or_else(|err| panic!("address: {err}")));
    listener.set_nonblocking(true).unwrap_or_else(|err| panic!("nonblocking: {err}"));
    let handle = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(err)
                    if err.kind() == std::io::ErrorKind::WouldBlock
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(err) => panic!("accept: {err}"),
            }
        };
        stream.set_nonblocking(false).unwrap_or_else(|err| panic!("blocking: {err}"));
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap_or_else(|err| panic!("timeout: {err}"));
        let mut reader = BufReader::new(stream);
        let mut received = Received::default();
        reader.read_line(&mut received.request_line).unwrap_or_else(|err| panic!("read: {err}"));
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap_or_else(|err| panic!("read: {err}"));
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                received.headers.push((name.to_ascii_lowercase(), value.trim().to_owned()));
            }
        }
        let length = received
            .headers
            .iter()
            .find(|(name, _)| name == "content-length")
            .and_then(|(_, value)| value.parse().ok())
            .unwrap_or(0);
        received.body = vec![0; length];
        reader.read_exact(&mut received.body).unwrap_or_else(|err| panic!("read body: {err}"));
        reader.get_mut().write_all(response.as_bytes()).unwrap_or_else(|err| panic!("write: {err}"));
        received
    });
    (url, handle)
}

/// The override of a build with the development tools.
fn overridden(url: &str) -> NoticeDestination {
    let destination =
        NoticeDestination::resolve(true, &|name| (name == NOTIFICATION_URL_ENV).then(|| url.to_owned()));
    assert!(destination.overridden);
    destination
}

#[tokio::test]
async fn the_real_client_posts_the_query_to_a_loopback_override() {
    let body = r#"{"notifications":[{"title":"T","body":"B","type":"info","publishedAt":"2026-10-17T09:00:00.000Z"}]}"#;
    let (url, server) = serve_once(format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    ));
    let destination = overridden(&url);
    let result = fetch_notifications(&*destination.requester("pipette-test"), &destination.url, 5).await;
    assert_eq!(
        result,
        NotificationFetchResult::fetched(vec![AppNotification {
            title: "T".to_owned(),
            body: "B".to_owned(),
            kind: "info".to_owned(),
            published_at: "2026-10-17T09:00:00.000Z".to_owned(),
        }])
    );
    let received = server.join().unwrap_or_else(|_| panic!("the server panicked"));
    assert_eq!(received.request_line.trim_end(), "POST / HTTP/1.1");
    assert!(received.headers.contains(&("content-type".to_owned(), "application/json".to_owned())));
    assert_eq!(received.body, request_body(5).into_bytes());
}

#[tokio::test]
async fn a_loopback_override_does_not_follow_a_redirect_off_the_loopback_interface() {
    // 192.0.2.1 is TEST-NET-1: never routed, and refused before any
    // connection is tried.
    let (url, server) = serve_once(
        "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://192.0.2.1/notices\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .to_owned(),
    );
    let destination = overridden(&url);
    let requester = destination.requester("pipette-test");
    let reply = requester.request(notice_request(&destination.url, 0)).await;
    assert!(matches!(&reply, Err(HttpError::Refused(host)) if host == "192.0.2.1"), "{reply:?}");
    server.join().unwrap_or_else(|_| panic!("the server panicked"));
    let result = fetch_notifications(&*requester, &destination.url, 0).await;
    assert!(!result.success);
}

#[tokio::test]
async fn an_override_off_the_loopback_interface_is_refused_before_connecting() {
    for url in ["http://192.0.2.1/", "https://example.invalid/", "http://localhost:9/"] {
        let destination = overridden(url);
        let reply = destination.requester("pipette-test").request(notice_request(&destination.url, 0)).await;
        assert!(matches!(reply, Err(HttpError::Refused(_))), "{url}: {reply:?}");
    }
}
