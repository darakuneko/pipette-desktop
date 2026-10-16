// SPDX-License-Identifier: GPL-2.0-or-later
//! A settings patch of the WebView (src/tauri-shim/api/settings.ts) reads
//! the file with its etag, builds the new text and writes it back naming
//! that etag, retrying up to 8 times. A sync merge of the same file runs
//! under the uid's write lock and writes only when the remote `_updatedAt`
//! is newer: these tests check that merges landing between a patch's read
//! and write never make the patch lose its field.

#![allow(clippy::unwrap_used, clippy::panic)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use pipette_entry_store::{FixedClock, WriteLocks};
use pipette_js_json::{Object, Value, parse, stringify};
use pipette_keyboard_stores::{SettingsWrite, StoreContext, read_pipette_settings, write_pipette_settings};
use pipette_sync::merge::{MergeEnv, MergeEvents, PackKind, PackRosters, merge_sync_unit};
use pipette_sync_runtime::RemoteMemory;
use pipette_time::iso_8601_millis;

const UID: &str = "kb";
const UNIT: &str = "keyboards/kb/settings";
const NOW: i64 = 1_800_000_000_000;
/// `MAX_PATCH_ATTEMPTS` of the shim.
const MAX_PATCH_ATTEMPTS: usize = 8;

struct Quiet;

impl MergeEvents for Quiet {
    fn unit_applied(&self, _unit: &str) {}
    fn pack_changed(&self, _kind: PackKind) {}
}

fn context(dir: &std::path::Path) -> StoreContext {
    StoreContext::new(
        dir,
        Arc::new(FixedClock::new(NOW)),
        Arc::new(WriteLocks::new()),
        Arc::new(|_: &str| {}),
    )
}

fn settings(fields: &[(&str, &str)], updated_ms: i64) -> String {
    let mut o: Object = fields.iter().map(|(k, v)| (*k, Value::from(*v))).collect();
    o.insert("_updatedAt", iso_8601_millis(updated_ms).into());
    stringify(&Value::Object(o))
}

fn remote_bundle(text: &str) -> Value {
    let mut files = Object::new();
    files.insert("pipette_settings.json", text.into());
    let mut bundle = Object::new();
    bundle.insert("files", Value::Object(files));
    Value::Object(bundle)
}

fn merge(ctx: &StoreContext, text: &str) -> bool {
    let (remote, rosters) = (RemoteMemory::default(), PackRosters::default());
    let env = MergeEnv { ctx, events: &Quiet, remote: &remote, rosters: &rosters };
    merge_sync_unit(&env, UNIT, &remote_bundle(text), "2026-01-01T00:00:00.000Z").unwrap()
}

/// The shim's patch: `key` set over the file as read, `_updatedAt` now.
/// `between` runs after each read, before its write. Answers how many
/// attempts it took, `None` when every attempt conflicted.
fn patch(ctx: &StoreContext, key: &str, value: &str, mut between: impl FnMut(usize)) -> Option<usize> {
    for attempt in 1..=MAX_PATCH_ATTEMPTS {
        let read = read_pipette_settings(ctx, UID).unwrap();
        let mut o = match read.content.as_deref().map(parse) {
            Some(Ok(Value::Object(o))) => o,
            _ => Object::new(),
        };
        o.insert(key, value.into());
        o.insert("_updatedAt", iso_8601_millis(ctx.now_ms()).into());
        between(attempt);
        if write_pipette_settings(ctx, UID, &stringify(&Value::Object(o)), &read.etag).unwrap()
            == SettingsWrite::Written
        {
            return Some(attempt);
        }
    }
    None
}

fn file(ctx: &StoreContext) -> Object {
    match parse(&read_pipette_settings(ctx, UID).unwrap().content.unwrap()).unwrap() {
        Value::Object(o) => o,
        _ => panic!(),
    }
}

