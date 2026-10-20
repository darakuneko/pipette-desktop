// SPDX-License-Identifier: GPL-2.0-or-later
//! Where the startup notices are fetched from: [`NOTIFICATION_ENDPOINT`],
//! or, in a build with the development tools only, the
//! `PIPETTE_NOTIFICATION_URL` override that the e2e runs point at a fake
//! notice server. A replaced destination gets a client that sends nowhere
//! but 127.0.0.1 and ::1, redirects included, so neither the override nor a
//! redirect from the fake server reaches another machine.

use std::sync::Arc;

use pipette_net::{HttpRequester, ReqwestClient};

use crate::request::NOTICE_LIMITS;

/// The notice server.
pub const NOTIFICATION_ENDPOINT: &str = "https://getnotifications-svtx62766a-uc.a.run.app";

/// The URL that replaces [`NOTIFICATION_ENDPOINT`] in a build with the
/// development tools.
pub const NOTIFICATION_URL_ENV: &str = "PIPETTE_NOTIFICATION_URL";

/// The notice destination of this process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoticeDestination {
    /// The URL the request is posted to, as given (the real endpoint is
    /// the host's root, and the fake server answers on any path).
    pub url: String,
    /// The URL comes from [`NOTIFICATION_URL_ENV`].
    pub overridden: bool,
}

impl NoticeDestination {
    /// The destination the environment `env` gives a build with
    /// (`dev_tools_build`) or without the development tools. A build
    /// without them does not read the variable; an empty value is no
    /// override.
    pub fn resolve(dev_tools_build: bool, env: &dyn Fn(&str) -> Option<String>) -> Self {
        let override_url =
            if dev_tools_build { env(NOTIFICATION_URL_ENV).filter(|url| !url.is_empty()) } else { None };
        match override_url {
            Some(url) => Self { url, overridden: true },
            None => Self { url: NOTIFICATION_ENDPOINT.to_owned(), overridden: false },
        }
    }

    /// The destination of this process's environment.
    pub fn from_process_env(dev_tools_build: bool) -> Self {
        Self::resolve(dev_tools_build, &|name| std::env::var(name).ok())
    }

    /// The client for this destination: one limited to the loopback
    /// interface for an override, else the ordinary one.
    pub fn requester(&self, user_agent: &str) -> Arc<dyn HttpRequester> {
        if self.overridden {
            Arc::new(ReqwestClient::loopback_only(NOTICE_LIMITS, user_agent))
        } else {
            Arc::new(ReqwestClient::new(NOTICE_LIMITS, user_agent))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(vars: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| vars.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned())
    }

    #[test]
    fn a_build_without_the_tools_ignores_the_override() {
        for vars in [
            &[(NOTIFICATION_URL_ENV, "http://127.0.0.1:9")][..],
            &[(NOTIFICATION_URL_ENV, "https://example.com"), ("PIPETTE_E2E", "1")][..],
            &[(NOTIFICATION_URL_ENV, "http://127.0.0.1:9"), ("PIPETTE_HUB_TEST", "1")][..],
        ] {
            let destination = NoticeDestination::resolve(false, &env(vars));
            assert_eq!(
                destination,
                NoticeDestination { url: NOTIFICATION_ENDPOINT.to_owned(), overridden: false },
                "{vars:?}"
            );
        }
    }

    #[test]
    fn a_build_with_the_tools_takes_a_non_empty_override_as_given() {
        assert_eq!(
            NoticeDestination::resolve(
                true,
                &env(&[(NOTIFICATION_URL_ENV, "http://127.0.0.1:4321/notices/")])
            ),
            NoticeDestination { url: "http://127.0.0.1:4321/notices/".to_owned(), overridden: true }
        );
        assert_eq!(
            NoticeDestination::resolve(true, &env(&[(NOTIFICATION_URL_ENV, "")])),
            NoticeDestination { url: NOTIFICATION_ENDPOINT.to_owned(), overridden: false }
        );
        assert_eq!(
            NoticeDestination::resolve(true, &env(&[])),
            NoticeDestination { url: NOTIFICATION_ENDPOINT.to_owned(), overridden: false }
        );
    }
}
