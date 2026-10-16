// SPDX-License-Identifier: GPL-2.0-or-later
//! Requests with a method, headers and a body against a server on the
//! loopback interface, and the client limited to the loopback interface,
//! which refuses every other destination before connecting. Nothing here
//! leaves the machine: the requests to other hosts are refused before any
//! lookup or connection.

#![allow(clippy::unwrap_used)]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

use pipette_net::{
    ERROR_BODY_LIMIT, HttpClient, HttpError, HttpReply, HttpRequest, HttpRequester, Limits, Method,
    ReqwestClient,
};

/// A request as the server read it.
struct Seen {
    method: String,
    path: String,
    head: String,
    body: Vec<u8>,
}

/// The raw response to a request.
type Respond = fn(&Seen) -> Vec<u8>;

fn serve_on(listener: TcpListener, respond: Respond) -> String {
    let addr = listener.local_addr().unwrap();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            thread::spawn(move || answer(stream, respond));
        }
    });
    if addr.is_ipv6() { format!("http://[{}]:{}", addr.ip(), addr.port()) } else { format!("http://{addr}") }
}

fn serve(respond: Respond) -> String {
    serve_on(TcpListener::bind("127.0.0.1:0").unwrap(), respond)
}

fn answer(mut stream: TcpStream, respond: Respond) {
    let mut head = Vec::new();
    let mut byte = [0u8];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).unwrap_or(0) == 0 {
            return;
        }
        head.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    let length = header(&head, "content-length").and_then(|value| value.parse::<usize>().ok()).unwrap_or(0);
    let mut body = vec![0; length];
    if stream.read_exact(&mut body).is_err() {
        return;
    }
    let mut words = head.split(' ');
    let method = words.next().unwrap_or("").to_owned();
    let path = words.next().unwrap_or("").to_owned();
    let reply = respond(&Seen { method, path, head, body });
    let _ = stream.write_all(&reply).and_then(|()| stream.flush());
}

/// The value of the header `name` in a request head.
fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

fn response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
    let mut out =
        format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Length: {}\r\n{headers}\r\n", body.len())
            .into_bytes();
    out.extend_from_slice(body);
    out
}

fn routes(seen: &Seen) -> Vec<u8> {
    match seen.path.as_str() {
        "/echo" => {
            let header = header(&seen.head, "x-test").unwrap_or("");
            let mut body = format!("{} {} {header} ", seen.method, seen.path).into_bytes();
            body.extend_from_slice(&seen.body);
            response("201 Created", "Content-Type: text/plain\r\n", &body)
        }
        "/limited" => response(
            "429 Too Many Requests",
            "Retry-After: 7\r\nContent-Type: application/json\r\n",
            b"{\"error\":1}",
        ),
        "/missing" => response("404 Not Found", "", b"not here"),
        "/huge-error" => response("500 Internal Server Error", "", &vec![b'e'; ERROR_BODY_LIMIT + 100]),
        "/big" => response("200 OK", "", &[7; 17]),
        "/to-google" => response("302 Found", "Location: https://www.googleapis.com/drive/v3/files\r\n", b""),
        "/to-local" => response("307 Temporary Redirect", "Location: /echo\r\n", b""),
        "/to-localhost" => response("302 Found", "Location: http://localhost:1/echo\r\n", b""),
        _ => response("404 Not Found", "", b""),
    }
}

const TEST_LIMITS: Limits = Limits {
    connect_timeout: Duration::from_secs(5),
    read_timeout: Duration::from_secs(5),
    total_timeout: Duration::from_secs(10),
    max_body_bytes: ERROR_BODY_LIMIT as u64 * 2,
};

fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
}

fn request(method: Method, url: String, headers: &[(&str, &str)], body: Option<&[u8]>) -> HttpRequest {
    HttpRequest {
        method,
        url,
        headers: headers.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())).collect(),
        body: body.map(<[u8]>::to_vec),
    }
}

fn send_with(client: &ReqwestClient, request: HttpRequest) -> Result<HttpReply, HttpError> {
    block_on(client.request(request))
}

fn send(request: HttpRequest) -> Result<HttpReply, HttpError> {
    send_with(&ReqwestClient::new(TEST_LIMITS, "pipette-test"), request)
}

fn loopback() -> ReqwestClient {
    ReqwestClient::loopback_only(TEST_LIMITS, "pipette-test")
}

