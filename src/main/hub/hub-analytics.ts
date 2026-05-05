// SPDX-License-Identifier: GPL-2.0-or-later
//
// Hub Analytics export builder. Assembles the
// `analytics-export-v1.json` payload that the desktop ships to
// pipette-hub. The full wire contract lives in
// `.claude/docs/HUB-ANALYTICS-API.md`; this module is the only
// production producer of that shape.
//
// The export is *all derived data*. We never include raw events:
// minute-level (1 minute) is the smallest granularity, and bigram
// IKIs ride along as bucketed histograms (`hist[]`) only.

import type {
  HubAnalyticsData,
  HubAnalyticsExportV1,
  HubAnalyticsFilters,
  HubAnalyticsSnapshot,
} from '../../shared/types/hub'
import { TYPING_APP_UNKNOWN_NAME } from '../../shared/types/typing-analytics'
import type {
  LayoutComparisonInputLayout,
  LayoutComparisonMetric,
  LayoutComparisonResult,
  TypingKeymapSnapshot,
} from '../../shared/types/typing-analytics'
import { aggregatePairTotals, rankBigramsByCount, rankBigramsBySlow } from '../typing-analytics/bigram-aggregate'
import { computeLayoutComparison } from '../typing-analytics/compute-layout-comparison'
import { getMachineHash } from '../typing-analytics/machine-hash'
import { getTypingAnalyticsDB } from '../typing-analytics/db/typing-analytics-db'
import {
  getTypingPeakRecordsInRange,
  getTypingPeakRecordsInRangeForHash,
  listTypingBksMinuteInRange,
  listTypingBksMinuteInRangeForHash,
  listTypingLayerUsageInRange,
  listTypingLayerUsageInRangeForHash,
  listTypingMatrixCellsByDayInRange,
  listTypingMatrixCellsByDayInRangeForHash,
  listTypingMatrixCellsInRange,
  listTypingMatrixCellsInRangeForHash,
  listTypingMinuteStatsInRange,
  listTypingMinuteStatsInRangeForHash,
  listTypingSessionsInRange,
  listTypingSessionsInRangeForHash,
} from '../typing-analytics/typing-analytics-service'
import type { KleKey } from '../../shared/kle/types'

const MS_PER_DAY = 86_400_000

/** Maximum window the Hub will accept for an analytics post. Mirrored in
 * the Hub-side validator (`pipette-hub/src/worker/services/analytics-validation.ts`). */
export const ANALYTICS_MAX_RANGE_MS = 30 * MS_PER_DAY

/** Lower bound on `snapshot.totalKeystrokes`. Below this we refuse the
 * upload entirely — both as a privacy guard (single-keystroke patterns
 * could be reconstructed from a tiny dataset) and as a UX guard
 * (sub-100-keystroke charts are noise). */
export const ANALYTICS_MIN_KEYSTROKES = 100

/** Bigram fan-out caps. Fixed (not user-configurable on upload) so the
 * payload size and the privacy surface stay predictable across users.
 * Top / Slow rankings ship the desktop default for the analyze panel. */
export const ANALYTICS_BIGRAM_TOP_LIMIT = 100
export const ANALYTICS_BIGRAM_SLOW_LIMIT = 100
/** Minimum sample count for the slow ranking — drops one-off outliers
 * the same way the live chart does. */
export const ANALYTICS_BIGRAM_SLOW_MIN_SAMPLE = 5

export type DeviceScope =
  | 'all'
  | 'own'
  | { kind: 'hash'; machineHash: string }

/** Category ids the renderer ships from the upload modal — kept as a
 * loose string union so the Hub-side enum can grow without a shared
 * import dance. */
export type AnalyticsCategoryId =
  | 'heatmap' | 'wpm' | 'interval' | 'activity'
  | 'ergonomics' | 'bigrams' | 'layoutComparison' | 'layer'

export interface BuildAnalyticsExportInput {
  uid: string
  productName: string
  vendorId: number
  productId: number
  snapshot: TypingKeymapSnapshot
  range: { fromMs: number; toMs: number }
  deviceScope: DeviceScope
  appScopes: string[]
  /** Renderer-side filter snapshot. `analysisTab` is required so the
   * Hub UI can land on the same tab the user uploaded from. */
  filters: HubAnalyticsFilters
  /** Pre-resolved layouts for the Layout Comparison tab. The renderer
   * looks these up via `LAYOUT_BY_ID` / key-label-store before triggering
   * the upload because that data is renderer-only. `null` skips the
   * comparison and ships `data.layoutComparison: null`. */
  layoutComparisonInputs: {
    source: LayoutComparisonInputLayout
    targets: LayoutComparisonInputLayout[]
    metrics: LayoutComparisonMetric[]
    /** KleKey geometry parsed from `snapshot.layout`. The renderer is
     * better positioned to do this — it already does it for the live
     * chart — so we accept the parsed result instead of re-parsing. */
    kleKeys: KleKey[]
    /** Layer to read source labels from. Phase 1 of layout comparison
     * uses layer 0; pass through whatever the live chart used. */
    layer?: number
  } | null
  /** Optional category picker — only the listed sections get fetched.
   * Sections not in the set ship as empty arrays so the Hub-side
   * validator still accepts the payload. Undefined / empty fetches
   * everything (back-compat with the pre-modal pipeline). */
  categories?: ReadonlySet<AnalyticsCategoryId>
  /** Which apps to include in `appData`. Undefined ships every app
   * (back-compat). Empty array ships no per-app slices. */
  appDataApps?: string[]
}

