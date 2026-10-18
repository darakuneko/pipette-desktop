// SPDX-License-Identifier: GPL-2.0-or-later
//! The automated test runs: a build with the development tools started
//! with `PIPETTE_E2E=1` (the e2e harness sets it for every session). In
//! such a run nothing may reach the real Hub or the real Google: the Hub
//! is closed off by its destination (src/hub_commands/setup.rs), the
//! sync's Google endpoints must be replaced by loopback servers, or the
//! sync gets none and every Google request is refused, and the startup
//! notices are fetched only from a destination on the loopback interface.

use pipette_net::{GoogleEndpoints, is_loopback_url};

/// Whether this process is an automated test run.
pub fn is_e2e_run() -> bool {
    pipette_hub::is_e2e_run(cfg!(feature = "dev-tools"), &|name| std::env::var(name).ok())
}

/// `pipette_net::google_endpoints`, refused in an e2e run that has not
/// replaced them.
pub fn google_endpoints() -> Result<GoogleEndpoints, String> {
    let endpoints = pipette_net::google_endpoints().map_err(|err| err.to_string())?;
    usable_in_run(endpoints, is_e2e_run())
}

fn usable_in_run(endpoints: GoogleEndpoints, e2e_run: bool) -> Result<GoogleEndpoints, String> {
    if e2e_run && !endpoints.replaced() {
        return Err(
            "PIPETTE_E2E=1 without the Google endpoint variables: the real Google is not used in an e2e run"
                .to_owned(),
        );
    }
    Ok(endpoints)
}

/// Whether the startup notices may be fetched from `url`: always outside
/// an e2e run (`e2e_run`, from [`is_e2e_run`]), and in one only from
/// 127.0.0.1 or ::1. The error is the `error` of the notice command's
/// failed result; nothing is sent then.
pub fn notification_destination_allowed(url: &str, e2e_run: bool) -> Result<(), String> {
    if e2e_run && !is_loopback_url(url) {
        return Err(
            "PIPETTE_E2E=1 with a startup-notice destination off the loopback interface: the real notice endpoint is not used in an e2e run"
                .to_owned(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const REAL_NOTICE_ENDPOINT: &str = "https://getnotifications-svtx62766a-uc.a.run.app";

    #[test]
    fn the_notices_come_only_from_the_loopback_interface_in_an_e2e_run() {
        for url in ["http://127.0.0.1:9", "http://127.0.0.1:4321/", "http://[::1]:4321"] {
            assert_eq!(notification_destination_allowed(url, true), Ok(()), "{url}");
        }
        for url in [
            REAL_NOTICE_ENDPOINT,
            "http://localhost:4321",
            "http://127.0.0.2:4321",
            "http://10.0.0.1",
            "http://127.0.0.1.example.com",
            "",
            "not a url",
        ] {
            assert!(notification_destination_allowed(url, true).is_err(), "{url}");
        }
    }

    #[test]
    fn any_notice_destination_is_allowed_outside_an_e2e_run() {
        assert_eq!(notification_destination_allowed(REAL_NOTICE_ENDPOINT, false), Ok(()));
        assert_eq!(notification_destination_allowed("http://127.0.0.1:9", false), Ok(()));
    }

    #[test]
    fn the_real_google_is_refused_in_an_e2e_run_only() {
        assert!(usable_in_run(GoogleEndpoints::production(), true).is_err());
        assert_eq!(usable_in_run(GoogleEndpoints::production(), false), Ok(GoogleEndpoints::production()));
    }
}
