// SPDX-License-Identifier: GPL-2.0-or-later
//! The stored Google tokens (src/main/sync/google-auth.ts): the token file
//! of the secret store, its cache in memory, the session [`Stamp`] and the
//! queue every read, write and removal of the file goes through. The queue
//! is a fair lock, so the file work runs one at a time in call order
//! (`queueTokenFileWork`).
//!
//! Electron's one session generation is two counters here. The sign-outs
//! asked for advance when `signOut` is called, as Electron's generation
//! does, so a write under way or queued by then fails as it does there.
//! The session advances inside the queue only, at the store of a sign-in
//! and at the turn of a sign-out: Electron's single-threaded main process
//! leaves no room between advancing its generation and queueing the work,
//! but other threads would, and a read queued there would cache the file a
//! sign-out is about to remove. Every change of either counter empties the
//! cache under the cache lock, so the cache only holds tokens of the
//! current stamp, and [`Loaded`] gives them with it. A refresh stores its
//! tokens only while the stamp of the tokens it refreshed is the current
//! one.

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
    /// Absent when the code exchange returned none: Electron's
    /// `JSON.stringify` leaves out the `undefined` it holds then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix time in milliseconds.
    pub expires_at: i64,
    pub id_token: Option<String>,
}

impl Drop for StoredTokens {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
        self.id_token.zeroize();
    }
}

impl fmt::Debug for StoredTokens {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StoredTokens").field("expires_at", &self.expires_at).finish_non_exhaustive()
    }
}

/// Which sign-in tokens belong to: the session and the sign-outs asked
/// for (see the module comment).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Stamp {
    session: u64,
    sign_outs: u64,
}

/// Tokens with the stamp they were read or written under.
#[derive(Clone)]
pub(crate) struct Loaded {
    pub(crate) stamp: Stamp,
    pub(crate) tokens: Arc<StoredTokens>,
}

pub(crate) struct TokenFile {
    secrets: Arc<SecretStore>,
    queue: tokio::sync::Mutex<()>,
    /// Advanced in the queue only.
    session: AtomicU64,
    /// Advanced when a sign-out is asked for, before it waits for the queue.
    sign_outs: AtomicU64,
    /// Tokens of the current stamp only (see the module comment).
    cached: Mutex<Option<Loaded>>,
}

impl TokenFile {
    pub(crate) fn new(secrets: Arc<SecretStore>) -> Self {
        Self {
            secrets,
            queue: tokio::sync::Mutex::new(()),
            session: AtomicU64::new(0),
            sign_outs: AtomicU64::new(0),
            cached: Mutex::new(None),
        }
    }

