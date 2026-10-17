// SPDX-License-Identifier: GPL-2.0-or-later
//! The checks the Hub makes on what it is sent, with its error texts, as
//! scripts/fake-hub/hub-validate.ts has them: the display-name rules, the
//! `test:<email>` id_token, and the validators of the uploads (language
//! packs, theme packs, key labels, analytics exports, the favorite JSON of
//! a feature post, the expiry of a private post).
//!
//! The reserved-name check folds full-width ASCII and drops zero-width
//! characters but applies no other NFKC mapping.

use pipette_js_json::{Object, Value};

use crate::js::{js_length, js_trim};
use crate::node_base64_decode;

const DANGEROUS_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];
const MAX_DISPLAY_NAME_LENGTH: usize = 50;

pub const I18N_MAX_BYTES: usize = 256 * 1024;
const I18N_MAX_DEPTH: usize = 8;
const I18N_MAX_KEYS: usize = 5000;
const I18N_MAX_NAME_LENGTH: usize = 64;

pub const THEME_MAX_BYTES: usize = 64 * 1024;
const THEME_MAX_NAME_LENGTH: usize = 64;
const THEME_COLOR_KEYS: [&str; 35] = [
    "surface",
    "surface-alt",
    "surface-dim",
    "surface-raised",
    "content",
    "content-secondary",
    "content-muted",
    "content-inverse",
    "edge",
    "edge-subtle",
    "edge-strong",
    "accent",
    "accent-hover",
    "accent-alt",
    "success",
    "warning",
    "danger",
    "pending",
    "key-bg",
    "key-bg-hover",
    "key-bg-active",
    "key-border",
    "key-shadow",
    "key-label",
    "key-sublabel",
    "key-label-remap",
    "key-bg-multi-selected",
    "tab-bg-active",
    "tab-text",
    "tab-text-active",
    "picker-bg",
    "picker-item-bg",
    "picker-item-hover",
    "picker-item-text",
    "picker-item-border",
];

const MAX_KEY_LABEL_NAME_LENGTH: usize = 100;
const MAX_KEY_LABEL_VALUE_LENGTH: usize = 50;
const MAX_KEY_LABEL_MAP_ENTRIES: usize = 500;

const ANALYTICS_MIN_KEYSTROKES: f64 = 100.0;
const ANALYTICS_MAX_RANGE_MS: f64 = 30.0 * 86_400_000.0;
const ANALYTICS_ARRAY_FIELDS: [&str; 10] = [
    "minuteStats",
    "matrixCells",
    "matrixCellsByDay",
    "layerUsage",
    "sessions",
    "bksMinute",
    "bigramTop",
    "bigramSlow",
    "appUsage",
    "wpmByApp",
];

type Checked<T> = Result<T, String>;

fn invalid<T>(reason: &str) -> Checked<T> {
    Err(format!("INVALID_PAYLOAD: {reason}"))
}

fn finite(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}

// --- Accounts ------------------------------------------------------------------

/// Trimmed, cut to 50 code points; `None` when empty.
pub fn normalize_display_name(raw: Option<&str>) -> Option<String> {
    let trimmed = js_trim(raw?);
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(MAX_DISPLAY_NAME_LENGTH).collect())
}

const RESERVED_PREFIXES: [&str; 2] = ["pipette", "darakuneko"];
const RESERVED_EXACT: [&str; 10] =
    ["admin", "administrator", "root", "owner", "moderator", "mod", "official", "staff", "support", "system"];

fn is_zero_width(c: char) -> bool {
    matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{FEFF}')
}

pub fn is_reserved_display_name(name: &str) -> bool {
    let folded: String = name
        .chars()
        .map(|c| match c {
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(u32::from(c) - 0xFEE0).unwrap_or(c),
            '\u{3000}' => ' ',
            other => other,
        })
        .filter(|c| !is_zero_width(*c))
        .collect();
    let normalized = js_trim(&folded).to_lowercase();
    if normalized.is_empty() {
        return false;
    }
    RESERVED_PREFIXES.iter().any(|prefix| normalized.starts_with(prefix))
        || RESERVED_EXACT.contains(&normalized.as_str())
}

