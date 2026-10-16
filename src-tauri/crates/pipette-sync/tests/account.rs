// SPDX-License-Identifier: GPL-2.0-or-later
//! The sign-in and sign-out specs of
//! src/main/sync/__tests__/sync-pending-store.test.ts ("switching to a new
//! sign-in", "signing out"): the waits for running sync work on Tokio's
//! paused clock, the pending units on a temporary userData directory, and
//! the stored sign-in a fake that records what happened in which order.

#![allow(clippy::unwrap_used)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use pipette_google_auth::{AuthConfig, AuthError, AuthTiming, GoogleAuth};
use pipette_net::{HttpError, HttpReply, HttpRequest};
use pipette_secret_store::{MemoryKeystore, SecretStore};
use pipette_sync::account::{
    ACCOUNT_SWITCH_BUSY_MESSAGE, ACCOUNT_SWITCH_WAIT, AccountSwitchError, AccountSwitcher,
    SIGN_OUT_PASSWORD_CHANGING, SignedInAccount,
};
use pipette_sync_pending::{PendingStore, Scheduler};
use pipette_sync_runtime::SyncRuntime;
use serde_json::json;
use tempfile::TempDir;

/// Drops the delayed writes: the writes these specs look at are the ones
/// made at once.
struct NoDelayedWrites;

impl Scheduler for NoDelayedWrites {
    fn schedule(&self, _: Duration, _: Box<dyn FnOnce() + Send>) {}
}

/// The stored sign-in: its account and the order of what was done to it.
#[derive(Default)]
struct FakeAccount {
    sub: Mutex<Option<String>>,
    events: Mutex<Vec<String>>,
    /// The pending store and the runtime the sign-out finds.
    seen: Mutex<Option<(PendingStore, SyncRuntime)>>,
}

impl FakeAccount {
    fn signed_in_as(sub: &str) -> Arc<Self> {
        let account = Self::default();
        *account.sub.lock().unwrap() = Some(sub.to_owned());
        Arc::new(account)
    }

    fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }
}

impl SignedInAccount for FakeAccount {
    async fn account_sub(&self) -> Option<String> {
        self.sub.lock().unwrap().clone()
    }

    async fn sign_out(&self) {
        let seen = self.seen.lock().unwrap().as_ref().map(|(pending, runtime)| {
            format!("holding {:?}, locked {}", held(pending), runtime.is_syncing())
        });
        self.events.lock().unwrap().push(format!("sign-out {}", seen.unwrap_or_default()));
        *self.sub.lock().unwrap() = None;
    }
}

struct Harness {
    dir: TempDir,
    runtime: SyncRuntime,
    pending: PendingStore,
    account: Arc<FakeAccount>,
    switcher: Arc<AccountSwitcher<FakeAccount>>,
}

impl Harness {
    /// The pending file `file` (with its version) and the stored sign-in
    /// of `account`.
    fn new(file: serde_json::Value, account: Arc<FakeAccount>) -> Self {
        let dir = TempDir::new().unwrap();
        let mut file = file;
        file["version"] = json!(1);
        std::fs::create_dir_all(dir.path().join("local")).unwrap();
        std::fs::write(dir.path().join("local").join("sync-pending.json"), file.to_string()).unwrap();
        let pending = PendingStore::restore(dir.path(), Arc::new(NoDelayedWrites), Box::new(|_| {}));
        let runtime = SyncRuntime::new();
        *account.seen.lock().unwrap() = Some((pending.clone(), runtime.clone()));
        let switcher = Arc::new(AccountSwitcher::new(runtime.clone(), pending.clone(), Arc::clone(&account)));
        Self { dir, runtime, pending, account, switcher }
    }

    fn pending_path(&self) -> std::path::PathBuf {
        self.dir.path().join("local").join("sync-pending.json")
    }

