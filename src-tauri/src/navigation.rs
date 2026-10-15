// SPDX-License-Identifier: GPL-2.0-or-later
//! Keeps the main window on the app's own pages: navigating anywhere else
//! is cancelled and no page can open a window (`window.open`, links with a
//! target). Links meant for the browser go through the `open_external`
//! command (shell.rs). The commands are guarded separately: the capabilities
//! grant them to the main window's local pages only.

use tauri::webview::NewWindowResponse;
use tauri::{Manager, Runtime, Url, WebviewWindowBuilder};

/// Whether `url` is a page of the app: the bundled pages, served from
/// `tauri://localhost` (Linux, macOS) or `http://tauri.localhost`
/// (Windows), or the development server `dev_url`.
pub fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    let bundled = matches!(
        (url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http", Some("tauri.localhost"))
    ) && url.port().is_none();
    bundled || dev_url.is_some_and(|dev| same_origin(url, dev))
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// The development server, in the builds whose window loads it. tauri-build
/// sets `cfg(dev)` exactly when the tauri crate is built without its
/// custom-protocol feature, which is also when Tauri loads `build.devUrl`
/// instead of the embedded pages. `tauri build`, which makes every bundle,
/// enables custom-protocol, so no bundled build counts the dev server as the
/// app's. The release profile alone is not the condition: `cargo build
/// --release` without custom-protocol keeps `cfg(dev)` and loads the dev
/// server.
pub fn dev_url(config: &tauri::Config) -> Option<Url> {
    if cfg!(dev) { config.build.dev_url.clone() } else { None }
}

/// Adds the navigation and new-window handlers to the builder of a window.
pub fn guard<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    dev_url: Option<Url>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
        .on_navigation(move |url| {
            let allowed = is_app_url(url, dev_url.as_ref());
            if !allowed {
                log::warn!("blocked navigation to {url}");
            }
            allowed
        })
        .on_new_window(|url, _features| {
            log::warn!("blocked a new window for {url}");
            NewWindowResponse::Deny
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        text.parse().unwrap()
    }

    #[test]
    fn allows_the_bundled_pages() {
        for page in
            ["tauri://localhost/tauri.html", "tauri://localhost/", "http://tauri.localhost/tauri.html#/x"]
        {
            assert!(is_app_url(&url(page), None), "{page}");
        }
    }

    #[test]
    fn blocks_everything_else() {
        for page in [
            "https://example.com/",
            "http://example.com/",
            "https://tauri.localhost/",
            "http://tauri.localhost:8080/",
            "tauri://localhost:1/",
            "tauri://example.com/",
            "http://localhost:5173/tauri.html",
            "http://localhost/",
            "file:///etc/passwd",
            "about:blank",
            "data:text/html,<p>x</p>",
            "javascript:alert(1)",
            "ipc://localhost/list_devices",
        ] {
            assert!(!is_app_url(&url(page), None), "{page}");
        }
    }

    #[test]
    fn allows_the_dev_server_only_when_given() {
        let dev = url("http://localhost:5173");
        assert!(is_app_url(&url("http://localhost:5173/tauri.html"), Some(&dev)));
        assert!(is_app_url(&url("tauri://localhost/tauri.html"), Some(&dev)));
        for page in [
            "http://localhost:5174/",
            "https://localhost:5173/",
            "http://127.0.0.1:5173/",
            "http://localhost/",
        ] {
            assert!(!is_app_url(&url(page), Some(&dev)), "{page}");
        }
    }

    #[test]
    fn the_dev_server_counts_only_where_the_window_loads_it() {
        let mut config = tauri::Config::default();
        config.build.dev_url = Some(url("http://localhost:5173"));
        let expected = if cfg!(dev) { Some(url("http://localhost:5173")) } else { None };
        assert_eq!(dev_url(&config), expected);
    }
}
