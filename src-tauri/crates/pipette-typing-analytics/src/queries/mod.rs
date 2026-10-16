// SPDX-License-Identifier: GPL-2.0-or-later
//! The query layer between the commands and the database: the Analyze and
//! Data modal IPC handlers (typing-analytics-ipc-analyze.ts, the cache
//! readers of typing-analytics-service.ts) and the range aggregates
//! (typing-analytics-ipc-range.ts), each a [`Query`] answering the
//! handler's arguments with the handler's value.
//!
//! The arguments arrive as the JavaScript values the renderer sent, in the
//! handler's order, and go through the handler's own checks: an argument
//! of the wrong type gets the handler's answer for it (an empty list, an
//! empty object, null, the empty peak records), never a failure.

mod analyze;
mod range;

use std::path::Path;

use pipette_entry_store::is_js_whitespace;
use pipette_js_json::Value;
use pipette_typing_analytics_db::{ScopeFilters, TypingAnalyticsDb};

pub use analyze::local_device_days;

/// The devices a `List*` / `Get*` member of the Analyze family reads: the
/// plain member every device, `…Local` this device, `…ForHash` the device
/// of its second argument.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Devices {
    All,
    Own,
    ForHash,
}

/// The Analyze reads that come in the three [`Devices`] forms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    /// `ListItems*`: the daily summaries.
    Items,
    /// `ListIntervalItems*`.
    IntervalItems,
    ActivityGrid,
    LayerUsage,
    MatrixCells,
    MatrixCellsByDay,
    MinuteStats,
    Sessions,
    BksMinute,
    PeakRecords,
}

/// One IPC member that reads the cache.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Query {
    ListKeyboards,
    Analyze(Family, Devices),
    GetMatrixHeatmap,
    ListDeviceInfos,
    ListAppsForRange,
    ListTypingTestsForRange,
    ListTypingTestRunsForRange,
    GetAppUsageForRange,
    GetWpmByAppForRange,
    GetMatrixHeatmapForRange,
    GetBigramAggregateForRange,
    ListRolloverMinutes,
    ListDurationCells,
    GetLayoutComparisonForRange,
}

const FAMILIES: [(&str, Family); 10] = [
    ("ListItems", Family::Items),
    ("ListIntervalItems", Family::IntervalItems),
    ("ListActivityGrid", Family::ActivityGrid),
    ("ListLayerUsage", Family::LayerUsage),
    ("ListMatrixCells", Family::MatrixCells),
    ("ListMatrixCellsByDay", Family::MatrixCellsByDay),
    ("ListMinuteStats", Family::MinuteStats),
    ("ListSessions", Family::Sessions),
    ("ListBksMinute", Family::BksMinute),
    ("GetPeakRecords", Family::PeakRecords),
];

impl Query {
    /// The query of a VialAPI member (`typingAnalyticsListItemsLocal`, …).
    pub fn from_member(member: &str) -> Option<Self> {
        let name = member.strip_prefix("typingAnalytics")?;
        let single = match name {
            "ListKeyboards" => Some(Self::ListKeyboards),
            "GetMatrixHeatmap" => Some(Self::GetMatrixHeatmap),
            "ListDeviceInfos" => Some(Self::ListDeviceInfos),
            "ListAppsForRange" => Some(Self::ListAppsForRange),
            "ListTypingTestsForRange" => Some(Self::ListTypingTestsForRange),
            "ListTypingTestRunsForRange" => Some(Self::ListTypingTestRunsForRange),
            "GetAppUsageForRange" => Some(Self::GetAppUsageForRange),
            "GetWpmByAppForRange" => Some(Self::GetWpmByAppForRange),
            "GetMatrixHeatmapForRange" => Some(Self::GetMatrixHeatmapForRange),
            "GetBigramAggregateForRange" => Some(Self::GetBigramAggregateForRange),
            "ListRolloverMinutes" => Some(Self::ListRolloverMinutes),
            "ListDurationCells" => Some(Self::ListDurationCells),
            "GetLayoutComparisonForRange" => Some(Self::GetLayoutComparisonForRange),
            _ => None,
        };
        single.or_else(|| {
            let (base, devices) = if let Some(base) = name.strip_suffix("Local") {
                (base, Devices::Own)
            } else if let Some(base) = name.strip_suffix("ForHash") {
                (base, Devices::ForHash)
            } else {
                (name, Devices::All)
            };
            FAMILIES.iter().find(|(n, _)| *n == base).map(|&(_, family)| Self::Analyze(family, devices))
        })
    }

