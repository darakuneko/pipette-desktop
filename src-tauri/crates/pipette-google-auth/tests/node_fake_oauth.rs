// SPDX-License-Identifier: GPL-2.0-or-later
//! The whole sign-in against the Node fake Google of the sync tests
//! (scripts/fake-drive/server.ts): its authorization endpoint sends the
//! "browser" (a client that sends only to the loopback interface) back to
//! the loopback redirect with a code, and its token endpoint checks the
//! PKCE verifier, issues the tokens and refreshes them.
//!
//! Needs Node and the repository's node_modules (tsx). Without them the test is
//! skipped, unless `PIPETTE_REQUIRE_FAKE_OAUTH=1` (CI) makes that a failure.

#![allow(clippy::unwrap_used)]

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use pipette_google_auth::{AuthConfig, AuthTiming, BrowserOpener, GoogleAuth, SwitchDirectly};
use pipette_net::{HttpClient, Limits, ReqwestClient};
use pipette_secret_store::{MemoryKeystore, SecretStore};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// The fake server, stopped when dropped.
struct FakeServer {
    child: Child,
    env: serde_json::Value,
}

impl Drop for FakeServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl FakeServer {
    fn start() -> Option<Self> {
        if !repo_root().join("node_modules/tsx").exists() {
            assert!(
                std::env::var("PIPETTE_REQUIRE_FAKE_OAUTH").as_deref() != Ok("1"),
                "node_modules/tsx is missing; run pnpm install"
            );
            eprintln!("skipped: node_modules/tsx is missing");
            return None;
        }
        // Node itself with tsx's loader, one process: killing it stops the
        // server (the tsx binary would leave its Node child running).
        let mut child = Command::new("node")
            .args(["--import", "tsx", "scripts/fake-drive/server.ts"])
            .current_dir(repo_root())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
        let printed: serde_json::Value = serde_json::from_str(&line).unwrap();
        Some(Self { child, env: printed["env"].clone() })
    }

    fn var(&self, name: &str) -> String {
        self.env[name].as_str().unwrap().to_owned()
    }
}

/// A browser that follows the authorization URL's redirects, on the
/// loopback interface only.
struct FollowingBrowser(Arc<ReqwestClient>);

impl BrowserOpener for FollowingBrowser {
    fn open(&self, url: &str) -> Result<(), String> {
        let client = self.0.clone();
        let url = url.to_owned();
        tokio::spawn(async move {
            let response = client.get_bytes(&url).await.unwrap();
            assert_eq!(response.status, 200, "the loopback redirect answered {}", response.status);
        });
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn signs_in_and_refreshes_against_the_fake_google() {
    let Some(server) = FakeServer::start() else { return };
    let user_data = tempfile::tempdir().unwrap();
    let secrets = Arc::new(SecretStore::new(user_data.path(), Arc::new(MemoryKeystore::default())));
    let client = Arc::new(ReqwestClient::loopback_only(Limits::DEFAULT, "pipette-test"));
    let clock = Arc::new(AtomicI64::new(pipette_time::now_ms()));
    let auth = GoogleAuth::new(
        AuthConfig {
            auth_endpoint: server.var("PIPETTE_GOOGLE_AUTH_URL"),
            token_endpoint: server.var("PIPETTE_GOOGLE_TOKEN_URL"),
            http: client.clone(),
            timing: AuthTiming::default(),
            now_ms: {
                let clock = clock.clone();
                Arc::new(move || clock.load(Ordering::SeqCst))
            },
            hub_test_account: Arc::new(|| None),
        },
        secrets,
    );

    auth.sign_in(&FollowingBrowser(client), &SwitchDirectly).await.unwrap();

    assert!(auth.is_authenticated().await);
    assert_eq!(auth.account_sub().await.as_deref(), Some("fake-sub-1"));
    let first = auth.access_token().await.unwrap();
    assert!(first.starts_with("fake-access-"), "{}", first.as_str());
    // An hour later the token is refreshed with the refresh token the fake
    // issued for this account.
    clock.fetch_add(3600 * 1000, Ordering::SeqCst);
    let refreshed = auth.access_token().await.unwrap();
    assert!(refreshed.starts_with("fake-access-"));
    assert_ne!(refreshed, first);
    assert_eq!(auth.account_sub().await.as_deref(), Some("fake-sub-1"));
}
