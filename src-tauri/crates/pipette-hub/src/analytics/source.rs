// SPDX-License-Identifier: GPL-2.0-or-later
//! The app's typing analytics as the [`AnalyticsSource`] of the Analyze
//! post's export: the machine hash and the cache of the analytics service,
//! each once its initialization has finished, the reads on its database
//! thread after the writes sent before them.

use std::sync::Arc;

use pipette_typing_analytics::TypingAnalytics;

use crate::sources::{AnalyticsJob, AnalyticsSource, BoxFuture};

/// [`AnalyticsSource`] over the app's analytics service.
#[derive(Clone)]
pub struct TypingAnalyticsSource(pub Arc<TypingAnalytics>);

impl AnalyticsSource for TypingAnalyticsSource {
    fn machine_hash(&self) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(async move {
            let ready = self.0.ready().await.map_err(|err| err.to_string())?;
            Ok(ready.machine_hash.clone())
        })
    }

    fn with_db(&self, job: AnalyticsJob) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let ready = self.0.ready().await.map_err(|err| err.to_string())?;
            ready.db.call(move |db| job(db)).await.map_err(|err| err.to_string())
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use pipette_entry_store::{RandomUuid, SystemClock};
    use pipette_typing_analytics::sync_state::{TypingSyncState, save_sync_state};
    use pipette_typing_analytics::{MachineIdentity, rebuild_from_master_files};

    use super::*;

    #[tokio::test]
    async fn reads_the_hash_and_the_cache_of_the_service_once_it_is_ready() {
        let dir = tempfile::tempdir().unwrap();
        let identity =
            || MachineIdentity::new(dir.path(), Arc::new(RandomUuid), Box::new(|| Ok("machine-id".into())));
        let hash = identity().machine_hash().unwrap();
        // A fresh cache for this hash: no rebuild.
        save_sync_state(dir.path(), &TypingSyncState::empty(&hash)).unwrap();
        let clock = Arc::new(SystemClock);
        let analytics = Arc::new(TypingAnalytics::new(
            dir.path(),
            identity(),
            clock.clone(),
            rebuild_from_master_files(clock),
        ));
        let source = TypingAnalyticsSource(analytics);
        assert_eq!(source.machine_hash().await.unwrap(), hash);
        let seen = Arc::new(Mutex::new(None));
        let sink = seen.clone();
        source
            .with_db(Box::new(move |db| {
                *sink.lock().unwrap() = Some(db.cache_needs_rebuild());
            }))
            .await
            .unwrap();
        assert_eq!(*seen.lock().unwrap(), Some(false));
    }
}
