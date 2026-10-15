// SPDX-License-Identifier: GPL-2.0-or-later
//! The canonical text of SQLite values shared with the TypeScript fixture
//! generator (scripts/analytics-db-fixtures/canonical.ts): `n`, `i:<dec>`,
//! `r:<16 hex of the IEEE-754 bits>`, `t:<hex of UTF-8>`, `b:<hex>`; cells
//! joined by `|`, rows by `\n`.

#![allow(dead_code, clippy::unwrap_used)]

use std::fmt::Write as _;
use std::path::PathBuf;

use pipette_typing_analytics_db::{DATA_TABLE_NAMES, MinuteStatsRow};
use rusqlite::Connection;
use rusqlite::types::ValueRef;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Never committed: the benchmark input and the TypeScript timings.
pub fn bench_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/tmp/pipette-typing-analytics-db")
}

pub fn read_json(path: PathBuf) -> Value {
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&text).unwrap()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
        write!(s, "{b:02x}").unwrap();
        s
    })
}

pub fn real_cell(value: f64) -> String {
    format!("r:{:016x}", value.to_bits())
}

fn cell(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => "n".to_owned(),
        ValueRef::Integer(i) => format!("i:{i}"),
        ValueRef::Real(r) => real_cell(r),
        ValueRef::Text(t) => format!("t:{}", hex(t)),
        ValueRef::Blob(b) => format!("b:{}", hex(b)),
    }
}

pub struct TableDump {
    pub count: usize,
    pub sha256: String,
    pub rows: Vec<String>,
}

pub fn dump_table(conn: &Connection, table: &str) -> TableDump {
    let mut info = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap();
    let mut columns: Vec<(String, i64)> = info
        .query_map([], |r| Ok((r.get::<_, String>("name")?, r.get::<_, i64>("pk")?)))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    let names = columns.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>().join(", ");
    columns.retain(|(_, pk)| *pk > 0);
    columns.sort_by_key(|(_, pk)| *pk);
    let order = columns.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>().join(", ");
    let mut stmt = conn.prepare(&format!("SELECT {names} FROM {table} ORDER BY {order}")).unwrap();
    let width = stmt.column_count();
    let rows: Vec<String> = stmt
        .query_map([], |r| Ok((0..width).map(|i| cell(r.get_ref(i).unwrap())).collect::<Vec<_>>().join("|")))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    let sha256 = hex(&Sha256::digest(rows.join("\n").as_bytes()));
    TableDump { count: rows.len(), sha256, rows }
}

/// Every data table of `conn` against the expected `tables` object; the
/// first differing row is shown when the fixture holds the rows.
pub fn assert_tables(conn: &Connection, expected: &Value, label: &str) {
    for table in DATA_TABLE_NAMES {
        let want = &expected[table];
        let got = dump_table(conn, table);
        if let Some(rows) = want["rows"].as_array() {
            for (i, (g, w)) in got.rows.iter().zip(rows).enumerate() {
                assert_eq!(g, w.as_str().unwrap(), "{label}: {table} row {i}");
            }
        }
        assert_eq!(got.count as u64, want["count"].as_u64().unwrap(), "{label}: {table} count");
        assert_eq!(got.sha256, want["sha256"].as_str().unwrap(), "{label}: {table} digest");
    }
}

/// A query row the way the fixture holds it: alias → `n` or `r:` cell.
pub fn query_row_cells(row: &MinuteStatsRow) -> Value {
    let opt = |v: Option<f64>| v.map_or_else(|| "n".to_owned(), real_cell);
    json!({
        "minuteMs": real_cell(row.minute_ms),
        "keystrokes": real_cell(row.keystrokes),
        "activeMs": real_cell(row.active_ms),
        "intervalMinMs": opt(row.interval_min_ms),
        "intervalP25Ms": opt(row.interval_p25_ms),
        "intervalP50Ms": opt(row.interval_p50_ms),
        "intervalP75Ms": opt(row.interval_p75_ms),
        "intervalMaxMs": opt(row.interval_max_ms),
        "pollP50Ms": opt(row.poll_p50_ms),
        "pollP95Ms": opt(row.poll_p95_ms),
    })
}

pub fn strings(value: &Value) -> Vec<String> {
    value.as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect()
}

pub fn object(value: &Value) -> &Map<String, Value> {
    value.as_object().unwrap()
}