#[test]
fn sends_the_method_the_headers_and_the_body() {
    let base = serve(routes);
    let reply =
        send(request(Method::Post, format!("{base}/echo"), &[("X-Test", "abc")], Some(b"payload"))).unwrap();
    assert_eq!(
        reply,
        HttpReply {
            status: 201,
            retry_after: None,
            content_type: Some("text/plain".to_owned()),
            body: b"POST /echo abc payload".to_vec(),
        }
    );
    assert!(reply.ok());
    for (method, name) in [(Method::Get, "GET"), (Method::Patch, "PATCH"), (Method::Delete, "DELETE")] {
        let reply = send(request(method, format!("{base}/echo"), &[], None)).unwrap();
        assert_eq!(reply.body, format!("{name} /echo  ").into_bytes());
    }
}

#[test]
fn returns_a_failed_status_with_its_body_and_retry_after() {
    let base = serve(routes);
    let limited = send(request(Method::Get, format!("{base}/limited"), &[], None)).unwrap();
    assert_eq!(
        limited,
        HttpReply {
            status: 429,
            retry_after: Some("7".to_owned()),
            content_type: Some("application/json".to_owned()),
            body: b"{\"error\":1}".to_vec(),
        }
    );
    assert!(!limited.ok());
    let missing = send(request(Method::Delete, format!("{base}/missing"), &[], None)).unwrap();
    assert_eq!((missing.status, missing.body), (404, b"not here".to_vec()));
}

#[test]
fn keeps_the_start_of_a_long_error_body() {
    let base = serve(routes);
    let reply = send(request(Method::Get, format!("{base}/huge-error"), &[], None)).unwrap();
    assert_eq!(reply.status, 500);
    assert_eq!(reply.body, vec![b'e'; ERROR_BODY_LIMIT]);
}

#[test]
fn refuses_a_successful_body_over_the_limit() {
    let base = serve(routes);
    let client = ReqwestClient::new(Limits { max_body_bytes: 16, ..TEST_LIMITS }, "pipette-test");
    let err = send_with(&client, request(Method::Get, format!("{base}/big"), &[], None)).unwrap_err();
    assert!(matches!(err, HttpError::TooLarge { limit: 16 }), "{err:?}");
}

#[test]
fn the_loopback_client_sends_to_127_0_0_1_and_follows_redirects_there() {
    let base = serve(routes);
    let reply = send_with(&loopback(), request(Method::Get, format!("{base}/to-local"), &[], None)).unwrap();
    assert_eq!(reply.body, b"GET /echo  ".to_vec());
    let got = block_on(loopback().get_bytes(&format!("{base}/echo"))).unwrap();
    assert_eq!(got.status, 201);
}

#[test]
fn the_loopback_client_sends_to_ipv6_loopback() {
    // Some machines have no IPv6 loopback; there is nothing to test there.
    let Ok(listener) = TcpListener::bind("[::1]:0") else { return };
    let base = serve_on(listener, routes);
    let reply =
        send_with(&loopback(), request(Method::Post, format!("{base}/echo"), &[], Some(b"6"))).unwrap();
    assert_eq!(reply.body, b"POST /echo  6".to_vec());
}

#[test]
fn the_loopback_client_refuses_googleapis_and_every_other_host() {
    for url in [
        "https://www.googleapis.com/drive/v3/files",
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
        "https://oauth2.googleapis.com/token",
        "http://localhost:1/",
        "http://127.0.0.2:1/",
        "http://10.0.0.1/",
        "http://[::2]/",
    ] {
        for method in [Method::Get, Method::Post, Method::Patch, Method::Delete] {
            let err = send_with(&loopback(), request(method, url.to_owned(), &[], Some(b"x"))).unwrap_err();
            assert!(matches!(err, HttpError::Refused(_)), "{method:?} {url}: {err:?}");
        }
        let err = block_on(loopback().get_bytes(url)).unwrap_err();
        assert!(matches!(err, HttpError::Refused(_)), "GET {url}: {err:?}");
    }
    let err = send_with(&loopback(), request(Method::Get, "not a url".to_owned(), &[], None)).unwrap_err();
    assert!(matches!(err, HttpError::Refused(_)), "{err:?}");
}

#[test]
fn the_loopback_client_refuses_a_redirect_off_the_loopback_interface() {
    let base = serve(routes);
    let err =
        send_with(&loopback(), request(Method::Get, format!("{base}/to-google"), &[], None)).unwrap_err();
    let HttpError::Refused(host) = err else { panic!("followed the redirect to Google: {err:?}") };
    assert_eq!(host, "www.googleapis.com");
    let err = block_on(loopback().get_bytes(&format!("{base}/to-google"))).unwrap_err();
    assert!(matches!(err, HttpError::Refused(_)), "{err:?}");
    let err =
        send_with(&loopback(), request(Method::Get, format!("{base}/to-localhost"), &[], None)).unwrap_err();
    assert!(matches!(err, HttpError::Refused(host) if host == "localhost"));
}
