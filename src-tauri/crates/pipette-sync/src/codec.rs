// SPDX-License-Identifier: GPL-2.0-or-later
//! The content of a unit's Drive file: its bundle's text in an encrypted
//! envelope, written as JSON text.

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

/// The envelope encryption of the sync format: a fresh salt and key per
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn seals_an_envelope_that_opens_with_the_password_only() {
        let content = EnvelopeCrypto
            .seal("{\"a\":1}".into(), Zeroizing::new("pw".into()), "favorites/macro".into())
            .await
            .unwrap();
        let envelope: Envelope = serde_json::from_str(&content).unwrap();
        assert_eq!(envelope.sync_unit, "favorites/macro");
        let opened = EnvelopeCrypto.open(content.clone().into_bytes(), Zeroizing::new("pw".into())).await;
        assert_eq!(opened.unwrap(), "{\"a\":1}");
        let wrong = EnvelopeCrypto.open(content.into_bytes(), Zeroizing::new("other".into())).await;
        assert_eq!(wrong.unwrap_err(), "Unsupported state or unable to authenticate data");
        assert!(EnvelopeCrypto.open(b"not json".to_vec(), Zeroizing::new("pw".into())).await.is_err());
    }
}