    fn file(&self) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(self.pending_path()).unwrap()).unwrap()
    }

    fn block_writes(&self) {
        let _ = std::fs::remove_file(self.pending_path());
        std::fs::create_dir_all(self.pending_path().join("blocker")).unwrap();
    }

    /// Remembers a created file, as the previous account's cache.
    fn fill_caches(&self) {
        self.runtime.remote().remember_created_file("favorites_macro.enc", "file-id");
    }

    fn caches_forgotten(&self) -> bool {
        self.runtime.remote().created_file_id("favorites_macro.enc").is_none()
    }

    fn sign_in(
        &self,
        new_sub: &str,
        store: impl std::future::Future<Output = Result<(), AuthError>> + Send + 'static,
    ) -> tokio::task::JoinHandle<Result<(), AccountSwitchError>> {
        let switcher = Arc::clone(&self.switcher);
        let new_sub = Some(new_sub.to_owned());
        tokio::spawn(async move { switcher.switch_account_keeping_pending(store, new_sub).await })
    }

    fn sign_out(&self) -> tokio::task::JoinHandle<Result<(), AccountSwitchError>> {
        let switcher = Arc::clone(&self.switcher);
        tokio::spawn(async move { switcher.sign_out_keeping_pending().await })
    }
}

fn active(pending: &PendingStore) -> Vec<String> {
    let mut units: Vec<String> =
        pending.snapshot_generations().keys().map(|u| u.as_str().unwrap().to_owned()).collect();
    units.sort();
    units
}

fn held(pending: &PendingStore) -> Vec<(String, Vec<String>)> {
    pending
        .held()
        .into_iter()
        .map(|(sub, units)| {
            (sub.as_str().unwrap().to_owned(), units.iter().map(|u| u.as_str().unwrap().to_owned()).collect())
        })
        .collect()
}

fn owner(pending: &PendingStore) -> Option<String> {
    pending.owner().map(|owner| owner.as_str().unwrap().to_owned())
}

/// A store step that records whether the sync lock was held while it ran.
fn recording_store(
    runtime: &SyncRuntime,
) -> (impl Future<Output = Result<(), AuthError>> + Send + 'static, Arc<Mutex<Option<bool>>>) {
    let seen = Arc::new(Mutex::new(None));
    let (runtime, record) = (runtime.clone(), Arc::clone(&seen));
    (
        async move {
            *record.lock().unwrap() = Some(runtime.is_syncing());
            Ok(())
        },
        seen,
    )
}

async fn settle() {
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
}

mod switching_to_a_new_sign_in {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn stores_the_new_tokens_only_after_the_running_pass_ends_holding_the_lock_then_hands_the_units_over()
     {
        let h = Harness::new(
            json!({ "owner": "account-a", "units": ["favorites/tapDance"], "held": {} }),
            FakeAccount::signed_in_as("account-a"),
        );
        let pass = h.runtime.try_claim_sync_lock(false).unwrap();
        let (store, locked_while_storing) = recording_store(&h.runtime);

        let switching = h.sign_in("account-b", store);
        settle().await;
        assert_eq!(*locked_while_storing.lock().unwrap(), None);
        assert!(h.runtime.account_switching());

        drop(pass);
        switching.await.unwrap().unwrap();

        assert_eq!(*locked_while_storing.lock().unwrap(), Some(true));
        assert!(!h.runtime.is_syncing() && !h.runtime.account_switching());
        assert_eq!(held(&h.pending), [("account-a".to_owned(), vec!["favorites/tapDance".to_owned()])]);
        assert_eq!(h.file()["owner"], "account-b");
    }

    #[tokio::test(start_paused = true)]
    async fn forgets_the_previous_accounts_caches_after_storing_the_tokens() {
        let h = Harness::new(
            json!({ "owner": "account-a", "units": [], "held": {} }),
            FakeAccount::signed_in_as("account-a"),
        );
        h.fill_caches();
        let runtime = h.runtime.clone();
        let created_while_storing = Arc::new(Mutex::new(None));
        let record = Arc::clone(&created_while_storing);
        let store = async move {
            *record.lock().unwrap() = runtime.remote().created_file_id("favorites_macro.enc");
            Ok(())
        };

        h.sign_in("account-b", store).await.unwrap().unwrap();

        assert_eq!(created_while_storing.lock().unwrap().as_deref(), Some("file-id"));
        assert!(h.caches_forgotten());
    }

