// SPDX-License-Identifier: GPL-2.0-or-later
// Shared state keys for the Analyze tab. Kept here so the chart
// components can import them without the whole view.

export type AnalysisTabKey = 'wpm' | 'interval' | 'activity' | 'keyHeatmap' | 'ergonomics' | 'layer'
/** Normalization option used by the Heatmap tab so the key colours can
 * be read as raw counts, rate (keys per hour), or share of the total
 * strokes in the selected window. */
export type HeatmapNormalization = 'absolute' | 'perHour' | 'shareOfTotal'
export type DeviceScope = 'own' | 'all'
/** Display unit for the Interval chart — the SQL stores keystroke
 * intervals in ms, but seconds are easier to reason about for pauses
 * and most day-level medians. */
export type IntervalUnit = 'ms' | 'sec'

/** Interval tab view mode. `timeSeries` is the original quartile line
 * chart; `distribution` renders the per-bin keystroke histogram (a.k.a.
 * typing-rhythm distribution). */
export type IntervalViewMode = 'timeSeries' | 'distribution'

/** WPM tab view mode. `timeSeries` is the original line chart;
 * `timeOfDay` aggregates WPM by hour-of-day (0..23 local). */
export type WpmViewMode = 'timeSeries' | 'timeOfDay'

/** Whether the WPM time-series chart overlays a Bksp% error-proxy
 * line. Only relevant in the `timeSeries` view. */
export type WpmErrorProxy = 'on' | 'off'

/** Activity tab metric. `keystrokes` is the classic press-count
 * heatmap; `wpm` colors the same grid by WPM derived from the pooled
 * minute-stats of that (dow, hour) cell. `sessions` swaps the grid
 * out for a duration histogram sourced from `typing_sessions`. */
export type ActivityMetric = 'keystrokes' | 'wpm' | 'sessions'

/** Layer tab view mode. `keystrokes` sums every press while a given
 * layer was active (what was typed while there). `activations` sums
 * how many times a layer-op keycode dispatched to that layer (how
 * often the layer was reached). The two metrics compare well side by
 * side — e.g. "same activations, vastly different keystrokes" flags a
 * layer that's often touched but seldom typed on. */
export type LayerViewMode = 'keystrokes' | 'activations'

/** Inclusive-lower, exclusive-upper millisecond range used by every
 * Analyze chart. `toMs` is the wall-clock the page was opened at and
 * the chart UI caps it to "now" so the user cannot pick the future. */
export interface RangeMs {
  fromMs: number
  toMs: number
}

/** Bucket-size choice for the Analyze charts. `'auto'` hands the
 * decision back to `pickBucketMs`; a number is a hard override in ms
 * (must be a member of the `GRANULARITIES` table to keep local-time
 * snapping sensible). */
export type GranularityChoice = 'auto' | number