/// What the Hub reads from a verified id_token.
pub struct Identity {
    pub email: String,
    /// The Google profile name; the display name a new account gets.
    pub name: Option<String>,
}

/// A `test:<email>` id_token of the Hub's test mode: one `@`, a domain of
/// example.com or one ending in `.test`, a local part that is not a
/// reserved name. The display name is the local part.
pub fn parse_test_id_token(id_token: &str) -> Option<Identity> {
    let raw = id_token.strip_prefix("test:")?;
    if raw.split('@').count() != 2 {
        return None;
    }
    let email = raw.to_lowercase();
    let (local, domain) = email.split_once('@')?;
    if local.is_empty() || domain.is_empty() {
        return None;
    }
    if domain != "example.com" && !domain.ends_with(".test") {
        return None;
    }
    if is_reserved_display_name(local) {
        return None;
    }
    Some(Identity { name: Some(local.to_owned()), email })
}

/// Any other id_token: a JWT whose payload has an email; the signature is
/// not checked.
pub fn parse_unverified_jwt(id_token: &str) -> Option<Identity> {
    let parts: Vec<&str> = id_token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let payload = pipette_js_json::parse(&String::from_utf8_lossy(&node_base64_decode(parts[1]))).ok()?;
    let payload = payload.as_object()?;
    let email = payload.get("email")?.as_str().filter(|email| !email.is_empty())?.to_owned();
    Some(Identity { email, name: payload.get("name").and_then(Value::as_str).map(str::to_owned) })
}

// --- Language and theme packs --------------------------------------------------

/// `^\d+\.\d+\.\d+(-[\w.]+)?$`
fn is_semver(text: &str) -> bool {
    let (core, pre) = match text.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (text, None),
    };
    let numbers: Vec<&str> = core.split('.').collect();
    numbers.len() == 3
        && numbers.iter().all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        && pre.is_none_or(|pre| {
            !pre.is_empty() && pre.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.')
        })
}

fn walk_translations(node: &Value, path: &[String], depth: usize, keys: &mut usize) -> Option<String> {
    if depth > I18N_MAX_DEPTH {
        return Some(format!("tree exceeds depth {I18N_MAX_DEPTH} at \"{}\"", path.join(".")));
    }
    match node {
        Value::String(_) => None,
        Value::Array(items) => items
            .iter()
            .position(|item| !matches!(item, Value::String(_)))
            .map(|index| format!("array element at \"{}[{index}]\" must be a string", path.join("."))),
        Value::Object(object) => {
            for (key, value) in object.iter() {
                let key = key.to_string_lossy().into_owned();
                if DANGEROUS_KEYS.contains(&key.as_str()) {
                    return Some(format!("forbidden key: {key}"));
                }
                if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                {
                    return Some(format!("invalid key segment \"{key}\""));
                }
                *keys += 1;
                if *keys > I18N_MAX_KEYS {
                    return Some(format!("pack exceeds {I18N_MAX_KEYS} keys"));
                }
                let mut child = path.to_vec();
                child.push(key);
                if let Some(err) = walk_translations(value, &child, depth + 1, keys) {
                    return Some(err);
                }
            }
            None
        }
        _ => Some(format!("leaf at \"{}\" must be a string", path.join("."))),
    }
}

/// The trimmed name and version of an upload.
pub type NameVersion = (String, String);

fn parse_payload(raw: &str, max: usize) -> Checked<Object> {
    if js_length(raw) > max {
        return invalid(&format!("pack exceeds {max} bytes"));
    }
    match pipette_js_json::parse(raw) {
        Err(_) => invalid("invalid JSON"),
        Ok(Value::Object(object)) => Ok(object),
        Ok(_) => invalid("payload must be an object"),
    }
}

