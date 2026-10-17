// SPDX-License-Identifier: GPL-2.0-or-later
//! The Hub of the app: its destination (`pipette_hub::HubDestination`),
//! settled once at launch, the client the commands send through and the
//! Hub JWT of this process, forgotten whenever the Google sign-in changes.
//! The Hub's background work, the startup update of the Hub-linked
//! language packs, starts only after the destination is settled, and not at
//! all when an e2e run's destination is blocked.

use std::sync::{Arc, Mutex, Weak};

use pipette_entry_store::Entry;
use pipette_google_auth::GoogleAuth;
use pipette_hub::startup_sync::{self, StartupPacks, StartupSyncOutcome, StartupSyncResult};
use pipette_hub::token::HubToken;
use pipette_hub::{BoxFuture, HubDestination, HubHttp, HubRequesters, IdTokenSource, SystemTiming};
use pipette_keyboard_stores::StoreContext;
use pipette_pack_stores::i18n::SavePackInput;
use tauri::{AppHandle, Manager, Runtime};
use zeroize::Zeroizing;

use crate::events::{I18N_PACK_CHANGED, emit_all};
use crate::sync_commands::SyncSecrets;

/// The Hub the commands use.
pub struct Hub {
    destination: HubDestination,
    http: HubHttp,
    token: Arc<HubToken>,
    /// What the last finished startup update of the language packs did.
    startup_sync: Mutex<Option<StartupSyncResult>>,
}

impl Hub {
    pub fn new(
        destination: HubDestination,
        requesters: HubRequesters,
        id_tokens: Arc<dyn IdTokenSource>,
    ) -> Self {
        let http = HubHttp::new(destination.base.clone(), requesters, Arc::new(SystemTiming));
        let token = Arc::new(HubToken::new(http.clone(), id_tokens));
        Self { destination, http, token, startup_sync: Mutex::new(None) }
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

    /// What the last startup update of the language packs that ran to its
    /// end did; `None` before one has.
    pub fn startup_sync_result(&self) -> Option<StartupSyncResult> {
        self.startup_sync.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
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

/// The language pack store of the startup update, read and written on a
/// blocking-task thread, as every store write.
struct BlockingPacks(StoreContext);

impl StartupPacks for BlockingPacks {
    fn list_metas(&self) -> BoxFuture<'_, Result<Vec<Entry>, String>> {
        let stores = self.0.clone();
        Box::pin(async move {
            tauri::async_runtime::spawn_blocking(move || pipette_pack_stores::i18n::list_metas(&stores))
                .await
                .map_err(|err| err.to_string())?
                .map_err(|err| format!("Error: {}", err.message))
        })
    }

    fn save_pack(&self, input: SavePackInput) -> BoxFuture<'_, Result<(), String>> {
        let stores = self.0.clone();
        Box::pin(async move {
            tauri::async_runtime::spawn_blocking(move || pipette_pack_stores::i18n::save_pack(&stores, input))
                .await
                .map_err(|err| err.to_string())?
                .map(|_| ())
                .map_err(|err| err.message)
        })
    }
}

/// Runs the startup update of the Hub-linked language packs once
/// (`startI18nStartupSync`): logs what it did, sends `i18n-pack:changed`
/// to every window when a pack changed, and records the counts. The pass
/// stops at a save boundary once the app quits; a stopped pass reports
/// nothing and records nothing.
pub async fn run_startup_sync<R: Runtime>(
    app: &AppHandle<R>,
    hub: &Hub,
    stores: StoreContext,
) -> StartupSyncOutcome {
    let quitting = || crate::lifecycle::is_quitting(app);
    let outcome = startup_sync::run(hub.http(), &BlockingPacks(stores), &quitting).await;
    for (level, message) in outcome.report() {
        log::log!(level, "{message}");
    }
    if outcome.changed() {
        emit_all(app, I18N_PACK_CHANGED, ());
    }
    if !outcome.stopped {
        *hub.startup_sync.lock().unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some(outcome.result.clone());
    }
    outcome
}

/// Starts the Hub's background work without waiting for it: the startup
/// update of the Hub-linked language packs, not in an e2e run whose Hub is
/// blocked. Runs at the end of the app's setup, after [`setup`] settled the
/// destination. The quit does not wait for it (Electron's before-quit
/// handler does not either).
pub fn start_background<R: Runtime>(app: &AppHandle<R>) {
    let Some(hub) = app.try_state::<Arc<Hub>>().map(|hub| Arc::clone(&hub)) else { return };
    if !hub.background_allowed() {
        return;
    }
    let Some(stores) = app.try_state::<StoreContext>().map(|stores| stores.inner().clone()) else {
        log::error!(
            "[hub] the stores are not managed; the startup update of the language packs does not run"
        );
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run_startup_sync(&app, &hub, stores).await;
    });
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

