// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildBigramsCsv } from '../analyze-csv-builders'
import { deserialize } from '../../../../shared/keycodes/keycodes'
import { parseKle } from '../../../../shared/kle/kle-parser'
import type { FingerType } from '../../../../shared/kle/kle-ergonomics'
import type {
  TypingBigramAggregateResult,
  TypingKeymapSnapshot,
} from '../../../../shared/types/typing-analytics'

const fetchSpy = vi.fn<(...args: unknown[]) => Promise<TypingBigramAggregateResult>>()

Object.defineProperty(window, 'vialAPI', {
  value: {
    typingAnalyticsGetBigramAggregateForRange: (...args: unknown[]) => fetchSpy(...args),
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
    expect(headers).toEqual(['bigram_id', 'count', 'avg_iki_ms', 'sd_iki_ms', 'class', 'word_position'])
    // No snapshot -> class stays blank, word_position still resolves.
    expect(rows[0]).toEqual([`${keSpace}_${keyA}`, '5', '400', '10', '', 'initiation'])
    expect(rows[1]).toEqual([`${keyA}_${keyB}`, '3', '30', '5', '', 'inWord'])
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
    expect(rows[0]).toEqual([`${keyA}_${keyB}`, '3', '30', '5', 'alternation', 'inWord'])
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
    expect(rows[0]).toEqual([`${keyA}_${keSpace}`, '2', '30', '0', '', 'excluded'])
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
    expect(headers).toEqual(['trigram_id', 'count', 'avg_iki_ms', 'sd_iki_ms', 'class', 'word_position'])
    expect(rows[0]).toEqual([`${keyA}_${keyB}_${keyA}`, '4', '30', '0', '', ''])
  })
})