/** Helper: should a category's data section be included in the
 * export? Undefined / empty `categories` means "include everything",
 * matching the pre-modal behavior. */
function isSectionEnabled(
  categories: ReadonlySet<AnalyticsCategoryId> | undefined,
  category: AnalyticsCategoryId,
): boolean {
  if (categories === undefined || categories.size === 0) return true
  return categories.has(category)
}

export async function buildAnalyticsExport(
  input: BuildAnalyticsExportInput,
): Promise<HubAnalyticsExportV1> {
  const { uid, range, appScopes, deviceScope } = input
  const machineHash = await resolveMachineHash(deviceScope)
  const collected = await collectData(uid, range, appScopes, machineHash, input)
  const { totalKeystrokes, ...data } = collected

  const snapshot: HubAnalyticsSnapshot = {
    keyboard: {
      uid,
      productName: input.productName,
      vendorId: input.vendorId,
      productId: input.productId,
    },
    deviceScope,
    keymapSnapshot: input.snapshot,
    range,
    totalKeystrokes,
    appScopes,
  }

  const appData = await buildAppData(uid, range, machineHash, data, input)

  const result: HubAnalyticsExportV1 = {
    version: 1,
    kind: 'analytics',
    exportedAt: new Date().toISOString(),
    snapshot,
    filters: input.filters,
    data,
  }
  if (appData !== undefined) result.appData = appData
  return result
}

async function buildAppData(
  uid: string,
  range: { fromMs: number; toMs: number },
  machineHash: string | undefined,
  aggregateData: HubAnalyticsData,
  input: BuildAnalyticsExportInput,
): Promise<Record<string, HubAnalyticsData> | undefined> {
  const appFilter = input.appDataApps
  if (appFilter !== undefined && appFilter.length === 0) return undefined
  const allApps = aggregateData.appUsage.filter((a) => a.name !== TYPING_APP_UNKNOWN_NAME)
  const allowed = appFilter !== undefined ? new Set(appFilter) : undefined
  const apps = allowed !== undefined ? allApps.filter((a) => allowed.has(a.name)) : allApps
  if (apps.length < 2) return undefined

  const usageByName = new Map(aggregateData.appUsage.map((a) => [a.name, a]))
  const wpmByName = new Map(aggregateData.wpmByApp.map((a) => [a.name, a]))

  const collected = await Promise.all(
    apps.map((app) => collectData(uid, range, [app.name], machineHash, input)),
  )

  const result: Record<string, HubAnalyticsData> = {}
  for (let i = 0; i < apps.length; i++) {
    const { totalKeystrokes: _tk, ...appData } = collected[i]!
    appData.sessions = []
    appData.peakRecords = { ...appData.peakRecords, longestSession: null }
    const usage = usageByName.get(apps[i]!.name)
    appData.appUsage = usage ? [usage] : []
    const wpm = wpmByName.get(apps[i]!.name)
    appData.wpmByApp = wpm ? [wpm] : []
    result[apps[i]!.name] = appData
  }
  return result
}

async function resolveMachineHash(scope: DeviceScope): Promise<string | undefined> {
  if (scope === 'all') return undefined
  if (scope === 'own') return getMachineHash()
  return scope.machineHash
}

