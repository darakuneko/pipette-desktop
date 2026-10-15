// SPDX-License-Identifier: GPL-2.0-or-later
//! Opening links in the user's browser. The renderer has no other way to
//! leave the app: the main window only shows the app's own pages
//! (navigation.rs), and the opener plugin is called from here only, never
//! registered, so it exposes no commands to the page.

use tauri::{State, Url};

use crate::command_error::CommandError;

/// Hands a URL to the system. Managed state, so the IPC contract tests
/// (ipc_contract.rs) can record the URLs instead of opening a browser.
pub struct ExternalOpener(Box<OpenUrl>);

type OpenUrl = dyn Fn(&str) -> Result<(), tauri_plugin_opener::Error> + Send + Sync;

impl ExternalOpener {
    /// The user's default browser.
    pub fn system() -> Self {
        Self(Box::new(|url| tauri_plugin_opener::open_url(url, None::<&str>)))
    }

    #[cfg(test)]
    pub fn new(
        open: impl Fn(&str) -> Result<(), tauri_plugin_opener::Error> + Send + Sync + 'static,
    ) -> Self {
        Self(Box::new(open))
    }
}

/// Why a URL is not opened; the messages are those of the Electron main
/// process's `SHELL_OPEN_EXTERNAL` handler (src/main/index.ts).
#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum UrlError {
    #[error("Invalid URL")]
    Invalid,
    #[error("Invalid URL scheme")]
    Scheme,
}

/// `url` parsed as the WHATWG URL parser does (`new URL(url)`), if it is an
/// http or https URL.
pub fn web_url(url: &str) -> Result<Url, UrlError> {
    let parsed = Url::parse(url).map_err(|_| UrlError::Invalid)?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        _ => Err(UrlError::Scheme),
    }
}

/// Opens `url` in the user's browser if it is an http or https URL. The
/// browser gets the parsed URL, so it sees the same URL the check accepted.
#[tauri::command]
pub async fn open_external(opener: State<'_, ExternalOpener>, url: String) -> Result<(), CommandError> {
    let url = web_url(&url)?;
    (opener.0)(url.as_str())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https_urls() {
        assert_eq!(web_url("https://example.com/a?b=c#d").unwrap().as_str(), "https://example.com/a?b=c#d");
        assert_eq!(web_url("http://localhost:8080").unwrap().as_str(), "http://localhost:8080/");
        assert_eq!(web_url("HTTPS://Example.COM").unwrap().as_str(), "https://example.com/");
    }

    #[test]
    fn rejects_other_schemes() {
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<p>x</p>",
            "mailto:a@example.com",
            "ftp://example.com/",
            "tauri://localhost/tauri.html",
            "ipc://localhost/list_devices",
        ] {
            assert_eq!(web_url(url), Err(UrlError::Scheme), "{url}");
        }
    }

    #[test]
    fn rejects_what_is_not_a_url() {
        for url in ["", "example.com", "/relative/path", "https://", "http://exa mple.com"] {
            assert_eq!(web_url(url), Err(UrlError::Invalid), "{url}");
        }
    }

    #[test]
    fn errors_carry_the_electron_messages() {
        assert_eq!(CommandError::from(UrlError::Invalid), CommandError::new("Invalid URL"));
        assert_eq!(CommandError::from(UrlError::Scheme), CommandError::new("Invalid URL scheme"));
    }
}
