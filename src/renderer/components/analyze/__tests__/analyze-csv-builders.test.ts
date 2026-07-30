// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TFunction } from 'i18next'
import { buildBigramsCsv, buildDurationDistributionCsv, buildHeatmapCsv, buildIntervalCsv } from '../analyze-csv-builders'
import { deserialize } from '../../../../shared/keycodes/keycodes'
import { parseKle } from '../../../../shared/kle/kle-parser'
import type { FingerType } from '../../../../shared/kle/kle-ergonomics'
import type { HeatmapFilters } from '../../../../shared/types/analyze-filters'
import type {
  TypingBigramAggregateResult,
  TypingDurationCell,
  TypingHeatmapByCell,
  TypingKeymapSnapshot,
  TypingMinuteStatsRow,
} from '../../../../shared/types/typing-analytics'

const fetchSpy = vi.fn<(...args: unknown[]) => Promise<TypingBigramAggregateResult>>()
const matrixHeatmapSpy = vi.fn<(...args: unknown[]) => Promise<TypingHeatmapByCell>>()
const durationCellsSpy = vi.fn<(...args: unknown[]) => Promise<TypingDurationCell[]>>()
const minuteStatsSpy = vi.fn<(...args: unknown[]) => Promise<TypingMinuteStatsRow[]>>()

Object.defineProperty(window, 'vialAPI', {
  value: {
    typingAnalyticsGetBigramAggregateForRange: (...args: unknown[]) => fetchSpy(...args),
    typingAnalyticsGetMatrixHeatmapForRange: (...args: unknown[]) => matrixHeatmapSpy(...args),
    typingAnalyticsListDurationCells: (...args: unknown[]) => durationCellsSpy(...args),
    typingAnalyticsListMinuteStatsLocal: (...args: unknown[]) => minuteStatsSpy(...args),
  },
  writable: true,
})

const range = { fromMs: 0, toMs: 60_000 }
const scopeArgs = { uid: '0xAABB', range, deviceScope: 'own' as const }

const layout = parseKle([['0,0', '0,1']])
const keyA = deserialize('KC_A')
const keyB = deserialize('KC_B')
const keSpace = deserialize('KC_SPACE')

function buildSnapshot(): TypingKeymapSnapshot {
  return {
    uid: '0x00',
    machineHash: 'h',
    productName: 'Test',
    savedAt: 0,
    layers: 1,
    matrix: { rows: 1, cols: 2 },
    keymap: [[['KC_A', 'KC_B']]],
    layout,
  }
}

const fingerOverrides: Record<string, FingerType> = {
  '0,0': 'left-index',
  '0,1': 'right-index',
}

function parseCsv(content: string): { headers: string[]; rows: string[][] } {
  const [headerLine, ...dataLines] = content.split('\n')
  return {
    headers: headerLine?.split(',') ?? [],
    rows: dataLines.filter((l) => l.length > 0).map((l) => l.split(',')),
  }
}

