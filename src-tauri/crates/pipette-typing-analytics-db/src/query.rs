// SPDX-License-Identifier: GPL-2.0-or-later
//! What the read statements share: the app / typing-test / run filters,
//! the device a query is narrowed to, and running a prepared statement
//! with named parameters.
//!
//! Every number is bound as a double, as better-sqlite3 binds a JavaScript
//! number, so a window bound or layer with a fraction compares the same.

use rusqlite::types::{FromSql, ToSql};
use rusqlite::{Connection, OptionalExtension, Row};

use crate::Error;

/// The app / typing-test / run filters of the Analyze view. An empty list
/// means no filter on that dimension.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScopeFilters {
    pub app_names: Vec<String>,
    pub typing_tests: Vec<String>,
    pub run_ids: Vec<String>,
}

/// The filters as the JSON arrays the statements read with `json_each`.
pub(crate) struct FilterJson {
    app_names: String,
    typing_tests: String,
    run_ids: String,
}

impl ScopeFilters {
    pub(crate) fn json(&self) -> Result<FilterJson, Error> {
        Ok(FilterJson {
            app_names: serde_json::to_string(&self.app_names)?,
            typing_tests: serde_json::to_string(&self.typing_tests)?,
            run_ids: serde_json::to_string(&self.run_ids)?,
        })
    }
}

/// The named parameters of one statement run.
pub(crate) type Params<'a> = Vec<(&'static str, &'a dyn ToSql)>;

impl FilterJson {
    pub(crate) fn add<'a>(&'a self, params: &mut Params<'a>) {
        params.push(("@appNamesJson", &self.app_names));
        params.push(("@typingTestsJson", &self.typing_tests));
        params.push(("@runIdsJson", &self.run_ids));
    }
}

/// The statement of a query that has one form for every device of the
/// keyboard and one for a single `machine_hash`, with `@machineHash`
/// added to `params` for the second.
pub(crate) fn for_device<'a>(
    machine_hash: Option<&'a &'a str>,
    every_device: &'static str,
    one_device: &'static str,
    params: &mut Params<'a>,
) -> &'static str {
    match machine_hash {
        Some(hash) => {
            params.push(("@machineHash", hash));
            one_device
        }
        None => every_device,
    }
}

/// Every row of a prepared statement, mapped.
pub(crate) fn all<T>(
    conn: &Connection,
    sql: &str,
    params: &[(&str, &dyn ToSql)],
    map: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, Error> {
    let mut stmt = conn.prepare_cached(sql)?;
    let rows = stmt.query_map(params, map)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The first row of a prepared statement, mapped, if there is one.
pub(crate) fn first<T>(
    conn: &Connection,
    sql: &str,
    params: &[(&str, &dyn ToSql)],
    map: impl FnOnce(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Option<T>, Error> {
    Ok(conn.prepare_cached(sql)?.query_row(params, map).optional()?)
}

/// Column `index` of `row`, which the statement names `name`. Reading by
/// index skips the search by name, which costs more than the value itself
/// on a long result; debug builds check the name.
pub(crate) fn column<T: FromSql>(row: &Row<'_>, index: usize, name: &str) -> rusqlite::Result<T> {
    debug_assert_eq!(row.as_ref().column_name(index)?, name, "column {index}");
    row.get(index)
}
