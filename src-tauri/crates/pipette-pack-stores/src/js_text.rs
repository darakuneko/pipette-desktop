// SPDX-License-Identifier: GPL-2.0-or-later
//! The name key the pack stores compare names by, with JavaScript's
//! `trim` and `toLowerCase` (pipette-entry-store).

use pipette_entry_store::{js_to_lower_case, trim_js_whitespace};
use pipette_js_json::Value;

/// `expr.trim().toLowerCase()` of a value that should be a string, or the
/// TypeError message `String(err)` gives when it is not: `expr` is the
/// expression V8 names in it.
pub fn folded_name(value: Option<&Value>, expr: &str) -> Result<Vec<u16>, String> {
    match value {
        Some(Value::String(s)) => Ok(js_to_lower_case(trim_js_whitespace(&s.utf16_units()))),
        None => Err("TypeError: Cannot read properties of undefined (reading 'trim')".to_owned()),
        Some(Value::Null) => Err("TypeError: Cannot read properties of null (reading 'trim')".to_owned()),
        Some(_) => Err(format!("TypeError: {expr}.trim is not a function")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_that_is_not_a_string_is_a_type_error() {
        assert_eq!(folded_name(Some(&" Ab ".into()), "name"), Ok("ab".encode_utf16().collect()));
        assert_eq!(
            folded_name(Some(&5.0.into()), "m.name"),
            Err("TypeError: m.name.trim is not a function".into())
        );
        assert_eq!(
            folded_name(None, "m.name"),
            Err("TypeError: Cannot read properties of undefined (reading 'trim')".into())
        );
    }
}
