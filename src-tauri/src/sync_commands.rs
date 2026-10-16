// SPDX-License-Identifier: GPL-2.0-or-later
//! The Cloud Sync commands, one module per group. The secrets (the Google
//! tokens and the sync password) stay in the backend: [`SyncSecrets`] holds
//! the secret store and the sign-in, and the commands answer the page only
//! with statuses and results.

use std::path::Path;
use std::sync::Arc;

use pipette_google_auth::{AuthConfig, AuthTiming, GoogleAuth, HUB_TEST_ACCOUNT_ENV, hub_test_account};
use pipette_net::{HttpError, HttpRequest, Limits};
use pipette_secret_store::{KEYSTORE_SERVICE, Keystore, SecretStore};
use pipette_sync_pending::PendingStore;
use tauri::{AppHandle, Manager, Runtime};

pub mod auth;
pub mod password;

/// The secret store and the Google sign-in of the sync.
pub struct SyncSecrets {
    pub secrets: Arc<SecretStore>,
    pub auth: Arc<GoogleAuth>,
}

/// The key store of this build: the OS key store, or in builds with the
/// development tools whatever `PIPETTE_DEV_KEYSTORE` picks.
fn keystore(user_data: &Path) -> Arc<dyn Keystore> {
    #[cfg(feature = "dev-tools")]
    {
        pipette_secret_store::dev_keystore_from_env(user_data, KEYSTORE_SERVICE)
    }
    #[cfg(not(feature = "dev-tools"))]
    {
        let _ = user_data;
        Arc::new(pipette_secret_store::OsKeystore::new(KEYSTORE_SERVICE))
    }
}

/// Manages the sync's secrets of `user_data` with the key store and the
/// Google endpoints of this build. Endpoints the environment makes unusable
/// (a development build with an incomplete or non-loopback set of endpoint
/// variables) leave no endpoint to go to: every token request is refused,
/// and nothing falls back to the real Google.
pub fn manage<R: Runtime>(app: &AppHandle<R>, user_data: &Path) {
    let user_agent = format!("Pipette/{}", app.package_info().version);
    let config = match pipette_net::google_endpoints() {
        Ok(endpoints) => {
            let http = Arc::new(endpoints.client(Limits::DEFAULT, user_agent));
            auth_config(endpoints.auth, endpoints.token, http)
        }
        Err(err) => {
            log::error!("[sync] the Google endpoints are unusable; the sync stays off: {err}");
            let refuse = |_: HttpRequest| Err(HttpError::Refused("an unusable Google endpoint".to_owned()));
            auth_config(String::new(), String::new(), Arc::new(refuse))
        }
    };
    manage_with(app, user_data, keystore(user_data), config);
    adopt_pending_at_startup(app);
}

/// Hands the pending units restored at startup to the account the stored
/// tokens belong to, without anything waiting for it (`setupSyncIpc` of
/// src/main/sync/sync-ipc.ts): units left while signed out go to it, and
/// another account's are held. Once the pending state is managed.
fn adopt_pending_at_startup<R: Runtime>(app: &AppHandle<R>) {
    let (Some(pending), Some(sync)) = (app.try_state::<PendingStore>(), app.try_state::<SyncSecrets>())
    else {
        log::error!("[sync] the pending changes are not managed; their owner is checked by the first upload");
        return;
    };
    let (pending, auth) = (pending.inner().clone(), Arc::clone(&sync.auth));
    tauri::async_runtime::spawn(async move {
        pending.adopt_for_account(auth.account_sub().await.as_deref());
    });
}

/// The sign-in's configuration with the app's clock and the Hub test
/// account of the environment.
fn auth_config(
    auth_endpoint: String,
    token_endpoint: String,
    http: Arc<dyn pipette_net::HttpRequester>,
) -> AuthConfig {
    AuthConfig {
        auth_endpoint,
        token_endpoint,
        http,
        timing: AuthTiming::default(),
        now_ms: Arc::new(pipette_time::now_ms),
        hub_test_account: Arc::new(|| {
            let base = pipette_net::hub_api_base(cfg!(feature = "dev-tools"));
            hub_test_account(std::env::var(HUB_TEST_ACCOUNT_ENV).ok(), &base)
        }),
    }
}

/// [`manage`] with a given key store and sign-in configuration (the tests'
/// in-memory key store).
pub fn manage_with<R: Runtime>(
    app: &AppHandle<R>,
    user_data: &Path,
    keystore: Arc<dyn Keystore>,
    config: AuthConfig,
) {
    let secrets = Arc::new(SecretStore::new(user_data, keystore));
    let auth = Arc::new(GoogleAuth::new(config, Arc::clone(&secrets)));
    app.manage(SyncSecrets { secrets, auth });
}

/// [`manage`] for the tests: an in-memory key store, no usable Google
/// endpoint (a sign-in is refused at once, as in a build whose endpoint
/// variables are unusable) and a browser that never opens.
#[cfg(test)]
pub fn manage_for_tests<R: Runtime>(app: &AppHandle<R>, user_data: &Path) {
    let offline = |_: HttpRequest| Err(HttpError::Network("offline".to_owned()));
    let mut config = auth_config(String::new(), String::new(), Arc::new(offline));
    config.hub_test_account = Arc::new(|| None);
    manage_with(app, user_data, Arc::new(pipette_secret_store::MemoryKeystore::default()), config);
    app.manage(crate::shell::AuthBrowser::new(|_| Err("no browser in the tests".to_owned())));
}
