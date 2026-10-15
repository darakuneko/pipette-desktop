// SPDX-License-Identifier: GPL-2.0-or-later
//! The `{success, …}` object the store handlers of the Electron build
//! answer, as JSON text written by `pipette_js_json`, so the entries'
//! fields this build does not know reach the renderer as `JSON.stringify`
//! writes them.

use std::fmt::Display;

use pipette_js_json::{Object, Value};

/// `{"success":true}` followed by the fields of `result`, or
/// `{"success":false,"error":…}` with the error's text.
pub fn response_json<E: Display>(result: Result<Object, E>) -> String {
    let mut response = Object::new();
    match result {
        Ok(fields) => {
            response.insert("success", true.into());
            for (key, value) in fields.iter() {
                response.insert(key.clone(), value.clone());
            }
        }
        Err(err) => {
            response.insert("success", false.into());
            response.insert("error", err.to_string().into());
        }
    }
    pipette_js_json::stringify(&Value::Object(response))
}

/// The one field `key` of a response.
pub fn field(key: &str, value: impl Into<Value>) -> Object {
    std::iter::once((key, value.into())).collect()
}

/// The answer of an operation that answers no field.
pub fn done<E>(result: Result<(), E>) -> Result<Object, E> {
    result.map(|()| Object::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn responses_carry_the_fields_or_the_error() {
        assert_eq!(response_json(done::<&str>(Ok(()))), r#"{"success":true}"#);
        assert_eq!(response_json::<&str>(Ok(field("data", "x"))), r#"{"success":true,"data":"x"}"#);
        assert_eq!(
            response_json(Err::<Object, _>("max entries reached")),
            r#"{"success":false,"error":"max entries reached"}"#
        );
    }
}