async function collectData(
  uid: string,
  range: { fromMs: number; toMs: number },
  appScopes: string[],
  machineHash: string | undefined,
  input: BuildAnalyticsExportInput,
): Promise<HubAnalyticsData & { totalKeystrokes: number }> {
  const { fromMs, toMs } = range
  const cats = input.categories
  // Map modal categories → which raw section to fetch. Several
  // categories share underlying data so we OR them.
  // - minuteStats fuels Summary / WPM / Interval / Activity
  // - matrixCells fuels KeyHeatmap / Ergonomics / Layer activations
  // - matrixCellsByDay only Ergonomics learning curve
  // - layerUsage only Layer keystrokes
  // - sessions only Activity (sessions metric) + Summary
  // - bksMinute Activity Backspace overlay + WPM Bksp % line
  // - bigrams only Bigrams tab
  // - layoutComparison only Layout Comparison tab
  // PeakRecords + appUsage + wpmByApp aren't surfaced as modal
  // categories — they back the always-on Summary / By-App tabs.
  const needsMinuteStats =
    isSectionEnabled(cats, 'wpm') ||
    isSectionEnabled(cats, 'interval') ||
    isSectionEnabled(cats, 'activity')
  const needsMatrixCells =
    isSectionEnabled(cats, 'heatmap') ||
    isSectionEnabled(cats, 'ergonomics') ||
    isSectionEnabled(cats, 'layer')
  const needsMatrixCellsByDay = isSectionEnabled(cats, 'ergonomics')
  const needsLayerUsage = isSectionEnabled(cats, 'layer')
  const needsSessions = isSectionEnabled(cats, 'activity')
  const needsBksMinute = isSectionEnabled(cats, 'activity') || isSectionEnabled(cats, 'wpm')
  const needsBigrams = isSectionEnabled(cats, 'bigrams')
  const needsLayoutComparison = isSectionEnabled(cats, 'layoutComparison')

  // Each per-tab fetch picks the same `*ForHash` / un-suffixed pair the
  // live chart does. machineHash === undefined === "all devices".
  // minuteStats is always fetched (even when no minute-based category
  // is enabled) because `snapshot.totalKeystrokes` — used by the
  // 100-keystrokes guard — is the sum of these rows. Skipping the
  // fetch would leave totalKeystrokes at 0 and bounce every category-
  // restricted upload.
  const minuteStatsAll = machineHash === undefined
    ? listTypingMinuteStatsInRange(uid, fromMs, toMs, appScopes)
    : listTypingMinuteStatsInRangeForHash(uid, machineHash, fromMs, toMs, appScopes)
  const minuteStats = needsMinuteStats ? minuteStatsAll : []

  const matrixCells = needsMatrixCells
    ? (machineHash === undefined
        ? listTypingMatrixCellsInRange(uid, fromMs, toMs, appScopes)
        : listTypingMatrixCellsInRangeForHash(uid, machineHash, fromMs, toMs, appScopes))
    : []

  const matrixCellsByDay = needsMatrixCellsByDay
    ? (machineHash === undefined
        ? listTypingMatrixCellsByDayInRange(uid, fromMs, toMs, appScopes)
        : listTypingMatrixCellsByDayInRangeForHash(uid, machineHash, fromMs, toMs, appScopes))
    : []

  const layerUsage = needsLayerUsage
    ? (machineHash === undefined
        ? listTypingLayerUsageInRange(uid, fromMs, toMs, appScopes)
        : listTypingLayerUsageInRangeForHash(uid, machineHash, fromMs, toMs, appScopes))
    : []

  const sessions = needsSessions
    ? (machineHash === undefined
        ? listTypingSessionsInRange(uid, fromMs, toMs)
        : listTypingSessionsInRangeForHash(uid, machineHash, fromMs, toMs))
    : []

  const bksMinute = needsBksMinute
    ? (machineHash === undefined
        ? listTypingBksMinuteInRange(uid, fromMs, toMs, appScopes)
        : listTypingBksMinuteInRangeForHash(uid, machineHash, fromMs, toMs, appScopes))
    : []

  // PeakRecords drives the always-on Summary cards. Use the existing
  // unselected-fetch path; if minuteStats was skipped above, the
  // server still has the rows it needs.
  const peakRecords = machineHash === undefined
    ? getTypingPeakRecordsInRange(uid, fromMs, toMs, appScopes)
    : getTypingPeakRecordsInRangeForHash(uid, machineHash, fromMs, toMs, appScopes)

  // App-scoped aggregates feed the By App tab. Hub side renders these
  // independent of the App filter (you can't compare across apps if the
  // dataset is already collapsed to one), so the live chart calls these
  // with no app filter — mirror that here.
  const db = getTypingAnalyticsDB()
  const appHash: string | null = machineHash ?? null
  const appUsage = db.getAppUsageForUidInRange(uid, appHash, fromMs, toMs)
  const wpmByApp = db.getWpmByAppForUidInRange(uid, appHash, fromMs, toMs)

  // Bigrams: pull raw minute rows, fold into pair totals, take the
  // top/slow ranking with the fixed limits documented in the API spec.
  let bigramTop: HubAnalyticsData['bigramTop'] = []
  let bigramSlow: HubAnalyticsData['bigramSlow'] = []
  if (needsBigrams) {
    const bigramRows = machineHash === undefined
      ? db.listBigramMinutesInRangeForUid(uid, fromMs, toMs, appScopes)
      : db.listBigramMinutesInRangeForUidAndHash(uid, machineHash, fromMs, toMs, appScopes)
    const bigramTotals = aggregatePairTotals(bigramRows)
    bigramTop = rankBigramsByCount(bigramTotals, ANALYTICS_BIGRAM_TOP_LIMIT)
    bigramSlow = rankBigramsBySlow(
      bigramTotals,
      ANALYTICS_BIGRAM_SLOW_MIN_SAMPLE,
      ANALYTICS_BIGRAM_SLOW_LIMIT,
    )
  }

  const layoutComparison = needsLayoutComparison
    ? await computeLayoutComparisonForExport(
        uid,
        fromMs,
        toMs,
        machineHash,
        appScopes,
        input.layoutComparisonInputs,
        input.snapshot,
      )
    : null

  return {
    minuteStats,
    matrixCells,
    matrixCellsByDay,
    layerUsage,
    sessions,
    bksMinute,
    bigramTop,
    bigramSlow,
    appUsage,
    wpmByApp,
    peakRecords,
    layoutComparison,
    // totalKeystrokes is derived from the unfiltered minute fetch so
    // the validator's 100-keystroke guard works even when the user
    // unchecks every minute-based category.
    totalKeystrokes: minuteStatsAll.reduce((sum, m) => sum + m.keystrokes, 0),
  }
}