    #[tokio::test(start_paused = true)]
    async fn waits_for_an_analytics_sync_and_a_remote_day_fetch_to_finish() {
        let h = Harness::new(json!({ "owner": null, "units": [], "held": {} }), Arc::default());
        let analytics = h.runtime.try_start_analytics_sync("uid1").unwrap();
        let fetch = h.runtime.try_start_remote_day_fetch("uid2").unwrap();
        let (store, stored) = recording_store(&h.runtime);

        let switching = h.sign_in("account-b", store);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(*stored.lock().unwrap(), None);
        // No new lock-free writer starts while the switch waits.
        assert!(h.runtime.try_start_analytics_sync("uid3").is_none());

        drop((analytics, fetch));
        tokio::time::sleep(Duration::from_millis(200)).await;
        switching.await.unwrap().unwrap();

        assert_eq!(*stored.lock().unwrap(), Some(true));
    }

    async fn refused_past_the_wait(h: &Harness) {
        let (store, stored) = recording_store(&h.runtime);
        h.fill_caches();
        let started = tokio::time::Instant::now();

        let refused = h.sign_in("account-b", store).await.unwrap().unwrap_err();

        assert!(matches!(refused, AccountSwitchError::Busy));
        assert_eq!(refused.to_string(), ACCOUNT_SWITCH_BUSY_MESSAGE);
        assert_eq!(refused.reason(), Some("syncBusy"));
        assert_eq!(started.elapsed(), ACCOUNT_SWITCH_WAIT);
        assert_eq!(*stored.lock().unwrap(), None);
        assert!(!h.caches_forgotten());
        assert!(!h.runtime.account_switching());
        assert_eq!(active(&h.pending), ["favorites/tapDance"]);
        assert_eq!(owner(&h.pending).as_deref(), Some("account-a"));
    }

    #[tokio::test(start_paused = true)]
    async fn fails_without_storing_the_tokens_when_a_pass_holds_the_sync_lock_past_the_wait() {
        let h = Harness::new(
            json!({ "owner": "account-a", "units": ["favorites/tapDance"], "held": {} }),
            FakeAccount::signed_in_as("account-a"),
        );
        let _pass = h.runtime.try_claim_sync_lock(false).unwrap();
        refused_past_the_wait(&h).await;
    }

    #[tokio::test(start_paused = true)]
    async fn fails_without_storing_the_tokens_when_an_analytics_sync_runs_past_the_wait() {
        let h = Harness::new(
            json!({ "owner": "account-a", "units": ["favorites/tapDance"], "held": {} }),
            FakeAccount::signed_in_as("account-a"),
        );
        let _analytics = h.runtime.try_start_analytics_sync("uid1").unwrap();
        refused_past_the_wait(&h).await;
        assert!(!h.runtime.is_syncing());
    }

    #[tokio::test(start_paused = true)]
    async fn refuses_a_second_switch_while_one_is_waiting() {
        let h = Harness::new(json!({ "owner": null, "units": [], "held": {} }), Arc::default());
        let pass = h.runtime.try_claim_sync_lock(false).unwrap();
        let first = h.sign_in("account-b", async { Ok(()) });
        settle().await;
        let (store, stored) = recording_store(&h.runtime);

        let second = h.sign_in("account-c", store).await.unwrap();
        assert!(matches!(second, Err(AccountSwitchError::Busy)));
        let sign_out = h.sign_out().await.unwrap();
        assert!(matches!(sign_out, Err(AccountSwitchError::Busy)));

        drop(pass);
        first.await.unwrap().unwrap();
        assert_eq!(*stored.lock().unwrap(), None);
        assert_eq!(owner(&h.pending).as_deref(), Some("account-b"));
    }

