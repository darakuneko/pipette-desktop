// SPDX-License-Identifier: GPL-2.0-or-later
//! The stored Google tokens (src/main/sync/google-auth.ts): the token file
//! of the secret store, its cache in memory, the session generation and the
//! queue every read, write and removal of the file goes through.
//!
//! The session generation advances with every sign-in and sign-out. A write
//! checks it before and after writing, so a refresh or a sign-in that
//! started under another session stores nothing; a read under another
//! session keeps what the cache holds. The queue is a fair lock, so the file
//! work runs one at a time in call order (`queueTokenFileWork`).

use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use pipette_secret_store::{SecretKind, SecretStore, StoreError};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::AuthError;

/// The stored tokens, in the JSON shape of Electron's `StoredTokens`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTokens {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix time in milliseconds.
    pub expires_at: i64,
    pub id_token: Option<String>,
}

impl Drop for StoredTokens {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
        if let Some(id_token) = &mut self.id_token {
            id_token.zeroize();
        }
    }
}

impl fmt::Debug for StoredTokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredTokens").field("expires_at", &self.expires_at).finish_non_exhaustive()
    }
}

pub(crate) struct TokenFile {
    secrets: Arc<SecretStore>,
    queue: tokio::sync::Mutex<()>,
    session: AtomicU64,
    cached: Mutex<Option<Arc<StoredTokens>>>,
}

impl TokenFile {
    pub(crate) fn new(secrets: Arc<SecretStore>) -> Self {
        Self {
            secrets,
            queue: tokio::sync::Mutex::new(()),
            session: AtomicU64::new(0),
            cached: Mutex::new(None),
        }
    }

    pub(crate) fn session(&self) -> u64 {
        self.session.load(Ordering::SeqCst)
    }

    /// Starts a new session and returns it.
    pub(crate) fn next_session(&self) -> u64 {
        self.session.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, Option<Arc<StoredTokens>>> {
        self.cached.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Stores `tokens` unless the session changed since `generation` was
    /// taken or `still_wanted` says no, both checked again after the write
    /// (`storeTokens`). A sign-out during the write removes the file next,
    /// so the tokens are not cached then either.
    pub(crate) async fn store(
        &self,
        tokens: StoredTokens,
        generation: u64,
        still_wanted: impl Fn() -> bool,
    ) -> Result<(), AuthError> {
        let _queue = self.queue.lock().await;
        let current = || generation == self.session() && still_wanted();
        if !current() {
            return Err(AuthError::SignInChanged);
        }
        let json =
            Zeroizing::new(serde_json::to_vec(&tokens).map_err(|err| AuthError::Other(err.to_string()))?);
        self.secrets.store(SecretKind::OauthTokens, &json).await.map_err(|err| match err {
            StoreError::KeystoreUnavailable => AuthError::KeystoreUnavailable,
            StoreError::Io(err) => AuthError::Other(err.to_string()),
        })?;
        if !current() {
            return Err(AuthError::SignInChanged);
        }
        *self.cache() = Some(Arc::new(tokens));
        Ok(())
    }

    /// The stored tokens, from memory or the file (`loadTokens`); `None`
    /// when there are none or they cannot be read.
    pub(crate) async fn load(&self) -> Option<Arc<StoredTokens>> {
        if let Some(tokens) = self.cache().clone() {
            return Some(tokens);
        }
        let generation = self.session();
        // Queued after any write or removal under way, so a read never sees
        // a file a sign-out is about to remove.
        let _queue = self.queue.lock().await;
        let bytes = match self.secrets.read_if_present(SecretKind::OauthTokens).await {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return None,
            Err(err) => {
                log::warn!("[google-auth] the stored tokens cannot be read: {err}");
                return None;
            }
        };
        let tokens: StoredTokens = match serde_json::from_slice(&bytes) {
            Ok(tokens) => tokens,
            Err(err) => {
                log::warn!("[google-auth] the stored tokens are damaged: {err}");
                return None;
            }
        };
        let mut cache = self.cache();
        // A sign-in or sign-out during the read decides what is signed in.
        if generation != self.session() {
            return cache.clone();
        }
        let tokens = Arc::new(tokens);
        *cache = Some(Arc::clone(&tokens));
        Some(tokens)
    }

    /// Ends the session, forgets the cached tokens and removes the file,
    /// ignoring every failure (`signOut`).
    pub(crate) async fn clear(&self) {
        self.next_session();
        *self.cache() = None;
        let _queue = self.queue.lock().await;
        if let Err(err) = self.secrets.clear(SecretKind::OauthTokens).await {
            log::warn!("[google-auth] the token file could not be removed: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_in_the_electron_shape() {
        let tokens = StoredTokens {
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: 1_700_000_000_000,
            id_token: None,
        };
        assert_eq!(
            serde_json::to_string(&tokens).unwrap(),
            r#"{"accessToken":"a","refreshToken":"r","expiresAt":1700000000000,"idToken":null}"#
        );
        assert_eq!(format!("{tokens:?}"), "StoredTokens { expires_at: 1700000000000, .. }");
    }
}
