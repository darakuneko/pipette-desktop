// SPDX-License-Identifier: GPL-2.0-or-later
//! What the replays of the recorded passes share: the userData tree, the Drive
//! seeds and files, the requests, the progress reports and the pending units in
//! the shapes the recorded goldens hold them.

#![allow(clippy::unwrap_used, clippy::panic, dead_code)]

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use pipette_drive::DriveApi;
use pipette_drive::fake::{DriveOp, Fault};
use pipette_sync_runtime::{SyncDirection, SyncProgress, SyncStatus};
use serde_json::{Map, Value, json};

use crate::execute_harness::{KeyCachedCodec, World};

pub fn fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

pub type Tree = BTreeMap<String, Option<String>>;

/// The userData tree without the cache, which the recordings do not keep,
/// and the pending file, which they do not write (its state is compared
/// step by step).
pub fn read_tree(root: &Path) -> Tree {
    fn walk(root: &Path, dir: &Path, tree: &mut Tree) {
        let mut entries: Vec<_> = std::fs::read_dir(dir).unwrap().flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        let rel = |path: &Path| path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
        if entries.is_empty() && dir != root {
            tree.insert(format!("{}/", rel(dir)), None);
        }
        for entry in entries {
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                walk(root, &path, tree);
            } else {
                tree.insert(
                    rel(&path),
                    Some(String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned()),
                );
            }
        }
    }
    let mut tree = Tree::new();
    walk(root, root, &mut tree);
    tree.retain(|path, _| {
        !path.starts_with("local/typing-analytics.db") && path != "local/sync-pending.json"
    });
    tree
}

pub fn tree_of(value: &Value) -> Tree {
    value.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.as_str().map(str::to_owned))).collect()
}

pub fn seed_tree(root: &Path, tree: &Tree) {
    for (path, content) in tree {
        match content {
            Some(content) => crate::execute_harness::write(root, path, content),
            None => std::fs::create_dir_all(root.join(path)).unwrap(),
        }
    }
}

pub struct Failures(pub Vec<String>);

impl Failures {
    pub fn check<T: PartialEq + std::fmt::Debug>(&mut self, what: String, got: T, want: T) {
        if got != want {
            self.0.push(format!("{what}:\n  got  {got:?}\n  want {want:?}"));
        }
    }
}

/// The request as the generators write it.
pub fn request(event: &str) -> String {
    let (op, rest) = event.split_once(':').unwrap();
    match op {
        "list" => "list".to_owned(),
        "create" => format!("create {}", rest.split_once(' ').map_or(rest, |(name, _)| name)),
        _ => format!("{op} {rest}"),
    }
}

/// The progress report as the renderer receives it.
pub fn progress_json(p: &SyncProgress) -> Value {
    let mut object = Map::new();
    object.insert(
        "direction".into(),
        json!(if p.direction == SyncDirection::Upload { "upload" } else { "download" }),
    );
    let status = match p.status {
        SyncStatus::Idle => "idle",
        SyncStatus::Syncing => "syncing",
        SyncStatus::Error => "error",
        SyncStatus::Success => "success",
        SyncStatus::Partial => "partial",
    };
    object.insert("status".into(), json!(status));
    if let Some(message) = &p.message {
        object.insert("message".into(), json!(message));
    }
    if let Some(unit) = &p.sync_unit {
        object.insert("syncUnit".into(), json!(unit));
    }
    if let Some(current) = p.current {
        object.insert("current".into(), json!(current));
    }
    if let Some(total) = p.total {
        object.insert("total".into(), json!(total));
    }
    if let Some(units) = &p.failed_units {
        object.insert("failedUnits".into(), json!(units));
    }
    if let Some(reason) = p.reason {
        object.insert("reason".into(), json!(reason.as_str()));
    }
    Value::Object(object)
}

pub fn op_of(name: &str) -> DriveOp {
    match name {
        "list" => DriveOp::List,
        "download" => DriveOp::Download,
        "create" => DriveOp::Create,
        "update" => DriveOp::Update,
        "delete" => DriveOp::Delete,
        other => panic!("no operation {other}"),
    }
}

pub fn inject_faults(world: &World, faults: &Value) {
    for fault in faults.as_array().into_iter().flatten() {
        let status = u16::try_from(fault["status"].as_u64().unwrap()).unwrap();
        world.drive.inner.inject(Fault {
            count: u32::try_from(fault["count"].as_u64().unwrap()).unwrap(),
            only: Some(op_of(fault["only"].as_str().unwrap())),
            ..Fault::with_status(status)
        });
    }
}

/// Puts a seed's file on Drive; one with `trashRenamedAt` is then renamed
/// to its trash name of that time.
pub async fn seed_drive(world: &World, codec: &Arc<KeyCachedCodec>, seed: &Value, password: &str) {
    let name = seed["name"].as_str().unwrap();
    let file = if seed.get("passwordCheck").is_some() {
        world.drive.seed_password_check(password).await
    } else if let Some(raw) = seed["raw"].as_str() {
        world.drive.seed(name, raw).await
    } else {
        let content = codec
            .seal_text(seed["plaintext"].as_str().unwrap(), password, seed["unit"].as_str().unwrap())
            .await;
        world.drive.seed(name, &content).await
    };
    if let Some(renamed_at) = seed["trashRenamedAt"].as_i64() {
        let created = pipette_drive::DriveFile {
            id: file.id.clone(),
            name: name.to_owned(),
            modified_time: file.modified_time,
            created_time: None,
        };
        let trash = pipette_drive::trash_names::trash_file_name(&created, renamed_at).unwrap();
        world.drive.inner.rename(file.id, trash).await.unwrap();
    }
}

/// The Drive files as the generators write them.
pub async fn drive_after(world: &World, codec: &Arc<KeyCachedCodec>, password: &str) -> Vec<Value> {
    let mut files = Vec::new();
    for stored in world.drive.inner.files() {
        let text = String::from_utf8_lossy(&stored.content).into_owned();
        let plaintext = codec.open_text(&stored.content, password).await.ok();
        let mut file = json!({ "id": stored.file.id, "name": stored.file.name, "modifiedTime": stored.file.modified_time });
        match plaintext {
            Some(plaintext) => file["plaintext"] = json!(plaintext),
            None => file["raw"] = json!(text),
        }
        files.push(file);
    }
    files
}

pub fn pending_json(world: &World) -> Value {
    let held: Vec<Value> = world
        .pending
        .held()
        .into_iter()
        .map(|(sub, units)| {
            json!([
                sub.to_string_lossy(),
                units.iter().map(|u| u.to_string_lossy().into_owned()).collect::<Vec<_>>()
            ])
        })
        .collect();
    json!({
        "units": world.pending_units(),
        "owner": world.pending.owner().map(|o| o.to_string_lossy().into_owned()),
        "held": held,
    })
}

/// The revisions recorded as handled and the files remembered as created.
pub fn remote_json(world: &World) -> (Value, Value) {
    let remote = world.runtime().remote();
    (
        json!(
            remote
                .handled_revisions()
                .into_iter()
                .map(|(name, r)| json!([name, r.id, r.modified_time]))
                .collect::<Vec<_>>()
        ),
        json!(remote.created_files().into_iter().map(|(name, id)| json!([name, id])).collect::<Vec<_>>()),
    )
}
