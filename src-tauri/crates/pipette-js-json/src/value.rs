// SPDX-License-Identifier: GPL-2.0-or-later
//! The values `JSON.parse` produces, held the way JavaScript holds them:
//! strings as UTF-16 (lone surrogates included), numbers as f64, objects
//! with JavaScript's property order.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};

use indexmap::{Equivalent, IndexMap};

/// A JSON value.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    /// Any f64 `JSON.parse` can produce: finite, or infinite for a literal
    /// out of range (`1e400`), which `JSON.stringify` writes as `null`.
    Number(f64),
    String(JsString),
    Array(Vec<Value>),
    Object(Object),
}

impl Value {
    pub fn as_object(&self) -> Option<&Object> {
        match self {
            Value::Object(object) => Some(object),
            _ => None,
        }
    }

    /// The text of a string value; `None` for other values and for a string
    /// with a lone surrogate.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => s.as_str(),
            _ => None,
        }
    }

    /// JavaScript's `Boolean(value)`.
    pub fn is_truthy(&self) -> bool {
        match self {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => *n != 0.0 && !n.is_nan(),
            Value::String(s) => !s.is_empty(),
            Value::Array(_) | Value::Object(_) => true,
        }
    }
}

impl From<bool> for Value {
    fn from(value: bool) -> Self {
        Value::Bool(value)
    }
}

impl From<f64> for Value {
    fn from(value: f64) -> Self {
        Value::Number(value)
    }
}

impl From<&str> for Value {
    fn from(value: &str) -> Self {
        Value::String(value.into())
    }
}

impl From<String> for Value {
    fn from(value: String) -> Self {
        Value::String(value.into())
    }
}

impl From<Object> for Value {
    fn from(value: Object) -> Self {
        Value::Object(value)
    }
}

/// A JavaScript string. Held as UTF-8 unless it has a lone surrogate, which
/// UTF-8 cannot hold; then as its UTF-16 code units, so it reads and writes
/// back exactly as JavaScript would (`JSON.stringify` escapes a lone
/// surrogate as `\udxxx`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsString(Repr);

/// `Units` only when the units are not valid UTF-16, so two equal strings
/// always have the same variant.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Repr {
    Text(String),
    Units(Vec<u16>),
}

impl JsString {
    /// The string of these UTF-16 code units.
    pub fn from_utf16(units: Vec<u16>) -> Self {
        match String::from_utf16(&units) {
            Ok(text) => JsString(Repr::Text(text)),
            Err(_) => JsString(Repr::Units(units)),
        }
    }

    /// The text, unless the string has a lone surrogate.
    pub fn as_str(&self) -> Option<&str> {
        match &self.0 {
            Repr::Text(text) => Some(text),
            Repr::Units(_) => None,
        }
    }

    /// The text, with U+FFFD for each lone surrogate.
    pub fn to_string_lossy(&self) -> Cow<'_, str> {
        match &self.0 {
            Repr::Text(text) => Cow::Borrowed(text),
            Repr::Units(units) => Cow::Owned(String::from_utf16_lossy(units)),
        }
    }

    pub fn is_empty(&self) -> bool {
        match &self.0 {
            Repr::Text(text) => text.is_empty(),
            Repr::Units(units) => units.is_empty(),
        }
    }

    /// The UTF-16 code units.
    pub fn utf16_units(&self) -> Vec<u16> {
        match &self.0 {
            Repr::Text(text) => text.encode_utf16().collect(),
            Repr::Units(units) => units.clone(),
        }
    }

    /// Each character, or `Err` with the code unit of a lone surrogate.
    pub(crate) fn chars(&self) -> Box<dyn Iterator<Item = Result<char, u16>> + '_> {
        match &self.0 {
            Repr::Text(text) => Box::new(text.chars().map(Ok)),
            Repr::Units(units) => Box::new(
                char::decode_utf16(units.iter().copied()).map(|r| r.map_err(|err| err.unpaired_surrogate())),
            ),
        }
    }
}

impl Hash for JsString {
    /// Hashes the text as `str` does, so a `&str` finds its key in the
    /// named properties ([`Equivalent`] below).
    fn hash<H: Hasher>(&self, state: &mut H) {
        match &self.0 {
            Repr::Text(text) => text.hash(state),
            Repr::Units(units) => units.hash(state),
        }
    }
}

impl Equivalent<JsString> for str {
    fn equivalent(&self, key: &JsString) -> bool {
        key.as_str() == Some(self)
    }
}

impl From<&str> for JsString {
    fn from(value: &str) -> Self {
        JsString(Repr::Text(value.to_owned()))
    }
}

impl From<String> for JsString {
    fn from(value: String) -> Self {
        JsString(Repr::Text(value))
    }
}

impl PartialEq<str> for JsString {
    fn eq(&self, other: &str) -> bool {
        self.as_str() == Some(other)
    }
}

/// The largest array index, 2^32 - 2.
const MAX_ARRAY_INDEX: u64 = 4_294_967_294;

/// `key` as an array index: the canonical decimal form of an integer from 0
/// to 2^32 - 2. JavaScript lists these keys first, in ascending order.
fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return None;
    }
    let n: u64 = key.parse().ok()?;
    if n > MAX_ARRAY_INDEX {
        return None;
    }
    u32::try_from(n).ok()
}

