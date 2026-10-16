// SPDX-License-Identifier: GPL-2.0-or-later
//! The canonical text of SQLite values shared with the TypeScript fixture
//! generator (scripts/analytics-db-fixtures/canonical.ts): `n`, `i:<dec>`,
//! `r:<16 hex of the IEEE-754 bits>`, `t:<hex of UTF-8>`, `b:<hex>`; cells
//! joined by `|`, rows by `\n`.

#![allow(dead_code, clippy::unwrap_used)]

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use pipette_js_json::{Value as JsValue, write_number};
use pipette_typing_analytics_db::{
    AppAggregate, CharMinuteInput, DATA_TABLE_NAMES, DeleteRange, Gram, MatrixCounts, MatrixMinuteInput,
    MinuteStatsInput, MinuteStatsRow, ScopeFilters, ScopeInput, SessionInput, ToJs, TypingAnalyticsDb,
};
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Never committed: the benchmark input and the TypeScript timings, in
/// `<target>/tmp/pipette-typing-analytics-db`. The generator writes them to
/// the directory `BENCH_DIR` names (scripts/analytics-db-fixtures/paths.ts,
/// via `cargoTargetTmpDir` in scripts/fixture-files.ts) and both resolve
/// `<target>` the same way: `CARGO_TARGET_DIR` taken from the current
/// directory when set, otherwise the workspace's `target`. Read at run time
/// because the example that uses it gets no `CARGO_TARGET_TMPDIR`.
pub fn bench_dir() -> PathBuf {
    let target = match std::env::var_os("CARGO_TARGET_DIR") {
        Some(dir) => std::env::current_dir().unwrap().join(dir),
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target"),
    };
    target.join("tmp/pipette-typing-analytics-db")
}

/// A second, read-only connection to a database file, for dumping its
/// tables while the crate's own connection stays open.
pub fn open_read_only(path: &Path) -> Connection {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

/// Removes a database file and its WAL side files, if present.
pub fn remove_db(path: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
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

/// A returned JavaScript value in the canonical form of the method
/// fixtures (scripts/analytics-db-fixtures/db-methods.ts): a number as
/// `r:<bits>`, a string as `s:<text>`.
pub fn canonical(value: &JsValue) -> Value {
    match value {
        JsValue::Null => Value::Null,
        JsValue::Bool(b) => Value::Bool(*b),
        JsValue::Number(n) => Value::String(real_cell(*n)),
        JsValue::String(s) => Value::String(format!("s:{}", s.to_string_lossy())),
        JsValue::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        JsValue::Object(object) => Value::Object(
            object.iter().map(|(k, v)| (k.to_string_lossy().into_owned(), canonical(v))).collect(),
        ),
    }
}

/// A heatmap aggregate as the TypeScript side returns it: a Map keyed
/// `${row},${col}`, in canonical form the array of its entries.
fn matrix_counts(cells: &[MatrixCounts]) -> Value {
    Value::Array(
        cells
            .iter()
            .map(|cell| {
                let mut key = String::from("s:");
                write_number(&mut key, cell.row);
                key.push(',');
                write_number(&mut key, cell.col);
                let counts = json!({
                    "total": real_cell(cell.total),
                    "tap": real_cell(cell.tap),
                    "hold": real_cell(cell.hold),
                });
                json!([key, counts])
            })
            .collect(),
    )
}

/// The positional arguments of a recorded call.
struct Args<'a>(&'a [Value]);

impl Args<'_> {
    fn str(&self, i: usize) -> &str {
        self.0[i].as_str().unwrap_or_else(|| panic!("argument {i} is not a string"))
    }
    fn num(&self, i: usize) -> f64 {
        self.0[i].as_f64().unwrap_or_else(|| panic!("argument {i} is not a number"))
    }
    fn int(&self, i: usize) -> i64 {
        self.0[i].as_i64().unwrap_or_else(|| panic!("argument {i} is not an integer"))
    }
    /// A string, or `None` for null or a missing argument.
    fn opt_str(&self, i: usize) -> Option<&str> {
        self.0.get(i).and_then(Value::as_str)
    }
    /// A list of strings; a missing argument is the empty list.
    fn strings(&self, i: usize) -> Vec<String> {
        self.0.get(i).filter(|v| !v.is_null()).map(strings).unwrap_or_default()
    }
    fn filters(&self, from: usize) -> ScopeFilters {
        ScopeFilters {
            app_names: self.strings(from),
            typing_tests: self.strings(from + 1),
            run_ids: self.strings(from + 2),
        }
    }
    fn parse<T: serde::de::DeserializeOwned>(&self, i: usize) -> T {
        serde_json::from_value(self.0[i].clone()).unwrap()
    }
}

