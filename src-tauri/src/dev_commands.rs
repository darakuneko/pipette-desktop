// SPDX-License-Identifier: GPL-2.0-or-later
//! The one place that decides whether the development tools of
//! dev_commands/tools.rs are in the app: they are with the dev-tools feature,
//! which build.rs rejects in the release profile. The feature also lets the
//! environment point the sync's Google endpoints at loopback servers
//! (`pipette_net::google_endpoints`).

use tauri::ipc::Invoke;
use tauri::webview::PageLoadPayload;
use tauri::{AppHandle, Builder, Webview, Wry};

use pipette_net::{Limits, ReqwestClient};

use crate::dialog::SystemDialogs;

#[cfg(feature = "dev-tools")]
mod hub;
#[cfg(feature = "dev-tools")]
mod sync_auth;
#[cfg(feature = "dev-tools")]
mod sync_triggers;
#[cfg(feature = "dev-tools")]
mod tools;
#[cfg(feature = "dev-tools")]
mod tray;
#[cfg(feature = "dev-tools")]
mod window_ops;

/// Installs `app`, the handler of the app commands, and `on_page_load`, the
/// app's page load hook, on `builder`; with the dev-tools feature, together
/// with the development tools. The builder keeps one page load hook, so the
/// development tools run theirs after the app's.
pub fn install_or_passthrough<F, P>(builder: Builder<Wry>, app: F, on_page_load: P) -> Builder<Wry>
where
    F: Fn(Invoke<Wry>) -> bool + Send + Sync + 'static,
    P: Fn(&Webview<Wry>, &PageLoadPayload<'_>) + Send + Sync + 'static,
{
    #[cfg(feature = "dev-tools")]
    let builder = tools::install(builder, app, on_page_load);
    #[cfg(not(feature = "dev-tools"))]
    let builder = builder.invoke_handler(app).on_page_load(on_page_load);
    builder
}

/// Manages the file dialogs of the file commands: the system's, with the
/// dev-tools feature behind the queue of `dev_dialog_respond`.
pub fn manage_dialogs(app: &AppHandle<Wry>) {
    let system = SystemDialogs::new(app.clone());
    #[cfg(feature = "dev-tools")]
    tools::manage_queued_dialogs(app, system);
    #[cfg(not(feature = "dev-tools"))]
    tauri::Manager::manage(app, crate::dialog::Dialogs::new(system));
}

/// Manages the HTTP client every request goes through: the real one, with
/// the dev-tools feature behind the recorded responses of
/// `dev_http_respond`. In an e2e run (`crate::e2e_run`) the real client
/// sends only to the loopback interface, so a request no test recorded a
/// response for (a word list, a Hub dataset) never leaves the machine,
/// redirects included.
pub fn manage_http(app: &AppHandle<Wry>) {
    let user_agent = format!("Pipette/{}", app.package_info().version);
    let real = if crate::e2e_run::is_e2e_run() {
        ReqwestClient::loopback_only(Limits::DEFAULT, user_agent)
    } else {
        ReqwestClient::new(Limits::DEFAULT, user_agent)
    };
    #[cfg(feature = "dev-tools")]
    tools::manage_queued_http(app, real);
    #[cfg(not(feature = "dev-tools"))]
    tauri::Manager::manage(app, pipette_net::Http::new(real));
}

/// Manages the browser of the sync's sign-in: the system's, with the
/// dev-tools feature replaceable by the recorder of `dev_sync_last_auth_url`.
pub fn manage_auth_browser(app: &AppHandle<Wry>) {
    #[cfg(feature = "dev-tools")]
    sync_auth::manage(app);
    #[cfg(not(feature = "dev-tools"))]
    tauri::Manager::manage(app, crate::shell::AuthBrowser::system());
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_the_google_endpoint_variables_only_with_the_development_tools() {
        assert_eq!(pipette_net::ENDPOINT_OVERRIDES_COMPILED, cfg!(feature = "dev-tools"));
    }
}
