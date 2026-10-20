// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the recorded golden scenarios of the favorite handlers:
//! the same userData files, clock and new ids, the same calls, then each
//! response, the notified units and every file left behind compared byte
//! for byte. A file-system error is recorded as `<os error>`, as its text
//! is the OS's.
//!
//! The export and the import convert keycodes on the renderer's side; the
//! fixture records what crosses to the store for them. An export step reads
//! the stored favorites (compared with what the handler read) and writes
//! the file the handler built where the dialog points; an import step
//! imports the recorded batches. What the renderer's side checks before it
//! calls the store (the scope, the protocol, the entry id, the file) is
//! not replayed.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use common::{Harness, build, ms, recorded, tree_of};
use pipette_js_json::{JsString, Object, Value};
use pipette_keyboard_stores::{
    FavoriteError, FavoriteImport, FavoriteType, ImportCounts, delete_favorite, import_favorites,
    list_favorites, load_favorite, read_favorites_for_export, rename_favorite, response_json, save_favorite,
    set_favorite_hub_post_id, set_favorite_hub_private,
};

fn text(step: &Object, key: &str) -> String {
    step.get(key).unwrap().as_str().unwrap().to_owned()
}

fn js_text(object: &Object, key: &str) -> JsString {
    match object.get(key) {
        Some(Value::String(s)) => s.clone(),
        other => panic!("{key}: {other:?}"),
    }
}

/// The step's type, as the commands read it: a name, or not a string.
fn favorite_type(step: &Object) -> Result<FavoriteType, FavoriteError> {
    match step.get("type") {
        Some(Value::String(name)) => FavoriteType::parse(&name.to_string_lossy()),
        _ => Err(FavoriteError::InvalidType),
    }
}

fn fields(pairs: Vec<(&str, Value)>) -> Object {
    pairs.into_iter().collect()
}

fn response(result: Result<Object, FavoriteError>) -> String {
    as_recorded(response_json(result))
}

/// `got` with a file-system error's text replaced as the fixture records it.
fn as_recorded(got: String) -> String {
    let parsed = pipette_js_json::parse(&got).unwrap();
    let error = parsed.as_object().unwrap().get("error").and_then(Value::as_str).unwrap_or_default();
    let known = ["Error: Invalid favorite type", "Error: Invalid filename"];
    if error.starts_with("Error: ") && !known.contains(&error) {
        let mut out = parsed.as_object().unwrap().clone();
        out.insert("error", "<os error>".into());
        return pipette_js_json::stringify(&Value::Object(out));
    }
    got
}

fn done(result: Result<(), FavoriteError>) -> String {
    response(pipette_keyboard_stores::done(result))
}

fn failed(error: &str) -> String {
    pipette_js_json::stringify(&Value::Object(fields(vec![
        ("success", false.into()),
        ("error", error.into()),
    ])))
}

/// What the dialog of the step answers: a path under userData, or none.
fn dialog(h: &Harness, step: &Object) -> Option<std::path::PathBuf> {
    step.get("dialog").and_then(Value::as_str).map(|path| h.user_data().join(path))
}

/// Writes the file an export built where the dialog points, answering as
/// the export does.
fn save_export(h: &Harness, step: &Object, built: &Object) -> String {
    if let Some(error) = built.get("error") {
        return failed(error.as_str().unwrap());
    }
    let Some(path) = dialog(h, step) else { return failed("cancelled") };
    match fs::write(path, text(built, "content")) {
        Ok(()) => r#"{"success":true}"#.to_owned(),
        Err(_) => failed("<os error>"),
    }
}

const RENDERER_CHECKS: [&str; 3] = ["Invalid scope", "Invalid vialProtocol", "Invalid entryId"];

/// The export of stored favorites: `None` when the renderer's side answers
/// without the store.
fn export(h: &Harness, step: &Object, transfer: Option<&Object>, want: &str) -> Option<String> {
    let want_error = pipette_js_json::parse(want).unwrap().as_object().unwrap().get("error").cloned();
    if transfer.is_none()
        && want_error.as_ref().and_then(Value::as_str).is_some_and(|e| RENDERER_CHECKS.contains(&e))
    {
        return None;
    }
    let ty = favorite_type(step).unwrap();
    let id = step.get("entryId").map(|id| id.as_str().unwrap().to_owned());
    match read_favorites_for_export(&h.ctx, ty, id.as_deref()) {
        Err(err) => {
            assert!(transfer.is_none(), "the handler read favorites the store did not");
            Some(response(Err(err)))
        }
        Ok(bodies) => {
            let transfer = transfer.expect("the store read favorites the handler did not");
            assert_eq!(
                Some(&Value::Array(bodies)),
                transfer.get("bodies"),
                "the favorites read for the export"
            );
            Some(save_export(h, step, transfer.get("built").unwrap().as_object().unwrap()))
        }
    }
}

