// SPDX-License-Identifier: GPL-2.0-or-later
// Shared formatters and stats helpers for the Analyze charts. Kept
// chart-neutral so both the WPM and Interval tabs (and any future
// chart) can pull from a single source of truth.

/** Human-friendly elapsed-time formatter used for "active typing
 * time" across the Analyze summaries. Chooses the coarsest unit pair
 * (`Xh Ym`, `Xm Ys`, `Xs`) that still carries information. */
export function formatActiveDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  const totalSec = Math.floor(ms / 1_000)
  const hours = Math.floor(totalSec / 3_600)
  const minutes = Math.floor((totalSec % 3_600) / 60)
  const seconds = totalSec % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** X-axis tick formatter for the time-series charts. Below a day the
 * label includes the clock (`MM-DD HH:mm`); from a day granularity up
 * the clock is dropped (`MM-DD`). */
export function formatBucketAxisLabel(ms: number, bucketMs: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  if (bucketMs >= 86_400_000) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `HH:00` label for an hour-of-day tick (0..23). Shared between the
 * WPM time-of-day bar chart and the Activity grid's cell title. */
export function formatHourLabel(hour: number): string {
  return `${hour.toString().padStart(2, '0')}:00`
}

export interface WeightedSample {
  value: number
  weight: number
}

/** Weighted median of `(value, weight)` samples. Returns `null` when
 * no sample contributes non-zero weight. Uses the nearest-observation
 * definition (no interpolation) — the charts treat the figure as a
 * summary label, not a statistical publication. */
export function weightedMedian(samples: ReadonlyArray<WeightedSample>): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a.value - b.value)
  const total = sorted.reduce((s, r) => s + r.weight, 0)
  if (total <= 0) return null
  const half = total / 2
  let acc = 0
  for (const s of sorted) {
    acc += s.weight
    if (acc >= half) return s.value
  }
  return sorted[sorted.length - 1].value
}

/** Unweighted median. Returns `null` for an empty input; averages the
 * middle two on an even-sized sample. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

/** Generic bucket-lookup for bin tables whose upper edge is `toMs`
 * (exclusive) or `null` for the unbounded tail. Non-finite / negative
 * inputs clamp to the first bucket so bad data stays visible. */
export function findBucketIndex<T extends { toMs: number | null }>(
  bins: readonly T[],
  value: number,
): number {
  if (!Number.isFinite(value) || value < 0) return 0
  for (let i = 0; i < bins.length; i += 1) {
    const top = bins[i].toMs
    if (top === null) return i
    if (value < top) return i
  }
  return bins.length - 1
}
