// SPDX-License-Identifier: GPL-2.0-or-later
//! The clients of a loopback Hub destination refuse to follow a redirect
//! off the loopback interface: a fake Hub on 127.0.0.1 cannot hand a
//! request on to another machine. Only 127.0.0.1 is ever connected to.

#![allow(clippy::unwrap_used)]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use pipette_hub::{Endpoint, HubDestination, HubHttp, RequestBody, SystemTiming};
use pipette_net::{HUB_URL_ENV, HttpError};

/// A server on 127.0.0.1 that answers every request with a redirect to
/// `location`, for as long as the test runs.
fn redirecting_server(location: &'static str) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut buffer = [0u8; 4096];
            let _ = stream.read(&mut buffer);
            let response = format!(
                "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    format!("http://{address}")
}

#[test]
fn a_redirect_from_the_loopback_hub_to_another_host_is_refused() {
    let base = redirecting_server("https://pipette-hub-worker.keymaps.workers.dev/api/auth/me");
    let lookup = |name: &str| (name == HUB_URL_ENV).then(|| base.clone());
    let destination = HubDestination::resolve(true, &lookup);
    assert!(destination.loopback && !destination.blocked);
    let http = HubHttp::new(
        destination.base.clone(),
        destination.requesters("pipette-test"),
        std::sync::Arc::new(SystemTiming),
    );
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    for endpoint in [Endpoint::AuthMe, Endpoint::I18nUpload] {
        let err = runtime.block_on(http.send(&endpoint, Some("jwt"), RequestBody::None)).unwrap_err();
        assert!(
            matches!(&err, pipette_hub::HubError::Network(HttpError::Refused(host)) if host == "pipette-hub-worker.keymaps.workers.dev"),
            "{endpoint:?}: {err:?}"
        );
    }
}
