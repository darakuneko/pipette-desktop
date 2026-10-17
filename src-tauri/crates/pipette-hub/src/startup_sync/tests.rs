// SPDX-License-Identifier: GPL-2.0-or-later
#![allow(clippy::unwrap_used)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use pipette_js_json::{Object, parse, stringify};
use pipette_net::{HttpError, HttpReply, HttpRequest};

use super::*;
use crate::http::{HubRequesters, SystemTiming};

const BASE: &str = "http://127.0.0.1:9";

/// The store with the given metas, recording the saves.
struct Packs {
    metas: Result<Vec<Entry>, String>,
    saves: Mutex<Vec<SavePackInput>>,
    save_error: Option<String>,
}

impl Packs {
    fn of(metas: &[&str]) -> Self {
        let metas = metas
            .iter()
            .map(|meta| match parse(meta).unwrap() {
                Value::Object(object) => Entry::from_object(object),
                _ => panic!("not an object"),
            })
            .collect();
        Self { metas: Ok(metas), saves: Mutex::new(Vec::new()), save_error: None }
    }

    fn saves(&self) -> Vec<SavePackInput> {
        self.saves.lock().unwrap().clone()
    }
}

impl StartupPacks for Packs {
    fn list_metas(&self) -> BoxFuture<'_, Result<Vec<Entry>, String>> {
        Box::pin(std::future::ready(self.metas.clone()))
    }

    fn save_pack(&self, input: SavePackInput) -> BoxFuture<'_, Result<(), String>> {
        self.saves.lock().unwrap().push(input);
        Box::pin(std::future::ready(self.save_error.clone().map_or(Ok(()), Err)))
    }
}

/// A Hub answering each request with `answer(path, body)`, recording what
/// it was asked.
struct Hub {
    http: HubHttp,
    seen: Arc<Mutex<Vec<(String, String)>>>,
}

fn hub(answer: impl Fn(&str, &str) -> (u16, String) + Send + Sync + 'static) -> Hub {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&seen);
    let requester = move |request: HttpRequest| -> Result<HttpReply, HttpError> {
        let path = request.url.strip_prefix(BASE).unwrap().to_owned();
        let body = request.body.as_ref().map(|b| String::from_utf8(b.clone()).unwrap()).unwrap_or_default();
        record.lock().unwrap().push((path.clone(), body.clone()));
        let (status, body) = answer(&path, &body);
        Ok(HttpReply {
            status,
            retry_after: None,
            content_type: Some("application/json".to_owned()),
            body: body.into_bytes(),
        })
    };
    let http = HubHttp::new(BASE, HubRequesters::single(Arc::new(requester)), Arc::new(SystemTiming));
    Hub { http, seen }
}

impl Hub {
    fn paths(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|(path, _)| path.clone()).collect()
    }
}

fn meta(id: &str, post: Option<&str>, cached: Option<&str>) -> String {
    let mut meta = Object::new();
    meta.insert("id", Value::from(id));
    meta.insert("name", Value::from("French"));
    meta.insert("version", Value::from("1.0.0"));
    meta.insert("enabled", Value::Bool(true));
    if let Some(post) = post {
        meta.insert("hubPostId", Value::from(post));
    }
    if let Some(cached) = cached {
        meta.insert("hubUpdatedAt", Value::from(cached));
    }
    stringify(&Value::Object(meta))
}

