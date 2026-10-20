// SPDX-License-Identifier: GPL-2.0-or-later
//! Choosing one copy when Drive lists several files with the same name.
//! Drive keys files by id and does not keep names unique, so two machines
//! creating the same file at once leave two copies. Every lookup by name
//! uses the same copy, so writes, merges and the recorded remote state all
//! land on one file instead of alternating between them.
//!
//! A [`Listing`] indexes one listing on first use, so the many lookups of
//! a pass are each O(1).

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::DriveFile;
use crate::trash_names::{TrashInfo, parse_trash_file};

/// The modifiedTime of `file` in milliseconds; an unreadable one sorts
/// before every readable one (`-Infinity`), so the choice does not depend
/// on the listing order.
pub fn modified_ms(file: &DriveFile) -> f64 {
    pipette_time::parse_date_time_string(&file.modified_time).map_or(f64::NEG_INFINITY, |ms| ms as f64)
}

/// The newest-wins rule every choice between copies follows: the later
/// time, ties broken by the smaller id (compared as JavaScript compares
/// strings, by UTF-16 code units).
pub fn is_newer_copy(a_ms: f64, a_id: &str, b_ms: f64, b_id: &str) -> bool {
    if a_ms != b_ms {
        return a_ms > b_ms;
    }
    a_id.encode_utf16().cmp(b_id.encode_utf16()) == Ordering::Less
}

fn better(a: &DriveFile, b: &DriveFile) -> bool {
    is_newer_copy(modified_ms(a), &a.id, modified_ms(b), &b.id)
}

/// A trash file of a listing with what its name says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrashCopy<'a> {
    pub file: &'a DriveFile,
    pub trash: &'a TrashInfo,
}

/// The copies of each name, by position in the listing.
#[derive(Default)]
struct NameIndex {
    /// Names in first-listed order.
    names: Vec<String>,
    /// Name → (the chosen copy, every copy).
    by_name: HashMap<String, (usize, Vec<usize>)>,
}

/// Original name → its trash files, names in first-listed order.
#[derive(Default)]
struct TrashIndex {
    names: Vec<String>,
    by_name: HashMap<String, Vec<(usize, TrashInfo)>>,
}

/// One listing of `appDataFolder`, with the lookups by name.
pub struct Listing {
    files: Vec<DriveFile>,
    names: OnceLock<NameIndex>,
    trash: OnceLock<TrashIndex>,
}

impl Listing {
    pub fn new(files: Vec<DriveFile>) -> Self {
        Self { files, names: OnceLock::new(), trash: OnceLock::new() }
    }

    /// Every file, in the listed order.
    pub fn files(&self) -> &[DriveFile] {
        &self.files
    }

    fn names(&self) -> &NameIndex {
        self.names.get_or_init(|| {
            let mut index = NameIndex::default();
            for (position, file) in self.files.iter().enumerate() {
                match index.by_name.get_mut(&file.name) {
                    Some((chosen, copies)) => {
                        if better(file, &self.files[*chosen]) {
                            *chosen = position;
                        }
                        copies.push(position);
                    }
                    None => {
                        index.names.push(file.name.clone());
                        index.by_name.insert(file.name.clone(), (position, vec![position]));
                    }
                }
            }
            index
        })
    }

    /// Kept apart from the name index so a plain lookup never parses trash
    /// names.
    fn trash(&self) -> &TrashIndex {
        self.trash.get_or_init(|| {
            let mut index = TrashIndex::default();
            for (position, file) in self.files.iter().enumerate() {
                let Some(trash) = parse_trash_file(&file.id, &file.name) else { continue };
                match index.by_name.get_mut(&trash.original_name) {
                    Some(copies) => copies.push((position, trash)),
                    None => {
                        index.names.push(trash.original_name.clone());
                        index.by_name.insert(trash.original_name.clone(), vec![(position, trash)]);
                    }
                }
            }
            index
        })
    }

    /// The copy of `name` every lookup uses: the newest modifiedTime, ties
    /// to the smallest id.
    pub fn pick_canonical(&self, name: &str) -> Option<&DriveFile> {
        self.names().by_name.get(name).map(|(chosen, _)| &self.files[*chosen])
    }

    /// One file per name, the chosen copy, names in first-listed order.
    pub fn canonical_files(&self) -> Vec<&DriveFile> {
        let index = self.names();
        index.names.iter().map(|name| &self.files[index.by_name[name].0]).collect()
    }

    /// Every copy of `name` in the listed order, for deletes that must not
    /// leave a duplicate behind.
    pub fn files_named(&self, name: &str) -> Vec<&DriveFile> {
        self.names()
            .by_name
            .get(name)
            .map(|(_, copies)| copies.iter().map(|position| &self.files[*position]).collect())
            .unwrap_or_default()
    }

    /// Names with two or more copies, in first-listed order.
    pub fn duplicated_names(&self) -> Vec<&str> {
        let index = self.names();
        index.names.iter().filter(|name| index.by_name[*name].1.len() > 1).map(String::as_str).collect()
    }

    /// The trash files of `name` in the listed order.
    pub fn trash_copies_of(&self, name: &str) -> Vec<TrashCopy<'_>> {
        self.trash()
            .by_name
            .get(name)
            .map(|copies| {
                copies
                    .iter()
                    .map(|(position, trash)| TrashCopy { file: &self.files[*position], trash })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Names with at least one trash file, in first-listed order.
    pub fn names_with_trash(&self) -> Vec<&str> {
        self.trash().names.iter().map(String::as_str).collect()
    }

    /// Every copy of `name` and then every trash file of it, for deletes
    /// meant to remove the name for good.
    pub fn files_named_with_trash(&self, name: &str) -> Vec<&DriveFile> {
        let mut files = self.files_named(name);
        files.extend(self.trash_copies_of(name).into_iter().map(|copy| copy.file));
        files
    }
}
