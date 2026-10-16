// SPDX-License-Identifier: GPL-2.0-or-later
//! An index entry: a JSON object kept in JavaScript's property order, with
//! typed accessors for the fields every store shares.

use pipette_js_json::{JsString, Object, Value};

/// The merge groups of the meta fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MetaGroup {
    Name,
    Hub,
    Enabled,
}

impl MetaGroup {
    /// In the order the clocks are written.
    pub const ALL: [MetaGroup; 3] = [MetaGroup::Name, MetaGroup::Hub, MetaGroup::Enabled];
}

/// Every merge group. `Created` carries the store's created fields, `Body`
/// every field no other group claims (see [`crate::body_fields_of`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EntryGroup {
    Created,
    Body,
    Name,
    Hub,
    Enabled,
}

impl EntryGroup {
    /// The group's key in an entry's `clocks`.
    pub fn key(self) -> &'static str {
        match self {
            EntryGroup::Created => "created",
            EntryGroup::Body => "body",
            EntryGroup::Name => "name",
            EntryGroup::Hub => "hub",
            EntryGroup::Enabled => "enabled",
        }
    }

    /// The meta group this is, if any.
    pub fn meta(self) -> Option<MetaGroup> {
        match self {
            EntryGroup::Name => Some(MetaGroup::Name),
            EntryGroup::Hub => Some(MetaGroup::Hub),
            EntryGroup::Enabled => Some(MetaGroup::Enabled),
            EntryGroup::Created | EntryGroup::Body => None,
        }
    }
}

impl From<MetaGroup> for EntryGroup {
    fn from(group: MetaGroup) -> Self {
        match group {
            MetaGroup::Name => EntryGroup::Name,
            MetaGroup::Hub => EntryGroup::Hub,
            MetaGroup::Enabled => EntryGroup::Enabled,
        }
    }
}

/// An entry of a store's index. Every field is kept as read, in its
/// position, so an entry written back keeps fields this build does not
/// know. The entries the helpers of this crate return carry `clocks` and an
/// `updatedAt` derived from them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Entry(Object);

impl Entry {
    pub fn from_object(object: Object) -> Self {
        Entry(object)
    }

    pub fn as_object(&self) -> &Object {
        &self.0
    }

    pub fn into_object(self) -> Object {
        self.0
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    /// Sets `key`; an existing key keeps its position, a new one goes last.
    pub fn set(&mut self, key: &str, value: impl Into<Value>) {
        self.0.insert(key, value.into());
    }

    pub fn remove(&mut self, key: &str) -> Option<Value> {
        self.0.remove(key)
    }

    /// Sets the string field `key` to `value` trimmed (`String.prototype.trim`),
    /// or removes it when `value` is `None` or blank.
    pub fn set_trimmed(&mut self, key: &str, value: Option<&JsString>) {
        match value.map(crate::text::js_trim).filter(|value| !value.is_empty()) {
            Some(value) => self.set(key, Value::String(value)),
            None => {
                self.remove(key);
            }
        }
    }

    /// The id, when it is a string.
    pub fn id(&self) -> Option<&JsString> {
        self.string("id")
    }

    /// The body filename, when it is a string.
    pub fn filename(&self) -> Option<&JsString> {
        self.string("filename")
    }

    pub fn updated_at(&self) -> Option<&JsString> {
        self.string("updatedAt")
    }

    /// The `deletedAt` value as stored (any JSON value counts: only a
    /// missing key means not deleted).
    pub fn deleted_at(&self) -> Option<&Value> {
        self.0.get("deletedAt")
    }

    /// Whether the entry is a tombstone. An entry the helpers return is
    /// deleted exactly when it has `deletedAt`.
    pub fn is_deleted(&self) -> bool {
        self.deleted_at().is_some()
    }

    /// The `clocks` object, when there is one.
    pub fn clocks(&self) -> Option<&Object> {
        self.0.get("clocks").and_then(Value::as_object)
    }

    /// The clock of `group` as stored.
    pub fn clock(&self, group: EntryGroup) -> Option<&Value> {
        self.clocks().and_then(|clocks| clocks.get(group.key()))
    }

    fn string(&self, key: &str) -> Option<&JsString> {
        match self.0.get(key) {
            Some(Value::String(s)) => Some(s),
            _ => None,
        }
    }
}

impl From<Entry> for Value {
    fn from(entry: Entry) -> Self {
        Value::Object(entry.0)
    }
}

impl From<Object> for Entry {
    fn from(object: Object) -> Self {
        Entry(object)
    }
}