/// The import of the recorded plan, answering as the import does.
fn import(h: &Harness, plan: &Object) -> String {
    let Some(Value::Number(skipped)) = plan.get("skipped") else { panic!("no skipped count") };
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let mut total = ImportCounts { imported: 0, skipped: *skipped as usize };
    let Some(Value::Array(batches)) = plan.get("batches") else { panic!("no batches") };
    for batch in batches {
        let batch = batch.as_object().unwrap();
        let ty = FavoriteType::parse(&text(batch, "type")).unwrap();
        let Some(Value::Array(entries)) = batch.get("entries") else { panic!("no entries") };
        let favorites: Vec<FavoriteImport> = entries
            .iter()
            .map(|entry| {
                let entry = entry.as_object().unwrap();
                FavoriteImport {
                    label: js_text(entry, "label"),
                    saved_at: js_text(entry, "savedAt"),
                    body: js_text(entry, "body"),
                }
            })
            .collect();
        match import_favorites(&h.ctx, ty, &favorites) {
            Ok(counts) => {
                total.imported += counts.imported;
                total.skipped += counts.skipped;
            }
            Err(err) => return import_failed(&err.to_string()),
        }
    }
    if let Some(failure) = plan.get("failure") {
        return import_failed(failure.as_str().unwrap());
    }
    #[allow(clippy::cast_precision_loss)]
    let counts =
        vec![("imported", (total.imported as f64).into()), ("skipped", (total.skipped as f64).into())];
    response(Ok(fields(counts)))
}

fn import_failed(error: &str) -> String {
    as_recorded(pipette_js_json::stringify(&Value::Object(fields(vec![
        ("success", false.into()),
        ("imported", 0.0.into()),
        ("skipped", 0.0.into()),
        ("error", error.into()),
    ]))))
}

/// The response of the step as JSON text; `None` for a clock move and for
/// a step the store takes no part in.
fn run_step(h: &Harness, step: &Object, transfer: Option<&Object>, want: Option<&str>) -> Option<String> {
    let id = || text(step, "id");
    let op = text(step, "op");
    if op == "at" {
        h.clock.set(ms(&text(step, "time")));
        return None;
    }
    let ty = favorite_type(step);
    Some(match op.as_str() {
        "list" => response(ty.and_then(|ty| list_favorites(&h.ctx, ty)).map(|entries| {
            fields(vec![("entries", Value::Array(entries.into_iter().map(Value::from).collect()))])
        })),
        "save" => response(
            ty.and_then(|ty| save_favorite(&h.ctx, ty, &text(step, "json"), &text(step, "label")))
                .map(|entry| fields(vec![("entry", entry.into())])),
        ),
        "load" => response(
            ty.and_then(|ty| load_favorite(&h.ctx, ty, &id()))
                .map(|data| fields(vec![("data", data.into())])),
        ),
        "rename" => done(ty.and_then(|ty| rename_favorite(&h.ctx, ty, &id(), &text(step, "label")))),
        "delete" => done(ty.and_then(|ty| delete_favorite(&h.ctx, ty, &id()))),
        "hubPostId" => {
            let post_id = step.get("hubPostId").unwrap().as_str().map(str::to_owned);
            done(ty.and_then(|ty| set_favorite_hub_post_id(&h.ctx, ty, &id(), post_id.as_deref())))
        }
        "hubPrivate" => {
            let link = step.get("link").cloned().filter(|link| *link != Value::Null);
            done(ty.and_then(|ty| set_favorite_hub_private(&h.ctx, ty, &id(), link)))
        }
        "export" => return export(h, step, transfer, want.unwrap()),
        "exportCurrent" => {
            let built = transfer?.get("built").unwrap().as_object().unwrap();
            save_export(h, step, built)
        }
        "import" => import(h, transfer?.get("plan").unwrap().as_object().unwrap()),
        "importToCurrent" => return None,
        op => panic!("unknown step {op}"),
    })
}

#[test]
fn the_scenarios_match_the_golden() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_favorite_store_scenarios.json");
    let fixture = pipette_js_json::parse(&fs::read_to_string(path).unwrap()).unwrap();
    let Value::Array(scenarios) = fixture else { panic!("not a list") };
    assert!(!scenarios.is_empty());
    for scenario in &scenarios {
        let scenario = scenario.as_object().unwrap();
        let name = text(scenario, "name");
        let h = Harness::new();
        h.clock.set(ms(&text(scenario, "time")));
        build(h.user_data(), &tree_of(scenario.get("tree").unwrap()));

        let list = |key: &str| match scenario.get(key) {
            Some(Value::Array(items)) => items.clone(),
            other => panic!("{name}: {key} {other:?}"),
        };
        let (steps, outcomes, transfers) = (list("steps"), list("outcomes"), list("transfers"));
        assert_eq!(steps.len(), outcomes.len(), "{name}");
        assert_eq!(steps.len(), transfers.len(), "{name}");
        for (at, ((step, want), transfer)) in steps.iter().zip(&outcomes).zip(&transfers).enumerate() {
            let got = run_step(&h, step.as_object().unwrap(), transfer.as_object(), want.as_str());
            if let Some(got) = got {
                assert_eq!(Some(got.as_str()), want.as_str(), "{name}: step {at}");
            }
        }

        let notified: Vec<String> =
            list("notified").iter().map(|unit| unit.as_str().unwrap().to_owned()).collect();
        assert_eq!(h.notified(), notified, "{name}: notified units");
        let want: BTreeMap<_, _> = tree_of(scenario.get("after").unwrap()).into_iter().collect();
        assert_eq!(recorded(h.user_data()), want, "{name}: files");
    }
}
