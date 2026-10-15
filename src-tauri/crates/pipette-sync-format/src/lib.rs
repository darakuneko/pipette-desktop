// SPDX-License-Identifier: GPL-2.0-or-later
//! Formats Pipette shares with other machines through Cloud Sync, in the
//! exact shape the TypeScript implementation (`src/main/sync/`,
//! `src/main/typing-analytics/machine-hash.ts`) reads and writes them:
//!
//! - [`envelope`] / [`crypto`] — the encrypted envelope stored on Google
//!   Drive (PBKDF2-HMAC-SHA256 key, AES-256-GCM, AAD bound to the sync unit).
//! - [`password_check`] — the password-check sentinel envelope.
//! - [`drive_names`] — sync unit ↔ Drive file name mapping.
//! - [`machine`] — the anonymized analytics machine hash and the raw machine
//!   id it is built from (the value `node-machine-id`'s `machineId(true)`
//!   returns).
//! - [`content_hash`] — the body hash used as a conflict tie-break.
//!
//! No Tauri dependency: this crate is pure data formatting plus the one
//! platform query the machine id needs.

pub mod content_hash;
pub mod crypto;
pub mod drive_names;
pub mod envelope;
pub mod machine;
pub mod password_check;
mod timestamp;

pub use content_hash::{content_hash, sha256_hex};
pub use crypto::{CryptoError, decrypt, encrypt};
pub use envelope::Envelope;
pub use machine::{MachineIdError, machine_hash, machine_id_original};