describe('buildBigramsCsv', () => {
  beforeEach(() => {
    fetchSpy.mockReset()
  })

  it('adds a word_position column populated for gram === 2 even without a snapshot', async () => {
    fetchSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { ngramId: `${keSpace}_${keyA}`, count: 5, hist: [0, 0, 0, 0, 0, 5, 0, 0], avgIki: 400, sd: 10 },
        { ngramId: `${keyA}_${keyB}`, count: 3, hist: [3, 0, 0, 0, 0, 0, 0, 0], avgIki: 30, sd: 5 },
      ],
      truncated: false,
    })
    const result = await buildBigramsCsv({ ...scopeArgs, gram: 2, snapshot: null })
    const { headers, rows } = parseCsv(result.content)
    expect(headers).toEqual(['bigram_id', 'count', 'avg_iki_ms', 'sd_iki_ms', 'class', 'word_position', 'observed_rollover_percent'])
    // No snapshot -> class stays blank, word_position still resolves.
    // Neither fixture entry carries overlapCount/overlapN -> the new
    // column is empty (unobserved), not 0.
    expect(rows[0]).toEqual([`${keSpace}_${keyA}`, '5', '400', '10', '', 'initiation', ''])
    expect(rows[1]).toEqual([`${keyA}_${keyB}`, '3', '30', '5', '', 'inWord', ''])
  })

  it('populates both class and word_position when a snapshot is supplied', async () => {
    fetchSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { ngramId: `${keyA}_${keyB}`, count: 3, hist: [3, 0, 0, 0, 0, 0, 0, 0], avgIki: 30, sd: 5 },
      ],
      truncated: false,
    })
    const result = await buildBigramsCsv({
      ...scopeArgs, gram: 2, snapshot: buildSnapshot(), fingerOverrides,
    })
    const { rows } = parseCsv(result.content)
    expect(rows[0]).toEqual([`${keyA}_${keyB}`, '3', '30', '5', 'alternation', 'inWord', ''])
  })

  it('excludes a pair ending at a separator from word_position via the "excluded" value', async () => {
    fetchSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { ngramId: `${keyA}_${keSpace}`, count: 2, hist: [2, 0, 0, 0, 0, 0, 0, 0], avgIki: 30, sd: 0 },
      ],
      truncated: false,
    })
    const result = await buildBigramsCsv({ ...scopeArgs, gram: 2, snapshot: null })
    const { rows } = parseCsv(result.content)
    expect(rows[0]).toEqual([`${keyA}_${keSpace}`, '2', '30', '0', '', 'excluded', ''])
  })

  it('leaves word_position blank for trigrams, matching the class column', async () => {
    fetchSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { ngramId: `${keyA}_${keyB}_${keyA}`, count: 4, hist: [4, 0, 0, 0, 0, 0, 0, 0], avgIki: 30, sd: 0 },
      ],
      truncated: false,
    })
    const result = await buildBigramsCsv({ ...scopeArgs, gram: 3, snapshot: buildSnapshot(), fingerOverrides })
    const { headers, rows } = parseCsv(result.content)
    expect(headers).toEqual(['trigram_id', 'count', 'avg_iki_ms', 'sd_iki_ms', 'class', 'word_position', 'observed_rollover_percent'])
    expect(rows[0]).toEqual([`${keyA}_${keyB}_${keyA}`, '4', '30', '0', '', '', ''])
  })

  it('renders observed_rollover_percent with 1 decimal when the entry has overlap data', async () => {
    fetchSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { ngramId: `${keyA}_${keyB}`, count: 4, hist: [4, 0, 0, 0, 0, 0, 0, 0], avgIki: 30, sd: 0, overlapCount: 1, overlapN: 3 },
      ],
      truncated: false,
    })
    const result = await buildBigramsCsv({ ...scopeArgs, gram: 2, snapshot: null })
    const { rows } = parseCsv(result.content)
    expect(rows[0]).toEqual([`${keyA}_${keyB}`, '4', '30', '0', '', 'inWord', '33.3'])
  })

  it('renders observed_rollover_percent as 0.0 (not empty) when overlapCount is a real observed zero', async () => {
    fetchSpy.mockResolvedValue({
      view: 'top',
      entries: [
        { ngramId: `${keyA}_${keyB}`, count: 4, hist: [4, 0, 0, 0, 0, 0, 0, 0], avgIki: 30, sd: 0, overlapCount: 0, overlapN: 5 },
      ],
      truncated: false,
    })
    const result = await buildBigramsCsv({ ...scopeArgs, gram: 2, snapshot: null })
    const { rows } = parseCsv(result.content)
    expect(rows[0]).toEqual([`${keyA}_${keyB}`, '4', '30', '0', '', 'inWord', '0.0'])
  })
})