/// The `{version: 1, kind: 'i18n', exportedAt, pack}` export of a language
/// pack.
pub fn parse_i18n_export(raw: &str) -> Checked<NameVersion> {
    let parsed = parse_payload(raw, I18N_MAX_BYTES)?;
    if parsed.get("version") != Some(&Value::Number(1.0)) {
        return invalid("unsupported version");
    }
    if parsed.get("kind").and_then(Value::as_str) != Some("i18n") {
        return invalid("kind mismatch");
    }
    if parsed.get("exportedAt").and_then(Value::as_str).is_none_or(str::is_empty) {
        return invalid("exportedAt must be a non-empty string");
    }
    let Some(Value::Object(pack)) = parsed.get("pack") else { return invalid("pack must be an object") };
    let Some(name) = pack.get("name").and_then(Value::as_str).filter(|name| !js_trim(name).is_empty()) else {
        return invalid("pack.name must be a non-empty string");
    };
    if js_length(name) > I18N_MAX_NAME_LENGTH {
        return invalid(&format!("pack.name must be <= {I18N_MAX_NAME_LENGTH} characters"));
    }
    let Some(version) = pack.get("version").and_then(Value::as_str).filter(|v| is_semver(&js_trim(v))) else {
        return invalid("pack.version must be valid semver (e.g. 0.1.0)");
    };
    let translations: Object = pack
        .iter()
        .filter(|(key, _)| !(*key == "name" || *key == "version"))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if let Some(err) = walk_translations(&Value::Object(translations), &[], 0, &mut 0) {
        return invalid(&err);
    }
    Ok((js_trim(name), js_trim(version)))
}

/// `^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$` or
/// `^(?:rgb|hsl)a?\([\d\s,./%+-]+\)$` (case ignored).
fn is_css_color(value: &str) -> bool {
    if let Some(hex) = value.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8) && hex.bytes().all(|b| b.is_ascii_hexdigit());
    }
    let lower = value.to_ascii_lowercase();
    let Some(rest) = ["rgba(", "rgb(", "hsla(", "hsl("].iter().find_map(|prefix| lower.strip_prefix(prefix))
    else {
        return false;
    };
    let Some(inner) = rest.strip_suffix(')') else { return false };
    !inner.is_empty()
        && inner.chars().all(|c| c.is_ascii_digit() || c.is_whitespace() || ",./%+-".contains(c))
}

/// A theme pack body `{name, version, colorScheme, colors}`.
pub fn parse_theme_pack(raw: &str) -> Checked<NameVersion> {
    let parsed = parse_payload(raw, THEME_MAX_BYTES)?;
    if let Some(key) = parsed.keys().find(|key| DANGEROUS_KEYS.iter().any(|d| *key == *d)) {
        return invalid(&format!("forbidden key: {}", key.to_string_lossy()));
    }
    let Some(name) = parsed.get("name").and_then(Value::as_str).filter(|name| !js_trim(name).is_empty())
    else {
        return invalid("name must be a non-empty string");
    };
    if js_length(name) > THEME_MAX_NAME_LENGTH {
        return invalid(&format!("name must be <= {THEME_MAX_NAME_LENGTH} characters"));
    }
    let Some(version) = parsed.get("version").and_then(Value::as_str).filter(|v| is_semver(&js_trim(v)))
    else {
        return invalid("version must be valid semver (e.g. 1.0.0)");
    };
    let Some(Value::Object(colors)) = parsed.get("colors") else {
        return invalid("colors must be an object");
    };
    if let Some(key) = colors.keys().find(|key| DANGEROUS_KEYS.iter().any(|d| *key == *d)) {
        return invalid(&format!("forbidden key in colors: {}", key.to_string_lossy()));
    }
    if let Some(missing) = THEME_COLOR_KEYS.iter().find(|key| !colors.contains_key(key)) {
        return invalid(&format!("missing required color: \"{missing}\""));
    }
    if !matches!(parsed.get("colorScheme").and_then(Value::as_str), Some("light" | "dark")) {
        return invalid("colorScheme must be \"light\" or \"dark\"");
    }
    for key in THEME_COLOR_KEYS {
        let Some(value) = colors.get(key).and_then(Value::as_str) else {
            return invalid(&format!("color \"{key}\" must be a string"));
        };
        if !is_css_color(value) {
            return invalid(&format!("color \"{key}\" has invalid CSS color value"));
        }
    }
    Ok((js_trim(name), js_trim(version)))
}

