// SPDX-License-Identifier: GPL-2.0-or-later
//! The Hub of the app: its destination (`pipette_hub::HubDestination`),
//! settled once at launch, and the client the commands send through. The
//! Hub's background work starts only after the destination is settled, and
//! not at all when an e2e run's destination is blocked.

use std::sync::Arc;

use pipette_hub::{HubDestination, HubHttp, HubRequesters, SystemTiming};
use tauri::{AppHandle, Manager, Runtime};

/// The Hub the commands use.
pub struct Hub {
    destination: HubDestination,
    #[allow(dead_code, reason = "the Hub handlers of src/hub_commands/ send through it")]
    http: HubHttp,
}

impl Hub {
    pub fn new(destination: HubDestination, requesters: HubRequesters) -> Self {
        let http = HubHttp::new(destination.base.clone(), requesters, Arc::new(SystemTiming));
        Self { destination, http }
    }

    pub fn destination(&self) -> &HubDestination {
        &self.destination
    }

    #[allow(dead_code, reason = "the Hub handlers of src/hub_commands/ send through it")]
    pub fn http(&self) -> &HubHttp {
        &self.http
    }

    /// Whether the Hub's background work may start: not in an e2e run
    /// whose Hub is not on the loopback interface.
    pub fn background_allowed(&self) -> bool {
        !self.destination().blocked
    }
}

/// Settles the Hub destination of this process and manages the Hub; its
/// background work may start only after this, and only when
/// [`Hub::background_allowed`]. Runs before the window opens, so no Hub
/// request leaves before the destination is checked.
pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    let destination = HubDestination::from_process_env(cfg!(feature = "dev-tools"));
    let user_agent = format!("Pipette/{}", app.package_info().version);
    let requesters = destination.requesters(&user_agent);
    let hub = manage_with(app, destination, requesters);
    if !hub.background_allowed() {
        log::warn!(
            "[hub] PIPETTE_E2E=1 without a Hub on the loopback interface: every Hub request is refused and no \
             Hub work runs in the background"
        );
    }
}

/// Manages a Hub on `destination` through `requesters`.
pub fn manage_with<R: Runtime>(
    app: &AppHandle<R>,
    destination: HubDestination,
    requesters: HubRequesters,
) -> Arc<Hub> {
    let hub = Arc::new(Hub::new(destination, requesters));
    app.manage(Arc::clone(&hub));
    hub
}

/// [`manage_with`] for the tests: the production Hub's address with every
/// request failing as offline, so nothing is sent anywhere.
#[cfg(test)]
pub fn manage_for_tests<R: Runtime>(app: &AppHandle<R>) -> Arc<Hub> {
    use pipette_net::{HttpError, HttpRequest, HttpRequester};
    let destination = HubDestination::resolve(false, &|_| None);
    let offline: Arc<dyn HttpRequester> =
        Arc::new(|_: HttpRequest| Err(HttpError::Network("offline".to_owned())));
    manage_with(app, destination, HubRequesters::single(offline))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn destination(vars: &'static [(&'static str, &'static str)], dev_tools: bool) -> HubDestination {
        HubDestination::resolve(dev_tools, &|name| {
            vars.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned())
        })
    }

    fn refused() -> HubRequesters {
        let refuse: Arc<dyn pipette_net::HttpRequester> =
            Arc::new(|_: pipette_net::HttpRequest| Err(pipette_net::HttpError::Refused("test".to_owned())));
        HubRequesters::single(refuse)
    }

    #[test]
    fn an_e2e_run_without_a_loopback_hub_starts_no_background_work() {
        for vars in [
            &[("PIPETTE_E2E", "1")][..],
            &[("PIPETTE_E2E", "1"), ("PIPETTE_HUB_URL", "https://example.com")][..],
            &[("PIPETTE_E2E", "1"), ("PIPETTE_HUB_URL", "")][..],
        ] {
            let hub = Hub::new(destination(vars, true), refused());
            assert!(!hub.background_allowed(), "{vars:?}");
        }
        let looped = Hub::new(
            destination(&[("PIPETTE_E2E", "1"), ("PIPETTE_HUB_URL", "http://127.0.0.1:9")], true),
            refused(),
        );
        assert!(looped.background_allowed());
        assert_eq!(looped.http().base(), "http://127.0.0.1:9");
        // Outside an e2e run the destination is Electron's, the real Hub.
        let normal = Hub::new(destination(&[], false), refused());
        assert!(normal.background_allowed());
        assert_eq!(normal.http().base(), pipette_net::HUB_API_DEFAULT);
    }
}
