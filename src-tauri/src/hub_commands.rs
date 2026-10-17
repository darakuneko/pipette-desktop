// SPDX-License-Identifier: GPL-2.0-or-later
//! The Hub commands, one module per domain, on crates/pipette-hub. The Hub
//! JWT and the Google id_token stay in the backend; the commands answer the
//! page with results only. [`setup`] settles where the Hub requests go and
//! manages the Hub before the window opens.

use serde_json::Value;

pub mod account;
pub mod analytics;
pub mod favorite;
pub mod key_labels;
pub mod packs;
pub mod posts;
pub mod setup;

pub use setup::setup;

/// The answer of a command whose handler is not written yet: nothing, as a
/// member the shim does not implement resolves with.
fn not_implemented() -> Value {
    Value::Null
}
