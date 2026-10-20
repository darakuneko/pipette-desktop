// SPDX-License-Identifier: GPL-2.0-or-later
//! The check of a language pack (`validatePack` of
//! src/shared/i18n/validate.ts), with the same errors, warnings, dangerous
//! keys and header. The Hub download of a language pack is refused when it
//! fails (crates/pipette-hub). The size of a pack is not checked here: the Hub
//! enforces it.
//!
//! The patterns are matched on UTF-16 code units with JavaScript's meaning
//! (theme_validate.rs).

use pipette_entry_store::{js_trim, utf16_len};
use pipette_js_json::{JsString, Object, Value};

use crate::theme_validate::{Part, is_semver, is_word, message};

/// `I18N_PACK_LIMITS.MAX_DEPTH`: the deepest translation tree.
pub const MAX_DEPTH: usize = 8;
/// `I18N_PACK_LIMITS.MAX_KEYS`: the most translation keys.
pub const MAX_KEYS: usize = 5000;
/// `I18N_PACK_LIMITS.MAX_NAME_LENGTH`: the longest name (UTF-16 units).
pub const MAX_NAME_LENGTH: usize = 64;

const DANGEROUS_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// What the check found. Only a pack with neither errors nor dangerous
/// keys passes, and only then is there a header (the name and version,
/// trimmed).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PackCheck {
    pub errors: Vec<JsString>,
    pub warnings: Vec<JsString>,
    pub dangerous_keys: Vec<JsString>,
    pub header: Option<(JsString, JsString)>,
}

impl PackCheck {
    pub fn ok(&self) -> bool {
        self.errors.is_empty() && self.dangerous_keys.is_empty()
    }
}

/// `validateName`.
fn name_error(value: Option<&Value>) -> Option<String> {
    let Some(Value::String(name)) = value else { return Some("name must be a string".into()) };
    let trimmed = js_trim(name);
    if trimmed.is_empty() {
        return Some("name must not be empty".into());
    }
    (utf16_len(&trimmed) > MAX_NAME_LENGTH)
        .then(|| format!("name must be at most {MAX_NAME_LENGTH} characters"))
}

/// `validateVersion`.
fn version_error(value: Option<&Value>) -> Option<&'static str> {
    let Some(Value::String(version)) = value else { return Some("version must be a string") };
    (!is_semver(&js_trim(version).utf16_units())).then_some("version must be a valid semver (e.g. 0.1.0)")
}

/// `/^[\w\-]+$/`.
fn is_key_segment(key: &JsString) -> bool {
    let units = key.utf16_units();
    !units.is_empty() && units.iter().all(|&unit| is_word(unit) || unit == u16::from(b'-'))
}

fn is_dangerous(key: &JsString) -> bool {
    DANGEROUS_KEYS.iter().any(|&dangerous| key.as_str() == Some(dangerous))
}

/// `path.join('.')`.
fn joined(path: &[JsString]) -> JsString {
    let mut units = Vec::new();
    for (i, key) in path.iter().enumerate() {
        if i > 0 {
            units.push(u16::from(b'.'));
        }
        units.extend(key.utf16_units());
    }
    JsString::from_utf16(units)
}

/// `typeof` of a value that is not a string.
fn type_of(value: &Value) -> &'static str {
    match value {
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
        Value::String(_) => "string",
        Value::Null | Value::Array(_) | Value::Object(_) => "object",
    }
}

struct Walk<'a> {
    check: &'a mut PackCheck,
    key_count: usize,
}

impl Walk<'_> {
    /// `walk`: the depth, the key shapes, the leaves and the dangerous keys
    /// of a translation tree. Past `MAX_KEYS` keys, each object stops at
    /// the key that went over.
    fn node(&mut self, node: &Value, path: &mut Vec<JsString>, depth: usize) {
        if depth > MAX_DEPTH {
            let at = joined(path);
            let text = format!("Translation tree exceeds depth {MAX_DEPTH} at \"");
            self.check.errors.push(message(&[Part::T(&text), Part::J(&at), Part::T("\"")]));
            return;
        }
        match node {
            Value::String(_) => {}
            Value::Array(items) => {
                let at = joined(path);
                for (i, item) in items.iter().enumerate() {
                    if !matches!(item, Value::String(_)) {
                        let index = format!("[{i}]\" must be a string");
                        self.check.errors.push(message(&[
                            Part::T("Array element at \""),
                            Part::J(&at),
                            Part::T(&index),
                        ]));
                    }
                }
            }
            Value::Object(object) => self.object(object.iter(), path, depth),
            other => {
                let at = joined(path);
                let got = format!("\" must be a string (got {})", type_of(other));
                self.check.errors.push(message(&[Part::T("Leaf at \""), Part::J(&at), Part::T(&got)]));
            }
        }
    }

    fn object<'v>(
        &mut self,
        entries: impl Iterator<Item = (&'v JsString, &'v Value)>,
        path: &mut Vec<JsString>,
        depth: usize,
    ) {
        for (key, value) in entries {
            if is_dangerous(key) {
                path.push(key.clone());
                self.check.dangerous_keys.push(joined(path));
                path.pop();
                continue;
            }
            if !is_key_segment(key) {
                let at = joined(path);
                self.check.errors.push(message(&[
                    Part::T("Invalid key segment \""),
                    Part::J(key),
                    Part::T("\" at \""),
                    Part::J(&at),
                    Part::T("\""),
                ]));
                continue;
            }
            self.key_count += 1;
            if self.key_count > MAX_KEYS {
                return;
            }
            path.push(key.clone());
            self.node(value, path, depth + 1);
            path.pop();
        }
    }
}