/// A JSON object with JavaScript's own-property order: the array index keys
/// in ascending order, then the other keys in the order they were first
/// added. Setting a key that exists keeps its position.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Object {
    indexed: BTreeMap<u32, (JsString, Value)>,
    named: IndexMap<JsString, Value>,
}

impl Object {
    pub fn new() -> Self {
        Self::default()
    }

    /// An empty object with room for `capacity` keys that are not array
    /// indexes, so building one of a known shape does not grow it.
    pub fn with_capacity(capacity: usize) -> Self {
        Self { indexed: BTreeMap::new(), named: IndexMap::with_capacity(capacity) }
    }

    /// Sets `key`, returning the value it replaced.
    pub fn insert(&mut self, key: impl Into<JsString>, value: Value) -> Option<Value> {
        let key = key.into();
        match key.as_str().and_then(array_index) {
            Some(index) => self.indexed.insert(index, (key, value)).map(|(_, old)| old),
            None => self.named.insert(key, value),
        }
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        match array_index(key) {
            Some(index) => self.indexed.get(&index).map(|(_, value)| value),
            None => self.named.get(key),
        }
    }

    /// Removes `key`, returning its value. The other keys keep their order,
    /// as with JavaScript's `delete`.
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        match array_index(key) {
            Some(index) => self.indexed.remove(&index).map(|(_, value)| value),
            None => self.named.shift_remove(key),
        }
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn len(&self) -> usize {
        self.indexed.len() + self.named.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The properties in JavaScript's order.
    pub fn iter(&self) -> impl Iterator<Item = (&JsString, &Value)> {
        self.indexed.values().map(|(key, value)| (key, value)).chain(self.named.iter())
    }

    pub fn keys(&self) -> impl Iterator<Item = &JsString> {
        self.iter().map(|(key, _)| key)
    }
}

impl<K: Into<JsString>> FromIterator<(K, Value)> for Object {
    fn from_iter<I: IntoIterator<Item = (K, Value)>>(iter: I) -> Self {
        let mut object = Object::new();
        for (key, value) in iter {
            object.insert(key, value);
        }
        object
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(object: &Object) -> Vec<String> {
        object.keys().map(|key| key.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn array_indexes_come_first_in_ascending_order() {
        let object: Object = ["b", "10", "a", "2", "4294967295", "4294967294", "01", "-0", "0"]
            .into_iter()
            .map(|key| (key, Value::Null))
            .collect();
        assert_eq!(keys(&object), ["0", "2", "10", "4294967294", "b", "a", "4294967295", "01", "-0"]);
    }

    #[test]
    fn a_duplicate_key_keeps_its_position_and_takes_the_last_value() {
        let mut object = Object::new();
        object.insert("a", 1.0.into());
        object.insert("b", 2.0.into());
        assert_eq!(object.insert("a", 3.0.into()), Some(1.0.into()));
        assert_eq!(keys(&object), ["a", "b"]);
        assert_eq!(object.get("a"), Some(&3.0.into()));
    }

    #[test]
    fn remove_keeps_the_order_of_the_other_keys() {
        let mut object: Object =
            ["a", "1", "b", "c", "0"].into_iter().map(|key| (key, Value::from(key))).collect();
        assert_eq!(object.remove("b"), Some(Value::from("b")));
        assert_eq!(object.remove("1"), Some(Value::from("1")));
        assert_eq!(object.remove("missing"), None);
        assert_eq!(keys(&object), ["0", "a", "c"]);
        object.insert("b", Value::Null);
        assert_eq!(keys(&object), ["0", "a", "c", "b"]);
    }

    #[test]
    fn a_lone_surrogate_string_is_kept_as_units() {
        let lone = JsString::from_utf16(vec![0x61, 0xd800]);
        assert_eq!(lone.as_str(), None);
        assert_eq!(lone.to_string_lossy(), "a\u{fffd}");
        let pair = JsString::from_utf16(vec![0xd83d, 0xde00]);
        assert_eq!(pair, JsString::from("😀"));
        assert_eq!(pair.utf16_units(), [0xd83d, 0xde00]);
    }

    #[test]
    fn a_lone_surrogate_key_is_a_named_key_of_its_own() {
        let mut object = Object::new();
        object.insert(JsString::from_utf16(vec![0xd800]), Value::Null);
        object.insert("x", Value::Null);
        assert_eq!(object.len(), 2);
        assert!(object.contains_key("x"));
        assert!(!object.contains_key("\u{fffd}"));
    }

    #[test]
    fn truthiness_follows_boolean() {
        let cases = [
            (Value::Null, false),
            (Value::Bool(false), false),
            (Value::Number(0.0), false),
            (Value::Number(-0.0), false),
            (Value::Number(f64::NAN), false),
            (Value::Number(f64::INFINITY), true),
            (Value::from(""), false),
            (Value::from("false"), true),
            (Value::from("0"), true),
            (Value::Array(vec![]), true),
            (Value::Object(Object::new()), true),
        ];
        for (value, truthy) in cases {
            assert_eq!(value.is_truthy(), truthy, "{value:?}");
        }
    }
}
