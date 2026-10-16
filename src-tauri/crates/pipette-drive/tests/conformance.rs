// SPDX-License-Identifier: GPL-2.0-or-later
//! The in-memory Drive against the conformance cases it shares with the
//! Node fake Drive (scripts/fake-drive/conformance-cases.json, run there
//! by scripts/fake-drive/conformance.test.ts).

#![allow(clippy::unwrap_used)]

use std::collections::HashMap;

use pipette_drive::fake::{DriveOp, Fault, InMemoryDrive};
use pipette_drive::{DriveApi, DriveError, ListQuery, UploadedFile};
use serde_json::Value;

const CASES: &str = include_str!("../../../../scripts/fake-drive/conformance-cases.json");

/// The id argument of a step: a saved file's id, or an id no file has.
fn id_of(saved: &HashMap<String, UploadedFile>, step: &Value) -> String {
    match step["id"].as_str().unwrap() {
        "missing" => "missing-id".to_owned(),
        key => saved[key].id.clone(),
    }
}

fn text<'a>(step: &'a Value, key: &str) -> &'a str {
    step[key].as_str().unwrap()
}

fn op_of(name: &str) -> DriveOp {
    match name {
        "list" => DriveOp::List,
        "download" => DriveOp::Download,
        "create" => DriveOp::Create,
        "update" => DriveOp::Update,
        "rename" => DriveOp::Rename,
        "delete" => DriveOp::Delete,
        other => panic!("unknown operation {other}"),
    }
}

/// Every page of a listing: the size of each and every name.
async fn list_pages(drive: &InMemoryDrive, step: &Value) -> Result<(Vec<usize>, Vec<String>), DriveError> {
    let page_size = step["pageSize"].as_u64().map_or(1000, |size| u32::try_from(size).unwrap());
    let (mut sizes, mut names, mut page_token) = (Vec::new(), Vec::new(), None);
    loop {
        let query = ListQuery {
            name_contains: step["nameContains"].as_str().map(str::to_owned),
            page_token,
            page_size,
        };
        let page = drive.list_page(query).await?;
        sizes.push(page.files.len());
        for file in page.files {
            assert!(
                !file.id.is_empty() && !file.modified_time.is_empty() && file.created_time.is_some(),
                "{file:?}"
            );
            names.push(file.name);
        }
        page_token = page.next_page_token;
        if page_token.is_none() {
            return Ok((sizes, names));
        }
    }
}

/// Checks the failure a step expects.
fn check_failure(context: &str, expect: &Value, result: Result<(), DriveError>) {
    let Err(DriveError::Status { status, body, retry_after }) = result else {
        panic!("{context}: expected status {}, got {result:?}", expect["status"]);
    };
    assert_eq!(u64::from(status), expect["status"].as_u64().unwrap(), "{context}");
    if let Some(expected) = expect.get("retryAfter") {
        assert_eq!(retry_after.as_deref(), expected.as_str(), "{context}");
    }
    if let Some(reason) = expect["reason"].as_str() {
        assert!(body.contains(&format!("\"reason\":\"{reason}\"")), "{context}: {body}");
    }
}

