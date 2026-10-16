// SPDX-License-Identifier: GPL-2.0-or-later
//! The harness of the sign-in tests: a GoogleAuth on a temporary userData
//! with an in-memory key store, a scripted token endpoint, a settable clock
//! and Hub test account, and a browser that records the URL it is given.

#![allow(dead_code, clippy::unwrap_used)]

use std::collections::VecDeque;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use pipette_google_auth::{AuthConfig, AuthTiming, BrowserOpener, GoogleAuth};
use pipette_net::{HttpError, HttpReply, HttpRequest, HttpRequester, RequestFuture};
use pipette_secret_store::{MemoryKeystore, SecretStore};
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{Notify, oneshot};

pub const TOKEN_ENDPOINT: &str = "http://127.0.0.1:9/token";
pub const AUTH_ENDPOINT: &str = "http://127.0.0.1:9/auth";
/// The clock the tests start at.
pub const NOW: i64 = 1_800_000_000_000;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// An answer of the scripted token endpoint.
pub enum Answer {
    Reply(u16, Value),
    /// Answers when the sender sends.
    Later(oneshot::Receiver<(u16, Value)>),
    /// Never answers.
    Hang,
}

/// A token endpoint that answers from a script and records the forms it
/// receives.
#[derive(Default)]
pub struct TokenEndpoint {
    answers: Mutex<VecDeque<Answer>>,
    forms: Mutex<Vec<Vec<(String, String)>>>,
}

impl TokenEndpoint {
    pub fn answer(&self, answer: Answer) {
        lock(&self.answers).push_back(answer);
    }

    pub fn ok(&self, body: Value) {
        self.answer(Answer::Reply(200, body));
    }

    /// Answers later; send on the returned sender to answer.
    pub fn later(&self) -> oneshot::Sender<(u16, Value)> {
        let (sender, receiver) = oneshot::channel();
        self.answer(Answer::Later(receiver));
        sender
    }

    pub fn forms(&self) -> Vec<Vec<(String, String)>> {
        lock(&self.forms).clone()
    }

    /// The value of `name` in the `index`th form.
    pub fn field(&self, index: usize, name: &str) -> Option<String> {
        self.forms().get(index)?.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone())
    }
}

impl HttpRequester for TokenEndpoint {
    fn request(&self, request: HttpRequest) -> RequestFuture<'_> {
        assert_eq!(request.url, TOKEN_ENDPOINT);
        assert_eq!(
            request.headers,
            vec![("Content-Type".to_owned(), "application/x-www-form-urlencoded".to_owned())]
        );
        let body = request.body.unwrap_or_default();
        lock(&self.forms).push(form_urlencoded::parse(&body).into_owned().collect());
        let answer = lock(&self.answers).pop_front();
        Box::pin(async move {
            let (status, body) = match answer {
                Some(Answer::Reply(status, body)) => (status, body),
                Some(Answer::Later(receiver)) => {
                    receiver.await.map_err(|_| HttpError::Network("dropped".into()))?
                }
                Some(Answer::Hang) => std::future::pending().await,
                None => panic!("the token endpoint has no answer scripted"),
            };
            let body = match body {
                Value::String(text) => text.into_bytes(),
                other => other.to_string().into_bytes(),
            };
            Ok(HttpReply { status, retry_after: None, content_type: None, body })
        })
    }
}

/// A token response with `extra` merged in.
pub fn tokens(extra: Value) -> Value {
    let mut body =
        json!({ "access_token": "a", "refresh_token": "r", "expires_in": 3600, "token_type": "Bearer" });
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    body
}

/// An unsigned JWT with `payload`.
pub fn jwt(payload: Value) -> String {
    format!("header.{}.sig", URL_SAFE_NO_PAD.encode(payload.to_string()))
}

/// A browser that records the URLs it is asked to open.
#[derive(Default)]
pub struct TestBrowser {
    urls: Mutex<Vec<String>>,
    opened: Notify,
}

impl BrowserOpener for TestBrowser {
    fn open(&self, url: &str) -> Result<(), String> {
        lock(&self.urls).push(url.to_owned());
        self.opened.notify_waiters();
        Ok(())
    }
}

impl TestBrowser {
    /// The `n`th URL opened, once it is.
    pub async fn url(&self, n: usize) -> url::Url {
        loop {
            let notified = self.opened.notified();
            if let Some(url) = lock(&self.urls).get(n) {
                return url::Url::parse(url).unwrap();
            }
            tokio::time::timeout(Duration::from_secs(5), notified).await.expect("the browser was not opened");
        }
    }

    pub fn opened(&self) -> usize {
        lock(&self.urls).len()
    }
}

/// The query parameter `name` of `url`.
pub fn param(url: &url::Url, name: &str) -> String {
    url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned()).unwrap()
}

/// Sends `GET <target>` to the loopback redirect of `url` and returns the
/// status of the answer, `None` when the connection fails or closes
/// without one.
pub async fn callback(url: &url::Url, target: &str) -> Option<u16> {
    let redirect = url::Url::parse(&param(url, "redirect_uri")).unwrap();
    let address = format!("127.0.0.1:{}", redirect.port().unwrap());
    let mut stream = TcpStream::connect(address).await.ok()?;
    let request = format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.ok()?;
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response)).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(&response);
    text.split(' ').nth(1)?.parse().ok()
}

pub struct Harness {
    pub auth: Arc<GoogleAuth>,
    pub keystore: Arc<MemoryKeystore>,
    pub secrets: Arc<SecretStore>,
    pub endpoint: Arc<TokenEndpoint>,
    pub clock: Arc<AtomicI64>,
    pub hub_account: Arc<Mutex<Option<String>>>,
    pub user_data: TempDir,
}

impl Harness {
    pub fn new() -> Self {
        Self::with_timing(AuthTiming::default())
    }

    pub fn with_timing(timing: AuthTiming) -> Self {
        let user_data = tempfile::tempdir().unwrap();
        let keystore = Arc::new(MemoryKeystore::default());
        let secrets = Arc::new(SecretStore::new(user_data.path(), keystore.clone()));
        let endpoint = Arc::new(TokenEndpoint::default());
        let clock = Arc::new(AtomicI64::new(NOW));
        let hub_account = Arc::new(Mutex::new(None));
        let config = AuthConfig {
            auth_endpoint: AUTH_ENDPOINT.to_owned(),
            token_endpoint: TOKEN_ENDPOINT.to_owned(),
            http: endpoint.clone(),
            timing,
            now_ms: {
                let clock = clock.clone();
                Arc::new(move || clock.load(Ordering::SeqCst))
            },
            hub_test_account: {
                let hub_account = hub_account.clone();
                Arc::new(move || lock(&hub_account).clone())
            },
        };
        let auth = Arc::new(GoogleAuth::new(config, secrets.clone()));
        Self { auth, keystore, secrets, endpoint, clock, hub_account, user_data }
    }

    pub fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    pub fn set_hub_account(&self, account: Option<&str>) {
        *lock(&self.hub_account) = account.map(str::to_owned);
    }

    /// Signs in through the code exchange with `body` as the answer.
    pub async fn sign_in_with(&self, body: Value) {
        self.endpoint.ok(body);
        self.auth
            .exchange_code_for_tokens("code", "verifier", 8080, &pipette_google_auth::SwitchDirectly)
            .await
            .unwrap();
    }

    pub fn token_file(&self) -> std::path::PathBuf {
        self.user_data.path().join("local/auth/tauri-oauth-tokens.bin")
    }
}
