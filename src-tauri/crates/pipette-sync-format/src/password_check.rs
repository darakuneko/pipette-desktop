// SPDX-License-Identifier: GPL-2.0-or-later
//! The password-check sentinel (`src/main/sync/sync-password.ts`): an
//! ordinary envelope under the sync unit `password-check` whose plaintext is
//! a fixed JSON string. A password is accepted when the envelope opens; the
//! plaintext itself is not compared.

use crate::crypto::{CryptoError, decrypt, encrypt};
use crate::envelope::Envelope;

/// Sync unit of the password-check envelope. It is a credential check, not
/// data, and never maps back from its Drive file name.
pub const PASSWORD_CHECK_UNIT: &str = "password-check";

/// `JSON.stringify({ type: 'password-check', version: 1 })`.
pub const PASSWORD_CHECK_PAYLOAD: &str = r#"{"type":"password-check","version":1}"#;

/// A new password-check envelope for `password`.
pub fn encrypt_password_check(password: &str) -> Result<Envelope, CryptoError> {
    encrypt(PASSWORD_CHECK_PAYLOAD, password, PASSWORD_CHECK_UNIT)
}

/// Whether `envelope` opens with `password`. Any decryption failure counts
/// as a mismatch, as in the TypeScript `openPasswordCheck`.
pub fn password_check_matches(envelope: &Envelope, password: &str) -> bool {
    decrypt(envelope, password).is_ok()
}