    /// The handler's answer to `args` on the cache of `cx`.
    pub fn answer(self, args: &[Value], cx: &Context<'_>) -> Result<Value, crate::Error> {
        let args = Args(args);
        match self {
            Self::ListKeyboards => Ok(js(cx.db.keyboards_with_typing_data()?)),
            Self::Analyze(family, devices) => analyze::family(family, devices, args, cx),
            Self::GetMatrixHeatmap => analyze::matrix_heatmap(args, cx),
            Self::ListDeviceInfos => analyze::device_infos(args, cx),
            Self::ListAppsForRange
            | Self::ListTypingTestsForRange
            | Self::GetAppUsageForRange
            | Self::GetWpmByAppForRange
            | Self::ListTypingTestRunsForRange => range::app_range(self, args, cx),
            Self::GetMatrixHeatmapForRange => range::matrix_heatmap(args, cx),
            Self::GetBigramAggregateForRange => range::bigram_aggregate(args, cx),
            Self::ListRolloverMinutes => range::rollover_minutes(args, cx),
            Self::ListDurationCells => range::duration_cells(args, cx),
            Self::GetLayoutComparisonForRange => range::layout_comparison(args, cx),
        }
    }
}

/// What the queries read besides their arguments.
pub struct Context<'a> {
    pub db: &'a TypingAnalyticsDb,
    pub user_data: &'a Path,
    pub own_hash: &'a str,
    /// `os.platform()` and `os.release()` of this device.
    pub os_platform: &'a str,
    pub os_release: &'a str,
}

fn js(value: impl pipette_typing_analytics_db::ToJs) -> Value {
    value.to_js()
}

fn empty_list() -> Value {
    Value::Array(Vec::new())
}

/// The handler's positional arguments; a missing one is undefined, which
/// every check treats as null does.
#[derive(Clone, Copy)]
struct Args<'a>(&'a [Value]);

impl<'a> Args<'a> {
    fn get(self, index: usize) -> &'a Value {
        self.0.get(index).unwrap_or(&Value::Null)
    }

    /// A non-empty string (`typeof v === 'string' && v.length > 0`).
    fn text(self, index: usize) -> Option<&'a str> {
        match self.get(index) {
            Value::String(s) if !s.is_empty() => s.as_str(),
            _ => None,
        }
    }

    /// A finite number.
    fn finite(self, index: usize) -> Option<f64> {
        match self.get(index) {
            Value::Number(n) if n.is_finite() => Some(*n),
            _ => None,
        }
    }

    /// The lower bound of an Analyze window: a finite number from 0 up, or
    /// 0.
    fn since(self, index: usize) -> f64 {
        self.finite(index).filter(|&n| n >= 0.0).unwrap_or(0.0)
    }

    /// The upper bound of an Analyze window: a finite number above `since`,
    /// or `Number.MAX_SAFE_INTEGER`.
    fn until(self, index: usize, since: f64) -> f64 {
        const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
        self.finite(index).filter(|&n| n > since).unwrap_or(MAX_SAFE_INTEGER)
    }

    /// `normalizeAppScopes` of the argument.
    fn scopes(self, index: usize) -> Vec<String> {
        normalize_app_scopes(self.get(index))
    }

    /// The app / typing-test / run filter lists at `index` and the two after.
    fn filters(self, index: usize) -> ScopeFilters {
        ScopeFilters {
            app_names: self.scopes(index),
            typing_tests: self.scopes(index + 1),
            run_ids: self.scopes(index + 2),
        }
    }
}

/// `normalizeAppScopes` (src/shared/types/analyze-filters.ts): the string
/// elements of a list trimmed as JavaScript trims, the empty ones and
/// repeats left out, in order. Anything that is not a list has none.
pub fn normalize_app_scopes(value: &Value) -> Vec<String> {
    let Value::Array(items) = value else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    for item in items.iter().filter_map(Value::as_str) {
        let trimmed = item.trim_matches(|c: char| u16::try_from(u32::from(c)).is_ok_and(is_js_whitespace));
        if !trimmed.is_empty() && !out.iter().any(|seen| seen == trimmed) {
            out.push(trimmed.to_owned());
        }
    }
    out
}

