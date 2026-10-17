// SPDX-License-Identifier: GPL-2.0-or-later
//! The Pipette Hub client of src/main/hub/*.ts: the HTTP layer
//! ([`HubHttp`], the endpoint table [`Endpoint`], the errors and the 429
//! retry), the multipart bodies ([`multipart`]), the input checks
//! ([`validate`]) and where the requests may go ([`HubDestination`]).
//! The handlers live in one module per group of the TS handlers
//! ([`token`], [`account`], [`posts`], [`private`], [`favorite`],
//! [`analytics`], [`packs`], [`key_labels`], [`startup_sync`]). What it
//! takes from the rest of the app comes through the traits of [`sources`].
//! With the `test-util` feature, [`fake::FakeHub`] answers as the Hub
//! does, in memory.
//!
//! The Hub's JWT and the Google id_token never leave the backend, and no
//! request's headers, body or query is logged.

pub mod account;
pub mod analytics;
mod base64;
pub mod destination;
pub mod endpoint;
pub mod favorite;
pub mod http;
mod js;
pub mod key_labels;
pub mod multipart;
pub mod packs;
pub mod posts;
pub mod private;
pub mod retry_after;
pub mod sources;
pub mod startup_sync;
pub mod token;
pub mod validate;

#[cfg(feature = "test-util")]
pub mod fake;

pub use base64::node_base64_decode;
pub use destination::{E2E_ENV, HubDestination, is_e2e_run};
pub use endpoint::{Endpoint, ListQuery, ReadMode};
pub use http::{
    HUB_LIMITS, HubError, HubHttp, HubRequesters, HubTiming, MAX_RETRY_AFTER_S, RequestBody, StatusKind,
    SystemTiming,
};
pub use js::{js_length, js_number_string, js_trim};
pub use sources::{AnalyticsSource, BoxFuture, IdTokenSource};
