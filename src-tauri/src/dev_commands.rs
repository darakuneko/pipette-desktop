// SPDX-License-Identifier: GPL-2.0-or-later
//! The one place that decides whether the development tools of
//! dev_commands/tools.rs are in the app: they are with the dev-tools feature,
//! which build.rs rejects in the release profile.

use tauri::ipc::Invoke;
use tauri::webview::PageLoadPayload;
use tauri::{Builder, Webview, Wry};

#[cfg(feature = "dev-tools")]
mod tools;

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
