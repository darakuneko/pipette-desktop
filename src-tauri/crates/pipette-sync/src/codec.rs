// SPDX-License-Identifier: GPL-2.0-or-later
//! The content of a unit's Drive file: its bundle's text in an encrypted
//! envelope (`encrypt` and `decrypt` of src/main/sync/sync-crypto.ts, and
//! the `JSON.stringify` / `JSON.parse` of the envelope around
//! `uploadFile` / `downloadFile` of google-drive.ts).

use std::future::Future;
use std::pin::Pin;

use pipette_sync_format::Envelope;
use pipette_sync_format::crypto::{decrypt, encrypt};
use zeroize::Zeroizing;

use crate::crypto::run_key_derivation;

pub type CodecFuture = Pin<Box<dyn Future<Output = Result<String, String>> + Send>>;

/// Seals a bundle's text into a Drive file's content and opens it again.
/// The error is the failure's message.
pub trait EnvelopeCodec: Send + Sync {
    /// The content of the Drive file of `unit` holding `plaintext`.
    fn seal(&self, plaintext: String, password: Zeroizing<String>, unit: String) -> CodecFuture;
    /// The plaintext of a downloaded Drive file's `content`.
    fn open(&self, content: Vec<u8>, password: Zeroizing<String>) -> CodecFuture;
}

/// The envelope encryption of the Electron build: a fresh salt and key per
/// envelope, derived on the blocking threads.
pub struct EnvelopeCrypto;

impl EnvelopeCodec for EnvelopeCrypto {
    fn seal(&self, plaintext: String, password: Zeroizing<String>, unit: String) -> CodecFuture {
        Box::pin(async move {
            let envelope = run_key_derivation(move || encrypt(&plaintext, &password, &unit))
                .await
                .map_err(|err| err.to_string())?
                .map_err(|err| err.to_string())?;
            serde_json::to_string(&envelope).map_err(|err| err.to_string())
        })
    }

    fn open(&self, content: Vec<u8>, password: Zeroizing<String>) -> CodecFuture {
        Box::pin(async move {
            // Text that is not JSON, or JSON that is not an envelope, fails
            // as `JSON.parse` and `decrypt` fail on it.
            let envelope: Envelope =
                serde_json::from_str(&String::from_utf8_lossy(&content)).map_err(|err| err.to_string())?;
            run_key_derivation(move || decrypt(&envelope, &password))
                .await
                .map_err(|err| err.to_string())?
                .map_err(|err| err.to_string())
        })
    }
}
