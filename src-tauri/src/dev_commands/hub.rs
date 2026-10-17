// SPDX-License-Identifier: GPL-2.0-or-later
//! The Hub seen and driven from the e2e tests: its state (never the token
//! itself) and a run of its startup work on demand. Builds with the
//! development tools only.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::command_error::CommandError;
use crate::hub_commands::setup::Hub;

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
}

#[tauri::command]
pub fn dev_hub_state(hub: State<'_, Arc<Hub>>) -> DevHubState {
    let destination = hub.destination();
    let token = hub.token().snapshot();
    DevHubState {
        base: destination.base.clone(),
        loopback: destination.loopback,
        blocked: destination.blocked,
        token_cached: token.cached,
        token_inflight: token.inflight,
        token_generation: token.generation,
        display_name_pending: token.display_name_pending,
    }
}

/// The startup sync of the Hub-linked language packs, run now.
#[tauri::command]
pub fn dev_hub_run_startup_sync() -> Result<(), CommandError> {
    Err(CommandError::new("the startup sync of the Hub-linked language packs is not implemented"))
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
            })
        );
        assert!(!state.to_string().contains(jwt));
    }
}
