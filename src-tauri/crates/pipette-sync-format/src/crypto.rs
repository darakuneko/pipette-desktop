// SPDX-License-Identifier: GPL-2.0-or-later
//! Envelope encryption, byte-compatible with `src/main/sync/sync-crypto.ts`.
//!
//! - Key: PBKDF2-HMAC-SHA256 over the password's UTF-8 bytes as given (no
//!   Unicode normalization, no trimming), 16-byte random salt, 600,000
//!   iterations, 32 bytes.
//! - Cipher: AES-256-GCM, 12-byte random nonce, 16-byte tag appended to the
//!   ciphertext.
//! - AAD: the UTF-8 bytes of `"{version}:{syncUnit}"`, so an envelope only
//!   opens under the sync unit it was written for.
//! - Plaintext: UTF-8 text (the JSON of a sync bundle).

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::alphabet::STANDARD;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use sha2::Sha256;
use std::time::SystemTime;

use crate::envelope::{ENVELOPE_VERSION, Envelope};
use crate::timestamp::iso_8601_millis;

pub const PBKDF2_ITERATIONS: u32 = 600_000;
pub const SALT_LENGTH: usize = 16;
pub const IV_LENGTH: usize = 12;
pub const KEY_LENGTH: usize = 32;
pub const AUTH_TAG_LENGTH: usize = 16;

