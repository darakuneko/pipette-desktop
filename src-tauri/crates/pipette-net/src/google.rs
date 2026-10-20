// SPDX-License-Identifier: GPL-2.0-or-later
//! The Google endpoints of the sync: the OAuth authorization and token
//! endpoints and the Drive API, and the client their requests go through.
//!
//! Builds with the `url-override` feature (the development tools) replace
//! all four with servers on the loopback interface from the environment, so
//! the tests run against fake servers. The replacement is fail-closed: once
//! any of the variables is set, all four must be, each on 127.0.0.1 or ::1,
//! or the endpoints are an error and nothing is sent anywhere; and every
//! client for replaced endpoints refuses any other destination, redirects
//! included ([`ReqwestClient::loopback_only`]). A build without the feature
//! has none of this code and never reads the variables.

use crate::client::{Limits, ReqwestClient};

/// The OAuth authorization endpoint.
pub const GOOGLE_AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
/// The OAuth token endpoint.
pub const GOOGLE_TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
/// The Drive API.
pub const DRIVE_API: &str = "https://www.googleapis.com/drive/v3";
/// The Drive upload API.
pub const DRIVE_UPLOAD_API: &str = "https://www.googleapis.com/upload/drive/v3";

/// Where the sync's requests go, without a trailing slash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleEndpoints {
    pub auth: String,
    pub token: String,
    pub drive_api: String,
    pub drive_upload: String,
    /// Whether these replace the real endpoints.
    replaced: bool,
}

impl GoogleEndpoints {
    pub fn production() -> Self {
        Self {
            auth: GOOGLE_AUTH_ENDPOINT.to_owned(),
            token: GOOGLE_TOKEN_ENDPOINT.to_owned(),
            drive_api: DRIVE_API.to_owned(),
            drive_upload: DRIVE_UPLOAD_API.to_owned(),
            replaced: false,
        }
    }

    /// Whether these are the loopback servers of the environment.
    pub fn replaced(&self) -> bool {
        self.replaced
    }

    /// The client for requests to these endpoints: for replaced ones, a
    /// client that sends only to the loopback interface.
    pub fn client(&self, limits: Limits, user_agent: impl Into<String>) -> ReqwestClient {
        if self.replaced {
            ReqwestClient::loopback_only(limits, user_agent)
        } else {
            ReqwestClient::new(limits, user_agent)
        }
    }
}

/// Whether this build reads the endpoint variables (`url-override`).
pub const ENDPOINT_OVERRIDES_COMPILED: bool = cfg!(feature = "url-override");

