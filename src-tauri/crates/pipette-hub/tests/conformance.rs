// SPDX-License-Identifier: GPL-2.0-or-later
//! The in-memory Hub against the conformance cases it shares with the Node
//! fake Hub (scripts/fake-hub/conformance-cases.json, whose "format" lines
//! describe the steps; scripts/fake-hub/conformance-runner.ts runs them
//! over HTTP). The cases are read from the repository, or from the file
//! `PIPETTE_HUB_CONFORMANCE_CASES` names; without either the test has
//! nothing to run.

// Test helpers outside #[test] functions panic on a broken case.
#![allow(clippy::unwrap_used)]

use std::path::PathBuf;

use pipette_hub::fake::{FAKE_HUB_BASE, FAKE_HUB_BOUNDARY, FakeHub, Fault, RecordKind};
use pipette_hub::node_base64_decode;
use pipette_js_json::{Object, Value, js_string, parse, stringify, stringify_with_gap};
use pipette_net::{HttpRequest, HttpRequester, Method};

type Saved = Vec<(String, Value)>;

fn cases_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PIPETTE_HUB_CONFORMANCE_CASES") {
        return Some(PathBuf::from(path));
    }
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../scripts/fake-hub/conformance-cases.json");
    path.exists().then_some(path)
}

fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|object| object.get(key))
}

fn text(value: &Value, key: &str) -> Option<String> {
    get(value, key).and_then(Value::as_str).map(str::to_owned)
}

fn saved<'a>(saved: &'a Saved, name: &str) -> Option<&'a Value> {
    saved.iter().rev().find(|(key, _)| key == name).map(|(_, value)| value)
}

/// `{name}` in every string replaced by the saved value, `{run}` by
/// nothing; `{"$range": …}` expanded.
fn substitute(value: &Value, saved_values: &Saved, context: &str) -> Value {
    match value {
        Value::String(s) => {
            let s = s.to_string_lossy();
            let mut out = String::new();
            let mut rest = s.as_ref();
            while let Some(open) = rest.find('{') {
                let after = &rest[open + 1..];
                match after.find('}') {
                    Some(close)
                        if !after[..close].is_empty()
                            && after[..close].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') =>
                    {
                        let name = &after[..close];
                        out.push_str(&rest[..open]);
                        if name != "run" {
                            let value = saved(saved_values, name)
                                .unwrap_or_else(|| panic!("{context}: nothing saved as {name}"));
                            out.push_str(&js_string(Some(value)));
                        }
                        rest = &after[close + 1..];
                    }
                    _ => {
                        out.push_str(&rest[..=open]);
                        rest = after;
                    }
                }
            }
            out.push_str(rest);
            Value::from(out)
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| substitute(item, saved_values, context)).collect())
        }
        Value::Object(object) => {
            if let Some(range) = object.get("$range") {
                let prefix = text(range, "prefix").unwrap();
                let Some(Value::Number(count)) = get(range, "count") else {
                    panic!("{context}: $range without count")
                };
                return Value::Array(
                    (1..=*count as usize).map(|i| Value::from(format!("{prefix}{i}"))).collect(),
                );
            }
            Value::Object(
                object.iter().map(|(k, v)| (k.clone(), substitute(v, saved_values, context))).collect(),
            )
        }
        other => other.clone(),
    }
}

