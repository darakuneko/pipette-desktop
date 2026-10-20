// SPDX-License-Identifier: GPL-2.0-or-later
//! The range aggregates: the Monitor App
//! lists, the key heatmap, the bigram ranking, the rollover trend, the
//! keypress durations and the Layout Comparison, each over a window and a
//! [`DeviceScope`] the handler resolves itself.

use pipette_js_json::{Object, Value};
use pipette_typing_analytics_db::{AppAggregate, Gram, ScopeFilters};

use super::analyze::{heatmap, heatmap_cells};
use super::{Args, Context, DeviceScope, Query, ceil_minute, empty_list, floor_minute, js};
use crate::bigram_aggregate::{
    aggregate_duration_totals, aggregate_pair_totals, duration_cell, observed_rollover_ratio, rank_by_count,
    rank_by_slow,
};
use crate::keymap_snapshots::get_keymap_snapshot_for_range;
use crate::layout_comparison;

/// The checked `(uid, sinceMs, untilMs, scope)` of a range handler: a
/// non-empty uid, finite bounds with `until` above `since`, a scope.
pub(super) struct Range<'a> {
    uid: &'a str,
    since: f64,
    until: f64,
    scope: DeviceScope,
}

fn range<'a>(args: Args<'a>, uid: usize, since: usize, until: usize, scope: usize) -> Option<Range<'a>> {
    let uid = args.text(uid)?;
    let since = args.finite(since)?;
    let until = args.finite(until).filter(|&u| u > since)?;
    Some(Range { uid, since, until, scope: DeviceScope::parse(args.get(scope))? })
}

/// The checked `(uid, sinceMs, untilMs, scope)` of the Monitor App lists;
/// an empty list when the handler rejects one.
pub(super) fn app_range_args(args: Args<'_>) -> Result<Range<'_>, Value> {
    range(args, 0, 1, 2, 3).ok_or_else(empty_list)
}

/// `ListAppsForRange` / `ListTypingTestsForRange` / `GetAppUsageForRange` /
/// `GetWpmByAppForRange` `(uid, sinceMs, untilMs, scope)` and
/// `ListTypingTestRunsForRange` with `typingTestScopes` after them: the
/// window widened to whole minutes.
pub(super) fn app_range(query: Query, args: Args<'_>, cx: &Context<'_>) -> Result<String, crate::Error> {
    let r = match app_range_args(args) {
        Ok(r) => r,
        Err(rejected) => return Ok(pipette_js_json::stringify(&rejected)),
    };
    let hash = r.scope.machine_hash(cx.own_hash);
    let (since, until) = (floor_minute(r.since), ceil_minute(r.until));
    let aggregate = match query {
        Query::ListAppsForRange => AppAggregate::Apps,
        Query::ListTypingTestsForRange => AppAggregate::TypingTests,
        Query::GetAppUsageForRange => AppAggregate::AppUsage,
        Query::GetWpmByAppForRange => AppAggregate::WpmByApp,
        _ => {
            let tests = args.scopes(4);
            return Ok(js(cx.db.typing_test_runs(r.uid, hash.as_deref(), since, until, &tests)?));
        }
    };
    Ok(js(cx.db.app_aggregate(aggregate, r.uid, hash.as_deref(), since, until)?))
}

/// `GetMatrixHeatmapForRange(uid, layer, sinceMs, untilMs, scope, …filters)`:
/// the window widened to whole minutes.
pub(super) fn matrix_heatmap(args: Args<'_>, cx: &Context<'_>) -> Result<Value, crate::Error> {
    let (r, layer) = match matrix_heatmap_args(args) {
        Ok(checked) => checked,
        Err(rejected) => return Ok(rejected),
    };
    let hash = r.scope.machine_hash(cx.own_hash);
    let cells = cx.db.matrix_counts_in_range(
        r.uid,
        hash.as_deref(),
        layer,
        floor_minute(r.since),
        ceil_minute(r.until),
        &args.filters(5),
    )?;
    Ok(heatmap(heatmap_cells(&cells)))
}

/// The window and the layer of `GetMatrixHeatmapForRange`; an empty
/// heatmap when the handler rejects one.
pub(super) fn matrix_heatmap_args(args: Args<'_>) -> Result<(Range<'_>, f64), Value> {
    let checked = (|| Some((range(args, 0, 2, 3, 4)?, args.finite(1).filter(|&l| l >= 0.0)?)))();
    checked.ok_or_else(|| Value::Object(Object::new()))
}

/// The checked arguments of the scoped handlers: the window as sent, the
/// device hash and the filters.
struct Scoped<'a> {
    uid: &'a str,
    hash: Option<String>,
    since: f64,
    until: f64,
    filters: ScopeFilters,
}

