// SPDX-License-Identifier: GPL-2.0-or-later
//! The `{success, …}` objects the store handlers of the Electron build
//! answer, as JSON text written by `pipette_js_json`, so the entries'
//! fields this build does not know reach the renderer as `JSON.stringify`
//! writes them: the flat form of the favorite and snapshot stores
//! ([`response_json`]), and the `{success, data?, errorCode?, error?}`
//! form of the key label and pack stores ([`coded_response`]).

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

/// A failure of the stores whose answers carry an `errorCode`: the code
/// and the `error` text.
pub type CodedError = (&'static str, String);

/// `{"success":true}` with `data` when there is one, or
/// `{"success":false,"errorCode":…,"error":…}`.
pub fn coded_response(result: Result<Option<Value>, CodedError>) -> Object {
    let mut response = Object::new();
    match result {
        Ok(data) => {
            response.insert("success", true.into());
            if let Some(data) = data {
                response.insert("data", data);
            }
        }
        Err((code, error)) => {
            response.insert("success", false.into());
            response.insert("errorCode", code.into());
            response.insert("error", error.into());
        }
    }
    response
}

/// [`coded_response`] as JSON text.
pub fn coded_response_json(result: Result<Option<Value>, CodedError>) -> String {
    pipette_js_json::stringify(&Value::Object(coded_response(result)))
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
    fn coded_responses_carry_the_data_or_the_code_and_error() {
        assert_eq!(coded_response_json(Ok(None)), r#"{"success":true}"#);
        assert_eq!(coded_response_json(Ok(Some(true.into()))), r#"{"success":true,"data":true}"#);
        assert_eq!(
            coded_response_json(Err(("NOT_FOUND", "Invalid id".to_owned()))),
            r#"{"success":false,"errorCode":"NOT_FOUND","error":"Invalid id"}"#
        );
    }

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