    #[tokio::test(start_paused = true)]
    async fn gives_ownerless_units_to_the_account_still_signed_in_before_its_tokens_are_replaced() {
        let h = Harness::new(
            json!({ "owner": null, "units": [], "held": {} }),
            FakeAccount::signed_in_as("account-a"),
        );
        h.pending.notify_change("favorites/tapDance");

        h.sign_in("account-b", async { Ok(()) }).await.unwrap().unwrap();

        assert_eq!(held(&h.pending), [("account-a".to_owned(), vec!["favorites/tapDance".to_owned()])]);
        assert!(active(&h.pending).is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn fails_without_storing_the_tokens_and_keeps_the_pending_state_when_the_hand_over_cannot_be_written()
     {
        let h = Harness::new(
            json!({ "owner": "account-a", "units": ["favorites/tapDance"], "held": {} }),
            FakeAccount::signed_in_as("account-a"),
        );
        h.fill_caches();
        let generation = h.pending.pending_generation_of("favorites/tapDance");
        h.block_writes();
        let (store, stored) = recording_store(&h.runtime);

        let failed = h.sign_in("account-b", store).await.unwrap();

        assert!(matches!(failed, Err(AccountSwitchError::Pending(_))));
        assert_eq!(*stored.lock().unwrap(), None);
        assert!(!h.caches_forgotten());
        assert_eq!(owner(&h.pending).as_deref(), Some("account-a"));
        assert_eq!(active(&h.pending), ["favorites/tapDance"]);
        assert_eq!(h.pending.pending_generation_of("favorites/tapDance"), generation);
        assert!(h.pending.held().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn fails_without_storing_the_tokens_when_the_ownerless_units_cannot_be_given_to_the_old_account() {
        let h = Harness::new(
            json!({ "owner": null, "units": [], "held": {} }),
            FakeAccount::signed_in_as("account-a"),
        );
        h.pending.notify_change("favorites/tapDance");
        h.block_writes();
        let (store, stored) = recording_store(&h.runtime);

        assert!(h.sign_in("account-b", store).await.unwrap().is_err());

        assert_eq!(*stored.lock().unwrap(), None);
        assert_eq!(owner(&h.pending), None);
        assert_eq!(active(&h.pending), ["favorites/tapDance"]);
    }

    #[tokio::test(start_paused = true)]
    async fn releases_the_lock_when_the_tokens_cannot_be_stored() {
        let h = Harness::new(json!({ "owner": null, "units": [], "held": {} }), Arc::default());
        h.fill_caches();

        let failed = h.sign_in("account-b", async { Err(AuthError::KeystoreUnavailable) }).await.unwrap();

        assert!(matches!(failed, Err(AccountSwitchError::Auth(AuthError::KeystoreUnavailable))));
        assert!(!h.caches_forgotten());
        assert!(!h.runtime.is_syncing() && !h.runtime.account_switching());
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_any_password_change_from_starting_during_the_switch() {
        let h = Harness::new(json!({ "owner": null, "units": [], "held": {} }), Arc::default());
        let runtime = h.runtime.clone();
        let started = Arc::new(Mutex::new(None));
        let record = Arc::clone(&started);
        let store = async move {
            *record.lock().unwrap() = Some(runtime.try_start_password_change().is_some());
            Ok(())
        };

        h.sign_in("account-b", store).await.unwrap().unwrap();

        assert_eq!(*started.lock().unwrap(), Some(false));
        assert!(h.runtime.try_start_password_change().is_some());
    }
}

mod the_startup {
    use std::sync::atomic::{AtomicU64, Ordering};

    use tokio::sync::Notify;

    use super::*;

    /// A stored sign-in whose first read waits until the test lets it
    /// finish.
    struct SlowAccount {
        sub: Mutex<Option<String>>,
        read: Notify,
        first: std::sync::atomic::AtomicBool,
    }

    impl SignedInAccount for SlowAccount {
        async fn account_sub(&self) -> Option<String> {
            let sub = self.sub.lock().unwrap().clone();
            if self.first.swap(false, Ordering::SeqCst) {
                self.read.notified().await;
            }
            sub
        }

        async fn sign_out(&self) {
            *self.sub.lock().unwrap() = None;
        }
    }

    fn startup(file: serde_json::Value) -> (TempDir, PendingStore, SyncRuntime, Arc<SlowAccount>) {
        let h = Harness::new(file, Arc::default());
        let account = Arc::new(SlowAccount {
            sub: Mutex::new(Some("account-a".to_owned())),
            read: Notify::new(),
            first: true.into(),
        });
        (h.dir, h.pending, h.runtime, account)
    }

    #[tokio::test(start_paused = true)]
    async fn hands_the_units_to_the_stored_sign_in() {
        let (_dir, pending, runtime, account) =
            startup(json!({ "owner": null, "units": ["favorites/macro"], "held": {} }));
        let switcher = AccountSwitcher::new(runtime, pending.clone(), Arc::clone(&account));
        account.read.notify_one();

        switcher.adopt_pending_at_startup(&AtomicU64::new(0)).await;

        assert_eq!(owner(&pending).as_deref(), Some("account-a"));
    }

    #[tokio::test(start_paused = true)]
    async fn adopts_nothing_when_the_sign_in_changed_while_it_read_the_account() {
        let (_dir, pending, runtime, account) =
            startup(json!({ "owner": null, "units": ["favorites/macro"], "held": {} }));
        let switcher = Arc::new(AccountSwitcher::new(runtime, pending.clone(), Arc::clone(&account)));
        let changes = Arc::new(AtomicU64::new(0));
        let (starting, counted) = (Arc::clone(&switcher), Arc::clone(&changes));
        let adoption = tokio::spawn(async move { starting.adopt_pending_at_startup(&counted).await });
        settle().await;

        // A sign-in of account-b completes while account-a is being read.
        let bump = Arc::clone(&changes);
        let store = async move {
            bump.fetch_add(1, Ordering::SeqCst);
            Ok(())
        };
        switcher.switch_account_keeping_pending(store, Some("account-b".to_owned())).await.unwrap();
        account.read.notify_one();
        adoption.await.unwrap();

        // The sign-in gave the ownerless units to account-a and held them
        // for it; the stale read of account-a takes nothing back.
        assert_eq!(owner(&pending).as_deref(), Some("account-b"));
        assert_eq!(held(&pending), [("account-a".to_owned(), vec!["favorites/macro".to_owned()])]);
        assert!(active(&pending).is_empty());
    }
}

mod signing_out {
    use super::*;

    fn signed_in() -> Harness {
        Harness::new(
            json!({ "owner": "account-a", "units": [], "held": {} }),
            FakeAccount::signed_in_as("account-a"),
        )
    }

    #[tokio::test(start_paused = true)]
    async fn holds_the_accounts_units_keeps_them_in_the_file_then_removes_the_tokens() {
        let h = signed_in();
        h.pending.notify_change("favorites/tapDance");
        h.fill_caches();

        h.sign_out().await.unwrap().unwrap();

        assert_eq!(
            h.account.events(),
            [r#"sign-out holding [("account-a", ["favorites/tapDance"])], locked true"#]
        );
        assert!(h.caches_forgotten());
        assert!(active(&h.pending).is_empty());
        assert_eq!(
            std::fs::read_to_string(h.pending_path()).unwrap(),
            r#"{"version":1,"owner":null,"units":[],"held":{"account-a":["favorites/tapDance"]}}"#
        );
    }

    #[tokio::test(start_paused = true)]
    async fn signs_out_only_after_the_running_pass_ends_holding_the_lock() {
        let h = signed_in();
        h.pending.notify_change("favorites/tapDance");
        let pass = h.runtime.try_claim_sync_lock(false).unwrap();

        let signing_out = h.sign_out();
        settle().await;
        assert!(h.account.events().is_empty());
        assert_eq!(active(&h.pending), ["favorites/tapDance"]);

        drop(pass);
        signing_out.await.unwrap().unwrap();

        assert_eq!(
            h.account.events(),
            [r#"sign-out holding [("account-a", ["favorites/tapDance"])], locked true"#]
        );
        assert!(!h.runtime.is_syncing());
    }

    #[tokio::test(start_paused = true)]
    async fn signs_out_anyway_once_the_wait_runs_out_holding_the_units_first() {
        let h = signed_in();
        h.pending.notify_change("favorites/tapDance");
        let _pass = h.runtime.try_claim_sync_lock(false).unwrap();
        let started = tokio::time::Instant::now();

        h.sign_out().await.unwrap().unwrap();

        assert_eq!(started.elapsed(), ACCOUNT_SWITCH_WAIT);
        // Without the lock, which the pass still holds.
        assert_eq!(
            h.account.events(),
            [r#"sign-out holding [("account-a", ["favorites/tapDance"])], locked true"#]
        );
        assert_eq!(held(&h.pending), [("account-a".to_owned(), vec!["favorites/tapDance".to_owned()])]);
        assert!(!h.runtime.account_switching());
    }

    #[tokio::test(start_paused = true)]
    async fn is_refused_at_once_while_a_password_change_runs_keeping_the_tokens_and_the_units() {
        let h = signed_in();
        h.pending.notify_change("favorites/tapDance");
        h.fill_caches();
        let _change = h.runtime.try_start_password_change().unwrap();

        let refused = h.switcher.sign_out_keeping_pending().await.unwrap_err();

        assert_eq!(refused.to_string(), SIGN_OUT_PASSWORD_CHANGING);
        assert_eq!(refused.reason(), None);
        assert!(!h.runtime.account_switching());
        assert!(h.account.events().is_empty());
        assert!(!h.caches_forgotten());
        assert_eq!(active(&h.pending), ["favorites/tapDance"]);
    }

    #[tokio::test(start_paused = true)]
    async fn keeps_the_tokens_and_reports_an_error_when_the_hold_cannot_be_written() {
        let h = signed_in();
        h.pending.notify_change("favorites/tapDance");
        h.fill_caches();
        h.block_writes();

        assert!(matches!(h.sign_out().await.unwrap(), Err(AccountSwitchError::Pending(_))));

        assert!(h.account.events().is_empty());
        assert!(!h.caches_forgotten());
        assert_eq!(owner(&h.pending).as_deref(), Some("account-a"));
        assert_eq!(active(&h.pending), ["favorites/tapDance"]);
    }

    #[tokio::test(start_paused = true)]
    async fn holds_ownerless_units_for_the_account_still_signed_in() {
        let h = Harness::new(
            json!({ "owner": null, "units": [], "held": {} }),
            FakeAccount::signed_in_as("account-a"),
        );
        h.pending.notify_change("favorites/tapDance");

        h.switcher.sign_out_keeping_pending_locked().await.unwrap();
        *h.account.sub.lock().unwrap() = Some("account-b".to_owned());
        h.switcher.adopt_pending_for_signed_in_account().await;

        assert!(active(&h.pending).is_empty());
        assert_eq!(held(&h.pending), [("account-a".to_owned(), vec!["favorites/tapDance".to_owned()])]);
    }

    #[tokio::test(start_paused = true)]
    async fn gives_changes_made_while_signed_out_to_the_next_account_and_holds_the_previous_accounts_for_it()
    {
        let h = signed_in();
        h.pending.notify_change("favorites/tapDance");
        h.sign_out().await.unwrap().unwrap();
        h.pending.notify_change("favorites/macro");

        h.sign_in("account-b", async { Ok(()) }).await.unwrap().unwrap();
        *h.account.sub.lock().unwrap() = Some("account-b".to_owned());

        assert_eq!(active(&h.pending), ["favorites/macro"]);
        assert_eq!(held(&h.pending), [("account-a".to_owned(), vec!["favorites/tapDance".to_owned()])]);

        h.sign_out().await.unwrap().unwrap();
        h.sign_in("account-a", async { Ok(()) }).await.unwrap().unwrap();

        assert_eq!(active(&h.pending), ["favorites/tapDance"]);
        assert_eq!(held(&h.pending), [("account-b".to_owned(), vec!["favorites/macro".to_owned()])]);
    }

    #[tokio::test(start_paused = true)]
    async fn only_removes_the_tokens_when_nothing_is_owned() {
        let h = signed_in();
        h.sign_out().await.unwrap().unwrap();
        std::fs::remove_file(h.pending_path()).unwrap();

        h.sign_out().await.unwrap().unwrap();

        assert!(!h.pending_path().exists());
        assert_eq!(h.account.events().len(), 2);
    }
}

/// The token switch through a real `GoogleAuth`: a code exchange against a
/// token endpoint that answers at once.
mod through_the_sign_in {
    use super::*;

    fn jwt(sub: &str) -> String {
        let part = |value: serde_json::Value| URL_SAFE_NO_PAD.encode(value.to_string());
        format!(
            "{}.{}.sig",
            part(json!({ "alg": "none" })),
            part(json!({ "sub": sub, "exp": 4_000_000_000_i64 }))
        )
    }

    fn google_auth(dir: &TempDir, sub: &str) -> Arc<GoogleAuth> {
        let body =
            json!({ "access_token": "a", "refresh_token": "r", "expires_in": 3600, "id_token": jwt(sub) });
        let token_endpoint = move |_: HttpRequest| {
            Ok::<_, HttpError>(HttpReply {
                status: 200,
                retry_after: None,
                content_type: Some("application/json".to_owned()),
                body: body.to_string().into_bytes(),
            })
        };
        let config = AuthConfig {
            auth_endpoint: "http://127.0.0.1:9/auth".to_owned(),
            token_endpoint: "http://127.0.0.1:9/token".to_owned(),
            http: Arc::new(token_endpoint),
            timing: AuthTiming::default(),
            now_ms: Arc::new(|| 1_800_000_000_000),
            hub_test_account: Arc::new(|| None),
        };
        Arc::new(GoogleAuth::new(
            config,
            Arc::new(SecretStore::new(dir.path(), Arc::new(MemoryKeystore::default()))),
        ))
    }

    fn setup(file: serde_json::Value, sub: &str) -> (TempDir, SyncRuntime, PendingStore, Arc<GoogleAuth>) {
        let dir = TempDir::new().unwrap();
        let mut file = file;
        file["version"] = json!(1);
        std::fs::create_dir_all(dir.path().join("local")).unwrap();
        std::fs::write(dir.path().join("local").join("sync-pending.json"), file.to_string()).unwrap();
        let pending = PendingStore::restore(dir.path(), Arc::new(NoDelayedWrites), Box::new(|_| {}));
        let auth = google_auth(&dir, sub);
        (dir, SyncRuntime::new(), pending, auth)
    }

    #[tokio::test]
    async fn stores_the_tokens_with_the_units_handed_to_the_new_account() {
        let (_dir, runtime, pending, auth) =
            setup(json!({ "owner": "account-a", "units": ["favorites/tapDance"], "held": {} }), "account-b");
        let switcher = AccountSwitcher::new(runtime.clone(), pending.clone(), Arc::clone(&auth));

        auth.exchange_code_for_tokens("code", "verifier", 1234, &switcher).await.unwrap();

        assert_eq!(auth.account_sub().await.as_deref(), Some("account-b"));
        assert_eq!(owner(&pending).as_deref(), Some("account-b"));
        assert_eq!(held(&pending), [("account-a".to_owned(), vec!["favorites/tapDance".to_owned()])]);

        switcher.sign_out_keeping_pending().await.unwrap();
        assert_eq!(auth.account_sub().await, None);
        assert!(!auth.is_authenticated().await);
    }

    #[tokio::test(start_paused = true)]
    async fn a_refused_switch_stores_nothing_and_carries_its_reason() {
        let (_dir, runtime, pending, auth) =
            setup(json!({ "owner": "account-a", "units": ["favorites/tapDance"], "held": {} }), "account-b");
        let switcher = AccountSwitcher::new(runtime.clone(), pending.clone(), Arc::clone(&auth));
        let _pass = runtime.try_claim_sync_lock(false).unwrap();

        let err = auth.exchange_code_for_tokens("code", "verifier", 1234, &switcher).await.unwrap_err();

        let AuthError::Switch(inner) = err else { panic!("not a refused switch: {err}") };
        let refusal = inner.downcast_ref::<AccountSwitchError>().unwrap();
        assert_eq!(refusal.reason(), Some("syncBusy"));
        assert!(!auth.is_authenticated().await);
        assert_eq!(owner(&pending).as_deref(), Some("account-a"));
        assert_eq!(active(&pending), ["favorites/tapDance"]);
    }
}
