// SPDX-License-Identifier: GPL-2.0-or-later
//! `fetchVerifiedBytes` of src/main/download-util.ts: a file from a
//! Hub-provided URL, checked against the byte size its manifest entry
//! declares. Used by the word list downloads and the Aozora Bunko import.

use std::fmt;

use pipette_net::{HttpClient, HttpError};

/// How many bytes came back when they were not the expected number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Received {
    Bytes(u64),
    /// The client stopped reading past its body size limit.
    MoreThan(u64),
}

impl fmt::Display for Received {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Received::Bytes(n) => write!(f, "{n}"),
            Received::MoreThan(limit) => write!(f, "more than {limit}"),
        }
    }
}

/// Why no verified bytes came back.
#[derive(Debug)]
pub enum FetchFailure {
    /// A response that is not 2xx.
    Http(u16),
    SizeMismatch {
        expected: f64,
        actual: Received,
    },
    /// No response.
    Network(HttpError),
}

/// `size mismatch (expected …, got …)`, with the expected size written as
/// `${number}` writes it.
pub fn size_mismatch_detail(expected: f64, actual: Received) -> String {
    format!("size mismatch (expected {}, got {actual})", number_text(expected))
}

/// `String(number)`.
pub(crate) fn number_text(value: f64) -> String {
    if value.is_nan() {
        "NaN".to_owned()
    } else if value.is_infinite() {
        if value > 0.0 { "Infinity" } else { "-Infinity" }.to_owned()
    } else {
        let mut text = String::new();
        pipette_js_json::write_number(&mut text, value);
        text
    }
}

/// Fetches `url` and checks the status and that the body is
/// `expected_size` bytes. A body past the client's size limit is a size
/// mismatch, as the byte count would be in Electron, which reads it whole.
pub async fn fetch_verified_bytes(
    http: &dyn HttpClient,
    url: &str,
    expected_size: f64,
) -> Result<Vec<u8>, FetchFailure> {
    let response = match http.get_bytes(url).await {
        Ok(response) => response,
        Err(HttpError::TooLarge { limit }) => {
            return Err(FetchFailure::SizeMismatch {
                expected: expected_size,
                actual: Received::MoreThan(limit),
            });
        }
        Err(err) => return Err(FetchFailure::Network(err)),
    };
    if !response.ok() {
        return Err(FetchFailure::Http(response.status));
    }
    let length = response.body.len() as u64;
    // Lengths are far below 2^53, so the conversion is exact.
    if length as f64 != expected_size {
        return Err(FetchFailure::SizeMismatch { expected: expected_size, actual: Received::Bytes(length) });
    }
    Ok(response.body)
}

#[cfg(test)]
mod tests {
    use pipette_net::HttpResponse;

    use super::*;

    fn fetch(result: Result<HttpResponse, HttpError>, expected: f64) -> Result<Vec<u8>, FetchFailure> {
        let cell = std::sync::Mutex::new(Some(result));
        let client = move |_: &str| cell.lock().unwrap().take().unwrap();
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(fetch_verified_bytes(
            &client,
            "https://h/x",
            expected,
        ))
    }

    #[test]
    fn checks_the_status_then_the_size() {
        let ok = |body: &[u8]| Ok(HttpResponse { status: 200, body: body.to_vec() });
        assert_eq!(fetch(ok(b"abc"), 3.0).unwrap(), b"abc");
        assert!(matches!(
            fetch(Ok(HttpResponse { status: 404, body: Vec::new() }), 3.0),
            Err(FetchFailure::Http(404))
        ));
        assert!(matches!(
            fetch(ok(b"ab"), 3.0),
            Err(FetchFailure::SizeMismatch { expected: 3.0, actual: Received::Bytes(2) })
        ));
        assert!(matches!(
            fetch(Err(HttpError::TooLarge { limit: 10 }), 3.0),
            Err(FetchFailure::SizeMismatch { actual: Received::MoreThan(10), .. })
        ));
        assert!(matches!(
            fetch(Err(HttpError::Timeout), 3.0),
            Err(FetchFailure::Network(HttpError::Timeout))
        ));
    }

    #[test]
    fn writes_the_expected_size_as_javascript_does() {
        assert_eq!(size_mismatch_detail(2.5, Received::Bytes(2)), "size mismatch (expected 2.5, got 2)");
        assert_eq!(
            size_mismatch_detail(1e21, Received::MoreThan(67_108_864)),
            "size mismatch (expected 1e+21, got more than 67108864)"
        );
        assert_eq!(
            size_mismatch_detail(f64::INFINITY, Received::Bytes(1)),
            "size mismatch (expected Infinity, got 1)"
        );
    }
}