/// The body the desktop app's MultipartBuilder writes for these parts.
fn multipart_body(parts: &[Value], templates: &Value) -> Vec<u8> {
    let mut body = Vec::new();
    let mut expanded = Vec::new();
    for part in parts {
        match part.as_str() {
            Some(name) => match get(templates, &name[1..]) {
                Some(Value::Array(items)) => expanded.extend(items.iter().cloned()),
                _ => panic!("no template {name}"),
            },
            None => expanded.push(part.clone()),
        }
    }
    for part in &expanded {
        let name = text(part, "name").unwrap();
        let Some(filename) = text(part, "filename") else {
            let value = text(part, "value").unwrap_or_default();
            body.extend(format!("--{FAKE_HUB_BOUNDARY}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").bytes());
            continue;
        };
        let content = if let Some(b64) = text(part, "contentBase64") {
            node_base64_decode(&b64)
        } else if let Some(json) = get(part, "contentJson") {
            stringify(json).into_bytes()
        } else {
            text(part, "content").unwrap_or_default().into_bytes()
        };
        let content_type = text(part, "contentType").unwrap_or_else(|| "application/octet-stream".to_owned());
        body.extend(
            format!(
                "--{FAKE_HUB_BOUNDARY}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n"
            )
            .bytes(),
        );
        body.extend(content);
        body.extend(b"\r\n");
    }
    body.extend(format!("--{FAKE_HUB_BOUNDARY}--\r\n").bytes());
    body
}

const STRING_PATTERNS: [&str; 6] =
    ["$uuid", "$jwt", "$privateToken", "$hubStamp", "$postCreatedStamp", "$isoTimestamp"];

fn shape_matches(pattern: &str, actual: &str) -> bool {
    let all = |text: &str, ok: fn(u8) -> bool| !text.is_empty() && text.bytes().all(ok);
    let hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    let url = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
    let digits_shape = |shape: &str| {
        actual.len() == shape.len()
            && actual
                .bytes()
                .zip(shape.bytes())
                .all(|(a, s)| if s == b'9' { a.is_ascii_digit() } else { a == s })
    };
    match pattern {
        "$uuid" => {
            let parts: Vec<&str> = actual.split('-').collect();
            parts.len() == 5 && parts.iter().zip([8, 4, 4, 4, 12]).all(|(p, n)| p.len() == n && all(p, hex))
        }
        "$jwt" => {
            let parts: Vec<&str> = actual.split('.').collect();
            parts.len() == 3 && parts.iter().all(|p| all(p, url))
        }
        "$privateToken" => {
            actual.strip_prefix("pt_v1_").is_some_and(|rest| rest.len() == 43 && all(rest, url))
        }
        "$hubStamp" => digits_shape("9999-99-99 99:99:99.999Z"),
        "$postCreatedStamp" => digits_shape("9999-99-99 99:99:99"),
        _ => digits_shape("9999-99-99T99:99:99.999Z"),
    }
}

fn match_pattern(
    actual: Option<&Value>,
    pattern: &Value,
    saved_values: &Saved,
    path: &str,
) -> Result<(), String> {
    let fail = |what: String| {
        Err(format!("{path}: expected {what}, got {}", actual.map_or("undefined".to_owned(), stringify)))
    };
    if let Some(p) = pattern.as_str().filter(|p| p.starts_with('$')) {
        let actual_text = actual.and_then(Value::as_str);
        let ok = match p {
            "$any" => actual.is_some(),
            "$string" => actual_text.is_some(),
            "$number" => matches!(actual, Some(Value::Number(_))),
            _ if p.starts_with("$saved:") => actual == saved(saved_values, &p[7..]),
            _ if p.starts_with("$after:") => matches!(
                (actual_text, saved(saved_values, &p[7..]).and_then(Value::as_str)),
                (Some(a), Some(b)) if a > b
            ),
            _ if STRING_PATTERNS.contains(&p) => actual_text.is_some_and(|text| shape_matches(p, text)),
            _ => return Err(format!("{path}: unknown pattern {p}")),
        };
        return if ok { Ok(()) } else { fail(p.to_owned()) };
    }
    match pattern {
        Value::Array(items) => {
            let Some(Value::Array(actual_items)) =
                actual.filter(|a| matches!(a, Value::Array(v) if v.len() == items.len()))
            else {
                return fail(format!("an array of {}", items.len()));
            };
            for (i, item) in items.iter().enumerate() {
                match_pattern(actual_items.get(i), item, saved_values, &format!("{path}[{i}]"))?;
            }
            Ok(())
        }
        Value::Object(object) => {
            if let Some(Value::Number(length)) = object.get("$length") {
                return match actual {
                    Some(Value::Array(items)) if items.len() == *length as usize => Ok(()),
                    _ => fail(format!("an array of {length}")),
                };
            }
            let Some(Value::Object(record)) = actual else { return fail("an object".to_owned()) };
            if let Some(Value::Array(keys)) = object.get("$keys") {
                let actual_keys: Vec<Value> = record.keys().map(|k| Value::String(k.clone())).collect();
                if actual_keys != *keys {
                    return fail(format!("the keys {}", stringify(&Value::Array(keys.clone()))));
                }
            }
            for (key, item) in object.iter() {
                let key = key.to_string_lossy();
                if key == "$keys" {
                    continue;
                }
                if item.as_str() == Some("$absent") {
                    if record.contains_key(&key) {
                        return fail(format!("no {key}"));
                    }
                    continue;
                }
                if !record.contains_key(&key) {
                    return fail(format!("a key {key}"));
                }
                match_pattern(record.get(&key), item, saved_values, &format!("{path}.{key}"))?;
            }
            Ok(())
        }
        _ if actual == Some(pattern) => Ok(()),
        _ => fail(stringify(pattern)),
    }
}

