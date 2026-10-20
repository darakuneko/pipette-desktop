// SPDX-License-Identifier: GPL-2.0-or-later
//! The local days against what JavaScript gave in each time zone: one
//! recorded fixture file per zone (tests/fixtures/local_days), each
//! replayed in a process
//! started with that zone's `TZ`.

// Helpers outside #[test] functions unwrap fixture data too.
#![allow(clippy::unwrap_used)]

use std::path::PathBuf;

use pipette_js_json::Value;
use pipette_time::test_util::in_each_time_zone;
use pipette_time::{local_date_ms, local_day_range_ms};

fn fixtures() -> Vec<Value> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/local_days");
    let mut paths: Vec<PathBuf> =
        std::fs::read_dir(&dir).unwrap().map(|entry| entry.unwrap().path()).collect();
    paths.sort();
    paths
        .iter()
        .map(|path| pipette_js_json::parse(&std::fs::read_to_string(path).unwrap()).unwrap())
        .collect()
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.as_object().and_then(|object| object.get(key)).unwrap_or_else(|| panic!("no {key}"))
}

fn ms(value: &Value) -> Option<i64> {
    match value {
        Value::Null => None,
        Value::Number(n) => Some(*n as i64),
        other => panic!("not a time: {other:?}"),
    }
}

fn array(value: &Value) -> &[Value] {
    match value {
        Value::Array(items) => items,
        other => panic!("not an array: {other:?}"),
    }
}

#[test]
fn local_days_match_javascript() {
    let fixtures = fixtures();
    let zones: Vec<&str> = fixtures.iter().map(|f| field(f, "timeZone").as_str().unwrap()).collect();
    assert_eq!(zones.len(), 5);
    let Some(zone) = in_each_time_zone("local_days_match_javascript", &zones) else { return };
    let fixture = fixtures.iter().find(|f| field(f, "timeZone").as_str() == Some(&zone)).unwrap();

    for case in array(field(fixture, "localDayRanges")) {
        let date = field(case, "date").as_str().unwrap();
        let expected = match field(case, "range") {
            Value::Null => None,
            range => Some((ms(field(range, "startMs")).unwrap(), ms(field(range, "endMs")).unwrap())),
        };
        assert_eq!(local_day_range_ms(date), expected, "{zone} {date:?}");
    }
    for case in array(field(fixture, "localDates")) {
        let part = |key| ms(field(case, key)).unwrap();
        let (year, month_index, day) = (part("year"), part("monthIndex"), part("day"));
        assert_eq!(
            local_date_ms(year, month_index, day),
            ms(field(case, "ms")),
            "{zone} new Date({year}, {month_index}, {day})"
        );
    }
}
