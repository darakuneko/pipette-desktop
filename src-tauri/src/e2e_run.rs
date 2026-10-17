// SPDX-License-Identifier: GPL-2.0-or-later
//! The automated test runs: a build with the development tools started
//! with `PIPETTE_E2E=1` (the e2e harness sets it for every session). In
//! such a run nothing may reach the real Hub or the real Google: the Hub
//! is closed off by its destination (src/hub_commands/setup.rs), and the
//! sync's Google endpoints must be replaced by loopback servers, or the
//! sync gets none and every Google request is refused.

use pipette_net::GoogleEndpoints;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_real_google_is_refused_in_an_e2e_run_only() {
        assert!(usable_in_run(GoogleEndpoints::production(), true).is_err());
        assert_eq!(usable_in_run(GoogleEndpoints::production(), false), Ok(GoogleEndpoints::production()));
    }
}
