// SPDX-License-Identifier: GPL-2.0-or-later
//! The Rust side of the Hub peer comparison (scripts/hub-peer/): this
//! crate's Hub code on a copy of a userData, as the Tauri build runs it,
//! against a scripted Hub inside the process. Nothing is sent anywhere:
//! the requests are answered by the scripted Hub's rules (the format of
//! scripts/hub-fixtures/hub-harness.ts `HubRule`) and recorded.
//!
//!   hub_peer <input.json>
//!
//! where the input has `userData` (the copy), `out` (the file the output
//! goes to), `now` (the clock of the stores and of the Hub client, in
//! milliseconds), `hubBase` (the scripted Hub's base, on 127.0.0.1 only)
//! and `command`, one of
//!
//! - `{"kind": "analytics", "ownHash", "seed"?, "params": [...]}`: the
//!   Analyze post's export of each `params` on a cache rebuilt from the
//!   copy's day files (or with the rows of the JSONL file `seed`), as
//!   `prepareAnalyticsExport` gives it with the preview values;
//! - `{"kind": "favoriteEntries", "entries": [{"type", "entryId"}]}`: the
//!   `hub_favorite_entry` answer of each entry;
//! - `{"kind": "calls", "idToken", "rules", "calls": [{"call", "args",
//!   "json"?}]}`: each upload handler's answer and the requests it sent,
//!   signed in with the Google id_token `idToken`;
//! - `{"kind": "startupSync", "rules"}`: the startup update of the
//!   Hub-linked language packs, its result and requests.
//!
//! A request is written as the comparison reads it: the method, the path,
//! the query's pairs sorted, the headers by lower-case name (without
//! `user-agent`, `accept` and the multipart boundary) and the body's bytes
//! as hex with the multipart boundary written as `{boundary}`. The output
//! holds the copy's data and stays in the file `out`; only `elapsedMs` and
//! `maxRssKb` are printed.
//!
//! The userData, the input and the output must be absolute paths outside
//! the real userData directories (checked through symlinks); otherwise the
//! peer exits with code 2 before touching anything.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::print_stdout, clippy::print_stderr)]

#[path = "../tests/common/mod.rs"]
mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::object;
use common::scripted_hub::{ScriptedHub, scripted_hub};
use pipette_entry_store::{Clock, FixedClock, WriteLocks};
use pipette_hub::analytics::{PrepareError, Prepared, prepare_analytics_export, preview};
use pipette_hub::packs::{self, PackKind};
use pipette_hub::sources::{AnalyticsJob, AnalyticsSource, BoxFuture};
use pipette_hub::token::HubToken;
use pipette_hub::{favorite, key_labels, startup_sync};
use pipette_js_json::{Object, Value, parse, stringify};
use pipette_keyboard_stores::StoreContext;
use pipette_net::HttpRequest;
use pipette_typing_analytics::{DbActor, rebuild_cache_from_master_files};

/// The rebuilt cache and the machine hash it was rebuilt for.
struct Cache {
    db: DbActor,
    hash: String,
}

impl AnalyticsSource for Cache {
    fn machine_hash(&self) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(std::future::ready(Ok(self.hash.clone())))
    }

    fn with_db(&self, job: AnalyticsJob) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move { self.db.call(move |db| job(db)).await.map_err(|err| err.to_string()) })
    }
}

fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|object| object.get(key))
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    get(value, key).unwrap_or_else(|| panic!("hub_peer: no {key}"))
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_else(|| panic!("hub_peer: not a string: {}", stringify(value))).to_owned()
}

fn list(value: &Value) -> &[Value] {
    match value {
        Value::Array(items) => items,
        other => panic!("hub_peer: not an array: {}", stringify(other)),
    }
}