/// Why the variables do not give a usable set of endpoints; the sync does
/// not start.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EndpointError {
    #[error("the Google endpoint override needs all of its variables; missing: {}", .0.join(", "))]
    Incomplete(Vec<&'static str>),
    #[error("{0} must be an http(s) URL on 127.0.0.1 or [::1]")]
    NotLoopback(&'static str),
}

/// The endpoints for this process: the real ones, or in a build with the
/// `url-override` feature, the replacements the environment sets.
pub fn google_endpoints() -> Result<GoogleEndpoints, EndpointError> {
    #[cfg(feature = "url-override")]
    {
        overrides::resolve(std::env::var_os)
    }
    #[cfg(not(feature = "url-override"))]
    {
        Ok(GoogleEndpoints::production())
    }
}

#[cfg(feature = "url-override")]
pub use overrides::{AUTH_URL_ENV, DRIVE_API_URL_ENV, DRIVE_UPLOAD_URL_ENV, TOKEN_URL_ENV, resolve};

#[cfg(feature = "url-override")]
mod overrides {
    use std::ffi::OsString;

    use super::{EndpointError, GoogleEndpoints};

    pub const AUTH_URL_ENV: &str = "PIPETTE_GOOGLE_AUTH_URL";
    pub const TOKEN_URL_ENV: &str = "PIPETTE_GOOGLE_TOKEN_URL";
    pub const DRIVE_API_URL_ENV: &str = "PIPETTE_DRIVE_API_URL";
    pub const DRIVE_UPLOAD_URL_ENV: &str = "PIPETTE_DRIVE_UPLOAD_URL";

    const ALL: [&str; 4] = [AUTH_URL_ENV, TOKEN_URL_ENV, DRIVE_API_URL_ENV, DRIVE_UPLOAD_URL_ENV];

    /// The endpoints the variables `lookup` reads give: the real ones when
    /// none is set (an empty value counts as set), else all four
    /// replacements, each an http(s) URL on 127.0.0.1 or ::1.
    pub fn resolve(
        lookup: impl FnMut(&'static str) -> Option<OsString>,
    ) -> Result<GoogleEndpoints, EndpointError> {
        let values = ALL.map(lookup);
        if values.iter().all(Option::is_none) {
            return Ok(GoogleEndpoints::production());
        }
        let missing: Vec<&'static str> =
            ALL.iter().zip(&values).filter(|(_, value)| value.is_none()).map(|(name, _)| *name).collect();
        if !missing.is_empty() {
            return Err(EndpointError::Incomplete(missing));
        }
        let url = |index: usize| {
            let text = values[index].as_ref().and_then(|value| value.to_str()).unwrap_or("");
            let text = text.trim_end_matches('/');
            if on_loopback(text) { Ok(text.to_owned()) } else { Err(EndpointError::NotLoopback(ALL[index])) }
        };
        Ok(GoogleEndpoints {
            auth: url(0)?,
            token: url(1)?,
            drive_api: url(2)?,
            drive_upload: url(3)?,
            replaced: true,
        })
    }

    fn on_loopback(url: &str) -> bool {
        reqwest::Url::parse(url).is_ok_and(|parsed| {
            matches!(parsed.scheme(), "http" | "https") && crate::client::is_loopback(&parsed)
        })
    }
}

#[cfg(all(test, feature = "url-override"))]
mod tests {
    use std::collections::HashMap;
    use std::ffi::OsString;

    use super::*;

    fn resolve_with(vars: &[(&str, &str)]) -> Result<GoogleEndpoints, EndpointError> {
        let vars: HashMap<String, OsString> =
            vars.iter().map(|(name, value)| ((*name).to_owned(), OsString::from(value))).collect();
        resolve(|name| vars.get(name).cloned())
    }

    const ALL_SET: [(&str, &str); 4] = [
        (AUTH_URL_ENV, "http://127.0.0.1:9000/auth/"),
        (TOKEN_URL_ENV, "http://127.0.0.1:9000/token"),
        (DRIVE_API_URL_ENV, "http://[::1]:9000/drive/v3"),
        (DRIVE_UPLOAD_URL_ENV, "https://127.0.0.1:9000/upload/drive/v3//"),
    ];

    #[test]
    fn uses_the_real_endpoints_when_nothing_is_set() {
        assert_eq!(resolve_with(&[]), Ok(GoogleEndpoints::production()));
        assert!(!GoogleEndpoints::production().replaced());
    }

    #[test]
    fn replaces_all_four_without_trailing_slashes() {
        let endpoints = resolve_with(&ALL_SET).unwrap();
        assert!(endpoints.replaced());
        assert_eq!(endpoints.auth, "http://127.0.0.1:9000/auth");
        assert_eq!(endpoints.token, "http://127.0.0.1:9000/token");
        assert_eq!(endpoints.drive_api, "http://[::1]:9000/drive/v3");
        assert_eq!(endpoints.drive_upload, "https://127.0.0.1:9000/upload/drive/v3");
    }

    #[test]
    fn refuses_a_partial_set() {
        assert_eq!(
            resolve_with(&ALL_SET[..1]),
            Err(EndpointError::Incomplete(vec![TOKEN_URL_ENV, DRIVE_API_URL_ENV, DRIVE_UPLOAD_URL_ENV]))
        );
        assert_eq!(resolve_with(&ALL_SET[1..]), Err(EndpointError::Incomplete(vec![AUTH_URL_ENV])));
        // An empty value counts as set, and is no URL.
        assert_eq!(
            resolve_with(&[(DRIVE_API_URL_ENV, "")]).unwrap_err(),
            EndpointError::Incomplete(vec![AUTH_URL_ENV, TOKEN_URL_ENV, DRIVE_UPLOAD_URL_ENV])
        );
    }

    #[test]
    fn refuses_an_endpoint_off_the_loopback_interface() {
        for (index, bad) in [
            "https://www.googleapis.com/drive/v3",
            "https://oauth2.googleapis.com/token",
            "http://localhost:9000/drive/v3",
            "http://127.0.0.2:9000/",
            "ftp://127.0.0.1/",
            "",
            "not a url",
        ]
        .iter()
        .enumerate()
        {
            let mut vars = ALL_SET;
            let slot = index % vars.len();
            vars[slot].1 = bad;
            assert_eq!(resolve_with(&vars), Err(EndpointError::NotLoopback(ALL_SET[slot].0)), "{bad}");
        }
    }
}