fn scoped<'a>(r: Range<'a>, filters: ScopeFilters, cx: &Context<'_>) -> Scoped<'a> {
    Scoped { uid: r.uid, hash: r.scope.machine_hash(cx.own_hash), since: r.since, until: r.until, filters }
}

/// The checked `(uid, scope, sinceMs, untilMs)` of `ListRolloverMinutes`
/// and `ListDurationCells`; an empty list when the handler rejects one.
pub(super) fn scoped_range_args(args: Args<'_>) -> Result<Range<'_>, Value> {
    range(args, 0, 2, 3, 1).ok_or_else(empty_list)
}

/// The bigram view's answer without entries.
fn empty_bigrams(view: &str) -> Value {
    bigram_result(view, Vec::new(), false, None)
}

fn bigram_result(view: &str, entries: Vec<Value>, truncated: bool, ratio: Option<f64>) -> Value {
    let fields = [
        ("view", Value::from(view)),
        ("entries", Value::Array(entries)),
        ("truncated", Value::from(truncated)),
        ("observedRolloverRatio", ratio.map_or(Value::Null, Value::Number)),
    ];
    fields.into_iter().collect::<Object>().into()
}

/// The ranking options: each a number in
/// range, floored, or its default.
struct BigramOptions {
    min_sample: f64,
    limit: f64,
    gram: Gram,
}

impl BigramOptions {
    fn parse(value: &Value) -> Self {
        let field = |key: &str| match value.as_object().and_then(|o| o.get(key)) {
            Some(Value::Number(n)) if n.is_finite() => Some(*n),
            _ => None,
        };
        Self {
            min_sample: field("minSampleCount").filter(|&n| n >= 0.0).map_or(5.0, f64::floor),
            limit: field("limit").filter(|&n| n > 0.0).map_or(30.0, f64::floor),
            gram: if field("gram") == Some(3.0) { Gram::Trigram } else { Gram::Bigram },
        }
    }
}

/// The view and the window of `GetBigramAggregateForRange`; the view's
/// answer without entries when the handler rejects one (`top`'s for an
/// unknown view).
pub(super) fn bigram_args(args: Args<'_>) -> Result<(&'static str, Range<'_>), Value> {
    let view = match args.get(3) {
        Value::String(v) if v == "top" => "top",
        Value::String(v) if v == "slow" => "slow",
        _ => return Err(empty_bigrams("top")),
    };
    let r = range(args, 0, 1, 2, 4).ok_or_else(|| empty_bigrams(view))?;
    Ok((view, r))
}

/// `GetBigramAggregateForRange(uid, sinceMs, untilMs, view, scope, options,
/// …filters)`: the n-grams of the window ranked by count (`top`) or by
/// average interval (`slow`), whether more ids than the limit exist, and
/// the rollover ratio (null for trigrams).
pub(super) fn bigram_aggregate(args: Args<'_>, cx: &Context<'_>) -> Result<Value, crate::Error> {
    let (view, r) = match bigram_args(args) {
        Ok(checked) => checked,
        Err(rejected) => return Ok(rejected),
    };
    let s = scoped(r, args.filters(6), cx);
    let options = BigramOptions::parse(args.get(5));
    let rows =
        cx.db.ngram_minutes_in_range(options.gram, s.uid, s.hash.as_deref(), s.since, s.until, &s.filters)?;
    let totals = aggregate_pair_totals(&rows);
    let truncated = totals.len() as f64 > options.limit;
    let ratio = match options.gram {
        Gram::Trigram => None,
        Gram::Bigram => observed_rollover_ratio(&totals),
    };
    let entries = match view {
        "slow" => rank_by_slow(&totals, options.min_sample, options.limit),
        _ => rank_by_count(&totals, options.limit),
    };
    Ok(bigram_result(view, entries, truncated, ratio))
}

/// `ListRolloverMinutes(uid, scope, sinceMs, untilMs, …filters)`.
pub(super) fn rollover_minutes(args: Args<'_>, cx: &Context<'_>) -> Result<String, crate::Error> {
    let s = match scoped_range_args(args) {
        Ok(r) => scoped(r, args.filters(4), cx),
        Err(rejected) => return Ok(pipette_js_json::stringify(&rejected)),
    };
    Ok(js(cx.db.rollover_minutes(s.uid, s.hash.as_deref(), s.since, s.until, &s.filters)?))
}

/// `ListDurationCells(uid, scope, sinceMs, untilMs, …filters)`: the
/// keypress durations of the window, one total per cell and layer.
pub(super) fn duration_cells(args: Args<'_>, cx: &Context<'_>) -> Result<Value, crate::Error> {
    let s = match scoped_range_args(args) {
        Ok(r) => scoped(r, args.filters(4), cx),
        Err(rejected) => return Ok(rejected),
    };
    let rows = cx.db.matrix_duration_cells(s.uid, s.hash.as_deref(), s.since, s.until, &s.filters)?;
    Ok(Value::Array(aggregate_duration_totals(&rows).iter().map(duration_cell).collect()))
}

/// The window and the options of `GetLayoutComparisonForRange`; null when
/// the handler rejects one.
pub(super) fn layout_comparison_args(
    args: Args<'_>,
) -> Result<(Range<'_>, layout_comparison::Options), Value> {
    let checked = (|| Some((range(args, 0, 1, 2, 3)?, layout_comparison::parse_options(args.get(4))?)))();
    checked.ok_or(Value::Null)
}

/// `GetLayoutComparisonForRange(uid, sinceMs, untilMs, scope, options,
/// …filters)`: null for rejected arguments or when this device has no
/// keymap snapshot for the window. The snapshot is always this device's
/// (only this device saves them); the counts are layer 0's for the scope,
/// over the window widened to whole minutes.
pub(super) fn layout_comparison(args: Args<'_>, cx: &Context<'_>) -> Result<Value, crate::Error> {
    let (r, options) = match layout_comparison_args(args) {
        Ok(checked) => checked,
        Err(rejected) => return Ok(rejected),
    };
    let snapshot = get_keymap_snapshot_for_range(cx.user_data, r.uid, cx.own_hash, r.since, r.until)?;
    if matches!(snapshot, Value::Null) {
        return Ok(Value::Null);
    }
    let hash = r.scope.machine_hash(cx.own_hash);
    let counts = cx.db.matrix_counts_in_range(
        r.uid,
        hash.as_deref(),
        0.0,
        floor_minute(r.since),
        ceil_minute(r.until),
        &args.filters(5),
    )?;
    Ok(layout_comparison::compute(&counts, &snapshot, &options)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_bigram_options() {
        let parse = |json: &str| BigramOptions::parse(&pipette_js_json::parse(json).unwrap());
        let defaults = parse("null");
        assert_eq!((defaults.min_sample, defaults.limit, defaults.gram), (5.0, 30.0, Gram::Bigram));
        let set = parse(r#"{"minSampleCount":2.7,"limit":10.9,"gram":3}"#);
        assert_eq!((set.min_sample, set.limit, set.gram), (2.0, 10.0, Gram::Trigram));
        let bad = parse(r#"{"minSampleCount":-1,"limit":0,"gram":"3"}"#);
        assert_eq!((bad.min_sample, bad.limit, bad.gram), (5.0, 30.0, Gram::Bigram));
        assert_eq!(parse(r#"{"limit":0.5}"#).limit, 0.0);
    }
}
