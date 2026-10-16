// SPDX-License-Identifier: GPL-2.0-or-later
//! The Google endpoints as a process gets them from its environment. Each
//! case runs this test binary again with the variables set, since a test
//! cannot set its own environment safely. Without the `url-override`
//! feature (a release build) the variables change nothing; with it, all
//! four replace the endpoints, a partial set is an error, and the client
//! for replaced endpoints refuses Google.

#![allow(clippy::unwrap_used)]

use std::process::Command;

use pipette_net::{GoogleEndpoints, google_endpoints};

const NAMES: [&str; 4] = [
    "PIPETTE_GOOGLE_AUTH_URL",
    "PIPETTE_GOOGLE_TOKEN_URL",
    "PIPETTE_DRIVE_API_URL",
    "PIPETTE_DRIVE_UPLOAD_URL",
];

const LOOPBACK: [&str; 4] = [
    "http://127.0.0.1:9/auth",
    "http://127.0.0.1:9/token",
    "http://127.0.0.1:9/drive/v3",
    "http://127.0.0.1:9/upload/drive/v3",
];

/// Runs the ignored test `name` of this binary with `vars` set (and the
/// others removed), and tells whether it passed.
fn run_child(name: &str, vars: &[(&str, &str)]) -> bool {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", name, "--ignored", "--test-threads=1", "--quiet"]);
    for variable in NAMES {
        command.env_remove(variable);
    }
    command.envs(vars.iter().copied());
    let output = command.output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    // An unknown name runs nothing and passes: make sure it ran.
    assert!(stdout.contains("1 passed") || stdout.contains("1 failed"), "{name} did not run: {stdout}");
    output.status.success()
}

fn all_loopback() -> Vec<(&'static str, &'static str)> {
    NAMES.into_iter().zip(LOOPBACK).collect()
}

#[cfg(not(feature = "url-override"))]
#[test]
fn a_release_build_ignores_the_variables() {
    const { assert!(!pipette_net::ENDPOINT_OVERRIDES_COMPILED) };
    assert!(run_child("child_has_the_real_endpoints", &all_loopback()));
    assert!(run_child("child_has_the_real_endpoints", &all_loopback()[..1]));
    let google = [(NAMES[2], "https://www.googleapis.com/drive/v3")];
    assert!(run_child("child_has_the_real_endpoints", &google));
}

#[test]
#[ignore = "run by the tests above with the variables set"]
fn child_has_the_real_endpoints() {
    assert_eq!(google_endpoints().unwrap(), GoogleEndpoints::production());
}

#[cfg(feature = "url-override")]
#[test]
fn a_development_build_replaces_all_four_or_none() {
    const { assert!(pipette_net::ENDPOINT_OVERRIDES_COMPILED) };
    assert!(run_child("child_has_the_real_endpoints", &[]));
    assert!(run_child("child_has_loopback_endpoints", &all_loopback()));
    for count in 1..NAMES.len() {
        assert!(run_child("child_has_no_endpoints", &all_loopback()[..count]), "{count} set");
    }
    let mut google = all_loopback();
    google[2].1 = "https://www.googleapis.com/drive/v3";
    assert!(run_child("child_has_no_endpoints", &google));
}

#[cfg(feature = "url-override")]
#[test]
#[ignore = "run by the tests above with the variables set"]
fn child_has_loopback_endpoints() {
    use pipette_net::{HttpError, HttpRequest, HttpRequester, Limits, Method};

    let endpoints = google_endpoints().unwrap();
    assert!(endpoints.replaced());
    assert_eq!(
        [endpoints.auth.as_str(), &endpoints.token, &endpoints.drive_api, &endpoints.drive_upload],
        LOOPBACK
    );
    // Their client refuses Google, before any connection.
    let client = endpoints.client(Limits::DRIVE, "pipette-test");
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    for url in ["https://www.googleapis.com/drive/v3/files", "https://oauth2.googleapis.com/token"] {
        let request =
            HttpRequest { method: Method::Get, url: url.to_owned(), headers: Vec::new(), body: None };
        let err = runtime.block_on(client.request(request)).unwrap_err();
        assert!(matches!(err, HttpError::Refused(_)), "{url}: {err:?}");
    }
}

#[cfg(feature = "url-override")]
#[test]
#[ignore = "run by the tests above with the variables set"]
fn child_has_no_endpoints() {
    assert!(google_endpoints().is_err());
}