describe('buildHeatmapCsv', () => {
  const heatmapFilters: Required<HeatmapFilters> = {
    selectedLayers: [0],
    groups: [[0]],
    frequentUsedN: 5,
    aggregateMode: 'cell',
    normalization: 'absolute',
    keyGroupFilter: 'all',
    mode: 'count',
  }
  const fakeT = ((key: string, params?: Record<string, unknown>) =>
    (params ? `${key}:${JSON.stringify(params)}` : key)) as TFunction

  beforeEach(() => {
    matrixHeatmapSpy.mockReset()
    durationCellsSpy.mockReset()
  })

  it('appends avg_duration_ms / duration_samples columns to the existing ranking rows', async () => {
    matrixHeatmapSpy.mockResolvedValue({
      '0,0': { total: 5, tap: 5, hold: 0 },
      '0,1': { total: 3, tap: 3, hold: 0 },
    })
    durationCellsSpy.mockResolvedValue([
      { row: 0, col: 0, layer: 0, durationSamples: 10, hist: [0, 0, 0, 10, 0, 0, 0, 0], sum: 1_000, sumSq: 100_000 },
    ])
    const result = await buildHeatmapCsv({ ...scopeArgs, snapshot: buildSnapshot(), heatmap: heatmapFilters, t: fakeT })
    const { headers, rows } = parseCsv(result.content)
    expect(headers).toEqual(['group_idx', 'group_label', 'rank', 'key_label', 'layer_label', 'matrix_label', 'count', 'avg_duration_ms', 'duration_samples'])
    const aRow = rows.find((r) => r[3] === 'A')
    expect(aRow?.[7]).toBe('100')
    expect(aRow?.[8]).toBe('10')
    // No duration data for this key -> empty strings, not a fabricated 0.
    const bRow = rows.find((r) => r[3] === 'B')
    expect(bRow?.[7]).toBe('')
    expect(bRow?.[8]).toBe('')
  })

  it('leaves duration columns empty (not a crash) when the duration fetch fails', async () => {
    matrixHeatmapSpy.mockResolvedValue({ '0,0': { total: 5, tap: 5, hold: 0 } })
    durationCellsSpy.mockRejectedValue(new Error('boom'))
    const result = await buildHeatmapCsv({ ...scopeArgs, snapshot: buildSnapshot(), heatmap: heatmapFilters, t: fakeT })
    const { rows } = parseCsv(result.content)
    expect(rows[0][7]).toBe('')
    expect(rows[0][8]).toBe('')
  })
})

describe('buildIntervalCsv', () => {
  beforeEach(() => {
    minuteStatsSpy.mockReset()
    minuteStatsSpy.mockResolvedValue([])
  })

  it('returns the interval bundle in timeSeries mode', async () => {
    const result = await buildIntervalCsv({ ...scopeArgs, granularity: 'auto', viewMode: 'timeSeries' })
    expect(result.slug).toBe('analyze-interval')
  })

  it('returns the interval-distribution bundle in distribution mode', async () => {
    const result = await buildIntervalCsv({ ...scopeArgs, granularity: 'auto', viewMode: 'distribution' })
    expect(result.slug).toBe('analyze-interval-distribution')
  })
})

describe('buildDurationDistributionCsv', () => {
  beforeEach(() => {
    durationCellsSpy.mockReset()
  })

  it('includes bucket_id, upper_bound_ms, center_ms, count, and share_percent columns', async () => {
    durationCellsSpy.mockResolvedValue([
      { row: 0, col: 0, layer: 0, durationSamples: 4, hist: [4, 0, 0, 0, 0, 0, 0, 0], sum: 200, sumSq: 10_000 },
    ])
    const result = await buildDurationDistributionCsv(scopeArgs)
    expect(result.slug).toBe('analyze-duration-distribution')
    const { headers, rows } = parseCsv(result.content)
    expect(headers).toEqual(['bucket_id', 'upper_bound_ms', 'center_ms', 'count', 'share_percent'])
    expect(rows[0]).toEqual(['0', '50', '25', '4', '100'])
  })

  it('emits an all-zero duration histogram (not a missing bundle) when no cell has data', async () => {
    durationCellsSpy.mockResolvedValue([])
    const result = await buildDurationDistributionCsv(scopeArgs)
    const { rows } = parseCsv(result.content)
    expect(rows).toHaveLength(8)
    expect(rows.every((r) => r[3] === '0' && r[4] === '0')).toBe(true)
  })
})
