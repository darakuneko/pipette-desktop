// SPDX-License-Identifier: GPL-2.0-or-later
//! The Hub account: the Hub origin, the display name of the next Hub token,
//! and the account's own record (on `pipette_hub::account`). The answers
//! carry the Hub's user object as the Hub sent it; the JWT stays here.

use std::sync::Arc;

use pipette_hub::account;
use serde_json::Value;
use tauri::State;
use tauri::ipc::Response;

use super::setup::Hub;
use crate::command_error::CommandError;

#[tauri::command]
pub fn hub_get_origin(hub: State<'_, Arc<Hub>>) -> String {
    account::origin(hub.http())
}

/// A display name that is not a string clears it.
#[tauri::command]
pub fn hub_set_auth_display_name(hub: State<'_, Arc<Hub>>, display_name: Option<Value>) {
    account::set_auth_display_name(hub.token(), display_name.as_ref().and_then(Value::as_str));
}

#[tauri::command]
pub async fn hub_fetch_auth_me(hub: State<'_, Arc<Hub>>) -> Result<Response, CommandError> {
    Ok(Response::new(pipette_js_json::stringify(&account::fetch_auth_me(hub.token()).await)))
}

#[tauri::command]
pub async fn hub_patch_auth_me(
    hub: State<'_, Arc<Hub>>,
    display_name: Option<Value>,
) -> Result<Response, CommandError> {
    let answer = account::patch_auth_me(hub.token(), display_name.as_ref().and_then(Value::as_str)).await;
    Ok(Response::new(pipette_js_json::stringify(&answer)))
}

#[cfg(test)]
mod tests {
    use pipette_app_config::AppConfigStore;
    use pipette_hub::HubDestination;
    use pipette_hub::fake::FakeHub;
    use pipette_hub::{HubRequesters, IdTokenSource};
    use pipette_sync::reset::Resets;
    use pipette_sync::reset::targets::LocalResetTargets;
    use tauri::Manager;
    use tauri::ipc::{InvokeResponseBody, IpcResponse};
    use tauri::test::{MockRuntime, mock_app};

    use super::*;
    use crate::app_config::AppConfig;
    use crate::hub_commands::setup::manage_with;
    use crate::sync_commands::SyncSecrets;

    /// An app with the sync, its resets and a Hub on `fake`, whose Google
    /// sign-in answers the Hub test account's id_token.
    fn app(user_data: &std::path::Path, fake: &Arc<FakeHub>) -> (tauri::App<MockRuntime>, Arc<Hub>) {
        let app = mock_app();
        let config: AppConfig = Arc::new(AppConfigStore::open(user_data));
        app.manage(config);
        crate::store_commands::sync_pending::manage_without_delayed_writes(app.handle(), user_data);
        crate::store_commands::keyboard_data::manage(app.handle(), user_data);
        crate::sync_commands::manage_for_tests(app.handle(), user_data);
        crate::analytics_commands::mark_cache_fresh(user_data, "machine");
        crate::analytics_commands::manage_with_machine_id(app.handle(), user_data, "machine");
        crate::sync_commands::preflight::manage_for_tests(app.handle());
        crate::sync_commands::execute::manage(app.handle());
        crate::sync_commands::reset::manage(app.handle());
        let destination = HubDestination::resolve(true, &|name| {
            (name == "PIPETTE_HUB_URL").then(|| "http://127.0.0.1:9".to_owned())
        });
        let id_tokens: Arc<dyn IdTokenSource> = Arc::new(|| Some("test:alice@example.com".to_owned()));
        let hub = manage_with(app.handle(), destination, HubRequesters::single(fake.clone()), id_tokens);
        (app, hub)
    }

    fn text(response: Response) -> String {
        match response.body().unwrap() {
            InvokeResponseBody::Json(text) => text,
            InvokeResponseBody::Raw(_) => panic!("not JSON"),
        }
    }

    async fn fetch_me(app: &tauri::App<MockRuntime>) -> String {
        text(hub_fetch_auth_me(app.state::<Arc<Hub>>()).await.unwrap())
    }

    fn token_requests(fake: &FakeHub) -> usize {
        fake.requests().iter().filter(|request| request.path == "/api/auth/token").count()
    }

    #[tokio::test]
    async fn the_account_commands_answer_from_the_hub() {
        let user_data = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeHub::new());
        let (app, hub) = app(user_data.path(), &fake);
        assert_eq!(hub_get_origin(app.state::<Arc<Hub>>()), "http://127.0.0.1:9");
        hub_set_auth_display_name(app.state::<Arc<Hub>>(), Some(Value::from("Alice")));
        assert!(hub.token().snapshot().display_name_pending);
        let me = fetch_me(&app).await;
        assert!(me.starts_with(r#"{"success":true,"user":{"#), "{me}");
        assert!(me.contains(r#""display_name":"Alice""#), "{me}");
        // A value that is not a string clears the display name.
        hub_set_auth_display_name(app.state::<Arc<Hub>>(), Some(Value::from(5)));
        assert!(!hub.token().snapshot().display_name_pending);

        let patched =
            text(hub_patch_auth_me(app.state::<Arc<Hub>>(), Some(Value::from(" Bob "))).await.unwrap());
        assert!(patched.contains(r#""display_name":"Bob""#), "{patched}");
        let empty = text(hub_patch_auth_me(app.state::<Arc<Hub>>(), None).await.unwrap());
        assert_eq!(empty, r#"{"success":false,"error":"Display name must not be empty"}"#);
    }

    /// Reset Local Data with App Settings signs out, and the sign-out
    /// forgets the Hub JWT: the next request takes a new one.
    #[tokio::test]
    async fn reset_local_data_forgets_the_hub_jwt() {
        let user_data = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeHub::new());
        let (app, hub) = app(user_data.path(), &fake);
        fetch_me(&app).await;
        fetch_me(&app).await;
        assert_eq!(token_requests(&fake), 1);
        assert!(hub.token().snapshot().cached);

        let targets = LocalResetTargets {
            keyboards: false,
            favorites: false,
            app_settings: true,
            i18n_packs: false,
            theme_packs: false,
        };
        app.state::<Arc<Resets>>().reset_local_targets(&targets).await.unwrap();
        let snapshot = hub.token().snapshot();
        assert!(!snapshot.cached);
        assert_eq!(snapshot.generation, 1);

        fetch_me(&app).await;
        assert_eq!(token_requests(&fake), 2);
    }

    #[tokio::test]
    async fn signing_out_forgets_the_hub_jwt_and_the_display_name() {
        let user_data = tempfile::tempdir().unwrap();
        let fake = Arc::new(FakeHub::new());
        let (app, hub) = app(user_data.path(), &fake);
        fetch_me(&app).await;
        hub_set_auth_display_name(app.state::<Arc<Hub>>(), Some(Value::from("Next")));
        let auth = Arc::clone(&app.state::<SyncSecrets>().auth);
        auth.sign_out().await;
        let snapshot = hub.token().snapshot();
        assert!(!snapshot.cached && !snapshot.display_name_pending);
        assert_eq!(snapshot.generation, 1);
    }
}
