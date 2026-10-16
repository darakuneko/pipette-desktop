// SPDX-License-Identifier: GPL-2.0-or-later
//! The browserless sign-in of the e2e tests: with
//! `PIPETTE_DEV_SUPPRESS_BROWSER=1` the sync's sign-in opens no browser and
//! records its authorization URL instead, which `dev_sync_last_auth_url`
//! answers, so a test reads the state and the redirect from it and plays the
//! browser against the loopback listener itself. Builds with the
//! development tools only.

use std::sync::{Arc, Mutex, PoisonError};

use tauri::{AppHandle, Manager, State, Wry};

use crate::shell::AuthBrowser;

/// The variable that turns the browser off.
pub const SUPPRESS_BROWSER_ENV: &str = "PIPETTE_DEV_SUPPRESS_BROWSER";

/// The last authorization URL a suppressed browser was asked to open.
#[derive(Default)]
pub struct LastAuthUrl(Mutex<Option<String>>);

impl LastAuthUrl {
    fn get(&self) -> Option<String> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn set(&self, url: &str) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(url.to_owned());
    }
}

/// Manages the sign-in's browser: the system's, or with
/// [`SUPPRESS_BROWSER_ENV`] set to `1`, the recorder of `dev_sync_last_auth_url`.
pub fn manage(app: &AppHandle<Wry>) {
    let suppress = std::env::var_os(SUPPRESS_BROWSER_ENV).is_some_and(|value| value == "1");
    let last = Arc::new(LastAuthUrl::default());
    app.manage(browser_for(suppress, Arc::clone(&last), AuthBrowser::system()));
    app.manage(last);
}

fn browser_for(suppress: bool, last: Arc<LastAuthUrl>, system: AuthBrowser) -> AuthBrowser {
    if !suppress {
        return system;
    }
    log::warn!("[dev] {SUPPRESS_BROWSER_ENV}=1: the sign-in opens no browser");
    AuthBrowser::new(move |url| {
        last.set(url);
        Ok(())
    })
}

/// The last authorization URL the suppressed browser got; null before any.
#[tauri::command]
pub fn dev_sync_last_auth_url(last: State<'_, Arc<LastAuthUrl>>) -> Option<String> {
    last.get()
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use pipette_google_auth::BrowserOpener;

    use super::*;

    fn system(opened: &Arc<AtomicBool>) -> AuthBrowser {
        let opened = Arc::clone(opened);
        AuthBrowser::new(move |_| {
            opened.store(true, Ordering::SeqCst);
            Ok(())
        })
    }

    #[test]
    fn a_suppressed_browser_records_the_url_and_opens_nothing() {
        let opened = Arc::new(AtomicBool::new(false));
        let last = Arc::new(LastAuthUrl::default());
        let browser = browser_for(true, Arc::clone(&last), system(&opened));
        assert_eq!(last.get(), None);
        browser.open("http://127.0.0.1:1/auth?state=a").unwrap();
        browser.open("http://127.0.0.1:1/auth?state=b").unwrap();
        assert_eq!(last.get().as_deref(), Some("http://127.0.0.1:1/auth?state=b"));
        assert!(!opened.load(Ordering::SeqCst));
    }

    #[test]
    fn without_the_variable_the_system_browser_opens_the_url() {
        let opened = Arc::new(AtomicBool::new(false));
        let last = Arc::new(LastAuthUrl::default());
        browser_for(false, Arc::clone(&last), system(&opened)).open("http://127.0.0.1:1/auth").unwrap();
        assert!(opened.load(Ordering::SeqCst));
        assert_eq!(last.get(), None);
    }
}
