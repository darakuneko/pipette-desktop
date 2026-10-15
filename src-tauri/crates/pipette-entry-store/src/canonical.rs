// SPDX-License-Identifier: GPL-2.0-or-later
//! Canonical JSON and the values of a field group, what the writes compare
//! to tell whether a group changed.

use pipette_js_json::{JsString, Object, Value, stringify};

use crate::entry::EntryGroup;
use crate::store_groups::{RESERVED_FIELDS, StoreGroupDef};

/// A key JavaScript's `obj[key] = value` does not create as a property: it
/// sets the prototype instead, so canonicalJson and groupValues of the
/// Electron build never carry it.
const PROTO: &str = "__proto__";

/// JSON with object keys sorted (by UTF-16 code units, as `Array.sort`
/// does) at every level, so equal values always give equal strings; `null`
/// for a missing value. As in JavaScript, the array-index keys still come
/// first, in ascending order, and a `__proto__` key is left out.
pub fn canonical_json(value: Option<&Value>) -> String {
    value.map_or_else(|| "null".to_owned(), |value| stringify(&sort_value(value)))
}

fn sort_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(sort_value).collect()),
        Value::Object(object) => {
            let mut keys: Vec<(&JsString, Vec<u16>)> = object
                .keys()
                .filter(|key| key.as_str() != Some(PROTO))
                .map(|key| (key, key.utf16_units()))
                .collect();
            keys.sort_by(|a, b| a.1.cmp(&b.1));
            let mut out = Object::new();
            for (key, _) in keys {
                if let Some(v) = lookup(object, key) {
                    out.insert(key.clone(), sort_value(v));
                }
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// The value of `key`, also for a key with a lone surrogate (which
/// `Object::get` cannot look up by `&str`).
fn lookup<'a>(object: &'a Object, key: &JsString) -> Option<&'a Value> {
    match key.as_str() {
        Some(key) => object.get(key),
        None => object.iter().find(|(k, _)| *k == key).map(|(_, v)| v),
    }
}

/// Every key of `entry` that is neither reserved nor claimed by the
/// created group or a meta group: the body group.
pub fn body_fields_of(def: &StoreGroupDef, entry: &Object) -> Vec<JsString> {
    entry
        .keys()
        .filter(|key| key.as_str().is_none_or(|k| !RESERVED_FIELDS.contains(&k) && !def.claims(k)))
        .cloned()
        .collect()
}

/// The fields of `group` that `entry` has, as an object (the body group is
/// every field [`body_fields_of`] returns). A missing field is left out,
/// as are `__proto__` keys (see [`canonical_json`]).
pub fn group_values(def: &StoreGroupDef, entry: &Object, group: EntryGroup) -> Object {
    let mut out = Object::new();
    let mut take = |key: &JsString| {
        if key.as_str() != Some(PROTO)
            && let Some(value) = lookup(entry, key)
        {
            out.insert(key.clone(), value.clone());
        }
    };
    let fields = match (group, group.meta()) {
        (EntryGroup::Body, _) => body_fields_of(def, entry),
        (_, Some(meta)) => def.meta(meta).unwrap_or_default().iter().map(|f| JsString::from(*f)).collect(),
        _ => def.created_fields.iter().map(|f| JsString::from(*f)).collect(),
    };
    fields.iter().for_each(&mut take);
    out
}
