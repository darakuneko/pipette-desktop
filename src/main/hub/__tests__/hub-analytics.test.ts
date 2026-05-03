// SPDX-License-Identifier: GPL-2.0-or-later
//
// Unit tests for the Hub Analytics export builder. We mock the
// typing-analytics service / DB layer so the assertions focus on the
// export shape, the validation thresholds, and the size estimator.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Mocks --------------------------------------------------------------

vi.mock('../../typing-analytics/machine-hash', () => ({
  getMachineHash: vi.fn(async () => 'own-hash'),
}))

const dbMock = {
  getAppUsageForUidInRange: vi.fn(),
  getWpmByAppForUidInRange: vi.fn(),
  listBigramMinutesInRangeForUid: vi.fn(),
  listBigramMinutesInRangeForUidAndHash: vi.fn(),
  aggregateMatrixCountsForUidInRange: vi.fn(),
}

vi.mock('../../typing-analytics/db/typing-analytics-db', () => ({
  getTypingAnalyticsDB: () => dbMock,
}))

vi.mock('../../typing-analytics/typing-analytics-service', () => ({
  listTypingMinuteStatsInRange: vi.fn(),
  listTypingMinuteStatsInRangeForHash: vi.fn(),
  listTypingMatrixCellsInRange: vi.fn(() => []),
  listTypingMatrixCellsInRangeForHash: vi.fn(() => []),
  listTypingMatrixCellsByDayInRange: vi.fn(() => []),
  listTypingMatrixCellsByDayInRangeForHash: vi.fn(() => []),
  listTypingLayerUsageInRange: vi.fn(() => []),
  listTypingLayerUsageInRangeForHash: vi.fn(() => []),
  listTypingSessionsInRange: vi.fn(() => []),
  listTypingSessionsInRangeForHash: vi.fn(() => []),
  listTypingBksMinuteInRange: vi.fn(() => []),
  listTypingBksMinuteInRangeForHash: vi.fn(() => []),
  getTypingPeakRecordsInRange: vi.fn(() => emptyPeakRecords()),
  getTypingPeakRecordsInRangeForHash: vi.fn(() => emptyPeakRecords()),
}))

vi.mock('../../typing-analytics/bigram-aggregate', () => ({
  aggregatePairTotals: vi.fn(() => []),
  rankBigramsByCount: vi.fn(() => []),
  rankBigramsBySlow: vi.fn(() => []),
}))

vi.mock('../../typing-analytics/compute-layout-comparison', () => ({
  computeLayoutComparison: vi.fn(() => ({ sourceLayoutId: 'src', targets: [] })),
}))

// --- Imports after mocks ------------------------------------------------