    mod startup_sync {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::time::{Duration, Instant};

        use pipette_hub::fake::FakeHub;
        use pipette_hub::packs::{self, PackKind};
        use pipette_js_json::{JsString, parse};
        use pipette_net::{HttpRequest, HttpRequester, RequestFuture};
        use pipette_pack_stores::Cached;
        use tauri::Listener;
        use tauri::test::{MockRuntime, mock_app};

        use super::*;
        use crate::events::I18N_PACK_CHANGED;

        const LOOPBACK: &[(&str, &str)] = &[("PIPETTE_HUB_URL", "http://127.0.0.1:9")];
        const DEADLINE: Duration = Duration::from_secs(10);

        /// The fake Hub behind a gate: requests wait until it opens.
        struct Gated {
            fake: Arc<FakeHub>,
            open: AtomicBool,
            sent: AtomicUsize,
        }

        impl HttpRequester for Gated {
            fn request(&self, request: HttpRequest) -> RequestFuture<'_> {
                self.sent.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    while !self.open.load(Ordering::SeqCst) {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    self.fake.request(request).await
                })
            }
        }

        fn gated(open: bool) -> Arc<Gated> {
            let fake = Arc::new(FakeHub::new());
            fake.set_user("alice@example.com", Some("Alice"), None);
            Arc::new(Gated { fake, open: AtomicBool::new(open), sent: AtomicUsize::new(0) })
        }

        /// An app with the stores on `user_data` and a Hub on `gate`.
        fn app(
            user_data: &std::path::Path,
            vars: &'static [(&'static str, &'static str)],
            gate: &Arc<Gated>,
        ) -> (tauri::App<MockRuntime>, Arc<Hub>) {
            let app = mock_app();
            crate::store_commands::keyboard_data::manage(app.handle(), user_data);
            let id_tokens: Arc<dyn IdTokenSource> = Arc::new(|| Some("test:alice@example.com".to_owned()));
            let hub = manage_with(
                app.handle(),
                destination(vars, true),
                HubRequesters::single(gate.clone()),
                id_tokens,
            );
            (app, hub)
        }

        /// A local pack linked to a post on the Hub, with a Hub time the Hub
        /// does not have.
        async fn stale_pack(app: &tauri::App<MockRuntime>, hub: &Hub) {
            let stores = app.state::<StoreContext>().inner().clone();
            let pack = parse(r#"{"name":"Japanese","version":"1.2.0","common":{"save":"保存"}}"#).unwrap();
            let input =
                SavePackInput { id: Some("pack-ja".into()), pack: Some(pack.clone()), ..Default::default() };
            pipette_pack_stores::i18n::save_pack(&stores, input).unwrap();
            let mut params = pipette_js_json::Object::new();
            params.insert("entryId", "pack-ja".into());
            params.insert("pack", pack);
            packs::upload(
                hub.token(),
                &stores,
                PackKind::I18n,
                Some(&pipette_js_json::Value::Object(params)),
            )
            .await;
            let post = pipette_pack_stores::i18n::list_metas(&stores)
                .unwrap()
                .into_iter()
                .find_map(|meta| match meta.get("hubPostId") {
                    Some(pipette_js_json::Value::String(post)) => Some(post.clone()),
                    _ => None,
                })
                .unwrap();
            let stale = Cached::Set(Some(JsString::from("2000-01-01 00:00:00.000Z")));
            pipette_pack_stores::i18n::set_hub_post_id(
                &stores,
                &"pack-ja".into(),
                Some(&post),
                Cached::Keep,
                stale,
            )
            .unwrap();
        }

        fn changes(app: &tauri::App<MockRuntime>) -> Arc<AtomicUsize> {
            let count = Arc::new(AtomicUsize::new(0));
            let counted = Arc::clone(&count);
            app.listen_any(I18N_PACK_CHANGED, move |_| {
                counted.fetch_add(1, Ordering::SeqCst);
            });
            count
        }

        async fn until(what: &str, done: impl Fn() -> bool) {
            let start = Instant::now();
            while !done() {
                assert!(start.elapsed() < DEADLINE, "timed out waiting for {what}");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }

        #[tokio::test]
        async fn the_launch_does_not_wait_for_the_update() {
            let user_data = tempfile::tempdir().unwrap();
            let gate = gated(true);
            let (app, hub) = app(user_data.path(), LOOPBACK, &gate);
            stale_pack(&app, &hub).await;
            let changed = changes(&app);
            gate.open.store(false, Ordering::SeqCst);
            gate.sent.store(0, Ordering::SeqCst);

            start_background(app.handle());
            // The timestamps request waits at the gate while the start has
            // returned.
            until("the timestamps request", || gate.sent.load(Ordering::SeqCst) > 0).await;
            assert!(hub.startup_sync_result().is_none());

            gate.open.store(true, Ordering::SeqCst);
            until("the update", || hub.startup_sync_result().is_some()).await;
            let result = hub.startup_sync_result().unwrap();
            assert_eq!((result.checked, result.updated, result.errors.len()), (1, 1, 0));
            until("the event", || changed.load(Ordering::SeqCst) == 1).await;
            let index = std::fs::read_to_string(user_data.path().join("sync/i18n/index.json")).unwrap();
            assert!(!index.contains("2000-01-01"), "{index}");
        }

        #[tokio::test]
        async fn a_blocked_e2e_hub_starts_no_update() {
            let user_data = tempfile::tempdir().unwrap();
            let gate = gated(true);
            let (app, hub) = app(user_data.path(), &[("PIPETTE_E2E", "1")], &gate);
            assert!(!hub.background_allowed());
            start_background(app.handle());
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert_eq!(gate.sent.load(Ordering::SeqCst), 0);
            assert!(hub.startup_sync_result().is_none());
        }

        #[tokio::test]
        async fn no_update_starts_before_the_hub_is_settled() {
            let app = mock_app();
            // Without the Hub managed there is nothing to start.
            start_background(app.handle());
            assert!(app.try_state::<Arc<Hub>>().is_none());
        }

        #[tokio::test]
        async fn a_quit_stops_the_update_before_it_saves() {
            let user_data = tempfile::tempdir().unwrap();
            let gate = gated(true);
            let (app, hub) = app(user_data.path(), LOOPBACK, &gate);
            stale_pack(&app, &hub).await;
            let changed = changes(&app);
            let before = std::fs::read_to_string(user_data.path().join("sync/i18n/index.json")).unwrap();
            crate::lifecycle::start_quitting_for_tests(app.handle());

            let stores = app.state::<StoreContext>().inner().clone();
            let outcome = run_startup_sync(app.handle(), &hub, stores).await;
            assert!(outcome.stopped);
            assert!(hub.startup_sync_result().is_none());
            let after = std::fs::read_to_string(user_data.path().join("sync/i18n/index.json")).unwrap();
            assert_eq!(before, after);
            tokio::time::sleep(Duration::from_millis(100)).await;
            assert_eq!(changed.load(Ordering::SeqCst), 0);
        }
    }
}
