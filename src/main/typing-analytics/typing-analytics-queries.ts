// SPDX-License-Identifier: GPL-2.0-or-later
// Read-side query wrappers for the Analyze / Data-modal IPC handlers
// (`typing-analytics-ipc-analyze.ts`) and the Hub Analytics export
// (`hub/hub-analytics.ts`). Every function here either delegates straight to
// the SQLite cache (`getTypingAnalyticsDB()`) or, for `getMatrixHeatmap`,
// folds the live in-memory buffer on top of it.

import { platform, release } from 'node:os'
import type {
  TypingAnalyticsDeviceInfo,
  TypingAnalyticsDeviceInfoBundle,
  TypingHeatmapByCell,
} from '../../shared/types/typing-analytics'
import {
  getTypingAnalyticsDB,
  type TypingActivityCell,
  type TypingDailySummary,
  type TypingIntervalDailySummary,
  type TypingKeyboardSummary,
  type TypingLayerUsageRow,
  type TypingMatrixCellRow,
  type TypingMatrixCellDailyRow,
  type TypingMinuteStatsRow,
  type TypingSessionRow,
  type TypingBksMinuteRow,
  type PeakRecords,
} from './db/typing-analytics-db'
import { getMachineHash } from './machine-hash'
import { MINUTE_MS } from './minute-buffer'
import { taState } from './typing-analytics-state'

// --- Data modal API --------------------------------------------------

/** Factory for the "no records found" sentinel shared by every
 * peak-records handler. */
export const emptyPeakRecords = (): PeakRecords => ({
  peakWpm: null,
  lowestWpm: null,
  peakKeystrokesPerMin: null,
  peakKeystrokesPerDay: null,
  longestSession: null,
})

/** Keyboards that currently have live typing analytics rows, aggregated
 * across every machine that has synced to this device. */
export function listTypingKeyboards(): TypingKeyboardSummary[] {
  return getTypingAnalyticsDB().listKeyboardsWithTypingData()
}

