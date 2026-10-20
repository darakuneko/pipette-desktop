// SPDX-License-Identifier: GPL-2.0-or-later
//! The parts every sync entry point runs before it touches data
//! (`pipette_sync::preflight::Preflight`) on this app's Drive, and the
//! sync-format status of the update banner (`syncFormatStatus` and
//! `sync:format-status-changed`). The status is
//! checked at startup and whenever the sign-in changes.

use std::sync::{Arc, Weak};

use pipette_drive::DriveApi;
use pipette_drive::client::DriveClient;
use pipette_drive::http::{AccessTokenSource, HttpDrive, TokenFuture};
use pipette_drive::retry::SystemRetryEnv;
use pipette_google_auth::GoogleAuth;
use pipette_net::{HttpError, HttpRequest};
use pipette_sync::format::SyncFormatStatus;
use pipette_sync::preflight::{BoxFuture, Preflight, PreflightDeps, SignIn};
use pipette_typing_analytics::SyncRuntime;
use tauri::{AppHandle, Manager, Runtime, State};

use super::SyncSecrets;
use crate::command_error::CommandError;
use crate::events::{SYNC_FORMAT_STATUS_CHANGED, emit_all};

/// The access token of the signed-in account for the Drive requests.
struct GoogleTokens(Arc<GoogleAuth>);

impl AccessTokenSource for GoogleTokens {
    fn access_token(&self) -> TokenFuture<'_> {
        Box::pin(async move { Ok(self.0.access_token().await.map(|token| token.as_str().to_owned())) })
    }
}

struct GoogleSignIn(Arc<GoogleAuth>);

impl SignIn for GoogleSignIn {
    fn is_signed_in(&self) -> BoxFuture<'_, bool> {
        Box::pin(self.0.is_authenticated())
    }
}

/// The Drive of this build: the endpoints of `pipette_net::google_endpoints`,
/// or, when the environment makes them unusable (an e2e run without them
/// included), none: every request is refused and nothing falls back to the
/// real Drive.
fn drive_api(auth: &Arc<GoogleAuth>, user_agent: String) -> Arc<dyn DriveApi> {
    let tokens = GoogleTokens(Arc::clone(auth));
    match crate::e2e_run::google_endpoints() {
        Ok(endpoints) => Arc::new(HttpDrive::for_endpoints(&endpoints, tokens, user_agent)),
        Err(_) => {
            let refuse = |_: HttpRequest| Err(HttpError::Refused("an unusable Drive endpoint".to_owned()));
            Arc::new(HttpDrive::new(refuse, tokens, "", ""))
        }
    }
}

/// Manages the preflight on this build's Drive. Needs the sync's secrets
/// ([`super::manage`]) and the sync runtime (the typing analytics manage
/// it) to be managed first.
pub fn manage<R: Runtime>(app: &AppHandle<R>) {
    let auth = Arc::clone(&app.state::<SyncSecrets>().auth);
    let user_agent = format!("Pipette/{}", app.package_info().version);
    manage_with(app, drive_api(&auth, user_agent));
}

/// [`manage`] on `drive`.
pub fn manage_with<R: Runtime>(app: &AppHandle<R>, drive: Arc<dyn DriveApi>) {
    let runtime = app.state::<SyncRuntime>().inner().clone();
    let sync = app.state::<SyncSecrets>();
    let quitting = runtime.clone();
    let preflight = Preflight::new(PreflightDeps {
        drive: DriveClient::new(drive, Arc::new(SystemRetryEnv::new(move || quitting.is_quitting()))),
        runtime,
        passwords: sync.secrets.clone(),
        sign_in: Arc::new(GoogleSignIn(Arc::clone(&sync.auth))),
        auth_dir: sync.secrets.auth_dir().to_path_buf(),
        now_ms: Arc::new(|| u64::try_from(pipette_time::now_ms()).unwrap_or(0)),
    });
    let handle = app.clone();
    preflight
        .set_sync_format_status_listener(move |status| emit_all(&handle, SYNC_FORMAT_STATUS_CHANGED, status));
    // What was learned about one account is not used for the next; its
    // Drive is checked afresh. This listener is the one place the
    // preflight's caches are forgotten on a sign-in or sign-out; it runs
    // inside the account switch (pipette_sync::account), before the switch
    // ends. Weak: the sign-in outlives nothing here.
    let weak: Weak<Preflight> = Arc::downgrade(&preflight);
    sync.auth.on_account_changed(move || {
        let Some(preflight) = weak.upgrade() else { return };
        preflight.forget_account();
        tauri::async_runtime::spawn(async move {
            refresh_if_signed_in(&preflight).await;
        });
    });
    app.manage(Arc::clone(&preflight));
    tauri::async_runtime::spawn(async move {
        refresh_if_signed_in(&preflight).await;
    });
}

/// Checks Drive's markers when signed in. Never fails: `None` when signed
/// out, or when Drive cannot be listed and nothing was known before.
async fn refresh_if_signed_in(preflight: &Arc<Preflight>) -> Option<SyncFormatStatus> {
    if !preflight.is_signed_in().await {
        return None;
    }
    preflight.refresh_sync_format_status().await
}

/// The sync-format status for the update banner: the one known, else a
/// check of Drive's markers when signed in. Every later change is sent as
/// `sync:format-status-changed`.
#[tauri::command]
pub async fn sync_format_status(
    preflight: State<'_, Arc<Preflight>>,
) -> Result<Option<SyncFormatStatus>, CommandError> {
    match preflight.cached_sync_format_status() {
        Some(status) => Ok(Some(status)),
        None => Ok(refresh_if_signed_in(&preflight).await),
    }
}

/// [`manage`] for the tests: an empty in-memory Drive.
#[cfg(test)]
pub fn manage_for_tests<R: Runtime>(app: &AppHandle<R>) {
    manage_with(app, Arc::new(pipette_drive::fake::InMemoryDrive::new()));
}