fn at(value: &Value, path: &str) -> Option<Value> {
    path.split('.').try_fold(value.clone(), |node, key| match &node {
        Value::Object(object) => object.get(key).cloned(),
        Value::Array(items) => key.parse::<usize>().ok().and_then(|i| items.get(i).cloned()),
        _ => None,
    })
}

fn control(hub: &FakeHub, step: &Value, saved_values: &mut Saved, context: &str) {
    match text(step, "control").as_deref() {
        Some("user") => {
            let active = match get(step, "active") {
                Some(Value::Bool(flag)) => Some(*flag),
                _ => None,
            };
            hub.set_user(&text(step, "email").unwrap(), text(step, "displayName").as_deref(), active);
        }
        Some("fault") => {
            let number = |key| match get(step, key) {
                Some(Value::Number(n)) => *n,
                _ => panic!("{context}: fault without {key}"),
            };
            hub.inject(Fault {
                status: number("status") as u16,
                count: number("count") as usize,
                retry_after: text(step, "retryAfter"),
                body: text(step, "body"),
                only: text(step, "only"),
            });
        }
        Some("keyLabel") => {
            let map = get(step, "map").cloned().unwrap_or(Value::Object(Object::new()));
            let answer = hub.seed_key_label(
                &text(step, "owner").unwrap(),
                &text(step, "name").unwrap(),
                map,
                None,
                false,
                None,
            );
            if let Some(name) = text(step, "save") {
                saved_values.push((name, get(&answer, "id").cloned().unwrap()));
            }
        }
        Some("touch") => {
            let kind = match text(step, "kind").as_deref() {
                Some("post") => RecordKind::Post,
                Some("privatePost") => RecordKind::PrivatePost,
                Some("i18n") => RecordKind::I18n,
                Some("theme") => RecordKind::Theme,
                Some("keyLabel") => RecordKind::KeyLabel,
                other => panic!("{context}: touch of {other:?}"),
            };
            assert!(
                hub.touch(kind, &text(step, "id").unwrap(), None).is_some(),
                "{context}: nothing to touch"
            );
        }
        Some("revokeTokens") => hub.revoke_tokens(),
        other => panic!("{context}: unknown control step {other:?}"),
    }
}

