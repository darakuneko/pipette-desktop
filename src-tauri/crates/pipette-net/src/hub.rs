// SPDX-License-Identifier: GPL-2.0-or-later
//! The Hub API base URL: the production Hub, or the `PIPETTE_HUB_URL`
//! override where it is allowed. The environment is read on every call.
//! Also the encoding of the values the Hub API routes carry.

/// The production Hub.
pub const HUB_API_DEFAULT: &str = "https://pipette-hub-worker.keymaps.workers.dev";

/// The base URL that replaces [`HUB_API_DEFAULT`] where an override is
/// allowed.
pub const HUB_URL_ENV: &str = "PIPETTE_HUB_URL";

/// Set to `1`, allows the [`HUB_URL_ENV`] override in any build (the e2e
/// and screenshot runs of a production build).
pub const HUB_TEST_ENV: &str = "PIPETTE_HUB_TEST";

/// The Hub API base URL for this process. The override is allowed in
/// builds with the development tools (`dev_tools_build`) and wherever
/// [`HUB_TEST_ENV`] is `1`. A
/// variable that is not valid UTF-8 counts as unset.
pub fn hub_api_base(dev_tools_build: bool) -> String {
    let override_url = std::env::var(HUB_URL_ENV).ok();
    let allowed = dev_tools_build || std::env::var(HUB_TEST_ENV).is_ok_and(|value| value == "1");
    resolve_hub_api_base(override_url.as_deref(), allowed)
}

/// [`hub_api_base`] for given values: a non-empty `override_url` when
/// `override_allowed`, its trailing slashes stripped, else the default.
pub fn resolve_hub_api_base(override_url: Option<&str>, override_allowed: bool) -> String {
    match override_url {
        Some(url) if !url.is_empty() && override_allowed => url.trim_end_matches('/').to_owned(),
        _ => HUB_API_DEFAULT.to_owned(),
    }
}

/// `encodeURIComponent` of a string (a Rust string has no lone surrogate,
/// on which JavaScript throws): every byte of the UTF-8 form other than
/// `A-Z a-z 0-9 - _ . ! ~ * ' ( )` as `%XX` with uppercase hex digits. For
/// the path segments of Hub API routes.
pub fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_the_production_hub_without_an_allowed_override() {
        assert_eq!(resolve_hub_api_base(None, true), HUB_API_DEFAULT);
        assert_eq!(resolve_hub_api_base(Some("http://localhost:8787"), false), HUB_API_DEFAULT);
        // An empty variable is falsy in `if (override && …)`.
        assert_eq!(resolve_hub_api_base(Some(""), true), HUB_API_DEFAULT);
    }

    #[test]
    fn uses_an_allowed_override_without_its_trailing_slashes() {
        assert_eq!(resolve_hub_api_base(Some("http://localhost:8787"), true), "http://localhost:8787");
        assert_eq!(resolve_hub_api_base(Some("http://localhost:8787///"), true), "http://localhost:8787");
        assert_eq!(resolve_hub_api_base(Some("http://h/a/"), true), "http://h/a");
        // `'/'.replace(/\/+$/, '')` is the empty string, and so is this.
        assert_eq!(resolve_hub_api_base(Some("//"), true), "");
    }

    #[test]
    fn encodes_as_encode_uri_component() {
        assert_eq!(encode_uri_component("monkeytype"), "monkeytype");
        assert_eq!(encode_uri_component("a b/é?#&=+%"), "a%20b%2F%C3%A9%3F%23%26%3D%2B%25");
        assert_eq!(encode_uri_component("-_.!~*'()AZaz09"), "-_.!~*'()AZaz09");
        assert_eq!(encode_uri_component("😀"), "%F0%9F%98%80");
    }
}
