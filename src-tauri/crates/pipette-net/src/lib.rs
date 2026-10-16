// SPDX-License-Identifier: GPL-2.0-or-later
//! Every request the app makes to the network goes through here: the stores
//! take an [`HttpClient`], the app manages one [`Http`] with the real
//! [`ReqwestClient`] behind it, and the tests answer with a closure. The
//! sync's requests with a method, headers and a body go through an
//! [`HttpRequester`]. The Hub API base URL (src/main/hub/hub-base.ts) is
//! here too.
//!
//! Unlike Electron's `net.fetch`, a request has timeouts and a body size
//! limit ([`Limits`]), so a stalled server ends in an error rather than a
//! request that never settles.

mod client;
mod hub;

pub use client::{
    ERROR_BODY_LIMIT, Http, HttpClient, HttpError, HttpFuture, HttpReply, HttpRequest, HttpRequester,
    HttpResponse, Limits, Method, RequestFuture, ReqwestClient,
};
pub use hub::{
    HUB_API_DEFAULT, HUB_TEST_ENV, HUB_URL_ENV, encode_uri_component, hub_api_base, resolve_hub_api_base,
};
