// SPDX-License-Identifier: GPL-2.0-or-later
//! Every request the app makes to the network goes through here: the stores
//! take an [`HttpClient`], the app manages one [`Http`] with the real
//! [`ReqwestClient`] behind it, and the tests answer with a closure. The
//! sync's requests with a method, headers and a body go through an
//! [`HttpRequester`]. The Google endpoints of the sync ([`google_endpoints`],
//! replaceable by loopback servers in development builds only) and the Hub
//! API base URL (src/main/hub/hub-base.ts) are here too.
//!
//! Unlike Electron's `net.fetch`, a request has timeouts and a body size
//! limit ([`Limits`]), so a stalled server ends in an error rather than a
//! request that never settles.

// The endpoint variables let a process send the sync's Google requests
// (tokens included) elsewhere, so only a debug build may read them. Every
// bundled build is a release build without debug assertions.
#[cfg(all(feature = "url-override", not(debug_assertions)))]
compile_error!(
    "the url-override feature of pipette-net is not allowed without debug assertions: it reads \
     the Google endpoints from the environment"
);

mod client;
mod google;
mod hub;

pub use client::{
    ERROR_BODY_LIMIT, Http, HttpClient, HttpError, HttpFuture, HttpReply, HttpRequest, HttpRequester,
    HttpResponse, Limits, Method, RequestFuture, ReqwestClient, is_loopback_url,
};
#[cfg(feature = "url-override")]
pub use google::{
    AUTH_URL_ENV, DRIVE_API_URL_ENV, DRIVE_UPLOAD_URL_ENV, TOKEN_URL_ENV, resolve as resolve_endpoints,
};
pub use google::{
    DRIVE_API, DRIVE_UPLOAD_API, ENDPOINT_OVERRIDES_COMPILED, EndpointError, GOOGLE_AUTH_ENDPOINT,
    GOOGLE_TOKEN_ENDPOINT, GoogleEndpoints, google_endpoints,
};
pub use hub::{
    HUB_API_DEFAULT, HUB_TEST_ENV, HUB_URL_ENV, encode_uri_component, hub_api_base, resolve_hub_api_base,
};