/// The keys that are not the pack's metadata, as `validatePack` copies them
/// into a plain object: `name` and `version` are left out, and so is
/// `__proto__`, which sets the copy's prototype instead of adding a key.
fn translation_entries(pack: &Object) -> impl Iterator<Item = (&JsString, &Value)> {
    pack.iter().filter(|(key, _)| !matches!(key.as_str(), Some("name" | "version" | "__proto__")))
}

/// Checks the pack `raw` (`None` is `undefined`) as `validatePack` does.
pub fn validate_pack(raw: Option<&Value>) -> PackCheck {
    let mut check = PackCheck::default();
    let Some(Value::Object(pack)) = raw else {
        check.errors.push("Pack must be a JSON object".into());
        return check;
    };
    if let Some(error) = name_error(pack.get("name")) {
        check.errors.push(error.as_str().into());
    }
    if let Some(error) = version_error(pack.get("version")) {
        check.errors.push(error.into());
    }
    let mut walk = Walk { check: &mut check, key_count: 0 };
    walk.object(translation_entries(pack), &mut Vec::new(), 0);
    let key_count = walk.key_count;
    if key_count > MAX_KEYS {
        check.errors.push(format!("Pack exceeds {MAX_KEYS} keys").as_str().into());
    }
    if translation_entries(pack).next().is_none() {
        check.warnings.push("Pack contains no translations beyond the metadata fields".into());
    }
    if check.ok() {
        let header = |key: &str| match pack.get(key) {
            Some(Value::String(s)) => js_trim(s),
            _ => JsString::from(""),
        };
        check.header = Some((header("name"), header("version")));
    }
    check
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    fn check(text: &str) -> PackCheck {
        validate_pack(Some(&pipette_js_json::parse(text).unwrap()))
    }

    fn strings(list: &[JsString]) -> Vec<String> {
        list.iter().map(|s| s.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn a_pack_passes_with_its_trimmed_header() {
        let found =
            check(r#"{"name":" Pack ","version":" 1.0.0-rc.1 ","common":{"save":"Save","list":["a"]}}"#);
        assert!(found.ok());
        assert_eq!(found.header, Some(("Pack".into(), "1.0.0-rc.1".into())));
        assert!(found.warnings.is_empty());
    }

    #[test]
    fn a_top_level_proto_is_not_a_key_but_a_nested_one_is_dangerous() {
        let top = check(r#"{"name":"P","version":"1.0.0","__proto__":{"x":"y"}}"#);
        assert!(top.ok());
        assert_eq!(strings(&top.warnings), ["Pack contains no translations beyond the metadata fields"]);
        let nested = check(r#"{"name":"P","version":"1.0.0","a":{"__proto__":"x","b":"c"}}"#);
        assert!(!nested.ok());
        assert_eq!(strings(&nested.dangerous_keys), ["a.__proto__"]);
        assert!(nested.header.is_none());
    }

    #[test]
    fn each_object_stops_at_the_key_past_the_limit() {
        let keys: Vec<String> = (0..=MAX_KEYS).map(|i| format!("\"k{i}\":\"v\"")).collect();
        let text = format!(r#"{{"name":"P","version":"1.0.0","big":{{{}}},"bad key":"x"}}"#, keys.join(","));
        let found = check(&text);
        // `big` stops at its 5000th key; the top level goes on, so the
        // invalid key after it is still reported.
        assert_eq!(
            strings(&found.errors),
            ["Invalid key segment \"bad key\" at \"\"", "Pack exceeds 5000 keys"]
        );
    }

    #[test]
    fn messages_keep_a_lone_surrogate_of_a_key() {
        let found = check(r#"{"name":"P","version":"1.0.0","a\ud800":"x"}"#);
        let error = &found.errors[0];
        assert!(error.as_str().is_none());
        assert!(error.utf16_units().contains(&0xd800));
    }
}
