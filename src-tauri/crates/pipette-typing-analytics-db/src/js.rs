// SPDX-License-Identifier: GPL-2.0-or-later
//! The values the queries answer, as the JavaScript values the TypeScript
//! DB layer returns: every number a double, a SQL NULL `null`, and each row
//! an object whose keys are the statement's column aliases in their order,
//! as better-sqlite3 builds it. [`ToJs`] gives that value, which
//! `pipette_js_json::stringify` writes as the same JSON text, and writes
//! that text itself without building the value.

use pipette_js_json::{Object, Value, stringify, write_number, write_str};

pub trait ToJs {
    fn to_js(&self) -> Value;

    /// Appends `JSON.stringify` of [`ToJs::to_js`]. The rows and the lists
    /// of them write it directly, which a long answer needs: building the
    /// values and then stringifying them costs more than the reads.
    fn write_json(&self, out: &mut String) {
        out.push_str(&stringify(&self.to_js()));
    }
}

impl ToJs for f64 {
    fn to_js(&self) -> Value {
        Value::Number(*self)
    }

    fn write_json(&self, out: &mut String) {
        write_number(out, *self);
    }
}

impl ToJs for u32 {
    fn to_js(&self) -> Value {
        Value::Number(f64::from(*self))
    }

    fn write_json(&self, out: &mut String) {
        write_number(out, f64::from(*self));
    }
}

impl ToJs for String {
    fn to_js(&self) -> Value {
        Value::from(self.as_str())
    }

    fn write_json(&self, out: &mut String) {
        write_str(out, self);
    }
}

impl<T: ToJs> ToJs for Option<T> {
    fn to_js(&self) -> Value {
        self.as_ref().map_or(Value::Null, ToJs::to_js)
    }

    fn write_json(&self, out: &mut String) {
        match self {
            Some(value) => value.write_json(out),
            None => out.push_str("null"),
        }
    }
}

impl<T: ToJs> ToJs for [T] {
    fn to_js(&self) -> Value {
        Value::Array(self.iter().map(ToJs::to_js).collect())
    }

    fn write_json(&self, out: &mut String) {
        out.push('[');
        for (i, item) in self.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            item.write_json(out);
        }
        out.push(']');
    }
}

impl<T: ToJs, const N: usize> ToJs for [T; N] {
    fn to_js(&self) -> Value {
        self.as_slice().to_js()
    }

    fn write_json(&self, out: &mut String) {
        self.as_slice().write_json(out);
    }
}

impl<T: ToJs> ToJs for Vec<T> {
    fn to_js(&self) -> Value {
        self.as_slice().to_js()
    }

    fn write_json(&self, out: &mut String) {
        self.as_slice().write_json(out);
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
/// order of the fields. The keys are plain names, never array indexes (which
/// JavaScript would order first) and never text that needs an escape, so
/// [`ToJs::write_json`] writes each as it is.
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

            fn write_json(&self, out: &mut String) {
                let open = out.len();
                out.push('{');
                $(
                    if out.len() > open + 1 {
                        out.push(',');
                    }
                    out.push_str(concat!("\"", $key, "\":"));
                    $crate::js::ToJs::write_json(&self.$field, out);
                )+
                out.push('}');
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