async fn run_step(
    drive: &InMemoryDrive,
    saved: &mut HashMap<String, UploadedFile>,
    context: &str,
    step: &Value,
) {
    let expect = &step["expect"];
    let wants_failure = expect.get("status").is_some();
    let save = |saved: &mut HashMap<String, UploadedFile>, file: UploadedFile| {
        if let Some(key) = step["save"].as_str() {
            if expect["newer"].as_bool() == Some(true) {
                assert!(file.modified_time > saved[key].modified_time, "{context}: not newer");
            }
            saved.insert(key.to_owned(), file);
        }
    };
    let result: Result<(), DriveError> = match text(step, "op") {
        "fault" => {
            let status = u16::try_from(step["status"].as_u64().unwrap()).unwrap();
            let mut fault = if status == 429 { Fault::rate_limit(None) } else { Fault::with_status(status) };
            fault.retry_after = step["retryAfter"].as_str().map(str::to_owned);
            fault.count = u32::try_from(step["count"].as_u64().unwrap()).unwrap();
            fault.only = step["only"].as_str().map(op_of);
            drive.inject(fault);
            Ok(())
        }
        "create" => drive
            .create(text(step, "name").to_owned(), text(step, "content").to_owned())
            .await
            .map(|file| save(saved, file)),
        "createRaw" => drive
            .create_raw(text(step, "name").to_owned(), text(step, "content").to_owned())
            .await
            .map(|id| {
                // Only the id comes back; the time is not compared.
                save(saved, UploadedFile { id, modified_time: String::new() });
            }),
        "update" => drive
            .update(id_of(saved, step), text(step, "content").to_owned())
            .await
            .map(|file| save(saved, file)),
        "rename" => drive.rename(id_of(saved, step), text(step, "name").to_owned()).await.map(|file| {
            assert_eq!(file.name, expect["name"].as_str().unwrap(), "{context}");
            if let Some(key) = expect["sameIdAs"].as_str() {
                assert_eq!(file.id, saved[key].id, "{context}");
            }
            save(saved, UploadedFile { id: file.id, modified_time: file.modified_time });
        }),
        "delete" => drive.delete(id_of(saved, step)).await,
        "download" => drive.download(id_of(saved, step)).await.map(|content| {
            assert_eq!(String::from_utf8(content).unwrap(), expect["content"].as_str().unwrap(), "{context}");
        }),
        "listPages" => list_pages(drive, step).await.map(|(sizes, mut names)| {
            let expected_sizes: Vec<usize> = expect["pageSizes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|size| size.as_u64().unwrap() as usize)
                .collect();
            assert_eq!(sizes, expected_sizes, "{context}");
            let mut expected: Vec<&str> =
                expect["names"].as_array().unwrap().iter().map(|name| name.as_str().unwrap()).collect();
            names.sort();
            expected.sort_unstable();
            assert_eq!(names, expected, "{context}");
        }),
        other => panic!("{context}: unknown step {other}"),
    };
    if wants_failure {
        check_failure(context, expect, result);
    } else if let Err(err) = result {
        panic!("{context}: {err:?}");
    }
}

#[tokio::test]
async fn passes_the_conformance_cases() {
    let cases: Value = serde_json::from_str(CASES).unwrap();
    let cases = cases["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 5);
    for case in cases {
        let drive = InMemoryDrive::new();
        let mut saved = HashMap::new();
        for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let context = format!("{} step {index}", text(case, "name"));
            run_step(&drive, &mut saved, &context, step).await;
        }
    }
}

#[tokio::test]
async fn stamps_each_write_one_second_after_the_last() {
    let drive = InMemoryDrive::new();
    let first = drive.create("a.enc".into(), "1".into()).await.unwrap();
    let second = drive.update(first.id.clone(), "2".into()).await.unwrap();
    assert_eq!(first, UploadedFile { id: "fake-1".into(), modified_time: "2026-01-01T00:00:00.000Z".into() });
    assert_eq!(second.modified_time, "2026-01-01T00:00:01.000Z");
    let renamed = drive.rename(first.id.clone(), "b.enc".into()).await.unwrap();
    assert_eq!(renamed.modified_time, "2026-01-01T00:00:02.000Z");
    let stored = drive.files();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].file.created_time.as_deref(), Some("2026-01-01T00:00:00.000Z"));
    assert_eq!(stored[0].content, b"2");
}

#[tokio::test]
async fn refuses_an_unknown_page_token() {
    let drive = InMemoryDrive::new();
    let query = ListQuery { name_contains: None, page_token: Some("bogus".into()), page_size: 10 };
    assert_eq!(drive.list_page(query).await.unwrap_err().status(), Some(400));
}