async function computeLayoutComparisonForExport(
  uid: string,
  fromMs: number,
  toMs: number,
  machineHash: string | undefined,
  appScopes: string[],
  inputs: BuildAnalyticsExportInput['layoutComparisonInputs'],
  snapshot: TypingKeymapSnapshot,
): Promise<LayoutComparisonResult | null> {
  if (inputs === null) return null
  // Layer 0 is the Phase 1 default; the IPC handler does the same thing
  // when the renderer doesn't override it.
  const layer = inputs.layer ?? 0
  // The live chart aligns to minute boundaries before reading matrix
  // counts so the heatmap doesn't double-count the partial minute the
  // user is currently typing in.
  const MINUTE_MS = 60_000
  const sinceMinuteMs = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS
  const untilMinuteMs = Math.ceil(toMs / MINUTE_MS) * MINUTE_MS
  const matrixCounts = getTypingAnalyticsDB().aggregateMatrixCountsForUidInRange(
    uid,
    layer,
    sinceMinuteMs,
    untilMinuteMs,
    machineHash,
    appScopes,
  )
  const result = computeLayoutComparison({
    matrixCounts,
    snapshot,
    kleKeys: inputs.kleKeys,
    source: inputs.source,
    targets: inputs.targets,
    metrics: inputs.metrics,
    layer,
  })
  const nameById = new Map(inputs.targets.map((t) => [t.id, t.name]))
  for (const target of result.targets) {
    const name = nameById.get(target.layoutId)
    if (name) target.layoutName = name
    if (target.fingerLoad) {
      target.fingerLoad = remapFingerKeys(target.fingerLoad)
    }
  }
  return result
}

const FINGER_KEY_TO_HUB: Record<string, string> = {
  'left-pinky': 'pinkyL', 'left-ring': 'ringL', 'left-middle': 'middleL',
  'left-index': 'indexL', 'left-thumb': 'thumbL',
  'right-thumb': 'thumbR', 'right-index': 'indexR', 'right-middle': 'middleR',
  'right-ring': 'ringR', 'right-pinky': 'pinkyR',
}

function remapFingerKeys(
  src: Partial<Record<string, number>>,
): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = {}
  for (const [k, v] of Object.entries(src)) {
    if (v !== undefined) out[FINGER_KEY_TO_HUB[k] ?? k] = v
  }
  return out
}

export type AnalyticsValidationResult =
  | { ok: true }
  | { ok: false; reason: string }

/** Pre-flight check identical in spirit to the Hub-side server validator
 * — fail fast on the desktop so we don't pay for serialization +
 * upload only to bounce on the Worker. */
export function validateAnalyticsExport(
  exportData: HubAnalyticsExportV1,
): AnalyticsValidationResult {
  if (exportData.snapshot.totalKeystrokes < ANALYTICS_MIN_KEYSTROKES) {
    return { ok: false, reason: 'keystrokes below threshold' }
  }
  const { fromMs, toMs } = exportData.snapshot.range
  if (toMs < fromMs) {
    return { ok: false, reason: 'snapshot.range.toMs must be >= fromMs' }
  }
  if (toMs - fromMs > ANALYTICS_MAX_RANGE_MS) {
    return { ok: false, reason: 'range exceeds 30 days' }
  }
  return { ok: true }
}

/** Serialised byte length of the export. Used by the upload dialog so
 * the user sees a concrete size before confirming. The string is
 * thrown away — we only need the byte count, not the text. */
export function estimateAnalyticsExportSizeBytes(exportData: HubAnalyticsExportV1): number {
  return Buffer.byteLength(JSON.stringify(exportData), 'utf-8')
}
