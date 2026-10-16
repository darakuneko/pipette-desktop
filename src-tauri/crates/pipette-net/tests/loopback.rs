// SPDX-License-Identifier: GPL-2.0-or-later
//! The real client against servers on the loopback interface, written by
//! hand on std's TcpListener: the status, redirects, the body size limit
//! and the timeout. Nothing here leaves the machine.

#![allow(clippy::unwrap_used)]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

use pipette_net::{HttpClient, HttpError, HttpResponse, Limits, ReqwestClient};

/// What the server sends for one connection, given the request's path.
type Respond = fn(&str) -> Option<Vec<u8>>;

/// Serves every connection on a thread of its own: reads the request head,
/// then writes `respond`'s answer and closes the connection, or holds the
/// connection open without answering when `respond` returns `None`.
fn serve(respond: Respond) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            thread::spawn(move || answer(stream, respond));
        }
    });
    format!("http://{addr}")
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
    let head = String::from_utf8_lossy(&head);
    let path = head.split(' ').nth(1).unwrap_or("").to_owned();
    match respond(&path) {
        Some(response) => {
            let _ = stream.write_all(&response);
        }
        // Hold the connection until the client gives up.
        None => thread::sleep(Duration::from_secs(5)),
    }
}

fn response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {status}\r\nConnection: close\r\n{headers}\r\n").into_bytes();
    out.extend_from_slice(body);
    out
}

fn with_length(status: &str, body: &[u8]) -> Vec<u8> {
    response(status, &format!("Content-Length: {}\r\n", body.len()), body)
}

/// A body without a length, ended by closing the connection.
fn without_length(body: &[u8]) -> Vec<u8> {
    response("200 OK", "", body)
}

fn routes(path: &str) -> Option<Vec<u8>> {
    match path {
        "/ok" => Some(with_length("200 OK", b"hello")),
        "/empty" => Some(with_length("204 No Content", b"")),
        "/missing" => Some(with_length("404 Not Found", b"not here")),
        "/moved" => Some(response("302 Found", "Location: /ok\r\nContent-Length: 0\r\n", b"")),
        "/16" => Some(with_length("200 OK", &[7; 16])),
        "/17" => Some(with_length("200 OK", &[7; 17])),
        "/16-unsized" => Some(without_length(&[7; 16])),
        "/17-unsized" => Some(without_length(&[7; 17])),
        _ => None,
    }
}

const TEST_LIMITS: Limits = Limits {
    connect_timeout: Duration::from_secs(5),
    total_timeout: Duration::from_millis(500),
    max_body_bytes: 16,
};

fn get(url: &str) -> Result<HttpResponse, HttpError> {
    let client = ReqwestClient::new(TEST_LIMITS, "pipette-test");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(client.get_bytes(url))
}

#[test]
fn returns_the_status_and_the_body() {
    let base = serve(routes);
    assert_eq!(get(&format!("{base}/ok")).unwrap(), HttpResponse { status: 200, body: b"hello".to_vec() });
    assert_eq!(get(&format!("{base}/empty")).unwrap(), HttpResponse { status: 204, body: Vec::new() });
}

#[test]
fn returns_a_failed_status_without_its_body() {
    let base = serve(routes);
    let response = get(&format!("{base}/missing")).unwrap();
    assert_eq!(response, HttpResponse { status: 404, body: Vec::new() });
    assert!(!response.ok());
}

#[test]
fn follows_redirects() {
    let base = serve(routes);
    assert_eq!(get(&format!("{base}/moved")).unwrap(), HttpResponse { status: 200, body: b"hello".to_vec() });
}

#[test]
fn takes_a_body_up_to_the_limit() {
    let base = serve(routes);
    assert_eq!(get(&format!("{base}/16")).unwrap().body, [7; 16]);
    assert_eq!(get(&format!("{base}/16-unsized")).unwrap().body, [7; 16]);
}

#[test]
fn refuses_a_body_over_the_limit_with_or_without_its_length() {
    let base = serve(routes);
    for path in ["/17", "/17-unsized"] {
        let err = get(&format!("{base}{path}")).unwrap_err();
        assert!(matches!(err, HttpError::TooLarge { limit: 16 }), "{path}: {err:?}");
    }
}

#[test]
fn gives_up_on_a_server_that_does_not_answer() {
    let base = serve(routes);
    let err = get(&format!("{base}/stall")).unwrap_err();
    assert!(matches!(err, HttpError::Timeout), "{err:?}");
}

#[test]
fn reports_a_refused_connection_and_a_bad_url_as_network_errors() {
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap()
    };
    for url in [format!("http://{closed}/"), "not a url".to_owned(), "ftp://127.0.0.1/".to_owned()] {
        let err = get(&url).unwrap_err();
        assert!(matches!(err, HttpError::Network(_)), "{url}: {err:?}");
    }
}

#[test]
fn speaks_tls_for_https() {
    // A server that answers the TLS handshake with plain HTTP: the client
    // builds its TLS setup (ring and the platform verifier) and fails in
    // the handshake rather than taking the plain answer.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let _ = stream.write_all(&with_length("200 OK", b"hello"));
        }
    });
    let err = get(&format!("https://{addr}/ok")).unwrap_err();
    assert!(matches!(err, HttpError::Network(_)), "{err:?}");
}