// --- Key labels ----------------------------------------------------------------

pub struct ParsedKeyLabel {
    pub name: String,
    pub map: Value,
    pub composite_labels: Option<Value>,
    /// `None` when absent: an update keeps the stored value.
    pub keymap_applicable: Option<bool>,
}

/// `^(?:0x[0-9a-fA-F]+|[A-Z][A-Z0-9_]*(?:\([^()]*\))?)$`
fn is_keycode_name(key: &str) -> bool {
    if let Some(hex) = key.strip_prefix("0x") {
        return !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit());
    }
    let (head, args) = match key.find('(') {
        Some(at) => (&key[..at], Some(&key[at..])),
        None => (key, None),
    };
    let mut bytes = head.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_uppercase())
        && bytes.all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        && args.is_none_or(|args| {
            args.len() >= 2 && args.ends_with(')') && !args[1..args.len() - 1].contains(['(', ')'])
        })
}

fn validate_label_map(raw: Option<&Value>, field: &str, required: bool) -> Checked<Option<Value>> {
    let object = match raw {
        None | Some(Value::Null) => return Ok(required.then(|| Value::Object(Object::new()))),
        Some(Value::Object(object)) => object,
        Some(_) => return Err(format!("{field} must be an object")),
    };
    if object.len() > MAX_KEY_LABEL_MAP_ENTRIES {
        return Err(format!("{field} exceeds {MAX_KEY_LABEL_MAP_ENTRIES} entries"));
    }
    for (key, value) in object.iter() {
        let key = key.to_string_lossy();
        if !is_keycode_name(&key) {
            return Err(format!("{field} key \"{key}\" is not a valid keycode name"));
        }
        let Some(text) = value.as_str() else {
            return Err(format!("{field} value for \"{key}\" must be a string"));
        };
        if js_length(text) > MAX_KEY_LABEL_VALUE_LENGTH {
            return Err(format!(
                "{field} value for \"{key}\" exceeds {MAX_KEY_LABEL_VALUE_LENGTH} characters"
            ));
        }
    }
    Ok(Some(Value::Object(object.clone())))
}

pub fn validate_key_label_payload(body: &Value) -> Checked<ParsedKeyLabel> {
    let Value::Object(body) = body else { return Err("Request body must be a JSON object".to_owned()) };
    let name = body.get("name").and_then(Value::as_str).map(js_trim).unwrap_or_default();
    if name.is_empty() {
        return Err("name is required".to_owned());
    }
    if js_length(&name) > MAX_KEY_LABEL_NAME_LENGTH {
        return Err(format!("name must be {MAX_KEY_LABEL_NAME_LENGTH} characters or less"));
    }
    let map = validate_label_map(body.get("map"), "map", true)?.unwrap_or(Value::Object(Object::new()));
    let composite_labels = validate_label_map(body.get("composite_labels"), "composite_labels", false)?;
    let keymap_applicable = match body.get("keymap_applicable") {
        None => None,
        Some(Value::Bool(flag)) => Some(*flag),
        Some(_) => return Err("keymap_applicable must be a boolean".to_owned()),
    };
    Ok(ParsedKeyLabel { name, map, composite_labels, keymap_applicable })
}

// --- Analytics exports ---------------------------------------------------------

