// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the Local Data scenarios recorded from the TypeScript handlers
//! by scripts/sync-fixtures/record-local-data-fixtures.test.ts: each seeds
//! a userData tree, then exports (the file's text and the tree left
//! behind) or imports a file (the outcome, the units changed and the tree
//! left behind), compared byte for byte. The dialogs are the command's
//! (src-tauri/src/sync_commands/data.rs) and are checked there.
//!
//! An error is compared by its kind; its text too where it is the Electron
//! build's own (not the system's, nor `JSON.parse`'s).

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::path::Path;
use std::sync::{Arc, Mutex};

use common::{Tree, get, read_tree, strings, text, tree_of, write_tree};
use pipette_entry_store::{FixedClock, WriteLocks};
use pipette_js_json::{Value, parse};
use pipette_keyboard_stores::StoreContext;
use pipette_sync::local_data::{
    LocalDataImportError, collect_export_categories, export_default_filename, export_text, import_local_data,
};

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_local_data.json");
    parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn now(fixture: &Value) -> i64 {
    match get(fixture, "now") {
        #[allow(clippy::cast_possible_truncation)]
        Value::Number(n) => *n as i64,
        other => panic!("not a time: {other:?}"),
    }
}

fn list(value: &Value) -> &[Value] {
    match value {
        Value::Array(items) => items,
        _ => panic!("not a list"),
    }
}

fn context(root: &Path, now: i64) -> StoreContext {
    StoreContext::new(
        root,
        Arc::new(FixedClock::new(now)),
        Arc::new(WriteLocks::new()),
        Arc::new(|_: &str| {}),
    )
}

#[test]
fn exports_as_the_typescript_handler_does() {
    let fixture = fixture();
    let now = now(&fixture);
    for scenario in list(get(&fixture, "exports")) {
        let name = text(get(scenario, "name"));
        let root = tempfile::tempdir().unwrap();
        write_tree(root.path(), &tree_of(get(scenario, "tree")));
        let ctx = context(root.path(), now);
        assert_eq!(
            export_default_filename(now),
            text(get(get(scenario, "dialog"), "defaultPath")),
            "{name}: default file name"
        );
        // The categories are read before the dialog asks where to save.
        let categories = collect_export_categories(&ctx).unwrap();
        if get(scenario, "cancel") != &Value::Bool(true) {
            assert_eq!(export_text(categories, now), text(get(scenario, "written")), "{name}: file");
        }
        assert_eq!(read_tree(root.path()), tree_of(get(scenario, "after")), "{name}: tree");
    }
}

/// The kind the generator gives a failure (`errorOf`) and whether its text
/// is compared.
fn kind_of(err: &LocalDataImportError) -> (&'static str, bool) {
    match err {
        LocalDataImportError::InvalidFormat => ("format", true),
        LocalDataImportError::UnsupportedVersion => ("version", true),
        LocalDataImportError::CorruptedIndex(_) => ("corrupted", true),
        LocalDataImportError::Type(_) => ("type", true),
        LocalDataImportError::RollbackFailed(..) => ("rollback", false),
        LocalDataImportError::UnreadableIndex(..) | LocalDataImportError::Io(_) => ("os", false),
    }
}

#[cfg(unix)]
fn set_read_only(dir: &Path, read_only: bool) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(if read_only { 0o555 } else { 0o755 }))
        .unwrap();
}

#[cfg(not(unix))]
fn set_read_only(dir: &Path, read_only: bool) {
    let mut permissions = std::fs::metadata(dir).unwrap().permissions();
    permissions.set_readonly(read_only);
    std::fs::set_permissions(dir, permissions).unwrap();
}

/// Whether a file can still be created in `dir`.
fn writes_into(dir: &Path) -> bool {
    let probe = dir.join(".write-probe");
    let wrote = std::fs::write(&probe, b"").is_ok();
    if wrote {
        std::fs::remove_file(&probe).unwrap();
    }
    wrote
}

#[test]
fn imports_as_the_typescript_handler_does() {
    let fixture = fixture();
    let now = now(&fixture);
    for scenario in list(get(&fixture, "imports")) {
        let name = text(get(scenario, "name"));
        // A cancelled dialog is the command's.
        let Some(file_text) = get(scenario, "text").as_str() else { continue };
        let root = tempfile::tempdir().unwrap();
        write_tree(root.path(), &tree_of(get(scenario, "tree")));
        let notified = Arc::new(Mutex::new(Vec::new()));
        let ctx = {
            let notified = Arc::clone(&notified);
            StoreContext::new(
                root.path(),
                Arc::new(FixedClock::new(now)),
                Arc::new(WriteLocks::new()),
                Arc::new(move |unit: &str| notified.lock().unwrap().push(unit.to_owned())),
            )
        };
        let read_only = strings(get(scenario, "readOnly"));
        for dir in &read_only {
            set_read_only(&root.path().join(dir), true);
        }
        if let Some(dir) = read_only.iter().find(|dir| writes_into(&root.path().join(dir))) {
            // Root (or CAP_DAC_OVERRIDE) writes into any directory, so the
            // failure the scenario needs cannot happen.
            eprintln!("SKIPPED imports_as_the_typescript_handler_does: {name}: {dir} is writable (root)");
            for dir in &read_only {
                set_read_only(&root.path().join(dir), false);
            }
            continue;
        }
        let outcome =
            parse(file_text).map_err(|_| None).and_then(|file| import_local_data(&ctx, &file).map_err(Some));
        for dir in &read_only {
            set_read_only(&root.path().join(dir), false);
        }

        let expected = get(scenario, "result");
        match outcome {
            Ok(units) => {
                assert_eq!(expected, &parse(r#"{"success":true}"#).unwrap(), "{name}: result");
                assert_eq!(units, strings(get(scenario, "notified")), "{name}: changed units");
            }
            Err(err) => {
                let error = get(expected, "error");
                let (kind, compare_text) = err.as_ref().map_or(("syntax", false), kind_of);
                assert_eq!(kind, text(get(error, "kind")), "{name}: kind of {err:?}");
                if compare_text {
                    let message =
                        err.unwrap().to_string().replace(&root.path().display().to_string(), "<userData>");
                    // Windows joins the path with `\`, the recording on Linux with `/`.
                    let message = message.replace(std::path::MAIN_SEPARATOR_STR, "/");
                    assert_eq!(message, text(get(error, "message")), "{name}: message");
                }
            }
        }
        // The import reports nothing itself: the command reports the units.
        assert!(notified.lock().unwrap().is_empty(), "{name}: notified");
        let mut after: Tree = tree_of(get(scenario, "after"));
        after.remove("picked.json");
        assert_eq!(read_tree(root.path()), after, "{name}: tree");
    }
}
