// SPDX-License-Identifier: GPL-2.0-or-later
// Shared state keys for the Analyze tab. Kept here so the chart
// components can import them without the whole view.

export type AnalysisTabKey = 'wpm' | 'interval' | 'activity'
export type DeviceScope = 'own' | 'all'
/** Display unit for the Interval chart — the SQL stores keystroke
 * intervals in ms, but seconds are easier to reason about for pauses
 * and most day-level medians. */
export type IntervalUnit = 'ms' | 'sec'

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
