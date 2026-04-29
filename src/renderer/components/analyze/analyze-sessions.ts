// SPDX-License-Identifier: GPL-2.0-or-later
// Session-length histogram for the Analyze > Activity > Sessions mode.
// `typing_sessions` rows carry start / end milliseconds; we bucket
// their durations into a fixed seven-bin ladder so the chart stays
// legible whether the user has five sessions or five thousand.
//
// The backing SQL query keeps sessions whose `start_ms` falls inside
// the selected window — "sessions the user started today" rather than
// "sessions fully contained in today". Each session's full duration is
// then reported as-is; clipping would misrepresent the lived length of
// a session the user sees as "one session".

import type { TypingSessionRow } from '../../../shared/types/typing-analytics'
import { findBucketIndex, median } from './analyze-format'

/** Bin edges (upper-exclusive) for session duration histograms, in
 * milliseconds. The final bin (`gtFourHours`) catches everything
 * above the last edge. */
export const SESSION_HISTOGRAM_BIN_IDS = [
  'lt5Min',
  '5to15Min',
  '15to30Min',
  '30to60Min',
  '1to2Hours',
  '2to4Hours',
  'gtFourHours',
] as const

type SessionBinId = (typeof SESSION_HISTOGRAM_BIN_IDS)[number]

interface SessionBinDef {
  id: SessionBinId
  fromMs: number
  /** `null` for the tail bucket (unbounded). */
  toMs: number | null
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

const BINS: readonly SessionBinDef[] = [
  { id: 'lt5Min',       fromMs: 0,              toMs: 5 * MINUTE_MS },
  { id: '5to15Min',     fromMs: 5 * MINUTE_MS,  toMs: 15 * MINUTE_MS },
  { id: '15to30Min',    fromMs: 15 * MINUTE_MS, toMs: 30 * MINUTE_MS },
  { id: '30to60Min',    fromMs: 30 * MINUTE_MS, toMs: 60 * MINUTE_MS },
  { id: '1to2Hours',    fromMs: HOUR_MS,        toMs: 2 * HOUR_MS },
  { id: '2to4Hours',    fromMs: 2 * HOUR_MS,    toMs: 4 * HOUR_MS },
  { id: 'gtFourHours',  fromMs: 4 * HOUR_MS,    toMs: null },
]

export interface SessionHistogramBin {
  id: SessionBinId
  fromMs: number
  toMs: number | null
  /** Count of sessions whose duration falls into this bin. */
  count: number
  /** Share of total session count in [0, 1]. 0 when no session
   * contributed. */
  share: number
}

export interface SessionDistributionSummary {
  sessionCount: number
  /** Sum of every session's `endMs - startMs`. */
  totalDurationMs: number
  /** `null` when `sessionCount === 0`. */
  meanDurationMs: number | null
  medianDurationMs: number | null
  longestDurationMs: number | null
  shortestDurationMs: number | null
}

export interface SessionHistogramResult {
  bins: SessionHistogramBin[]
  summary: SessionDistributionSummary
}

/** Bucket a session by duration (ms). Thin adapter over
 * {@link findBucketIndex} that fixes the `BINS` table so callers don't
 * have to plumb it through. */
export function findSessionBinIndex(durationMs: number): number {
  return findBucketIndex(BINS, durationMs)
}

export function buildSessionHistogram(
  rows: readonly TypingSessionRow[],
): SessionHistogramResult {
  const counts = new Array<number>(BINS.length).fill(0)
  const durations: number[] = []
  // Track min / max / sum inline so we never need to spread a potentially
  // huge `durations` array through `Math.max / Math.min` (a multi-year
  // range can produce tens of thousands of sessions).
  let totalDurationMs = 0
  let longestDurationMs: number | null = null
  let shortestDurationMs: number | null = null

  for (const r of rows) {
    const duration = r.endMs - r.startMs
    if (!Number.isFinite(duration) || duration <= 0) continue
    durations.push(duration)
    totalDurationMs += duration
    longestDurationMs = longestDurationMs === null ? duration : Math.max(longestDurationMs, duration)
    shortestDurationMs = shortestDurationMs === null ? duration : Math.min(shortestDurationMs, duration)
    counts[findBucketIndex(BINS, duration)] += 1
  }

  const total = durations.length
  const bins: SessionHistogramBin[] = BINS.map((def, i) => ({
    id: def.id,
    fromMs: def.fromMs,
    toMs: def.toMs,
    count: counts[i],
    share: total > 0 ? counts[i] / total : 0,
  }))

  return {
    bins,
    summary: {
      sessionCount: total,
      totalDurationMs,
      meanDurationMs: total === 0 ? null : totalDurationMs / total,
      medianDurationMs: median(durations),
      longestDurationMs,
      shortestDurationMs,
    },
  }
}
