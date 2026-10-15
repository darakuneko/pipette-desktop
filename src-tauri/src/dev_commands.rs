// SPDX-License-Identifier: GPL-2.0-or-later
//! The one place that decides whether the development tools of
//! dev_commands/tools.rs are in the app: they are with the dev-tools feature,
//! which build.rs rejects in the release profile.

use tauri::ipc::Invoke;
use tauri::{Builder, Wry};

#[cfg(feature = "dev-tools")]
mod tools;

/// Installs `app`, the handler of the app commands, on `builder`; with the
/// dev-tools feature, together with the development tools.
pub fn install_or_passthrough<F>(builder: Builder<Wry>, app: F) -> Builder<Wry>
where
    F: Fn(Invoke<Wry>) -> bool + Send + Sync + 'static,
{
    #[cfg(feature = "dev-tools")]
    let builder = tools::install(builder, app);
    #[cfg(not(feature = "dev-tools"))]
    let builder = builder.invoke_handler(app);
    builder
}
