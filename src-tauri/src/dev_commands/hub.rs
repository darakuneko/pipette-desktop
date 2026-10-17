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
}

#[tauri::command]
pub fn dev_hub_state(hub: State<'_, Arc<Hub>>) -> DevHubState {
    let destination = hub.destination();
    DevHubState {
        base: destination.base.clone(),
        loopback: destination.loopback,
        blocked: destination.blocked,
    }
}

/// The startup sync of the Hub-linked language packs, run now.
#[tauri::command]
pub fn dev_hub_run_startup_sync() -> Result<(), CommandError> {
    Err(CommandError::new("the startup sync of the Hub-linked language packs is not implemented"))
}
