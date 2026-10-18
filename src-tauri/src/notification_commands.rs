// SPDX-License-Identifier: GPL-2.0-or-later
//! The command behind the shim's notification member
//! (src/tauri-shim/api/notification.ts): `NOTIFICATION_FETCH` of
//! src/main/notification-store.ts, the startup notices. The renderer asks
//! for them (useStartupNotification and the Settings Notification tab);
//! nothing here fetches on its own.
//!
//! The destination (`pipette_notification::NoticeDestination`) is settled
//! on the first fetch from the process's environment and kept: the real
//! endpoint, or in a build with the development tools a
//! `PIPETTE_NOTIFICATION_URL` override with a client limited to the
//! loopback interface. In an e2e run (`crate::e2e_run`) a destination off
//! the loopback interface gets no request at all; this check is compiled
//! into every build and is a no-op where `is_e2e_run` is false.

use std::sync::Arc;

use pipette_net::HttpRequester;
use pipette_notification::{NoticeDestination, NotificationFetchResult};
use tauri::{AppHandle, Manager, Runtime};

/// Where the notices are fetched from and the client that fetches them.
pub struct NoticeSource {
    destination: NoticeDestination,
    requester: Arc<dyn HttpRequester>,
}

impl NoticeSource {
    pub fn new(destination: NoticeDestination, requester: Arc<dyn HttpRequester>) -> Self {
        Self { destination, requester }
    }

    /// The source of this process's environment.
    #[cfg(not(test))]
    fn from_process_env<R: Runtime>(app: &AppHandle<R>) -> Self {
        let destination = NoticeDestination::from_process_env(cfg!(feature = "dev-tools"));
        let requester = destination.requester(&format!("Pipette/{}", app.package_info().version));
        Self::new(destination, requester)
    }

    /// Fetches the notices, unless `e2e_run` and the destination is off the
    /// loopback interface: then nothing is sent and the fetch fails.
    pub async fn fetch(&self, e2e_run: bool, now_ms: i64) -> NotificationFetchResult {
        let url = &self.destination.url;
        if let Err(error) = crate::e2e_run::notification_destination_allowed(url, e2e_run) {
            log::warn!("[notification] {error}");
            return NotificationFetchResult::failed(error);
        }
        pipette_notification::fetch_notifications(&*self.requester, url, now_ms).await
    }
}

/// The managed source; on the first call, the one of this process's
/// environment. A unit test's app manages its own ([`manage_for_tests`]),
/// and without one nothing is sent.
fn source<R: Runtime>(app: &AppHandle<R>) -> Option<Arc<NoticeSource>> {
    if let Some(source) = app.try_state::<Arc<NoticeSource>>() {
        return Some(Arc::clone(&source));
    }
    #[cfg(not(test))]
    {
        // Two first calls at once may both build one; the first managed wins.
        app.manage(Arc::new(NoticeSource::from_process_env(app)));
        app.try_state::<Arc<NoticeSource>>().map(|source| Arc::clone(&source))
    }
    #[cfg(test)]
    None
}

#[tauri::command]
pub async fn notification_fetch<R: Runtime>(app: AppHandle<R>) -> NotificationFetchResult {
    match source(&app) {
        Some(source) => source.fetch(crate::e2e_run::is_e2e_run(), pipette_time::now_ms()).await,
        None => NotificationFetchResult::failed("the notice source is not set up"),
    }
}

/// Manages a source that answers every fetch with one notice and sends
/// nothing, for the IPC contract tests (ipc_contract.rs).
#[cfg(test)]
pub fn manage_for_tests<R: Runtime>(app: &AppHandle<R>) {
    use pipette_net::{HttpError, HttpReply, HttpRequest};
    let answer = |_: HttpRequest| -> Result<HttpReply, HttpError> {
        Ok(HttpReply {
            status: 200,
            retry_after: None,
            content_type: Some("application/json".to_owned()),
            body: br#"{"notifications":[{"title":"Release","body":"Notes","type":"info","publishedAt":{"_seconds":1760000000,"_nanoseconds":0}}]}"#.to_vec(),
        })
    };
    let destination = NoticeDestination::resolve(false, &|_| None);
    app.manage(Arc::new(NoticeSource::new(destination, Arc::new(answer))));
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use pipette_net::{HttpError, HttpReply, HttpRequest};
    use pipette_notification::NOTIFICATION_ENDPOINT;

    use super::*;

    /// A requester that counts its requests and answers with no notices.
    fn counting(count: &Arc<AtomicUsize>) -> Arc<dyn HttpRequester> {
        let count = Arc::clone(count);
        Arc::new(move |_: HttpRequest| -> Result<HttpReply, HttpError> {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(HttpReply {
                status: 200,
                retry_after: None,
                content_type: None,
                body: br#"{"notifications":[]}"#.to_vec(),
            })
        })
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap_or_else(|err| panic!("{err}"))
            .block_on(future)
    }

    fn destination(dev_tools: bool, vars: &'static [(&'static str, &'static str)]) -> NoticeDestination {
        NoticeDestination::resolve(dev_tools, &|name| {
            vars.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned())
        })
    }

    #[test]
    fn an_e2e_run_sends_nothing_to_a_destination_off_the_loopback_interface() {
        for destination in [
            // No override: the real endpoint.
            destination(true, &[("PIPETTE_E2E", "1")]),
            destination(true, &[("PIPETTE_E2E", "1"), ("PIPETTE_NOTIFICATION_URL", "")]),
            destination(
                true,
                &[("PIPETTE_E2E", "1"), ("PIPETTE_NOTIFICATION_URL", "https://example.invalid")],
            ),
            destination(true, &[("PIPETTE_E2E", "1"), ("PIPETTE_NOTIFICATION_URL", "http://localhost:9")]),
        ] {
            let count = Arc::new(AtomicUsize::new(0));
            let source = NoticeSource::new(destination.clone(), counting(&count));
            let result = block_on(source.fetch(true, 0));
            assert!(!result.success && result.error.is_some(), "{destination:?}: {result:?}");
            assert_eq!(count.load(Ordering::SeqCst), 0, "{destination:?}");
        }
    }

    #[test]
    fn an_e2e_run_fetches_from_a_loopback_override() {
        let count = Arc::new(AtomicUsize::new(0));
        let destination =
            destination(true, &[("PIPETTE_E2E", "1"), ("PIPETTE_NOTIFICATION_URL", "http://127.0.0.1:9")]);
        let source = NoticeSource::new(destination, counting(&count));
        assert_eq!(block_on(source.fetch(true, 0)), NotificationFetchResult::fetched(vec![]));
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_build_without_the_tools_ignores_the_override_and_the_e2e_mark() {
        // The release build reads neither variable: the destination is the
        // real endpoint, and the fetch is not refused (`is_e2e_run` is
        // false without the tools). The requester here sends nothing.
        let destination =
            destination(false, &[("PIPETTE_E2E", "1"), ("PIPETTE_NOTIFICATION_URL", "http://127.0.0.1:9")]);
        assert_eq!(destination.url, NOTIFICATION_ENDPOINT);
        assert!(!pipette_hub::is_e2e_run(false, &|_| Some("1".to_owned())));
        let count = Arc::new(AtomicUsize::new(0));
        let source = NoticeSource::new(destination, counting(&count));
        assert!(block_on(source.fetch(false, 0)).success);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
}
