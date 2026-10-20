// SPDX-License-Identifier: GPL-2.0-or-later
//! The Hub seen and driven from the e2e tests: its state (never the token
//! itself) and a run of its startup work on demand. Builds with the
//! development tools only.

use std::sync::Arc;

use pipette_hub::startup_sync::StartupSyncResult;
use pipette_keyboard_stores::StoreContext;
use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use crate::command_error::CommandError;
use crate::hub_commands::setup::{Hub, run_startup_sync};

/// The counts of a startup update of the Hub-linked language packs
/// ([`StartupSyncResult`], with the number of errors).
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StartupSyncCounts {
    checked: usize,
    updated: usize,
    missing_on_hub: usize,
    errors: usize,
}

impl From<&StartupSyncResult> for StartupSyncCounts {
    fn from(result: &StartupSyncResult) -> Self {
        Self {
            checked: result.checked,
            updated: result.updated,
            missing_on_hub: result.missing_on_hub,
            errors: result.errors.len(),
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevHubState {
    /// The Hub API base URL the requests go to.
    base: String,
    /// The base is an override on the loopback interface.
    loopback: bool,
    /// An e2e run whose Hub is not on the loopback interface: every Hub
    /// request is refused.
    blocked: bool,
    /// A Hub JWT is cached (never its value).
    token_cached: bool,
    /// A Hub token request is shared with the callers that come.
    token_inflight: bool,
    /// The times the cached JWT was forgotten for a sign-in or sign-out.
    token_generation: u64,
    /// A display name is set for the next Hub token request.
    display_name_pending: bool,
    /// A startup update of the Hub-linked language packs ran to its end.
    startup_sync_done: bool,
    /// What the last one that did found; `null` before one has.
    startup_sync: Option<StartupSyncCounts>,
}

#[tauri::command]
pub fn dev_hub_state(hub: State<'_, Arc<Hub>>) -> DevHubState {
    let destination = hub.destination();
    let token = hub.token().snapshot();
    let startup_sync = hub.startup_sync_result();
    DevHubState {
        base: destination.base.clone(),
        loopback: destination.loopback,
        blocked: destination.blocked,
        token_cached: token.cached,
        token_inflight: token.inflight,
        token_generation: token.generation,
        display_name_pending: token.display_name_pending,
        startup_sync_done: startup_sync.is_some(),
        startup_sync: startup_sync.as_ref().map(StartupSyncCounts::from),
    }
}

/// The startup update of the Hub-linked language packs, run now as at
/// launch (logged, `i18n-pack:changed` when a pack changed, recorded in
/// [`dev_hub_state`]); its counts. Refused where the Hub's background work
/// may not start, and failed when the quit stopped it.
#[tauri::command]
pub async fn dev_hub_run_startup_sync<R: Runtime>(
    app: AppHandle<R>,
    hub: State<'_, Arc<Hub>>,
    stores: State<'_, StoreContext>,
) -> Result<StartupSyncCounts, CommandError> {
    if !hub.background_allowed() {
        return Err(CommandError::new("the Hub is blocked in this e2e run"));
    }
    let outcome = run_startup_sync(&app, &hub, stores.inner().clone()).await;
    if outcome.stopped {
        return Err(CommandError::new("the app is quitting"));
    }
    Ok(StartupSyncCounts::from(&outcome.result))
}

#[cfg(test)]
mod tests {
    use pipette_hub::fake::FakeHub;
    use pipette_hub::{HubDestination, HubRequesters, IdTokenSource};
    use tauri::Manager;

    use super::*;

    /// The state tells whether a token is cached, never the token.
    #[tokio::test]
    async fn the_state_shows_the_token_cache_without_the_token() {
        let app = tauri::test::mock_app();
        let fake = Arc::new(FakeHub::new());
        let destination = HubDestination::resolve(true, &|name| {
            (name == "PIPETTE_HUB_URL").then(|| "http://127.0.0.1:9".to_owned())
        });
        let id_tokens: Arc<dyn IdTokenSource> = Arc::new(|| Some("test:alice@example.com".to_owned()));
        let hub = crate::hub_commands::setup::manage_with(
            app.handle(),
            destination,
            HubRequesters::single(fake.clone()),
            id_tokens,
        );
        pipette_hub::account::fetch_auth_me(hub.token()).await;
        let bearer = fake.requests().last().unwrap().header("Authorization").unwrap().to_owned();
        let jwt = bearer.strip_prefix("Bearer ").unwrap();

        let state = serde_json::to_value(dev_hub_state(app.state::<Arc<Hub>>())).unwrap();
        assert_eq!(
            state,
            serde_json::json!({
                "base": "http://127.0.0.1:9",
                "loopback": true,
                "blocked": false,
                "tokenCached": true,
                "tokenInflight": false,
                "tokenGeneration": 0,
                "displayNamePending": false,
                "startupSyncDone": false,
                "startupSync": null,
            })
        );
        assert!(!state.to_string().contains(jwt));
    }

    /// A run now records its counts in the state; a blocked Hub refuses it.
    #[tokio::test]
    async fn a_startup_update_run_now_is_counted_in_the_state() {
        let user_data = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_app();
        crate::store_commands::keyboard_data::manage(app.handle(), user_data.path());
        let stores = app.state::<StoreContext>().inner().clone();
        let pack = pipette_js_json::parse(r#"{"name":"Japanese","version":"1.2.0"}"#).unwrap();
        let input = pipette_pack_stores::i18n::SavePackInput {
            id: Some("pack-ja".into()),
            pack: Some(pack),
            hub_post_id: pipette_pack_stores::Field::Set("gone".into()),
            ..Default::default()
        };
        pipette_pack_stores::i18n::save_pack(&stores, input).unwrap();
        let fake = Arc::new(FakeHub::new());
        let destination = HubDestination::resolve(true, &|name| {
            (name == "PIPETTE_HUB_URL").then(|| "http://127.0.0.1:9".to_owned())
        });
        crate::hub_commands::setup::manage_with(
            app.handle(),
            destination,
            HubRequesters::single(fake.clone()),
            Arc::new(|| None::<String>),
        );

        let counts = dev_hub_run_startup_sync(app.handle().clone(), app.state(), app.state()).await.unwrap();
        let expected = serde_json::json!({ "checked": 1, "updated": 0, "missingOnHub": 1, "errors": 0 });
        assert_eq!(serde_json::to_value(&counts).unwrap(), expected);
        let state = serde_json::to_value(dev_hub_state(app.state::<Arc<Hub>>())).unwrap();
        assert_eq!(state["startupSyncDone"], true);
        assert_eq!(state["startupSync"], expected);

        let blocked = tauri::test::mock_app();
        crate::store_commands::keyboard_data::manage(blocked.handle(), user_data.path());
        let destination =
            HubDestination::resolve(true, &|name| (name == "PIPETTE_E2E").then(|| "1".to_owned()));
        crate::hub_commands::setup::manage_with(
            blocked.handle(),
            destination,
            HubRequesters::single(fake.clone()),
            Arc::new(|| None::<String>),
        );
        let sent = fake.requests().len();
        assert!(
            dev_hub_run_startup_sync(blocked.handle().clone(), blocked.state(), blocked.state())
                .await
                .is_err()
        );
        assert_eq!(fake.requests().len(), sent);
    }
}