/// Standard alphabet, padded on output. Input is accepted with or without
/// padding, as Node's `Buffer.from(s, 'base64')` does.
const BASE64: GeneralPurpose = GeneralPurpose::new(
    &STANDARD,
    GeneralPurposeConfig::new()
        .with_encode_padding(true)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CryptoError {
    /// A binary field is not standard Base64. Node's decoder is more lenient
    /// (it skips characters outside the alphabet and also takes `-` and `_`),
    /// so such text may still open on the TypeScript side; envelopes written
    /// by either implementation never contain it.
    #[error("invalid Base64 in the {0} field")]
    InvalidBase64(&'static str),
    /// Same message and check as the TypeScript `decrypt`: the decoded
    /// ciphertext cannot even hold the tag.
    #[error("Ciphertext too short")]
    CiphertextTooShort,
    /// Every envelope the TypeScript side writes has a 12-byte IV; other
    /// lengths are not accepted here.
    #[error("unsupported IV length {0}")]
    UnsupportedIvLength(usize),
    /// Wrong password, a different sync unit or version than the one
    /// encrypted under, or tampered bytes. Same message as Node's
    /// `decipher.final()` failure.
    #[error("Unsupported state or unable to authenticate data")]
    Authentication,
    #[error("the system random number generator failed")]
    Random,
    #[error("AES-GCM encryption failed")]
    Encryption,
}

fn derive_key(password: &str, salt: &[u8]) -> [u8; KEY_LENGTH] {
    let mut key = [0u8; KEY_LENGTH];
    pbkdf2::pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, PBKDF2_ITERATIONS, &mut key);
    key
}

fn build_aad(version: u32, sync_unit: &str) -> Vec<u8> {
    format!("{version}:{sync_unit}").into_bytes()
}

fn cipher_for(key: &[u8; KEY_LENGTH]) -> Aes256Gcm {
    Aes256Gcm::new(key.into())
}

fn seal(
    plaintext: &str,
    key: &[u8; KEY_LENGTH],
    sync_unit: &str,
    salt: &[u8; SALT_LENGTH],
    iv: &[u8; IV_LENGTH],
    updated_at: String,
) -> Result<Envelope, CryptoError> {
    let aad = build_aad(ENVELOPE_VERSION, sync_unit);
    let ciphertext = cipher_for(key)
        .encrypt(Nonce::from_slice(iv), Payload { msg: plaintext.as_bytes(), aad: &aad })
        .map_err(|_| CryptoError::Encryption)?;
    Ok(Envelope {
        version: ENVELOPE_VERSION,
        sync_unit: sync_unit.to_owned(),
        updated_at,
        salt: BASE64.encode(salt),
        iv: BASE64.encode(iv),
        ciphertext: BASE64.encode(ciphertext),
    })
}

/// Encrypts `plaintext` for `sync_unit` with a fresh random salt and IV,
/// stamped with the current time.
pub fn encrypt(plaintext: &str, password: &str, sync_unit: &str) -> Result<Envelope, CryptoError> {
    let mut salt = [0u8; SALT_LENGTH];
    let mut iv = [0u8; IV_LENGTH];
    OsRng.try_fill_bytes(&mut salt).map_err(|_| CryptoError::Random)?;
    OsRng.try_fill_bytes(&mut iv).map_err(|_| CryptoError::Random)?;
    let key = derive_key(password, &salt);
    seal(plaintext, &key, sync_unit, &salt, &iv, iso_8601_millis(SystemTime::now()))
}

/// The binary fields of an envelope, checked in the order the TypeScript
/// `decrypt` checks them, before any key is derived.
struct Sealed {
    salt: Vec<u8>,
    iv: Vec<u8>,
    ciphertext: Vec<u8>,
}

fn unpack(envelope: &Envelope) -> Result<Sealed, CryptoError> {
    let salt = BASE64.decode(&envelope.salt).map_err(|_| CryptoError::InvalidBase64("salt"))?;
    let iv = BASE64.decode(&envelope.iv).map_err(|_| CryptoError::InvalidBase64("iv"))?;
    let ciphertext =
        BASE64.decode(&envelope.ciphertext).map_err(|_| CryptoError::InvalidBase64("ciphertext"))?;
    if ciphertext.len() < AUTH_TAG_LENGTH {
        return Err(CryptoError::CiphertextTooShort);
    }
    if iv.len() != IV_LENGTH {
        return Err(CryptoError::UnsupportedIvLength(iv.len()));
    }
    Ok(Sealed { salt, iv, ciphertext })
}

fn open(envelope: &Envelope, sealed: &Sealed, key: &[u8; KEY_LENGTH]) -> Result<String, CryptoError> {
    let aad = build_aad(envelope.version, &envelope.sync_unit);
    let plaintext = cipher_for(key)
        .decrypt(Nonce::from_slice(&sealed.iv), Payload { msg: &sealed.ciphertext, aad: &aad })
        .map_err(|_| CryptoError::Authentication)?;
    Ok(String::from_utf8_lossy(&plaintext).into_owned())
}

/// Decrypts `envelope` with `password`. Invalid UTF-8 in the plaintext is
/// replaced with U+FFFD, as Node's `toString('utf-8')` does.
pub fn decrypt(envelope: &Envelope, password: &str) -> Result<String, CryptoError> {
    let sealed = unpack(envelope)?;
    open(envelope, &sealed, &derive_key(password, &sealed.salt))
}

/// The key [`encrypt`] and [`decrypt`] derive from `password` and `salt`.
/// With [`encrypt_with_key`] and [`decrypt_with_key`], a test derives it once
/// per password and salt instead of once per call.
#[cfg(feature = "test-util")]
pub fn key_for(password: &str, salt: &[u8]) -> [u8; KEY_LENGTH] {
    derive_key(password, salt)
}

/// [`encrypt`] with a caller-chosen salt, IV and `updatedAt`, and the key
/// [`key_for`] derived from the password and that salt, so tests can compare
/// envelopes byte for byte. Reusing an IV with the same key breaks AES-GCM,
/// so this is never used for real data.
#[cfg(feature = "test-util")]
pub fn encrypt_with_key(
    plaintext: &str,
    key: &[u8; KEY_LENGTH],
    sync_unit: &str,
    salt: &[u8; SALT_LENGTH],
    iv: &[u8; IV_LENGTH],
    updated_at: &str,
) -> Result<Envelope, CryptoError> {
    seal(plaintext, key, sync_unit, salt, iv, updated_at.to_owned())
}

/// [`decrypt`] with the key [`key_for`] derived from the password and the
/// envelope's salt. Same checks and errors as [`decrypt`].
#[cfg(feature = "test-util")]
pub fn decrypt_with_key(envelope: &Envelope, key: &[u8; KEY_LENGTH]) -> Result<String, CryptoError> {
    open(envelope, &unpack(envelope)?, key)
}