#[test]
fn a_merge_between_read_and_write_makes_the_patch_read_again_and_keep_both_changes() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path());
    std::fs::create_dir_all(dir.path().join("sync/keyboards/kb")).unwrap();
    std::fs::write(
        dir.path().join("sync/keyboards/kb/pipette_settings.json"),
        settings(&[("a", "old")], NOW - 10_000),
    )
    .unwrap();
    let remote = settings(&[("a", "remote"), ("b", "remote")], NOW - 5_000);
    let attempts = patch(&ctx, "patched", "yes", |attempt| {
        if attempt == 1 {
            assert!(!merge(&ctx, &remote));
        }
    });
    assert_eq!(attempts, Some(2));
    let o = file(&ctx);
    assert_eq!(o.get("patched"), Some(&"yes".into()));
    assert_eq!(o.get("b"), Some(&"remote".into()));
    // The patch is newer than the remote copy: merging that copy again
    // leaves the file alone and asks for an upload instead.
    assert!(merge(&ctx, &remote));
    assert_eq!(file(&ctx).get("patched"), Some(&"yes".into()));
}

#[test]
fn a_merge_of_a_copy_already_applied_does_not_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path());
    let remote = settings(&[("a", "remote")], NOW - 5_000);
    assert!(!merge(&ctx, &remote));
    let attempts = patch(&ctx, "patched", "yes", |_| {
        // The same revision again (a poll that saw it unchanged).
        merge(&ctx, &remote);
    });
    assert_eq!(attempts, Some(1));
}

#[test]
fn every_attempt_but_the_last_can_lose_to_a_newer_remote_copy() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path());
    let attempts = patch(&ctx, "patched", "yes", |attempt| {
        if attempt < MAX_PATCH_ATTEMPTS {
            let text =
                settings(&[("seq", &attempt.to_string())], NOW - 10_000 + i64::try_from(attempt).unwrap());
            assert!(!merge(&ctx, &text));
        }
    });
    assert_eq!(attempts, Some(MAX_PATCH_ATTEMPTS));
    let o = file(&ctx);
    assert_eq!(o.get("patched"), Some(&"yes".into()));
    assert_eq!(o.get("seq"), Some(&"7".into()));
}

#[test]
fn a_ninth_newer_copy_fails_the_patch_rather_than_dropping_it_silently() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path());
    let attempts = patch(&ctx, "patched", "yes", |attempt| {
        let text = settings(&[("seq", &attempt.to_string())], NOW - 10_000 + i64::try_from(attempt).unwrap());
        assert!(!merge(&ctx, &text));
    });
    // The shim then answers `{ success: false }` with "Settings changed
    // while being written".
    assert_eq!(attempts, None);
    assert_eq!(file(&ctx).get("patched"), None);
}

#[test]
fn passes_merging_on_another_thread_never_drop_the_patch() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = context(dir.path());
    let merges = Arc::new(AtomicUsize::new(0));
    // A few remote revisions, each older than the patch, merged again and
    // again as passes see them; only a newer one rewrites the file.
    let revisions: Vec<String> =
        (0..3).map(|i| settings(&[("seq", &i.to_string())], NOW - 1_000_000 + i)).collect();
    std::thread::scope(|scope| {
        let merger = {
            let (ctx, merges, revisions) = (ctx.clone(), merges.clone(), &revisions);
            scope.spawn(move || {
                for i in 0..300 {
                    merge(&ctx, &revisions[(i / 100).min(2)]);
                    merges.fetch_add(1, Ordering::Relaxed);
                }
            })
        };
        while merges.load(Ordering::Relaxed) < 50 {
            std::thread::yield_now();
        }
        assert!(patch(&ctx, "patched", "yes", |_| {}).is_some());
        merger.join().unwrap();
    });
    // Every remote copy is older than the patch, so none replaced it.
    let o = file(&ctx);
    assert_eq!(o.get("patched"), Some(&"yes".into()));
}
