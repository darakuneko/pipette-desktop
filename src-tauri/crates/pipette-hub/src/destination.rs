// SPDX-License-Identifier: GPL-2.0-or-later
//! Where the Hub requests go, settled once when the app starts.
//!
//! The base URL is `pipette_net::resolve_hub_api_base`: the production Hub,
//! or the `PIPETTE_HUB_URL` override where it is allowed. On top of that:
//!
//! - An override on 127.0.0.1 or ::1 gets clients that send nowhere else,
//!   redirects included (`ReqwestClient::loopback_only`), so a fake Hub
//!   cannot hand a request on to another machine.
//! - In a build with the development tools, `PIPETTE_E2E=1` marks an
//!   automated test run. In such a run a Hub destination that is not on
//!   the loopback interface (no override, an ignored one, or one on another
//!   host) is blocked: every Hub request fails before it is sent, and the
//!   Hub's background work does not start. A missing or ineffective
//!   override would otherwise send the test's requests to the real Hub.

use std::sync::Arc;

use pipette_net::{
    HUB_API_DEFAULT, HUB_TEST_ENV, HUB_URL_ENV, HttpError, HttpRequest, HttpRequester, Limits, ReqwestClient,
    is_loopback_url, resolve_hub_api_base,
};

use crate::http::{HUB_LIMITS, HubRequesters};

/// Set to `1` by the e2e harness for every session.
pub const E2E_ENV: &str = "PIPETTE_E2E";

/// Whether this process is an automated test run: a build with the
/// development tools and `PIPETTE_E2E=1`. A build without them ignores the
/// variable.
pub fn is_e2e_run(dev_tools_build: bool, env: &dyn Fn(&str) -> Option<String>) -> bool {
    dev_tools_build && env(E2E_ENV).as_deref() == Some("1")
}

/// The Hub destination of this process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HubDestination {
    /// The Hub API base URL, without a trailing slash.
    pub base: String,
    /// The base comes from an allowed `PIPETTE_HUB_URL`.
    pub overridden: bool,
    /// The base is an overridden URL on 127.0.0.1 or ::1.
    pub loopback: bool,
    /// An e2e run whose destination is not on the loopback interface: no
    /// Hub request may be sent.
    pub blocked: bool,
}

impl HubDestination {
    /// The destination the environment `env` gives a build with
    /// (`dev_tools_build`) or without the development tools.
    pub fn resolve(dev_tools_build: bool, env: &dyn Fn(&str) -> Option<String>) -> Self {
        let override_url = env(HUB_URL_ENV);
        let allowed = dev_tools_build || env(HUB_TEST_ENV).as_deref() == Some("1");
        let base = resolve_hub_api_base(override_url.as_deref(), allowed);
        let overridden =
            allowed && override_url.as_deref().is_some_and(|url| !url.is_empty()) && base != HUB_API_DEFAULT;
        let loopback = overridden && is_loopback_url(&base);
        let blocked = is_e2e_run(dev_tools_build, env) && !loopback;
        Self { base, overridden, loopback, blocked }
    }

    /// The destination of this process's environment.
    pub fn from_process_env(dev_tools_build: bool) -> Self {
        Self::resolve(dev_tools_build, &|name| std::env::var(name).ok())
    }

    /// The clients for this destination: none for a blocked one (each
    /// request fails as refused), loopback-only ones for a loopback
    /// override, else the ordinary ones.
    pub fn requesters(&self, user_agent: &str) -> HubRequesters {
        if self.blocked {
            let refuse: Arc<dyn HttpRequester> = Arc::new(|request: HttpRequest| {
                Err(HttpError::Refused(format!(
                    "{} (an e2e run's Hub must be on the loopback interface)",
                    origin_of(&request.url)
                )))
            });
            return HubRequesters::single(refuse);
        }
        let client = |limits: Limits| -> Arc<dyn HttpRequester> {
            if self.loopback {
                Arc::new(ReqwestClient::loopback_only(limits, user_agent))
            } else {
                Arc::new(ReqwestClient::new(limits, user_agent))
            }
        };
        HubRequesters { upload: client(Limits::DEFAULT), other: client(HUB_LIMITS) }
    }
}