/// An argument as the handler gets it: `None` for a missing one.
fn arg(args: &[Value], index: usize) -> Option<&Value> {
    args.get(index)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `bytes` with every `needle` replaced by `with`.
fn replace(bytes: &[u8], needle: &[u8], with: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at..].starts_with(needle) {
            out.extend_from_slice(with);
            at += needle.len();
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    out
}

/// A request as the comparison reads it (see the module comment).
fn logged(request: &HttpRequest, base: &str) -> Value {
    let rest = request.url.strip_prefix(base).expect("a request to the scripted Hub");
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let mut pairs: Vec<(String, String)> = form_urlencoded::parse(query.as_bytes()).into_owned().collect();
    pairs.sort();
    let mut boundary = None;
    let mut headers: Vec<(String, String)> = Vec::new();
    for (name, value) in &request.headers {
        let name = name.to_ascii_lowercase();
        if name == "user-agent" || name == "accept" {
            continue;
        }
        let value = match value.split_once("; boundary=") {
            Some((kind, found)) if name == "content-type" => {
                boundary = Some(found.to_owned());
                kind.to_owned()
            }
            _ => value.clone(),
        };
        headers.push((name, value));
    }
    headers.sort();
    let body = request.body.as_ref().map(|body| match &boundary {
        Some(boundary) => hex(&replace(body, boundary.as_bytes(), b"{boundary}")),
        None => hex(body),
    });
    let query =
        pairs.into_iter().map(|(name, value)| Value::Array(vec![name.into(), value.into()])).collect();
    let headers: Object = headers.into_iter().map(|(name, value)| (name, Value::from(value))).collect();
    object([
        ("method", request.method.as_str().into()),
        ("path", path.into()),
        ("query", Value::Array(query)),
        ("headers", Value::Object(headers)),
        ("bodyHex", body.map_or(Value::Null, Value::from)),
    ])
}

/// The requests sent since the last call, as [`logged`] writes them.
fn take_requests(hub: &ScriptedHub, base: &str) -> Value {
    let sent: Vec<HttpRequest> = std::mem::take(&mut *hub.script.sent.lock().unwrap());
    Value::Array(sent.iter().map(|request| logged(request, base)).collect())
}

fn analytics(input: &Value, command: &Value, stores: &StoreContext, now: i64) -> Value {
    let user_data = PathBuf::from(text(field(input, "userData")));
    let hash = text(field(command, "ownHash"));
    let db = DbActor::open_in_memory().unwrap();
    match get(command, "seed") {
        Some(seed) => {
            let path = PathBuf::from(text(seed));
            refuse_unsafe_path("seed", &path);
            let rows = std::fs::read_to_string(path).unwrap();
            db.call_blocking(move |db| db.apply_day_jsonl(&rows).map(drop)).unwrap().unwrap();
        }
        None => {
            let clock: Arc<dyn Clock> = Arc::new(FixedClock::new(now));
            rebuild_cache_from_master_files(&db, &user_data, &hash, &clock).unwrap();
        }
    }
    let source = Cache { db, hash };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let results = list(field(command, "params"))
        .iter()
        .map(|params| match runtime.block_on(prepare_analytics_export(params, stores, &source, now)) {
            Ok(prepared @ Prepared::Built(_)) => {
                let Prepared::Built(export) = &prepared else { unreachable!() };
                object([("exportJson", export.to_json().into()), ("preview", preview(&prepared))])
            }
            Ok(Prepared::Failed { error, total_keystrokes, range_ms }) => object([(
                "failed",
                object([
                    ("error", error.into()),
                    ("totalKeystrokes", Value::Number(total_keystrokes)),
                    ("rangeMs", Value::Number(range_ms)),
                ]),
            )]),
            Err(PrepareError(message)) => object([("thrown", message.into())]),
        })
        .collect();
    object([("results", Value::Array(results))])
}

fn favorite_entries(input: &Value, command: &Value) -> Value {
    let sync_dir = PathBuf::from(text(field(input, "userData"))).join("sync");
    let results = list(field(command, "entries"))
        .iter()
        .map(|entry| {
            favorite::entry_answer(favorite::read_entry(&sync_dir, get(entry, "type"), get(entry, "entryId")))
        })
        .collect();
    object([("results", Value::Array(results))])
}

async fn run_call(token: &HubToken, stores: &StoreContext, call: &Value) -> Value {
    let name = text(field(call, "call"));
    let args = list(field(call, "args"));
    let a = arg(args, 0);
    match name.as_str() {
        "KEY_LABEL_HUB_UPLOAD" => parse(&key_labels::upload(token, stores, a).await).unwrap(),
        "HUB_UPLOAD_I18N_POST" => packs::upload(token, stores, PackKind::I18n, a).await,
        "HUB_UPLOAD_THEME_POST" => packs::upload(token, stores, PackKind::Theme, a).await,
        "HUB_UPLOAD_FAVORITE_POST" => favorite::upload(token, a, &text(field(call, "json"))).await,
        other => panic!("hub_peer: not an upload call: {other}"),
    }
}

fn calls(base: &str, now: f64, command: &Value, stores: &StoreContext) -> Value {
    let hub = scripted_hub(base, now, field(command, "rules"));
    let id_token = text(field(command, "idToken"));
    let token = HubToken::new(hub.http.clone(), Arc::new(move || Some(id_token.clone())));
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let results = list(field(command, "calls"))
        .iter()
        .map(|call| {
            let answer = runtime.block_on(run_call(&token, stores, call));
            object([("answer", answer), ("requests", take_requests(&hub, base))])
        })
        .collect();
    object([("results", Value::Array(results))])
}

fn startup(base: &str, now: f64, command: &Value, stores: &StoreContext) -> Value {
    let hub = scripted_hub(base, now, field(command, "rules"));
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let outcome = runtime.block_on(startup_sync::run(&hub.http, stores, &|| false));
    let result = &outcome.result;
    object([
        (
            "result",
            object([
                ("checked", Value::Number(result.checked as f64)),
                ("updated", Value::Number(result.updated as f64)),
                ("missingOnHub", Value::Number(result.missing_on_hub as f64)),
                ("errors", Value::Number(result.errors.len() as f64)),
            ]),
        ),
        ("changed", Value::Bool(outcome.changed())),
        ("requests", take_requests(&hub, base)),
    ])
}

fn max_rss_kb() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("VmHWM:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

/// The real userData directories of Pipette and of Electron, as the
/// harness of the TypeScript sync tests lists them
/// (scripts/sync-fixtures/harness.ts): under `~/.config`,
/// `$XDG_CONFIG_HOME`, `~/Library/Application Support` and `%APPDATA%`.
fn forbidden_roots() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let mut config_roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = &home {
        config_roots.push(home.join(".config"));
        config_roots.push(home.join("Library").join("Application Support"));
    }
    for name in ["XDG_CONFIG_HOME", "APPDATA"] {
        if let Some(dir) = std::env::var_os(name).filter(|dir| !dir.is_empty()) {
            config_roots.push(PathBuf::from(dir));
        }
    }
    config_roots
        .into_iter()
        .flat_map(|root| [root.join("pipette-desktop"), root.join("Electron")])
        .flat_map(|dir| {
            let resolved = resolve(&dir);
            [dir, resolved]
        })
        .collect()
}

/// `path` with its symlinks resolved: the deepest ancestor that exists,
/// canonicalized, with the rest of the path after it.
fn resolve(path: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut current = path.to_path_buf();
    loop {
        if let Ok(real) = std::fs::canonicalize(&current) {
            return rest.into_iter().rev().fold(real, |acc: PathBuf, part| acc.join(part));
        }
        match (current.file_name().map(ToOwned::to_owned), current.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                current = parent.to_path_buf();
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// Exits before anything is touched when `path` is relative, or is or is
/// inside a real userData directory (itself or through a symlink).
fn refuse_unsafe_path(name: &str, path: &Path) {
    if !path.is_absolute() {
        eprintln!("hub_peer: {name} must be an absolute path");
        std::process::exit(2);
    }
    let candidates = [path.to_path_buf(), resolve(path)];
    for root in forbidden_roots() {
        if candidates.iter().any(|candidate| candidate.starts_with(&root)) {
            eprintln!(
                "hub_peer: refused {name} {} inside the real userData {}",
                path.display(),
                root.display()
            );
            std::process::exit(2);
        }
    }
}

/// Exits when the scripted Hub's base is not on 127.0.0.1.
fn refuse_non_loopback(base: &str) {
    let host = base.strip_prefix("http://").and_then(|rest| rest.split(['/', ':']).next());
    if host != Some("127.0.0.1") {
        eprintln!("hub_peer: refused the Hub base {base}: only 127.0.0.1");
        std::process::exit(2);
    }
}

fn main() {
    let input_path = PathBuf::from(std::env::args().nth(1).expect("usage: hub_peer <input.json>"));
    refuse_unsafe_path("input", &input_path);
    let input = parse(&std::fs::read_to_string(&input_path).expect("the input file")).expect("JSON input");
    let user_data = PathBuf::from(text(field(&input, "userData")));
    let out = PathBuf::from(text(field(&input, "out")));
    refuse_unsafe_path("userData", &user_data);
    refuse_unsafe_path("out", &out);
    let base = text(field(&input, "hubBase"));
    refuse_non_loopback(&base);
    let Value::Number(now) = *field(&input, "now") else { panic!("hub_peer: now") };

    let stores = StoreContext::new(
        &user_data,
        Arc::new(FixedClock::new(now as i64)),
        Arc::new(WriteLocks::new()),
        Arc::new(|_: &str| {}),
    );
    let command = field(&input, "command");
    let started = std::time::Instant::now();
    let output = match text(field(command, "kind")).as_str() {
        "analytics" => analytics(&input, command, &stores, now as i64),
        "favoriteEntries" => favorite_entries(&input, command),
        "calls" => calls(&base, now, command, &stores),
        "startupSync" => startup(&base, now, command, &stores),
        other => panic!("hub_peer: unknown command {other}"),
    };
    let elapsed = started.elapsed().as_millis();
    std::fs::write(&out, stringify(&output)).expect("the output file");
    println!(
        "{{\"elapsedMs\":{elapsed},\"maxRssKb\":{}}}",
        max_rss_kb().map_or("null".to_owned(), |kb| kb.to_string())
    );
}
