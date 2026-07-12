// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  aggregateFingerPairs,
  buildKeycodeFingerMap,
} from '../analyze-bigram-finger'
import { deserialize, getProtocol, setProtocol } from '../../../../shared/keycodes/keycodes'
import { parseKle } from '../../../../shared/kle/kle-parser'
import type { FingerType } from '../../../../shared/kle/kle-ergonomics'
import type { TypingBigramTopEntry, TypingKeymapSnapshot } from '../../../../shared/types/typing-analytics'

function entry(
  ngramId: string,
  count: number,
  hist: number[] = [0, 0, 0, 0, 0, 0, 0, 0],
): TypingBigramTopEntry {
  return { ngramId, count, hist, avgIki: null }
}

/** Resolve `qmkId` to its numeric code under a specific protocol,
 * restoring the global protocol afterwards. */
function deserializeUnderProtocol(qmkId: string, protocol: number): number {
  const prev = getProtocol()
  setProtocol(protocol)
  try {
    return deserialize(qmkId)
  } finally {
    setProtocol(prev)
  }
}

function snapshotWithKeymap(keymap: string[][][]): TypingKeymapSnapshot {
  return {
    uid: '0x00',
    machineHash: 'h',
    productName: 'Test',
    savedAt: 0,
    layers: keymap.length,
    matrix: { rows: keymap[0]?.length ?? 0, cols: keymap[0]?.[0]?.length ?? 0 },
    keymap,
    layout: null,
  }
}

describe('aggregateFingerPairs', () => {
  const fingerMap = new Map<number, FingerType>([
    [1, 'left-index'],
    [2, 'right-middle'],
    [3, 'right-index'],
  ])

  it('returns empty totals for empty entries', () => {
    expect(aggregateFingerPairs([], fingerMap).size).toBe(0)
  })

  it('groups by (prevFinger, currFinger) and sums count + hist', () => {
    const totals = aggregateFingerPairs(
      [
        entry('1_2', 3, [3, 0, 0, 0, 0, 0, 0, 0]),
        entry('1_2', 2, [0, 2, 0, 0, 0, 0, 0, 0]),
        entry('2_3', 1, [0, 0, 1, 0, 0, 0, 0, 0]),
      ],
      fingerMap,
    )
    expect(totals.get('left-index_right-middle')).toEqual({
      count: 5,
      hist: [3, 2, 0, 0, 0, 0, 0, 0],
    })
    expect(totals.get('right-middle_right-index')).toEqual({
      count: 1,
      hist: [0, 0, 1, 0, 0, 0, 0, 0],
    })
  })

  it('drops pairs whose keycodes are unmapped', () => {
    const totals = aggregateFingerPairs(
      [entry('99_2', 5)], // 99 not in fingerMap
      fingerMap,
    )
    expect(totals.size).toBe(0)
  })

  it('drops pairs with malformed bigramId', () => {
    const totals = aggregateFingerPairs(
      [entry('bad', 1), entry('1_2', 1)],
      fingerMap,
    )
    expect(totals.size).toBe(1)
    expect(totals.get('left-index_right-middle')?.count).toBe(1)
  })
})

describe('buildKeycodeFingerMap', () => {
  const keys = parseKle([['0,0']]).keys

  it('resolves snapshot keycodes under the snapshot vialProtocol', () => {
    // QK_BOOT is protocol-dependent (0x5c00 in v5, 0x7c00 in v6), so it
    // exercises the protocol plumbing the same way key-heatmap-helpers
    // does for Speed mode.
    const v5BootCode = deserializeUnderProtocol('QK_BOOT', 5)
    const v6BootCode = deserializeUnderProtocol('QK_BOOT', 6)
    expect(v5BootCode).not.toBe(v6BootCode)

    const snapshot = snapshotWithKeymap([[['QK_BOOT']]])
    const overrides: Record<string, FingerType> = { '0,0': 'left-index' }

    // Without a snapshot protocol, QK_BOOT resolves under the current
    // default (v6) and the map is keyed by the v6 code.
    const withoutProtocol = buildKeycodeFingerMap(snapshot, keys, overrides)
    expect(withoutProtocol.get(v5BootCode)).toBeUndefined()
    expect(withoutProtocol.get(v6BootCode)).toBe('left-index')

    // With vialProtocol=5 the map is keyed by the v5 code instead —
    // matching what a v5 snapshot's recorded bigram data uses.
    const withProtocol = buildKeycodeFingerMap(snapshot, keys, overrides, 5)
    expect(withProtocol.get(v5BootCode)).toBe('left-index')
    expect(withProtocol.get(v6BootCode)).toBeUndefined()
  })

  it('restores the global protocol after resolving', () => {
    const prev = getProtocol()
    const snapshot = snapshotWithKeymap([[['KC_A']]])
    buildKeycodeFingerMap(snapshot, keys, { '0,0': 'left-index' }, 5)
    expect(getProtocol()).toBe(prev)
  })

  it('returns an empty map for an empty keymap', () => {
    const snapshot = snapshotWithKeymap([])
    expect(buildKeycodeFingerMap(snapshot, keys, {}, 5).size).toBe(0)
  })
})