import {
  ANALYTICS_BIGRAM_SLOW_LIMIT,
  ANALYTICS_BIGRAM_SLOW_MIN_SAMPLE,
  ANALYTICS_BIGRAM_TOP_LIMIT,
  ANALYTICS_MAX_RANGE_MS,
  ANALYTICS_MIN_KEYSTROKES,
  buildAnalyticsExport,
  estimateAnalyticsExportSizeBytes,
  validateAnalyticsExport,
} from '../hub-analytics'
import {
  listTypingMinuteStatsInRange,
  listTypingMinuteStatsInRangeForHash,
} from '../../typing-analytics/typing-analytics-service'
import { getMachineHash } from '../../typing-analytics/machine-hash'
import {
  aggregatePairTotals,
  rankBigramsByCount,
  rankBigramsBySlow,
} from '../../typing-analytics/bigram-aggregate'
import { computeLayoutComparison } from '../../typing-analytics/compute-layout-comparison'
import type { TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import type { HubAnalyticsFilters } from '../../../shared/types/hub'

function emptyPeakRecords(): {
  peakWpm: null
  lowestWpm: null
  peakKeystrokesPerMin: null
  peakKeystrokesPerDay: null
  longestSession: null
} {
  return {
    peakWpm: null,
    lowestWpm: null,
    peakKeystrokesPerMin: null,
    peakKeystrokesPerDay: null,
    longestSession: null,
  }
}

const SNAPSHOT: TypingKeymapSnapshot = {
  uid: 'kb-1',
  machineHash: 'own-hash',
  productName: 'Test Board',
  savedAt: 1_000_000,
  layers: 1,
  matrix: { rows: 1, cols: 1 },
  keymap: [[['KC_A']]],
  layout: {},
}

const FILTERS: HubAnalyticsFilters = {
  analysisTab: 'summary',
  bigrams: { topLimit: 10, slowLimit: 10, fingerLimit: 20 },
}

const FROM_MS = 1_700_000_000_000
const TO_MS = FROM_MS + 86_400_000

function baseInput() {
  return {
    uid: 'kb-1',
    productName: 'Test Board',
    vendorId: 0xABCD,
    productId: 0x1234,
    snapshot: SNAPSHOT,
    range: { fromMs: FROM_MS, toMs: TO_MS },
    deviceScope: 'all' as const,
    appScopes: [],
    filters: FILTERS,
    layoutComparisonInputs: null,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  dbMock.getAppUsageForUidInRange.mockReturnValue([{ name: 'VSCode', keystrokes: 500, activeMs: 50_000 }])
  dbMock.getWpmByAppForUidInRange.mockReturnValue([{ name: 'VSCode', keystrokes: 500, activeMs: 50_000 }])
  dbMock.listBigramMinutesInRangeForUid.mockReturnValue([])
  dbMock.listBigramMinutesInRangeForUidAndHash.mockReturnValue([])
  dbMock.aggregateMatrixCountsForUidInRange.mockReturnValue(new Map())
  vi.mocked(listTypingMinuteStatsInRange).mockReturnValue([
    { minuteMs: FROM_MS, keystrokes: 60, activeMs: 60_000, intervalMinMs: null, intervalP25Ms: null, intervalP50Ms: null, intervalP75Ms: null, intervalMaxMs: null },
    { minuteMs: FROM_MS + 60_000, keystrokes: 100, activeMs: 60_000, intervalMinMs: null, intervalP25Ms: null, intervalP50Ms: null, intervalP75Ms: null, intervalMaxMs: null },
  ])
  vi.mocked(listTypingMinuteStatsInRangeForHash).mockReturnValue([
    { minuteMs: FROM_MS, keystrokes: 200, activeMs: 60_000, intervalMinMs: null, intervalP25Ms: null, intervalP50Ms: null, intervalP75Ms: null, intervalMaxMs: null },
  ])
})

describe('buildAnalyticsExport', () => {
  it('produces a v1 export with totalKeystrokes summed from minuteStats', async () => {
    const result = await buildAnalyticsExport(baseInput())
    expect(result.version).toBe(1)
    expect(result.kind).toBe('analytics')
    expect(result.snapshot.totalKeystrokes).toBe(160) // 60 + 100
    expect(result.snapshot.keyboard.uid).toBe('kb-1')
    expect(result.snapshot.keyboard.productName).toBe('Test Board')
    expect(result.snapshot.range).toEqual({ fromMs: FROM_MS, toMs: TO_MS })
    expect(result.snapshot.deviceScope).toBe('all')
    expect(result.filters).toBe(FILTERS)
  })

  it('uses the un-suffixed fetcher for "all" scope and the hash variant for hash scope', async () => {
    await buildAnalyticsExport(baseInput())
    expect(listTypingMinuteStatsInRange).toHaveBeenCalledTimes(1)
    expect(listTypingMinuteStatsInRangeForHash).not.toHaveBeenCalled()

    vi.clearAllMocks()
    vi.mocked(listTypingMinuteStatsInRangeForHash).mockReturnValue([
      { minuteMs: FROM_MS, keystrokes: 200, activeMs: 60_000, intervalMinMs: null, intervalP25Ms: null, intervalP50Ms: null, intervalP75Ms: null, intervalMaxMs: null },
    ])
    await buildAnalyticsExport({
      ...baseInput(),
      deviceScope: { kind: 'hash', machineHash: 'remote-hash' },
    })
    expect(listTypingMinuteStatsInRangeForHash).toHaveBeenCalledWith(
      'kb-1', 'remote-hash', FROM_MS, TO_MS, [],
    )
    expect(listTypingMinuteStatsInRange).not.toHaveBeenCalled()
  })

  it('resolves the own machineHash for "own" scope', async () => {
    await buildAnalyticsExport({ ...baseInput(), deviceScope: 'own' })
    expect(getMachineHash).toHaveBeenCalled()
    expect(listTypingMinuteStatsInRangeForHash).toHaveBeenCalledWith(
      'kb-1', 'own-hash', FROM_MS, TO_MS, [],
    )
  })

  it('passes the fixed bigram limits (10 / 10 / minSample 5) to the rankers', async () => {
    await buildAnalyticsExport(baseInput())
    expect(aggregatePairTotals).toHaveBeenCalled()
    expect(rankBigramsByCount).toHaveBeenCalledWith(expect.anything(), ANALYTICS_BIGRAM_TOP_LIMIT)
    expect(rankBigramsBySlow).toHaveBeenCalledWith(
      expect.anything(),
      ANALYTICS_BIGRAM_SLOW_MIN_SAMPLE,
      ANALYTICS_BIGRAM_SLOW_LIMIT,
    )
  })

  it('omits layout comparison when no layout inputs are supplied', async () => {
    const result = await buildAnalyticsExport(baseInput())
    expect(result.data.layoutComparison).toBeNull()
    expect(computeLayoutComparison).not.toHaveBeenCalled()
  })

  it('computes layout comparison when layout inputs are supplied', async () => {
    const result = await buildAnalyticsExport({
      ...baseInput(),
      layoutComparisonInputs: {
        source: { id: 'qwerty', map: { 'KC_A': 'a' } },
        target: { id: 'colemak', map: { 'KC_A': 'a' } },
        metrics: [],
        kleKeys: [],
      },
    })
    expect(computeLayoutComparison).toHaveBeenCalled()
    expect(result.data.layoutComparison).toEqual({ sourceLayoutId: 'src', targets: [] })
  })

  it('forwards the App-tab aggregates for ByApp', async () => {
    const result = await buildAnalyticsExport(baseInput())
    expect(result.data.appUsage).toEqual([{ name: 'VSCode', keystrokes: 500, activeMs: 50_000 }])
    expect(result.data.wpmByApp).toEqual([{ name: 'VSCode', keystrokes: 500, activeMs: 50_000 }])
  })

  it('respects the user category picker and ships unselected sections as empty', async () => {
    const onlyHeatmap = await buildAnalyticsExport({
      ...baseInput(),
      categories: new Set(['heatmap']),
    })
    expect(onlyHeatmap.data.matrixCells).toEqual([])
    // matrixCells fetcher *was* called (heatmap is enabled), the empty
    // result is the mock's default returning `[]`.
    // Skipped sections ship as empty arrays:
    expect(onlyHeatmap.data.minuteStats).toEqual([])
    expect(onlyHeatmap.data.layerUsage).toEqual([])
    expect(onlyHeatmap.data.matrixCellsByDay).toEqual([])
    expect(onlyHeatmap.data.bigramTop).toEqual([])
    expect(onlyHeatmap.data.bigramSlow).toEqual([])
    expect(aggregatePairTotals).not.toHaveBeenCalled()
  })

  it('still computes totalKeystrokes when no minute-based category is selected', async () => {
    const result = await buildAnalyticsExport({
      ...baseInput(),
      categories: new Set(['heatmap']),
    })
    // baseInput's mocked listTypingMinuteStatsInRange returns 60 + 100
    // — totalKeystrokes is derived off the unfiltered fetch so the
    // 100-keystroke guard works even when minuteStats ships empty.
    expect(result.snapshot.totalKeystrokes).toBe(160)
  })
})

describe('validateAnalyticsExport', () => {
  function makeExport(overrides: Partial<{ totalKeystrokes: number; fromMs: number; toMs: number }> = {}) {
    return {
      version: 1,
      kind: 'analytics',
      exportedAt: '2026-05-03T00:00:00.000Z',
      snapshot: {
        keyboard: { uid: 'kb-1', productName: 'Test', vendorId: 0, productId: 0 },
        deviceScope: 'all',
        keymapSnapshot: SNAPSHOT,
        range: { fromMs: overrides.fromMs ?? FROM_MS, toMs: overrides.toMs ?? TO_MS },
        totalKeystrokes: overrides.totalKeystrokes ?? 200,
        appScopes: [],
      },
      filters: FILTERS,
      data: {
        minuteStats: [], matrixCells: [], matrixCellsByDay: [], layerUsage: [],
        sessions: [], bksMinute: [], bigramTop: [], bigramSlow: [],
        appUsage: [], wpmByApp: [],
        peakRecords: emptyPeakRecords(),
        layoutComparison: null,
      },
    } as const
  }

  it('accepts a payload at the threshold', () => {
    const result = validateAnalyticsExport(makeExport({ totalKeystrokes: ANALYTICS_MIN_KEYSTROKES }))
    expect(result.ok).toBe(true)
  })

  it('rejects below the keystroke threshold', () => {
    const result = validateAnalyticsExport(makeExport({ totalKeystrokes: ANALYTICS_MIN_KEYSTROKES - 1 }))
    expect(result).toEqual({ ok: false, reason: 'keystrokes below threshold' })
  })

  it('accepts a 30-day range exactly at the cap', () => {
    const result = validateAnalyticsExport(makeExport({
      fromMs: FROM_MS,
      toMs: FROM_MS + ANALYTICS_MAX_RANGE_MS,
    }))
    expect(result.ok).toBe(true)
  })

  it('rejects a range exceeding 30 days by 1 ms', () => {
    const result = validateAnalyticsExport(makeExport({
      fromMs: FROM_MS,
      toMs: FROM_MS + ANALYTICS_MAX_RANGE_MS + 1,
    }))
    expect(result).toEqual({ ok: false, reason: 'range exceeds 30 days' })
  })

  it('rejects an inverted range', () => {
    const result = validateAnalyticsExport(makeExport({ fromMs: TO_MS, toMs: FROM_MS }))
    expect(result.ok).toBe(false)
  })
})

describe('estimateAnalyticsExportSizeBytes', () => {
  it('returns the UTF-8 byte length of the JSON serialisation', async () => {
    const exportData = await buildAnalyticsExport(baseInput())
    const bytes = estimateAnalyticsExportSizeBytes(exportData)
    expect(bytes).toBe(Buffer.byteLength(JSON.stringify(exportData), 'utf-8'))
    // Smoke check: the export with 2 minute rows and a couple of app
    // entries should land in the kilobyte range, not megabytes.
    expect(bytes).toBeGreaterThan(100)
    expect(bytes).toBeLessThan(50_000)
  })
})