    fn stamp(&self) -> Stamp {
        Stamp {
            session: self.session.load(Ordering::SeqCst),
            sign_outs: self.sign_outs.load(Ordering::SeqCst),
        }
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, Option<Loaded>> {
        self.cached.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts a new session with nothing cached; runs in the queue.
    fn next_session(&self) -> Stamp {
        Self::next_session_locked(&self.session, &mut self.cache());
        self.stamp()
    }

    fn next_session_locked(session: &AtomicU64, cache: &mut Option<Loaded>) {
        *cache = None;
        session.fetch_add(1, Ordering::SeqCst);
    }

    /// Stores the tokens of a refresh of tokens of `stamp`, unless a
    /// sign-in or sign-out came since, checked before and after the write
    /// (`storeTokens`).
    pub(crate) async fn store_refresh(&self, tokens: StoredTokens, stamp: Stamp) -> Result<(), AuthError> {
        let _queue = self.queue.lock().await;
        if stamp != self.stamp() {
            return Err(AuthError::SignInChanged);
        }
        self.write_and_keep(tokens, stamp).await
    }

    /// Stores the tokens of a sign-in as a new session, if `still_wanted`
    /// says so when its turn in the queue comes. The check and the new
    /// session come before the write, together under the queue, so a
    /// cancelled sign-in neither writes nor ends the session of a later
    /// one; once written, only a sign-out keeps the tokens from being kept.
    /// They also run together under the cache lock, where a sign-out is
    /// asked for ([`TokenFile::ask_sign_out`]): a sign-out that cancels the
    /// sign-in before the check makes the check fail, and one asked for
    /// after it sees the new session and removes what it writes.
    pub(crate) async fn store_new_session(
        &self,
        tokens: StoredTokens,
        still_wanted: impl FnOnce() -> bool,
    ) -> Result<(), AuthError> {
        let _queue = self.queue.lock().await;
        let stamp = {
            let mut cache = self.cache();
            if !still_wanted() {
                return Err(AuthError::SignInChanged);
            }
            Self::next_session_locked(&self.session, &mut cache);
            self.stamp()
        };
        self.write_and_keep(tokens, stamp).await
    }

    /// Writes `tokens` and caches them if the stamp is still `stamp`. Runs
    /// in the queue, so only a sign-out asked for during the write changes
    /// it; that sign-out removes the file next (it is queued after this),
    /// so the tokens are not cached then.
    async fn write_and_keep(&self, tokens: StoredTokens, stamp: Stamp) -> Result<(), AuthError> {
        let json =
            Zeroizing::new(serde_json::to_vec(&tokens).map_err(|err| AuthError::Other(err.to_string()))?);
        self.secrets.store(SecretKind::OauthTokens, &json).await.map_err(|err| match err {
            StoreError::KeystoreUnavailable => AuthError::KeystoreUnavailable,
            StoreError::Io(err) => AuthError::Other(err.to_string()),
        })?;
        let mut cache = self.cache();
        if stamp != self.stamp() {
            return Err(AuthError::SignInChanged);
        }
        *cache = Some(Loaded { stamp, tokens: Arc::new(tokens) });
        Ok(())
    }

    /// The stored tokens with their stamp, from memory or the file
    /// (`loadTokens`); `None` when there are none or they cannot be read.
    pub(crate) async fn load(&self) -> Option<Loaded> {
        let stamp = {
            let cache = self.cache();
            if let Some(loaded) = cache.clone() {
                return Some(loaded);
            }
            self.stamp()
        };
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
        if stamp != self.stamp() {
            return cache.clone();
        }
        let loaded = Loaded { stamp, tokens: Arc::new(tokens) };
        *cache = Some(loaded.clone());
        Some(loaded)
    }

    /// Ends the session, forgets the cached tokens and removes the file,
    /// ignoring every failure (`signOut`). The sign-out counts as asked for
    /// at once; the new session, the emptied cache and the removal come at
    /// its turn in the queue, so whatever a read queued before it cached is
    /// dropped there, and a read queued after it finds no file. A sign-in
    /// that stored its tokens in between came later and stays signed in.
    pub(crate) async fn clear(&self) {
        let asked_in = self.ask_sign_out();
        self.sign_out_in_turn(asked_in).await;
    }

    /// Counts the sign-out as asked for and returns the session it was
    /// asked in.
    fn ask_sign_out(&self) -> u64 {
        let mut cache = self.cache();
        self.sign_outs.fetch_add(1, Ordering::SeqCst);
        *cache = None;
        self.session.load(Ordering::SeqCst)
    }

    /// The sign-out's work at its turn, unless a sign-in stored its tokens
    /// after the sign-out was asked for in session `asked_in`: that sign-in
    /// came later, and in Electron its write is queued after the removal
    /// and stays.
    async fn sign_out_in_turn(&self, asked_in: u64) {
        let _queue = self.queue.lock().await;
        if self.session.load(Ordering::SeqCst) != asked_in {
            return;
        }
        self.next_session();
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
            refresh_token: Some("r".into()),
            expires_at: 1_700_000_000_000,
            id_token: None,
        };
        assert_eq!(
            serde_json::to_string(&tokens).unwrap(),
            r#"{"accessToken":"a","refreshToken":"r","expiresAt":1700000000000,"idToken":null}"#
        );
        assert_eq!(format!("{tokens:?}"), "StoredTokens { expires_at: 1700000000000, .. }");
    }

    fn tokens(access_token: &str) -> StoredTokens {
        StoredTokens {
            access_token: access_token.into(),
            refresh_token: Some("r".into()),
            expires_at: i64::MAX,
            id_token: None,
        }
    }

    /// A read can take its place in the queue after a sign-out was asked
    /// for and before the sign-out takes its own (another thread can run in
    /// between): what it reads and caches is dropped at the sign-out's turn.
    #[tokio::test]
    async fn a_read_between_a_sign_out_and_its_turn_keeps_nothing_past_the_sign_out() {
        let dir = tempfile::tempdir().unwrap();
        let keystore = Arc::new(pipette_secret_store::MemoryKeystore::default());
        let file = TokenFile::new(Arc::new(SecretStore::new(dir.path(), keystore)));
        file.store_new_session(tokens("a"), || true).await.unwrap();
        let asked_in = file.ask_sign_out();
        let read = file.load().await.unwrap();
        assert_eq!(read.tokens.access_token, "a");
        file.sign_out_in_turn(asked_in).await;
        assert!(file.load().await.is_none());
        assert!(!file.secrets.path(SecretKind::OauthTokens).exists());
    }

    /// A sign-in can store its tokens after a sign-out was asked for and
    /// before the sign-out takes its place in the queue: the sign-in came
    /// later, so its tokens stay.
    #[tokio::test]
    async fn a_sign_in_stored_between_a_sign_out_and_its_turn_stays_signed_in() {
        let dir = tempfile::tempdir().unwrap();
        let keystore = Arc::new(pipette_secret_store::MemoryKeystore::default());
        let file = TokenFile::new(Arc::new(SecretStore::new(dir.path(), keystore)));
        file.store_new_session(tokens("a"), || true).await.unwrap();
        let asked_in = file.ask_sign_out();
        file.store_new_session(tokens("b"), || true).await.unwrap();
        file.sign_out_in_turn(asked_in).await;
        assert_eq!(file.load().await.unwrap().tokens.access_token, "b");
        let other = TokenFile::new(Arc::clone(&file.secrets));
        assert_eq!(other.load().await.unwrap().tokens.access_token, "b");
    }

    #[test]
    fn leaves_out_a_missing_refresh_token_as_electron_does() {
        let text = r#"{"accessToken":"a","expiresAt":1,"idToken":null}"#;
        let tokens: StoredTokens = serde_json::from_str(text).unwrap();
        assert_eq!(tokens.refresh_token, None);
        assert_eq!(serde_json::to_string(&tokens).unwrap(), text);
    }
}