/** Day-level summaries for one keyboard uid, newest first. */
export function listTypingDailySummaries(
  uid: string,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingDailySummary[] {
  return getTypingAnalyticsDB().listDailySummariesForUid(uid, appScopes, typingTestScopes, runIdScopes)
}

/** Pure-cache lookup for the Analyze > Interval chart. Returns every
 * day's envelope + mean quartile across every scope that shares `uid`. */
export function listTypingIntervalSummaries(uid: string): TypingIntervalDailySummary[] {
  return getTypingAnalyticsDB().listIntervalSummariesForUid(uid)
}

/** Same as {@link listTypingIntervalSummaries} but restricted to one
 * machine hash — powers the Analyze device filter when scoped to this
 * device only. */
export function listTypingIntervalSummariesForHash(
  uid: string,
  machineHash: string,
): TypingIntervalDailySummary[] {
  return getTypingAnalyticsDB().listIntervalSummariesForUidAndHash(uid, machineHash)
}

/** Hour × day-of-week activity grid for the Analyze > Heatmap view
 * over the inclusive-lower, exclusive-upper `[sinceMs, untilMs)`
 * window. Pass `sinceMs=0, untilMs=Number.MAX_SAFE_INTEGER` for the
 * full history. */
export function listTypingActivityGrid(
  uid: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingActivityCell[] {
  return getTypingAnalyticsDB().listActivityGridForUid(uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

export function listTypingActivityGridForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingActivityCell[] {
  return getTypingAnalyticsDB().listActivityGridForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

/** Per-layer keystroke totals for the Analyze > Layer tab. Covers
 * `[sinceMs, untilMs)` and aggregates across every machine hash. */
export function listTypingLayerUsageInRange(
  uid: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingLayerUsageRow[] {
  return getTypingAnalyticsDB().listLayerUsageForUid(uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

export function listTypingLayerUsageInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingLayerUsageRow[] {
  return getTypingAnalyticsDB().listLayerUsageForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

/** Per-cell matrix totals for the Analyze > Layer activations mode.
 * Aggregates across every machine hash. */
export function listTypingMatrixCellsInRange(
  uid: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingMatrixCellRow[] {
  return getTypingAnalyticsDB().listMatrixCellsForUid(uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

export function listTypingMatrixCellsInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingMatrixCellRow[] {
  return getTypingAnalyticsDB().listMatrixCellsForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

/** Per-(localDay, layer, row, col) totals for the Analyze Ergonomic
 * Learning Curve. The renderer buckets these by week / month before
 * folding them into ergonomic sub-scores; we keep `dayMs` numeric so
 * the bucketing stays purely arithmetic on the renderer side. */
export function listTypingMatrixCellsByDayInRange(
  uid: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingMatrixCellDailyRow[] {
  return getTypingAnalyticsDB().listMatrixCellsByDayForUid(uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

export function listTypingMatrixCellsByDayInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingMatrixCellDailyRow[] {
  return getTypingAnalyticsDB().listMatrixCellsByDayForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

/** Minute-raw stats for the Analyze WPM / Interval charts over the
 * `[sinceMs, untilMs)` window. Callers bucket these on the renderer.
 * Empty `appScopes` (or omitted) keeps the pre-filter behaviour; a
 * non-empty array restricts the query to minutes whose tagged app
 * matches one of the listed names. */
export function listTypingMinuteStatsInRange(
  uid: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingMinuteStatsRow[] {
  return getTypingAnalyticsDB().listMinuteStatsInRangeForUid(uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

export function listTypingMinuteStatsInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingMinuteStatsRow[] {
  return getTypingAnalyticsDB().listMinuteStatsInRangeForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

/** Live sessions that intersect `[sinceMs, untilMs)`. Powers the
 * Analyze session-distribution histogram. */
export function listTypingSessionsInRange(
  uid: string,
  sinceMs: number,
  untilMs: number,
): TypingSessionRow[] {
  return getTypingAnalyticsDB().listSessionsInRangeForUid(uid, sinceMs, untilMs)
}

export function listTypingSessionsInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
): TypingSessionRow[] {
  return getTypingAnalyticsDB().listSessionsInRangeForUidAndHash(uid, machineHash, sinceMs, untilMs)
}

/** Per-minute character counts for the Analyze error-proxy overlay. */
export function listTypingBksMinuteInRange(
  uid: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingBksMinuteRow[] {
  return getTypingAnalyticsDB().listBksMinuteInRangeForUid(uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

export function listTypingBksMinuteInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingBksMinuteRow[] {
  return getTypingAnalyticsDB().listBksMinuteInRangeForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

export function getTypingPeakRecordsInRange(
  uid: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): PeakRecords {
  return getTypingAnalyticsDB().getPeakRecordsInRangeForUid(uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

export function getTypingPeakRecordsInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): PeakRecords {
  return getTypingAnalyticsDB().getPeakRecordsInRangeForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

/** Day-level summaries restricted to a single `machineHash`. When
 * called with the local machine hash it powers the Local tab; with a
 * remote hash it powers the Sync > Device tab. */
export function listTypingDailySummariesForHash(
  uid: string,
  machineHash: string,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingDailySummary[] {
  return getTypingAnalyticsDB().listDailySummariesForUidAndHash(uid, machineHash, appScopes, typingTestScopes, runIdScopes)
}

/** Per-keyboard device infos for the Analyze > Device filter: own
 * machine + every remote machine that has live data. The own entry
 * is built from the local OS module so the filter can label it even
 * before the first event has been persisted to typing_scopes. */
export async function listTypingDeviceInfosForUid(
  uid: string,
): Promise<TypingAnalyticsDeviceInfoBundle> {
  const ownHash = await getMachineHash()
  const remotes = getTypingAnalyticsDB().listRemoteDeviceInfosForUid(uid, ownHash)
  const own: TypingAnalyticsDeviceInfo = {
    machineHash: ownHash,
    osPlatform: platform(),
    osRelease: release(),
  }
  return { own, remotes }
}

/** Heatmap intensity for the typing-view overlay: summed matrix counts
 * per (row, col) on a single keyboard + machine + layer, covering the
 * window `[floorMinute(sinceMs), now]`. Values are the sum of:
 *
 *  - DB rows flushed for that window (closed minutes), and
 *  - the live current-minute entries still sitting in the `MinuteBuffer`.
 *
 * Each cell carries a `{ total, tap, hold }` triple so the UI can
 * colour the outer (hold) and inner (tap) rects of LT/MT keys
 * independently while non-tap-hold keys stay painted by `total`.
 * The live-minute path is what keeps a 5s poll usable — without it
 * the heatmap would lag the debounced flush by up to ~59 seconds.
 * Serializes the Map as a plain keyed object so the triple round-trips
 * through IPC unchanged. */
export async function getMatrixHeatmap(
  uid: string,
  layer: number,
  sinceMs: number,
): Promise<TypingHeatmapByCell> {
  const machineHash = await getMachineHash()
  const sinceMinuteMs = Math.floor(sinceMs / MINUTE_MS) * MINUTE_MS

  const db = getTypingAnalyticsDB()
  const totals = db.aggregateMatrixCountsForUid(uid, machineHash, layer, sinceMinuteMs)
  const live = taState.minuteBuffer.peekMatrixCountsForUid(uid, machineHash, layer)
  for (const [key, cell] of live) {
    const existing = totals.get(key)
    if (existing) {
      existing.total += cell.total
      existing.tap += cell.tap
      existing.hold += cell.hold
    } else {
      totals.set(key, { total: cell.total, tap: cell.tap, hold: cell.hold })
    }
  }

  const result: TypingHeatmapByCell = {}
  for (const [key, cell] of totals) result[key] = cell
  return result
}