/// The index fields of an analytics post.
pub struct AnalyticsIndex {
    pub product_name: String,
    pub keyboard_uid: String,
    pub total_keystrokes: f64,
    pub range_from_ms: f64,
    pub range_to_ms: f64,
}

fn analytics_data_error(value: Option<&Value>, path: &str) -> Option<String> {
    let Some(Value::Object(data)) = value else { return Some(format!("{path} must be an object")) };
    if let Some(field) =
        ANALYTICS_ARRAY_FIELDS.iter().find(|field| !matches!(data.get(field), Some(Value::Array(_))))
    {
        return Some(format!("{path}.{field} must be array"));
    }
    if !matches!(data.get("peakRecords"), Some(Value::Object(_))) {
        return Some(format!("{path}.peakRecords must be an object"));
    }
    if !matches!(data.get("layoutComparison"), Some(Value::Null | Value::Object(_))) {
        return Some(format!("{path}.layoutComparison must be an object or null"));
    }
    None
}

fn snapshot_index(snapshot: Option<&Value>) -> Result<AnalyticsIndex, &'static str> {
    let Some(Value::Object(snapshot)) = snapshot else { return Err("snapshot must be an object") };
    let Some(Value::Object(keyboard)) = snapshot.get("keyboard") else {
        return Err("snapshot.keyboard must be an object");
    };
    let Some(uid) = keyboard.get("uid").and_then(Value::as_str).filter(|uid| !uid.is_empty()) else {
        return Err("snapshot.keyboard.uid must be a non-empty string");
    };
    let Some(product_name) = keyboard.get("productName").and_then(Value::as_str) else {
        return Err("snapshot.keyboard.productName must be a string");
    };
    let Some(Value::Object(range)) = snapshot.get("range") else {
        return Err("snapshot.range must be an object");
    };
    let (Some(from), Some(to)) = (finite(range.get("fromMs")), finite(range.get("toMs"))) else {
        return Err("snapshot.range.fromMs/toMs must be numbers");
    };
    if to < from {
        return Err("snapshot.range.toMs must be >= fromMs");
    }
    if to - from > ANALYTICS_MAX_RANGE_MS {
        return Err("range exceeds 30 days");
    }
    let Some(total) = finite(snapshot.get("totalKeystrokes")) else {
        return Err("snapshot.totalKeystrokes must be a number");
    };
    if total < ANALYTICS_MIN_KEYSTROKES {
        return Err("keystrokes below threshold");
    }
    if !matches!(snapshot.get("keymapSnapshot"), Some(Value::Object(_))) {
        return Err("snapshot.keymapSnapshot must be an object");
    }
    if !matches!(snapshot.get("appScopes"), Some(Value::Array(_))) {
        return Err("snapshot.appScopes must be array");
    }
    Ok(AnalyticsIndex {
        product_name: product_name.to_owned(),
        keyboard_uid: uid.to_owned(),
        total_keystrokes: total,
        range_from_ms: from,
        range_to_ms: to,
    })
}

pub fn parse_analytics_export(raw: &str) -> Checked<AnalyticsIndex> {
    let parsed = match pipette_js_json::parse(raw) {
        Err(_) => return invalid("invalid JSON"),
        Ok(Value::Object(object)) => object,
        Ok(_) => return invalid("payload must be an object"),
    };
    if parsed.get("version") != Some(&Value::Number(1.0)) {
        return invalid("unsupported version");
    }
    if parsed.get("kind").and_then(Value::as_str) != Some("analytics") {
        return invalid("kind mismatch");
    }
    if parsed.get("exportedAt").and_then(Value::as_str).is_none_or(str::is_empty) {
        return invalid("exportedAt must be a non-empty string");
    }
    let index = snapshot_index(parsed.get("snapshot")).or_else(invalid)?;
    if !matches!(parsed.get("filters"), Some(Value::Object(_))) {
        return invalid("filters must be an object");
    }
    if let Some(err) = analytics_data_error(parsed.get("data"), "data") {
        return invalid(&err);
    }
    if let Some(app_data) = parsed.get("appData") {
        let Value::Object(apps) = app_data else { return invalid("appData must be an object") };
        for (app, slice) in apps.iter() {
            let app = app.to_string_lossy();
            if DANGEROUS_KEYS.contains(&app.as_ref()) {
                return invalid(&format!("forbidden key in appData: {app}"));
            }
            if let Some(err) = analytics_data_error(Some(slice), &format!("appData[\"{app}\"]")) {
                return invalid(&err);
            }
        }
    }
    Ok(index)
}

