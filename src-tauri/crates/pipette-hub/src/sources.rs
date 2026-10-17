// SPDX-License-Identifier: GPL-2.0-or-later
//! What the Hub code takes from the rest of the app through traits, so the
//! crate depends on neither the Google sign-in nor the analytics actor and
//! the tests can stand in for both.

use std::future::Future;
use std::pin::Pin;

use zeroize::Zeroizing;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `getIdToken` of src/main/sync/google-auth.ts: the Google id_token the
/// Hub token is exchanged for (`test:<email>` for the Hub test account),
/// `None` when no one is signed in.
pub trait IdTokenSource: Send + Sync {
    fn id_token(&self) -> BoxFuture<'_, Option<Zeroizing<String>>>;
}

/// A closure answers at once, for the tests.
impl<F: Fn() -> Option<String> + Send + Sync> IdTokenSource for F {
    fn id_token(&self) -> BoxFuture<'_, Option<Zeroizing<String>>> {
        Box::pin(std::future::ready(self().map(Zeroizing::new)))
    }
}

/// The typing analytics queries the Analyze post's export reads
/// (src/main/hub/hub-analytics.ts). The app connects it to its analytics
/// actor; the export's tests answer from fixed rows.
pub trait AnalyticsSource: Send + Sync {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_closure_is_an_id_token_source() {
        let source = || Some("test:a@example.com".to_owned());
        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let token = runtime.block_on(source.id_token()).unwrap();
        assert_eq!(token.as_str(), "test:a@example.com");
        let signed_out = || None::<String>;
        assert!(runtime.block_on(signed_out.id_token()).is_none());
    }
}