/// `DeviceScope` as `parseDeviceScope` (analyze-filters.ts) reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum DeviceScope {
    Own,
    All,
    Hash(String),
}

impl DeviceScope {
    fn parse(value: &Value) -> Option<Self> {
        match value {
            Value::String(s) if s == "own" => Some(Self::Own),
            Value::String(s) if s == "all" => Some(Self::All),
            Value::Object(o) => {
                let kind_is_hash = matches!(o.get("kind"), Some(Value::String(k)) if k == "hash");
                match o.get("machineHash") {
                    Some(Value::String(hash)) if kind_is_hash && !hash.is_empty() => {
                        hash.as_str().map(|hash| Self::Hash(hash.to_owned()))
                    }
                    _ => None,
                }
            }
            _ => None,
        }
    }

    /// The device hash a read is narrowed to; `None` for every device.
    fn machine_hash(&self, own_hash: &str) -> Option<String> {
        match self {
            Self::Own => Some(own_hash.to_owned()),
            Self::All => None,
            Self::Hash(hash) => Some(hash.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Value {
        pipette_js_json::parse(json).unwrap()
    }

    #[test]
    fn trims_and_drops_empty_and_repeated_scopes() {
        let items = parse(r#"[" Code ", "Code", "", "　﻿", "Slack\n", "\u0085x", 7, null]"#);
        assert_eq!(normalize_app_scopes(&items), ["Code", "Slack", "\u{85}x"]);
        assert!(normalize_app_scopes(&parse("[]")).is_empty());
        assert!(normalize_app_scopes(&parse(r#""Code""#)).is_empty());
    }

    #[test]
    fn parses_device_scopes() {
        assert_eq!(DeviceScope::parse(&parse(r#""own""#)), Some(DeviceScope::Own));
        assert_eq!(DeviceScope::parse(&parse(r#""all""#)), Some(DeviceScope::All));
        assert_eq!(
            DeviceScope::parse(&parse(r#"{"kind":"hash","machineHash":"h"}"#)),
            Some(DeviceScope::Hash("h".into()))
        );
        for bad in [r#"{"kind":"hash","machineHash":""}"#, r#"{"kind":"own"}"#, r#""hash""#, "null", "[]"] {
            assert_eq!(DeviceScope::parse(&parse(bad)), None, "{bad}");
        }
    }

    #[test]
    fn names_every_member() {
        assert_eq!(
            Query::from_member("typingAnalyticsListItemsLocal"),
            Some(Query::Analyze(Family::Items, Devices::Own))
        );
        assert_eq!(
            Query::from_member("typingAnalyticsListMatrixCellsByDayForHash"),
            Some(Query::Analyze(Family::MatrixCellsByDay, Devices::ForHash))
        );
        assert_eq!(
            Query::from_member("typingAnalyticsGetPeakRecords"),
            Some(Query::Analyze(Family::PeakRecords, Devices::All))
        );
        assert_eq!(Query::from_member("typingAnalyticsListDurationCells"), Some(Query::ListDurationCells));
        assert_eq!(Query::from_member("typingAnalyticsListKeyboardsLocal"), None);
        assert_eq!(Query::from_member("typingAnalyticsEvent"), None);
    }

    #[test]
    fn reads_window_bounds_as_the_handlers_do() {
        let values =
            [Value::Number(-1.0), Value::Number(5.0), Value::Number(f64::INFINITY), Value::from("5")];
        let args = Args(&values);
        assert_eq!(args.since(0), 0.0);
        assert_eq!(args.since(1), 5.0);
        assert_eq!(args.until(1, 5.0), 9_007_199_254_740_991.0);
        assert_eq!(args.until(1, 4.0), 5.0);
        assert_eq!(args.until(2, 0.0), 9_007_199_254_740_991.0);
        assert_eq!(args.finite(3), None);
        assert_eq!(args.text(9), None);
    }
}