async fn run_case(hub: &FakeHub, case: &Value, templates: &Value) -> Result<(), String> {
    let name = text(case, "name").unwrap();
    let mut saved_values: Saved = Vec::new();
    let Some(Value::Array(steps)) = get(case, "steps") else { panic!("{name}: no steps") };
    for (index, raw) in steps.iter().enumerate() {
        let context = format!("{name} step {index}");
        let step = substitute(raw, &saved_values, &context);
        let templates = substitute(templates, &saved_values, &context);
        if get(&step, "control").is_some() {
            control(hub, &step, &mut saved_values, &context);
            continue;
        }
        let request_line = text(&step, "request").unwrap();
        let (method, target) = request_line.split_once(' ').unwrap();
        let method = match method {
            "GET" => Method::Get,
            "POST" => Method::Post,
            "PUT" => Method::Put,
            "PATCH" => Method::Patch,
            _ => Method::Delete,
        };
        let mut headers = Vec::new();
        if let Some(auth) = text(&step, "auth") {
            let token = match auth.strip_prefix('!') {
                Some(raw) => raw.to_owned(),
                None => js_string(saved(&saved_values, &auth)),
            };
            headers.push(("Authorization".to_owned(), format!("Bearer {token}")));
        }
        let body = if let Some(json) = get(&step, "json") {
            headers.push(("Content-Type".to_owned(), "application/json".to_owned()));
            Some(stringify(json).into_bytes())
        } else if let Some(raw) = text(&step, "raw") {
            headers.push(("Content-Type".to_owned(), "application/json".to_owned()));
            Some(raw.into_bytes())
        } else if let Some(Value::Array(parts)) = get(&step, "multipart") {
            headers.push((
                "Content-Type".to_owned(),
                format!("multipart/form-data; boundary={FAKE_HUB_BOUNDARY}"),
            ));
            Some(multipart_body(parts, &templates))
        } else {
            None
        };
        let request = HttpRequest { method, url: format!("{FAKE_HUB_BASE}{target}"), headers, body };
        let reply = hub.request(request).await.unwrap();
        let body_text = String::from_utf8(reply.body.clone()).unwrap();
        let expect = get(&step, "expect").cloned().unwrap_or(Value::Null);
        let Some(Value::Number(status)) = get(&expect, "status") else { panic!("{context}: no status") };
        if f64::from(reply.status) != *status {
            return Err(format!("{context}: status {} ({body_text}), expected {status}", reply.status));
        }
        if let Some(Value::Object(expected_headers)) = get(&expect, "headers") {
            for (header, value) in expected_headers.iter() {
                let header = header.to_string_lossy();
                let actual = match header.to_ascii_lowercase().as_str() {
                    "retry-after" => reply.retry_after.clone(),
                    "content-type" => reply.content_type.clone(),
                    _ => None,
                };
                if actual.as_deref() != value.as_str() {
                    return Err(format!(
                        "{context}: header {header} {actual:?}, expected {}",
                        stringify(value)
                    ));
                }
            }
        }
        let parsed = if body_text.is_empty() { Value::Null } else { parse(&body_text).unwrap() };
        if let Some(pattern) = get(&expect, "json") {
            match_pattern(Some(&parsed), pattern, &saved_values, &context)?;
        }
        if get(&expect, "pretty") == Some(&Value::Bool(true))
            && body_text != stringify_with_gap(&parsed, "  ")
        {
            return Err(format!("{context}: not pretty-printed: {body_text}"));
        }
        if let Some(Value::Object(save)) = get(&step, "save") {
            for (name, path) in save.iter() {
                let path = path.as_str().unwrap();
                let value = at(&parsed, path).ok_or_else(|| format!("{context}: nothing at {path}"))?;
                saved_values.push((name.to_string_lossy().into_owned(), value));
            }
        }
    }
    Ok(())
}

#[tokio::test]
async fn the_in_memory_hub_passes_the_conformance_cases() {
    let Some(path) = cases_path() else {
        eprintln!("no conformance cases (scripts/fake-hub/conformance-cases.json); nothing to run");
        return;
    };
    let file = parse(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let templates = get(&file, "templates").cloned().unwrap();
    let Some(Value::Array(cases)) = get(&file, "cases") else { panic!("no cases") };
    let mut failures = Vec::new();
    for case in cases {
        let hub = FakeHub::new();
        if let Err(err) = run_case(&hub, case, &templates).await {
            failures.push(err);
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
