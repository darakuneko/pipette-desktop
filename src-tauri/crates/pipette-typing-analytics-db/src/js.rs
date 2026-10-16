// SPDX-License-Identifier: GPL-2.0-or-later
//! The values the queries answer, as the JavaScript values the TypeScript
//! DB layer returns: every number a double, a SQL NULL `null`, and each row
//! an object whose keys are the statement's column aliases in their order,
//! as better-sqlite3 builds it. [`ToJs`] gives that value, which
//! `pipette_js_json::stringify` writes as the same JSON text.

use pipette_js_json::{Object, Value};

pub trait ToJs {
    fn to_js(&self) -> Value;
}

impl ToJs for f64 {
    fn to_js(&self) -> Value {
        Value::Number(*self)
    }
}

impl ToJs for u32 {
    fn to_js(&self) -> Value {
        Value::Number(f64::from(*self))
    }
}

impl ToJs for String {
    fn to_js(&self) -> Value {
        Value::from(self.as_str())
    }
}

impl<T: ToJs> ToJs for Option<T> {
    fn to_js(&self) -> Value {
        self.as_ref().map_or(Value::Null, ToJs::to_js)
    }
}

impl<T: ToJs> ToJs for [T] {
    fn to_js(&self) -> Value {
        Value::Array(self.iter().map(ToJs::to_js).collect())
    }
}

impl<T: ToJs, const N: usize> ToJs for [T; N] {
    fn to_js(&self) -> Value {
        self.as_slice().to_js()
    }
}

impl<T: ToJs> ToJs for Vec<T> {
    fn to_js(&self) -> Value {
        self.as_slice().to_js()
    }
}

/// An object of `(key, value)` pairs in that order.
pub(crate) fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    let mut out = Object::with_capacity(N);
    for (key, value) in fields {
        out.insert(key, value);
    }
    out.into()
}

/// A struct whose [`ToJs`] value is an object with the given keys, in the
/// order of the fields.
macro_rules! js_object {
    (
        $(#[$meta:meta])*
        pub struct $name:ident {
            $($(#[$field_meta:meta])* $field:ident: $ty:ty => $key:literal,)+
        }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq)]
        pub struct $name {
            $($(#[$field_meta])* pub $field: $ty,)+
        }

        impl $crate::js::ToJs for $name {
            fn to_js(&self) -> pipette_js_json::Value {
                $crate::js::object([$(($key, $crate::js::ToJs::to_js(&self.$field)),)+])
            }
        }
    };
}

/// [`js_object!`] for a row read straight from a statement whose columns
/// are the fields, in order, with the keys as their aliases.
macro_rules! sql_row {
    (
        $(#[$meta:meta])*
        pub struct $name:ident {
            $($(#[$field_meta:meta])* $field:ident: $ty:ty => $key:literal,)+
        }
    ) => {
        js_object! {
            $(#[$meta])*
            pub struct $name {
                $($(#[$field_meta])* $field: $ty => $key,)+
            }
        }

        impl $name {
            /// The fields are the statement's columns in order.
            pub(crate) fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
                let mut column = 0..;
                Ok(Self { $($field: $crate::query::column(row, column.next().unwrap_or_default(), $key)?,)+ })
            }
        }
    };
}

pub(crate) use {js_object, sql_row};
