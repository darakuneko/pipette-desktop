// SPDX-License-Identifier: GPL-2.0-or-later
//! The Hub of the app: its destination (`pipette_hub::HubDestination`),
//! settled once at launch, the client the commands send through and the
//! Hub JWT of this process, forgotten whenever the Google sign-in changes.
//! The Hub's background work starts only after the destination is settled,
//! and not at all when an e2e run's destination is blocked.

use std::sync::{Arc, Weak};

use pipette_google_auth::GoogleAuth;
use pipette_hub::token::HubToken;
use pipette_hub::{BoxFuture, HubDestination, HubHttp, HubRequesters, IdTokenSource, SystemTiming};
use tauri::{AppHandle, Manager, Runtime};
use zeroize::Zeroizing;

use crate::sync_commands::SyncSecrets;

/// The Hub the commands use.
pub struct Hub {
    destination: HubDestination,
    http: HubHttp,
    token: Arc<HubToken>,
}

impl Hub {
    pub fn new(
        destination: HubDestination,
        requesters: HubRequesters,
        id_tokens: Arc<dyn IdTokenSource>,
    ) -> Self {
        let http = HubHttp::new(destination.base.clone(), requesters, Arc::new(SystemTiming));
        let token = Arc::new(HubToken::new(http.clone(), id_tokens));
        Self { destination, http, token }
    }

    pub fn destination(&self) -> &HubDestination {
        &self.destination
    }

    pub fn http(&self) -> &HubHttp {
        &self.http
    }

    /// The Hub JWT and the requests that need it.
    pub fn token(&self) -> &HubToken {
        &self.token
    }

    /// Whether the Hub's background work may start: not in an e2e run
    /// whose Hub is not on the loopback interface.
    pub fn background_allowed(&self) -> bool {
        !self.destination().blocked
    }
}

/// The Google id_token of the sync's sign-in (`getIdToken`).
struct GoogleIdTokens(Arc<GoogleAuth>);

impl IdTokenSource for GoogleIdTokens {
    fn id_token(&self) -> BoxFuture<'_, Option<Zeroizing<String>>> {
        Box::pin(self.0.id_token())
    }
}

/// No one is signed in: for an app whose sync is not managed.
fn signed_out() -> Option<String> {
    None
}

/// The id_tokens of the sync's sign-in, when it is managed.
fn id_tokens<R: Runtime>(app: &AppHandle<R>) -> Arc<dyn IdTokenSource> {
    match app.try_state::<SyncSecrets>() {
        Some(sync) => Arc::new(GoogleIdTokens(Arc::clone(&sync.auth))),
        None => {
            log::error!(
                "[hub] the sync is not managed; the Hub requests that need a token fail as signed out"
            );
            Arc::new(signed_out)
        }
    }
}

/// Forgets the Hub JWT whenever the stored sign-in changes: a sign-in, a
/// sign-out, and the Reset Local Data that signs out (`forgetAccountCaches`
/// of src/main/sync/sync-account-caches.ts). The sign-in calls this after
/// it stored the new tokens or removed them, inside the account switch, as
/// Electron does. Weak: the sign-in outlives nothing here.
fn forget_token_on_account_change<R: Runtime>(app: &AppHandle<R>, hub: &Arc<Hub>) {
    let Some(sync) = app.try_state::<SyncSecrets>() else { return };
    let weak: Weak<HubToken> = Arc::downgrade(&hub.token);
    sync.auth.on_account_changed(move || {
        if let Some(token) = weak.upgrade() {
            token.clear();
        }
    });
}

/// Settles the Hub destination of this process and manages the Hub; its
/// background work may start only after this, and only when
/// [`Hub::background_allowed`]. Runs before the window opens, so no Hub
/// request leaves before the destination is checked. Needs the sync
/// (its sign-in) to be managed first.
pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    let destination = HubDestination::from_process_env(cfg!(feature = "dev-tools"));
    let user_agent = format!("Pipette/{}", app.package_info().version);
    let requesters = destination.requesters(&user_agent);
    let hub = manage_with(app, destination, requesters, id_tokens(app));
    if !hub.background_allowed() {
        log::warn!(
            "[hub] PIPETTE_E2E=1 without a Hub on the loopback interface: every Hub request is refused and no \
             Hub work runs in the background"
        );
    }
}

/// Manages a Hub on `destination` through `requesters`, exchanging the
/// `id_tokens` for its JWT, which is forgotten when the sync's sign-in
/// changes.
pub fn manage_with<R: Runtime>(
    app: &AppHandle<R>,
    destination: HubDestination,
    requesters: HubRequesters,
    id_tokens: Arc<dyn IdTokenSource>,
) -> Arc<Hub> {
    let hub = Arc::new(Hub::new(destination, requesters, id_tokens));
    forget_token_on_account_change(app, &hub);
    app.manage(Arc::clone(&hub));
    hub
}

/// [`manage_with`] for the tests: the production Hub's address with every
/// request failing as offline, so nothing is sent anywhere, and the sync's
/// sign-in when it is managed.
#[cfg(test)]
pub fn manage_for_tests<R: Runtime>(app: &AppHandle<R>) -> Arc<Hub> {
    use pipette_net::{HttpError, HttpRequest, HttpRequester};
    let destination = HubDestination::resolve(false, &|_| None);
    let offline: Arc<dyn HttpRequester> =
        Arc::new(|_: HttpRequest| Err(HttpError::Network("offline".to_owned())));
    manage_with(app, destination, HubRequesters::single(offline), id_tokens(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn destination(vars: &'static [(&'static str, &'static str)], dev_tools: bool) -> HubDestination {
        HubDestination::resolve(dev_tools, &|name| {
            vars.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned())
        })
    }

    fn refused() -> HubRequesters {
        let refuse: Arc<dyn pipette_net::HttpRequester> =
            Arc::new(|_: pipette_net::HttpRequest| Err(pipette_net::HttpError::Refused("test".to_owned())));
        HubRequesters::single(refuse)
    }

    #[test]
    fn an_e2e_run_without_a_loopback_hub_starts_no_background_work() {
        for vars in [
            &[("PIPETTE_E2E", "1")][..],
            &[("PIPETTE_E2E", "1"), ("PIPETTE_HUB_URL", "https://example.com")][..],
            &[("PIPETTE_E2E", "1"), ("PIPETTE_HUB_URL", "")][..],
        ] {
            let hub = Hub::new(destination(vars, true), refused(), Arc::new(signed_out));
            assert!(!hub.background_allowed(), "{vars:?}");
        }
        let looped = Hub::new(
            destination(&[("PIPETTE_E2E", "1"), ("PIPETTE_HUB_URL", "http://127.0.0.1:9")], true),
            refused(),
            Arc::new(signed_out),
        );
        assert!(looped.background_allowed());
        assert_eq!(looped.http().base(), "http://127.0.0.1:9");
        // Outside an e2e run the destination is Electron's, the real Hub.
        let normal = Hub::new(destination(&[], false), refused(), Arc::new(signed_out));
        assert!(normal.background_allowed());
        assert_eq!(normal.http().base(), pipette_net::HUB_API_DEFAULT);
    }
}