/// `scheme://host[:port]` of `url`, without its path and query, which may
/// carry names.
fn origin_of(url: &str) -> &str {
    let after_scheme = url.find("://").map_or(0, |at| at + 3);
    let end = url[after_scheme..].find(['/', '?', '#']).map_or(url.len(), |at| after_scheme + at);
    &url[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(vars: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| vars.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned())
    }

    #[test]
    fn a_loopback_override_is_loopback_and_not_blocked() {
        let vars = env(&[(HUB_URL_ENV, "http://127.0.0.1:9/"), (E2E_ENV, "1")]);
        let destination = HubDestination::resolve(true, &vars);
        assert_eq!(
            destination,
            HubDestination {
                base: "http://127.0.0.1:9".to_owned(),
                overridden: true,
                loopback: true,
                blocked: false,
            }
        );
    }

    #[test]
    fn an_e2e_run_without_an_effective_loopback_override_is_blocked() {
        // No override.
        let none = HubDestination::resolve(true, &env(&[(E2E_ENV, "1")]));
        assert_eq!((none.base.as_str(), none.overridden, none.blocked), (HUB_API_DEFAULT, false, true));
        // An empty override is no override.
        let empty = HubDestination::resolve(true, &env(&[(HUB_URL_ENV, ""), (E2E_ENV, "1")]));
        assert!(empty.blocked && !empty.overridden);
        // A host name is not the loopback interface.
        let named =
            HubDestination::resolve(true, &env(&[(HUB_URL_ENV, "http://localhost:8787"), (E2E_ENV, "1")]));
        assert!(named.overridden && !named.loopback && named.blocked);
        let remote =
            HubDestination::resolve(true, &env(&[(HUB_URL_ENV, "https://example.com"), (E2E_ENV, "1")]));
        assert!(remote.blocked);
    }

    #[test]
    fn a_build_without_the_tools_ignores_the_override_and_the_e2e_mark() {
        // The override is ignored without PIPETTE_HUB_TEST=1, and the e2e
        // mark is not read: the destination is the real Hub.
        let ignored =
            HubDestination::resolve(false, &env(&[(HUB_URL_ENV, "http://127.0.0.1:9"), (E2E_ENV, "1")]));
        assert_eq!(
            ignored,
            HubDestination {
                base: HUB_API_DEFAULT.to_owned(),
                overridden: false,
                loopback: false,
                blocked: false,
            }
        );
        let test_mode =
            HubDestination::resolve(false, &env(&[(HUB_URL_ENV, "http://127.0.0.1:9"), (HUB_TEST_ENV, "1")]));
        assert!(test_mode.loopback && !test_mode.blocked);
    }

    #[test]
    fn outside_an_e2e_run_nothing_is_blocked() {
        for e2e in [None, Some("0"), Some("true")] {
            let vars = move |name: &str| if name == E2E_ENV { e2e.map(str::to_owned) } else { None };
            let destination = HubDestination::resolve(true, &vars);
            assert_eq!((destination.base.as_str(), destination.blocked), (HUB_API_DEFAULT, false), "{e2e:?}");
        }
        assert!(!is_e2e_run(false, &|_| Some("1".to_owned())));
    }

    #[test]
    fn a_blocked_destination_refuses_every_request_without_sending_it() {
        let destination = HubDestination::resolve(true, &env(&[(E2E_ENV, "1")]));
        let requesters = destination.requesters("pipette-test");
        let request = HttpRequest {
            method: pipette_net::Method::Get,
            url: format!("{HUB_API_DEFAULT}/api/key-labels?q=secret"),
            headers: Vec::new(),
            body: None,
        };
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        for requester in [&requesters.upload, &requesters.other] {
            let err = runtime.block_on(requester.request(request.clone())).unwrap_err();
            let HttpError::Refused(message) = &err else { panic!("{err:?}") };
            assert!(message.starts_with(HUB_API_DEFAULT) && !message.contains("secret"), "{message}");
        }
    }
}
