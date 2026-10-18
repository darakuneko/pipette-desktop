// SPDX-License-Identifier: GPL-2.0-or-later
//! The startup notices of src/main/notification-store.ts
//! (`fetchNotifications`): where they come from (destination.rs), the
//! request (request.rs), and the response read into the renderer's result
//! (normalize.rs, with the publication dates of date_parse.rs).
//!
//! Where it differs from Electron:
//! - a string date is kept only in the forms date_parse.rs reads, a subset
//!   of what `Date.parse` reads;
//! - the error text of a failed request or of a body that is not JSON is
//!   this build's own (the renderer reads only `success`);
//! - the proxy comes from the environment (reqwest), not Chromium's
//!   settings;
//! - a body over 1 MiB fails the fetch ([`NOTICE_LIMITS`]); Electron reads
//!   any size. Ten notices are a few kilobytes.

mod date_parse;
mod destination;
mod normalize;
mod request;

use pipette_net::HttpRequester;

pub use date_parse::{date_parse_ms, is_valid_iso_date};
pub use destination::{NOTIFICATION_ENDPOINT, NOTIFICATION_URL_ENV, NoticeDestination};
pub use normalize::{
    AppNotification, INVALID_RESPONSE_FORMAT, INVALID_TIME_VALUE, NotificationFetchResult, result_from_reply,
};
pub use request::{FETCH_TIMEOUT, NOTICE_LIMITS, notice_request, request_body};

/// The error of a fetch that took longer than [`FETCH_TIMEOUT`].
pub const TIMED_OUT: &str = "the request timed out";

/// `fetchNotifications`: posts the notice query to `url` through
/// `requester` with `now_ms` as `Date.now()`, and reads the response. A
/// status outside 2xx settles once the headers are in, without its body
/// (Electron stops at `!response.ok` too). The whole fetch ends after
/// [`FETCH_TIMEOUT`] whatever the requester's own bounds. The body is at
/// most [`NOTICE_LIMITS`]'s 1 MiB, which parses in milliseconds, so the
/// parse and the checks run in place. Logs a failure with its error and a success with the number of
/// notices only: the notices themselves are never logged. Run on the Tokio
/// runtime.
pub async fn fetch_notifications(
    requester: &dyn HttpRequester,
    url: &str,
    now_ms: i64,
) -> NotificationFetchResult {
    let reply = tokio::time::timeout(
        FETCH_TIMEOUT,
        requester.request_without_error_body(notice_request(url, now_ms)),
    )
    .await;
    let result = match reply {
        Ok(Ok(reply)) => result_from_reply(&reply),
        Ok(Err(err)) => NotificationFetchResult::failed(err.to_string()),
        Err(_) => NotificationFetchResult::failed(TIMED_OUT),
    };
    match (&result.notifications, &result.error) {
        (Some(notifications), _) => log::debug!("[notification] fetched {} notices", notifications.len()),
        (None, Some(error)) => log::warn!("[notification] fetch failed: {error}"),
        (None, None) => {}
    }
    result
}

#[cfg(test)]
mod tests;
