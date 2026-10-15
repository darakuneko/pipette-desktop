// SPDX-License-Identifier: GPL-2.0-or-later
//! The encrypted envelope (`SyncEnvelope` in `src/shared/types/sync.ts`).

use serde::{Deserialize, Serialize};

/// Envelope format version, written into every envelope and into its AAD.
pub const ENVELOPE_VERSION: u32 = 1;

/// One encrypted sync unit as stored on Drive.
///
/// Serializes with the field names and order `JSON.stringify` gives the
/// TypeScript object (`version`, `syncUnit`, `updatedAt`, `salt`, `iv`,
/// `ciphertext`). The binary fields are standard Base64 (`+/`, `=` padding):
/// `salt` 16 bytes, `iv` 12 bytes, `ciphertext` the AES-GCM output with the
/// 16-byte tag appended; there is no separate tag field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    /// Always [`ENVELOPE_VERSION`] when written. Decryption feeds the stored
    /// value into the AAD as it is, so an envelope whose version was changed
    /// after encryption does not open.
    pub version: u32,
    /// The sync unit, e.g. `favorites/tapDance` or `keyboards/{uid}/snapshots`.
    pub sync_unit: String,
    /// ISO 8601 UTC with milliseconds (`Date.prototype.toISOString`).
    pub updated_at: String,
    pub salt: String,
    pub iv: String,
    pub ciphertext: String,
}
