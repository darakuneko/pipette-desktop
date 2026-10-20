// SPDX-License-Identifier: GPL-2.0-or-later
//! The check of a theme pack (`validateThemePack` of
//! src/shared/theme/validate.ts), with the same errors, warnings and
//! header. The page runs that check before it calls the backend; the store
//! runs this one too, so a pack that reaches the backend some other way is
//! refused. The color values end up in
//! CSS custom properties, so only hex colors and `rgb()` / `hsl()` forms
//! pass.
//!
//! The patterns of validate.ts are matched by hand on UTF-16 code units
//! with JavaScript's meaning (`\d` and `\w` are ASCII, `/i` folds ASCII
//! only, `$` is the end of the text).

use pipette_entry_store::{js_trim, utf16_len};
use pipette_js_json::{JsString, Object, Value};

/// `THEME_PACK_LIMITS.MAX_NAME_LENGTH` (src/shared/types/theme-store.ts):
/// the longest pack name (UTF-16 units). The validator's fixture records the
/// TypeScript value and its test checks this one against it.
pub const MAX_NAME_LENGTH: usize = 64;

/// `THEME_COLOR_KEYS`: the colors every pack has.
pub const THEME_COLOR_KEYS: [&str; 35] = [
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

/// `OPTIONAL_THEME_COLOR_KEYS`: the colors a pack may leave out.
pub const OPTIONAL_THEME_COLOR_KEYS: [&str; 3] = ["key-label-simulated", "wire-row", "wire-col"];

const DANGEROUS_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// What the check found: `ok` is no errors, and only then is there a
/// header (the name and version, trimmed).
#[derive(Clone, Debug, PartialEq)]
pub struct ThemeCheck {
    pub errors: Vec<JsString>,
    pub warnings: Vec<JsString>,
    pub header: Option<(JsString, JsString)>,
}

impl ThemeCheck {
    pub fn ok(&self) -> bool {
        self.errors.is_empty()
    }

    /// The errors as the store answers them, `errors.join('; ')`.
    pub fn joined_errors(&self) -> JsString {
        let mut units = Vec::new();
        for (i, error) in self.errors.iter().enumerate() {
            if i > 0 {
                units.extend("; ".encode_utf16());
            }
            units.extend(error.utf16_units());
        }
        JsString::from_utf16(units)
    }
}

/// A piece of a message: text, or a string of the pack, which may hold a
/// lone surrogate.
pub(crate) enum Part<'a> {
    T(&'a str),
    J(&'a JsString),
}

pub(crate) fn message(parts: &[Part<'_>]) -> JsString {
    let mut units = Vec::new();
    for part in parts {
        match part {
            Part::T(text) => units.extend(text.encode_utf16()),
            Part::J(string) => units.extend(string.utf16_units()),
        }
    }
    JsString::from_utf16(units)
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

fn is_digit(unit: u16) -> bool {
    (u16::from(b'0')..=u16::from(b'9')).contains(&unit)
}

pub(crate) fn is_word(unit: u16) -> bool {
    u8::try_from(unit).is_ok_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// `/^\d+\.\d+\.\d+(-[\w.]+)?$/`.
pub(crate) fn is_semver(units: &[u16]) -> bool {
    let mut at = 0;
    for part in 0..3 {
        let start = at;
        while at < units.len() && is_digit(units[at]) {
            at += 1;
        }
        if at == start {
            return false;
        }
        if part < 2 {
            if units.get(at) != Some(&u16::from(b'.')) {
                return false;
            }
            at += 1;
        }
    }
    match units.get(at) {
        None => true,
        Some(&dash) if dash == u16::from(b'-') => {
            let rest = &units[at + 1..];
            !rest.is_empty() && rest.iter().all(|&unit| is_word(unit) || unit == u16::from(b'.'))
        }
        Some(_) => false,
    }
}

/// `validateVersion`.
fn version_error(value: Option<&Value>) -> Option<&'static str> {
    let Some(Value::String(version)) = value else { return Some("version must be a string") };
    (!is_semver(&js_trim(version).utf16_units())).then_some("version must be a valid semver (e.g. 1.0.0)")
}

/// `/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/`.
fn is_hex_color(units: &[u16]) -> bool {
    let Some((&hash, digits)) = units.split_first() else { return false };
    hash == u16::from(b'#')
        && matches!(digits.len(), 3 | 4 | 6 | 8)
        && digits.iter().all(|&unit| u8::try_from(unit).is_ok_and(|byte| byte.is_ascii_hexdigit()))
}

/// `/^(?:rgb|hsl)a?\([^)]+\)$/i`.
fn is_css_function_color(units: &[u16]) -> bool {
    let lower = |unit: u16| u8::try_from(unit).map(|byte| byte.to_ascii_lowercase()).ok();
    let prefix: Option<Vec<u8>> = units.iter().take(3).map(|&unit| lower(unit)).collect();
    if !matches!(prefix.as_deref(), Some(b"rgb" | b"hsl")) {
        return false;
    }
    let mut rest = &units[3..];
    if rest.first().is_some_and(|&unit| lower(unit) == Some(b'a')) {
        rest = &rest[1..];
    }
    let close = u16::from(b')');
    let Some((&open, inner)) = rest.split_first() else { return false };
    let Some((&last, middle)) = inner.split_last() else { return false };
    open == u16::from(b'(') && last == close && !middle.is_empty() && !middle.contains(&close)
}

fn is_css_color(value: &JsString) -> bool {
    let units = value.utf16_units();
    is_hex_color(&units) || is_css_function_color(&units)
}

fn dangerous(key: &JsString) -> bool {
    DANGEROUS_KEYS.iter().any(|&dangerous| key.as_str() == Some(dangerous))
}

fn known(key: &JsString) -> bool {
    THEME_COLOR_KEYS.iter().chain(&OPTIONAL_THEME_COLOR_KEYS).any(|&known| key.as_str() == Some(known))
}

/// Checks the pack `raw` (`None` is `undefined`) as `validateThemePack`
/// does.
pub fn validate_theme_pack(raw: Option<&Value>) -> ThemeCheck {
    let mut check = ThemeCheck { errors: Vec::new(), warnings: Vec::new(), header: None };
    let Some(Value::Object(pack)) = raw else {
        check.errors.push("Theme pack must be a JSON object".into());
        return check;
    };
    for key in pack.keys().filter(|key| dangerous(key)) {
        check.errors.push(message(&[
            Part::T("Dangerous key \""),
            Part::J(key),
            Part::T("\" is not allowed"),
        ]));
    }
    if let Some(error) = name_error(pack.get("name")) {
        check.errors.push(error.as_str().into());
    }
    if let Some(error) = version_error(pack.get("version")) {
        check.errors.push(error.into());
    }
    if !matches!(pack.get("colorScheme"), Some(Value::String(s)) if s.as_str().is_some_and(|s| s == "light" || s == "dark"))
    {
        check.errors.push("colorScheme must be exactly \"light\" or \"dark\"".into());
    }
    let Some(Value::Object(colors)) = pack.get("colors") else {
        check.errors.push("colors must be an object".into());
        return check;
    };
    check_colors(colors, &mut check);
    if check.ok() {
        let header = |key: &str| match pack.get(key) {
            Some(Value::String(s)) => js_trim(s),
            _ => JsString::from(""),
        };
        check.header = Some((header("name"), header("version")));
    }
    check
}

fn check_colors(colors: &Object, check: &mut ThemeCheck) {
    for key in colors.keys().filter(|key| dangerous(key)) {
        check.errors.push(message(&[
            Part::T("Dangerous key \"colors."),
            Part::J(key),
            Part::T("\" is not allowed"),
        ]));
    }
    for required in THEME_COLOR_KEYS.iter().filter(|key| !colors.contains_key(key)) {
        check.errors.push(format!("Missing required color: \"{required}\"").as_str().into());
    }
    for key in colors.keys().filter(|key| !known(key)) {
        check.warnings.push(message(&[
            Part::T("Unknown color key \""),
            Part::J(key),
            Part::T("\" will be ignored"),
        ]));
    }
    for key in THEME_COLOR_KEYS.iter().chain(&OPTIONAL_THEME_COLOR_KEYS) {
        match colors.get(key) {
            None => {}
            Some(Value::String(value)) if is_css_color(value) => {}
            Some(Value::String(value)) => check.errors.push(message(&[
                Part::T("Color \""),
                Part::T(key),
                Part::T("\" has invalid CSS color value: \""),
                Part::J(value),
                Part::T("\""),
            ])),
            Some(_) => check.errors.push(format!("Color \"{key}\" must be a string").as_str().into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn the_patterns_match_as_the_javascript_ones() {
        for ok in ["1.0.0", "10.20.30", "1.0.0-beta.1", "1.0.0-a_b"] {
            assert!(is_semver(&units(ok)), "{ok}");
        }
        for bad in ["1", "1.0", "v1.0.0", "1.0.0-", "1.0.0-a b", "1.0.0\n", "１.0.0", "1..0", "1.0.0-ü"] {
            assert!(!is_semver(&units(bad)), "{bad}");
        }
        for ok in ["#fff", "#FFFF", "#a1b2c3", "#a1b2c3d4", "rgb(1,2,3)", "RGBA(1 2 3 / .5)", "hsl(a\nb)"] {
            assert!(is_css_color(&ok.into()), "{ok}");
        }
        for bad in [
            "red",
            "#12",
            "#12345",
            "#1234567",
            "#ggg",
            "rgb()",
            "rgb(1,2,3",
            "rgb(1)(2)",
            " #fff",
            "rgbaa(1)",
        ] {
            assert!(!is_css_color(&bad.into()), "{bad}");
        }
    }
}
