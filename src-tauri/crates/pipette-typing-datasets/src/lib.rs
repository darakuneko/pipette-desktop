// SPDX-License-Identifier: GPL-2.0-or-later
//! The Typing Test word datasets, writing the same files as the Electron
//! build:
//!
//! - the bundled default dataset of each provider (monkeytype, tatoeba,
//!   aozora), from src/shared/data/typing-test-providers.ts;
//! - the Hub overrides of those datasets (`local/typing-test-dataset.json`)
//!   and their update from the Hub's anonymous dataset API;
//! - the downloaded word lists (`local/downloads/languages/{provider}`).
//!
//! Requests go through the [`pipette_net::Http`] the store is given, and
//! the file work of each call runs on the Tokio blocking pool, so the calls
//! run on a Tokio runtime (Tauri's).

mod dataset;
mod download;
mod hub;
mod providers;
mod store;
mod text;

pub use dataset::{Dataset, Model, effective_dataset};
pub use download::{FetchFailure, Received, fetch_verified_bytes, size_mismatch_detail};
pub use hub::{fetch_dataset, fetch_dataset_version};
pub use providers::{DEFAULT_PROVIDER, is_bundled, is_registered, provider_default};
pub use store::{DatasetError, DatasetUpdate, LanguageStore, UpdateCheck};
pub use text::decode_utf8;