// --- Feature posts and private posts -------------------------------------------

const FEATURE_JSON_INSPECT_LIMIT: usize = 1024 * 1024;

/// A favorite export of version 3 needs a non-negative integer
/// `vial_protocol`; anything the Hub cannot read as JSON passes.
pub fn feature_json_error(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() > FEATURE_JSON_INSPECT_LIMIT {
        return None;
    }
    let Ok(Value::Object(parsed)) = pipette_js_json::parse(&String::from_utf8_lossy(bytes)) else {
        return None;
    };
    if parsed.get("version") != Some(&Value::Number(3.0)) {
        return None;
    }
    match finite(parsed.get("vial_protocol")) {
        Some(protocol) if protocol.fract() == 0.0 && protocol >= 0.0 => None,
        _ => Some("vial_protocol is required for FavoriteExportFile v3"),
    }
}

/// `expires_in_days` of a private upload: absent or empty is 180 days,
/// otherwise a plain digit string from 1 to 180. `Err` for a file part.
pub fn parse_expires_in_days(raw: Option<Result<&str, ()>>) -> Checked<i64> {
    const RANGE: &str = "expires_in_days must be an integer between 1 and 180";
    match raw {
        None | Some(Ok("")) => Ok(180),
        Some(Ok(text)) => {
            let trimmed = js_trim(text);
            if trimmed.is_empty() || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
                return Err(RANGE.to_owned());
            }
            match trimmed.parse::<i64>() {
                Ok(days) if (1..=180).contains(&days) => Ok(days),
                _ => Err(RANGE.to_owned()),
            }
        }
        Some(Err(())) => Err(RANGE.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_names_and_tokens_as_the_hub_does() {
        assert!(is_reserved_display_name("Admin"));
        assert!(is_reserved_display_name("pipette-bot"));
        assert!(is_reserved_display_name("\u{200B}ＲＯＯＴ"));
        assert!(!is_reserved_display_name("alice"));
        assert_eq!(normalize_display_name(Some("  Bob  ")).as_deref(), Some("Bob"));
        assert_eq!(normalize_display_name(Some(" ")), None);
        assert!(parse_test_id_token("test:no-at-sign").is_none());
        assert!(parse_test_id_token("test:a@other.com").is_none());
        assert_eq!(
            parse_test_id_token("test:Alice@Example.com").map(|id| id.email).as_deref(),
            Some("alice@example.com")
        );
        assert!(is_semver("1.0.0") && is_semver("1.2.3-beta.1") && !is_semver("1.0") && !is_semver("1.0.0-"));
        assert!(is_keycode_name("KC_A") && is_keycode_name("LT(1,KC_B)") && is_keycode_name("0x1F"));
        assert!(!is_keycode_name("bad key") && !is_keycode_name("LT(1,(KC_B))"));
        assert!(is_css_color("#abc") && is_css_color("rgb(10, 10, 10)") && !is_css_color("red"));
        assert_eq!(
            parse_expires_in_days(Some(Ok("0"))),
            Err("expires_in_days must be an integer between 1 and 180".to_owned())
        );
        assert_eq!(parse_expires_in_days(Some(Ok(" 7 "))), Ok(7));
        assert_eq!(parse_expires_in_days(None), Ok(180));
    }
}