/// [`ToJs::to_js`], checking that [`ToJs::write_json`] writes the same text
/// as stringifying it.
trait CheckedJs {
    fn checked_js(&self) -> JsValue;
}

impl<T: ToJs + ?Sized> CheckedJs for T {
    fn checked_js(&self) -> JsValue {
        let value = self.to_js();
        let mut text = String::new();
        self.write_json(&mut text);
        assert_eq!(text, pipette_js_json::stringify(&value));
        value
    }
}

/// Runs a call recorded by the method fixtures on `db`, by its TypeScript
/// method name and arguments, and returns its answer in canonical form.
pub fn run_call(db: &mut TypingAnalyticsDb, method: &str, args: &[Value]) -> Value {
    let a = Args(args);
    // `…ForUidAndHash` takes the hash after the uid; `…ForUid` reads every
    // device.
    let (hash, rest) = if method.ends_with("AndHash") { (Some(a.str(1).to_owned()), 2) } else { (None, 1) };
    let hash = hash.as_deref();
    let base = method.trim_end_matches("AndHash");
    let js = match base {
        "listLocalKeyboardUids" => db.local_keyboard_uids(a.str(0)).unwrap().checked_js(),
        "listKeyboardsWithTypingData" => db.keyboards_with_typing_data().unwrap().checked_js(),
        "listRemoteDeviceInfosForUid" => db.remote_device_infos(a.str(0), a.str(1)).unwrap().checked_js(),
        "aggregateMatrixCountsForUid" => {
            return matrix_counts(&db.matrix_counts_since(a.str(0), a.str(1), a.num(2), a.num(3)).unwrap());
        }
        "aggregateMatrixCountsForUidInRange" => {
            let cells = db
                .matrix_counts_in_range(a.str(0), a.opt_str(4), a.num(1), a.num(2), a.num(3), &a.filters(5))
                .unwrap();
            return matrix_counts(&cells);
        }
        "listDailySummariesForUid" => {
            db.daily_summaries(a.str(0), hash, &a.filters(rest)).unwrap().checked_js()
        }
        "listIntervalSummariesForUid" => db.interval_summaries(a.str(0), hash).unwrap().checked_js(),
        "listActivityGridForUid" => db
            .activity_grid(a.str(0), hash, a.num(rest), a.num(rest + 1), &a.filters(rest + 2))
            .unwrap()
            .checked_js(),
        "listLayerUsageForUid" => db
            .layer_usage(a.str(0), hash, a.num(rest), a.num(rest + 1), &a.filters(rest + 2))
            .unwrap()
            .checked_js(),
        "listMatrixCellsForUid" => db
            .matrix_cells(a.str(0), hash, a.num(rest), a.num(rest + 1), &a.filters(rest + 2))
            .unwrap()
            .checked_js(),
        "listMatrixDurationCellsForUid" => db
            .matrix_duration_cells(a.str(0), hash, a.num(rest), a.num(rest + 1), &a.filters(rest + 2))
            .unwrap()
            .checked_js(),
        "listMatrixCellsByDayForUid" => db
            .matrix_cells_by_day(a.str(0), hash, a.num(rest), a.num(rest + 1), &a.filters(rest + 2))
            .unwrap()
            .checked_js(),
        "listMinuteStatsInRangeForUid" => db
            .minute_stats_in_range(a.str(0), hash, a.num(rest), a.num(rest + 1), &a.filters(rest + 2))
            .unwrap()
            .checked_js(),
        "listSessionsInRangeForUid" => {
            db.sessions_in_range(a.str(0), hash, a.num(rest), a.num(rest + 1)).unwrap().checked_js()
        }
        "listBksMinuteInRangeForUid" => db
            .backspace_minutes(a.str(0), hash, a.num(rest), a.num(rest + 1), &a.filters(rest + 2))
            .unwrap()
            .checked_js(),
        "getPeakRecordsInRangeForUid" => db
            .peak_records(a.str(0), hash, a.num(rest), a.num(rest + 1), &a.filters(rest + 2))
            .unwrap()
            .checked_js(),
        "listNgramMinutesInRangeForUid" => {
            // The gram comes first, so the uid and hash move one along.
            let gram = if a.num(0) == 2.0 { Gram::Bigram } else { Gram::Trigram };
            let (hash, rest) = if method.ends_with("AndHash") { (Some(a.str(2)), 3) } else { (None, 2) };
            db.ngram_minutes_in_range(
                gram,
                a.str(1),
                hash,
                a.num(rest),
                a.num(rest + 1),
                &a.filters(rest + 2),
            )
            .unwrap()
            .checked_js()
        }
        "listRolloverMinutesInRange" => db
            .rollover_minutes(a.str(0), a.opt_str(1), a.num(2), a.num(3), &a.filters(4))
            .unwrap()
            .checked_js(),
        "listAppsForUidInRange"
        | "listTypingTestsForUidInRange"
        | "getAppUsageForUidInRange"
        | "getWpmByAppForUidInRange" => {
            let aggregate = match base {
                "listAppsForUidInRange" => AppAggregate::Apps,
                "listTypingTestsForUidInRange" => AppAggregate::TypingTests,
                "getAppUsageForUidInRange" => AppAggregate::AppUsage,
                _ => AppAggregate::WpmByApp,
            };
            db.app_aggregate(aggregate, a.str(0), a.opt_str(1), a.num(2), a.num(3)).unwrap().checked_js()
        }
        "listTypingTestRunsForUidInRange" => db
            .typing_test_runs(a.str(0), a.opt_str(1), a.num(2), a.num(3), &a.strings(4))
            .unwrap()
            .checked_js(),
        "upsertScope" => {
            db.upsert_scope(&a.parse::<ScopeInput>(0)).unwrap();
            JsValue::Null
        }
        "writeMinute" => {
            let stats: MinuteStatsInput = a.parse(0);
            let chars: Vec<CharMinuteInput> = a.parse(1);
            let matrix: Vec<MatrixMinuteInput> = a.parse(2);
            db.write_minute(&stats, &chars, &matrix, a.num(3)).unwrap();
            JsValue::Null
        }
        "insertSession" => {
            db.insert_session(&a.parse::<SessionInput>(0), a.num(1)).unwrap();
            JsValue::Null
        }
        "retainOwnData" => {
            db.retain_own_data(a.str(0), a.num(1)).unwrap();
            JsValue::Null
        }
        "tombstoneRowsForUidHashInRanges" => {
            let ranges: Vec<DeleteRange> = a.0[2]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| DeleteRange {
                    start_ms: r["startMs"].as_i64().unwrap(),
                    end_ms: r["endMs"].as_i64().unwrap(),
                    cutoff_ms: r["cutoffMs"].as_i64().unwrap(),
                })
                .collect();
            db.tombstone_ranges_for_uid_hash(a.str(0), a.str(1), &ranges, a.int(3)).unwrap().checked_js()
        }
        "tombstoneAllRowsForUidHash" => {
            db.tombstone_all_for_uid_hash(a.str(0), a.str(1), a.int(2)).unwrap().checked_js()
        }
        "tombstoneAllRowsForUid" => db.tombstone_all_for_uid(a.str(0), a.int(1)).unwrap().checked_js(),
        "truncateCache" => {
            db.truncate_cache().unwrap();
            JsValue::Null
        }
        other => panic!("no Rust call for {other}"),
    };
    canonical(&js)
}