fn timestamps(items: &[(&str, &str)]) -> String {
    let items: Vec<String> =
        items.iter().map(|(id, at)| format!(r#"{{"id":"{id}","updated_at":"{at}"}}"#)).collect();
    format!(r#"{{"ok":true,"data":{{"items":[{}]}}}}"#, items.join(","))
}

fn export(name: &str, version: &str) -> String {
    format!(
        r#"{{"version":1,"kind":"i18n","exportedAt":"2026-05-10T03:00:00.000Z","pack":{{"name":"{name}","version":"{version}"}}}}"#
    )
}

fn never_stopped() -> bool {
    false
}

fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(future)
}

#[test]
fn packs_without_a_hub_post_id_are_skipped() {
    let packs = Packs::of(&[&meta("pack-local", None, None), &meta("pack-blank", Some("  "), None)]);
    let hub = hub(|path, _| panic!("asked {path}"));
    let outcome = block_on(run(&hub.http, &packs, &never_stopped));
    assert_eq!(outcome, StartupSyncOutcome::default());
    assert!(outcome.report().is_empty());
}

#[test]
fn a_pack_whose_hub_time_matches_is_not_downloaded() {
    let packs = Packs::of(&[&meta("pack-1", Some("hub-1"), Some("2026-05-09T00:00:00.000Z"))]);
    let hub = hub(|_, _| (200, timestamps(&[("hub-1", "2026-05-09T00:00:00.000Z")])));
    let outcome = block_on(run(&hub.http, &packs, &never_stopped));
    assert_eq!(outcome.result, StartupSyncResult { checked: 1, ..StartupSyncResult::default() });
    assert_eq!(hub.paths(), ["/api/i18n-packs/timestamps"]);
    assert!(packs.saves().is_empty());
    assert!(!outcome.changed());
}

#[test]
fn a_newer_pack_is_saved_unattended_with_the_hub_time() {
    let packs = Packs::of(&[&meta("pack-1", Some(" hub-1 "), Some("2026-05-09T00:00:00.000Z"))]);
    let hub = hub(|path, body| match path {
        "/api/i18n-packs/timestamps" => {
            assert_eq!(body, r#"{"ids":["hub-1"]}"#);
            (200, timestamps(&[("hub-1", "2026-05-10T03:00:00.000Z")]))
        }
        "/api/i18n-packs/hub-1/download" => (200, export("French", "1.1.0")),
        other => panic!("asked {other}"),
    });
    let outcome = block_on(run(&hub.http, &packs, &never_stopped));
    assert_eq!(outcome.result, StartupSyncResult { checked: 1, updated: 1, ..StartupSyncResult::default() });
    assert!(outcome.changed());
    let saves = packs.saves();
    assert_eq!(saves.len(), 1);
    let save = &saves[0];
    assert_eq!(save.id, Some(JsString::from("pack-1")));
    assert_eq!(save.pack, Some(parse(r#"{"name":"French","version":"1.1.0"}"#).unwrap()));
    assert_eq!(save.hub_post_id, Field::Set(JsString::from("hub-1")));
    assert_eq!(save.hub_updated_at, Field::Set(JsString::from("2026-05-10T03:00:00.000Z")));
    assert!(save.unattended);
    // The user's enabled state is kept.
    assert_eq!(save.enabled, None);
    assert_eq!(
        outcome.report(),
        [(Level::Info, "i18n startup sync: checked=1 updated=1 missingOnHub=0 errors=0".to_owned())]
    );
}

#[test]
fn a_pack_missing_on_the_hub_is_counted_and_kept() {
    let packs = Packs::of(&[&meta("pack-orphan", Some("hub-gone"), None)]);
    let hub = hub(|_, _| (200, timestamps(&[])));
    let outcome = block_on(run(&hub.http, &packs, &never_stopped));
    assert_eq!(
        outcome.result,
        StartupSyncResult { checked: 1, missing_on_hub: 1, ..StartupSyncResult::default() }
    );
    assert!(packs.saves().is_empty());
}

#[test]
fn a_pack_without_a_cached_hub_time_is_downloaded() {
    let packs = Packs::of(&[&meta("pack-legacy", Some("hub-1"), None)]);
    let hub = hub(|path, _| match path {
        "/api/i18n-packs/timestamps" => (200, timestamps(&[("hub-1", "2026-05-09T00:00:00.000Z")])),
        _ => (200, export("French", "1.1.0")),
    });
    let outcome = block_on(run(&hub.http, &packs, &never_stopped));
    assert_eq!(outcome.result.updated, 1);
}

#[test]
fn an_invalid_pack_is_an_error_and_the_others_go_on() {
    let packs = Packs::of(&[
        &meta("pack-bad", Some("hub-bad"), Some("old")),
        &meta("pack-good", Some("hub-good"), Some("old")),
    ]);
    let hub = hub(|path, _| match path {
        "/api/i18n-packs/timestamps" => (200, timestamps(&[("hub-bad", "new"), ("hub-good", "new")])),
        "/api/i18n-packs/hub-bad/download" => (200, export("Bad", "nope")),
        _ => (200, export("Good", "1.0.0")),
    });
    let outcome = block_on(run(&hub.http, &packs, &never_stopped));
    assert_eq!(outcome.result.checked, 2);
    assert_eq!(outcome.result.updated, 1);
    assert_eq!(
        outcome.result.errors,
        [SyncError {
            pack_id: "pack-bad".to_owned(),
            hub_post_id: "hub-bad".to_owned(),
            reason: "invalid pack from Hub: version must be a valid semver (e.g. 0.1.0)".to_owned(),
        }]
    );
    assert_eq!(outcome.report()[1].0, Level::Warn);
}

#[test]
fn a_failed_download_names_the_error_class() {
    let packs = Packs::of(&[&meta("pack-a", Some("hub-a"), None), &meta("pack-b", Some("hub-b"), None)]);
    let hub = hub(|path, _| match path {
        "/api/i18n-packs/timestamps" => (200, timestamps(&[("hub-a", "t"), ("hub-b", "t")])),
        "/api/i18n-packs/hub-a/download" => (429, "slow".to_owned()),
        _ => (500, "down".to_owned()),
    });
    let outcome = block_on(run(&hub.http, &packs, &never_stopped));
    let reasons: Vec<&str> = outcome.result.errors.iter().map(|err| err.reason.as_str()).collect();
    assert_eq!(
        reasons,
        ["Hub429Error: Hub i18n download failed: 429 slow", "Error: Hub i18n download failed: 500 down"]
    );
}

#[test]
fn a_failed_save_is_an_error() {
    let mut packs = Packs::of(&[&meta("pack-1", Some("hub-1"), None)]);
    packs.save_error = Some("Language pack is no longer linked to this Hub post".to_owned());
    let hub = hub(|path, _| match path {
        "/api/i18n-packs/timestamps" => (200, timestamps(&[("hub-1", "t")])),
        _ => (200, export("French", "1.0.0")),
    });
    let outcome = block_on(run(&hub.http, &packs, &never_stopped));
    assert_eq!(outcome.result.updated, 0);
    assert_eq!(
        outcome.result.errors[0].reason,
        "savePack failed: Language pack is no longer linked to this Hub post"
    );
    assert!(!outcome.changed());
}

#[test]
fn an_unreadable_index_ends_the_pass_quietly() {
    let mut packs = Packs::of(&[]);
    packs.metas = Err("Error: disk gone".to_owned());
    let hub = hub(|path, _| panic!("asked {path}"));
    let outcome = block_on(run(&hub.http, &packs, &never_stopped));
    assert_eq!(outcome.result, StartupSyncResult::default());
    assert_eq!(
        outcome.report(),
        [(Level::Warn, "i18n startup sync: failed to read pack index: Error: disk gone".to_owned())]
    );
}

#[test]
fn a_failed_timestamps_request_ends_the_pass_with_the_count() {
    let packs = Packs::of(&[&meta("pack-1", Some("hub-1"), None)]);
    let hub = hub(|_, _| (503, "down".to_owned()));
    let outcome = block_on(run(&hub.http, &packs, &never_stopped));
    assert_eq!(outcome.result, StartupSyncResult { checked: 1, ..StartupSyncResult::default() });
    assert_eq!(hub.paths(), ["/api/i18n-packs/timestamps"]);
    assert_eq!(
        outcome.report(),
        [
            (Level::Warn, "i18n startup sync: timestamps fetch failed: Error: Hub i18n timestamps fetch failed: 503 down".to_owned()),
            (Level::Info, "i18n startup sync: checked=1 updated=0 missingOnHub=0 errors=0".to_owned()),
        ]
    );
}

#[test]
fn more_than_100_packs_go_in_batches_of_100() {
    let metas: Vec<String> =
        (0..150).map(|i| meta(&format!("pack-{i}"), Some(&format!("hub-{i}")), Some("same"))).collect();
    let packs = Packs::of(&metas.iter().map(String::as_str).collect::<Vec<_>>());
    let hub = hub(|_, body| {
        let ids = match parse(body).unwrap() {
            Value::Object(object) => match object.get("ids") {
                Some(Value::Array(ids)) => ids.clone(),
                _ => panic!("no ids"),
            },
            _ => panic!("not an object"),
        };
        let items: Vec<(String, &str)> =
            ids.iter().map(|id| (id.as_str().unwrap().to_owned(), "same")).collect();
        let items: Vec<(&str, &str)> = items.iter().map(|(id, at)| (id.as_str(), *at)).collect();
        (200, timestamps(&items))
    });
    let outcome = block_on(run(&hub.http, &packs, &never_stopped));
    assert_eq!(outcome.result, StartupSyncResult { checked: 150, ..StartupSyncResult::default() });
    let mut sizes: Vec<usize> = hub
        .seen
        .lock()
        .unwrap()
        .iter()
        .map(|(_, body)| match parse(body).unwrap() {
            Value::Object(object) => match object.get("ids") {
                Some(Value::Array(ids)) => ids.len(),
                _ => 0,
            },
            _ => 0,
        })
        .collect();
    sizes.sort_unstable();
    assert_eq!(sizes, [50, 100]);
}

#[test]
fn a_quit_stops_the_pass_before_its_saves() {
    let packs = Packs::of(&[&meta("pack-1", Some("hub-1"), None)]);
    let quitting = AtomicBool::new(false);
    let stopped = || quitting.load(Ordering::SeqCst);
    let hub_quits = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&hub_quits);
    let hub = hub(move |path, _| match path {
        "/api/i18n-packs/timestamps" => (200, timestamps(&[("hub-1", "t")])),
        _ => {
            // The quit starts while the pack downloads.
            flag.store(true, Ordering::SeqCst);
            (200, export("French", "1.0.0"))
        }
    });
    let checking = || {
        if hub_quits.load(Ordering::SeqCst) {
            quitting.store(true, Ordering::SeqCst);
        }
        stopped()
    };
    let outcome = block_on(run(&hub.http, &packs, &checking));
    assert!(outcome.stopped);
    assert!(packs.saves().is_empty());
    assert!(outcome.report().is_empty());
    assert!(!outcome.changed());

    // A quit before the pass sends nothing.
    let hub = hub_never();
    let outcome = block_on(run(&hub.http, &packs, &|| true));
    assert!(outcome.stopped);
    assert!(hub.paths().is_empty());
}

fn hub_never() -> Hub {
    hub(|path, _| panic!("asked {path}"))
}
