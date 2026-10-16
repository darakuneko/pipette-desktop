// SPDX-License-Identifier: GPL-2.0-or-later
//! A language store on a temporary userData directory whose requests are
//! answered from a queue of replies, the URLs it asked recorded, and
//! userData trees (path → node) to build and compare.

#![allow(dead_code, clippy::unwrap_used, clippy::panic)]

use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use pipette_js_json::Value;
use pipette_net::{Http, HttpError, HttpResponse};
use pipette_typing_datasets::LanguageStore;
use tempfile::TempDir;

pub const HUB: &str = "https://pipette-hub-worker.keymaps.workers.dev";

pub type Reply = Result<HttpResponse, HttpError>;

pub struct Harness {
    pub dir: TempDir,
    pub replies: Arc<Mutex<VecDeque<Reply>>>,
    pub urls: Arc<Mutex<Vec<String>>>,
    pub store: LanguageStore,
}

impl Harness {
    pub fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let replies = Arc::new(Mutex::new(VecDeque::new()));
        let urls = Arc::new(Mutex::new(Vec::new()));
        let store = Self::store_on(dir.path(), &replies, &urls);
        Self { dir, replies, urls, store }
    }

    fn store_on(
        dir: &Path,
        replies: &Arc<Mutex<VecDeque<Reply>>>,
        urls: &Arc<Mutex<Vec<String>>>,
    ) -> LanguageStore {
        let (replies, urls) = (Arc::clone(replies), Arc::clone(urls));
        let http = Http::new(move |url: &str| {
            urls.lock().unwrap().push(url.to_owned());
            // No reply is a rejected fetch, as in the fixture generator.
            replies
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| Err(HttpError::Network(format!("Error: no reply recorded for {url}"))))
        });
        LanguageStore::new(dir, http, || HUB.to_owned())
    }

    /// A new store on the same userData, as a new process starts.
    pub fn restart(&mut self) {
        self.store = Self::store_on(self.dir.path(), &self.replies, &self.urls);
    }

    pub fn user_data(&self) -> &Path {
        self.dir.path()
    }

    pub fn reply(&self, reply: Reply) {
        self.replies.lock().unwrap().push_back(reply);
    }

    pub fn ok(&self, body: &str) {
        self.reply(Ok(HttpResponse { status: 200, body: body.as_bytes().to_vec() }));
    }

    pub fn replies_left(&self) -> usize {
        self.replies.lock().unwrap().len()
    }

    pub fn urls(&self) -> Vec<String> {
        self.urls.lock().unwrap().clone()
    }

    pub fn write(&self, path: &str, content: &str) {
        let target = self.user_data().join(path);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, content).unwrap();
    }

    pub fn read(&self, path: &str) -> Option<String> {
        fs::read_to_string(self.user_data().join(path)).ok()
    }
}

pub fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(future)
}

/// What is at a path: a file's bytes, or a directory (the path ends in `/`).
#[derive(Debug, PartialEq)]
pub enum Node {
    File(Vec<u8>),
    Dir,
}

pub fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}

/// A recorded file: UTF-8 text, or `{hex}` for other bytes.
pub fn bytes_of(value: &Value) -> Vec<u8> {
    match value {
        Value::String(content) => content.as_str().unwrap().as_bytes().to_vec(),
        Value::Object(object) => hex_bytes(object.get("hex").unwrap().as_str().unwrap()),
        other => panic!("unknown content {other:?}"),
    }
}

/// A recorded tree, in its order.
pub fn tree_of(value: &Value) -> Vec<(String, Node)> {
    value
        .as_object()
        .unwrap()
        .iter()
        .map(|(path, node)| {
            let node = match node {
                Value::Null => Node::Dir,
                content => Node::File(bytes_of(content)),
            };
            (path.as_str().unwrap().to_owned(), node)
        })
        .collect()
}

/// Builds `tree` under `dir`, in its order.
pub fn build(dir: &Path, tree: &[(String, Node)]) {
    for (path, node) in tree {
        let target = dir.join(path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        match node {
            Node::Dir => fs::create_dir_all(&target).unwrap(),
            Node::File(bytes) => fs::write(&target, bytes).unwrap(),
        }
    }
}

/// Everything under `dir`.
pub fn recorded(dir: &Path) -> BTreeMap<String, Node> {
    let mut tree = BTreeMap::new();
    record(dir, "", &mut tree);
    tree
}

fn record(dir: &Path, prefix: &str, tree: &mut BTreeMap<String, Node>) {
    for item in fs::read_dir(dir).unwrap() {
        let item = item.unwrap();
        let name = item.file_name().into_string().unwrap();
        let path = item.path();
        if fs::symlink_metadata(&path).unwrap().is_dir() {
            tree.insert(format!("{prefix}{name}/"), Node::Dir);
            record(&path, &format!("{prefix}{name}/"), tree);
        } else {
            tree.insert(format!("{prefix}{name}"), Node::File(fs::read(&path).unwrap()));
        }
    }
}
