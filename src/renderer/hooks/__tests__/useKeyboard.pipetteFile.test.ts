// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useKeyboard } from '../useKeyboard'
import type { KeyboardDefinition, VilFile } from '../../../shared/types/protocol'

const testDefinition: KeyboardDefinition = {
  name: 'Test KB',
  matrix: { rows: 2, cols: 3 },
  layouts: {
    keymap: [['0,0', '0,1', '0,2'], ['1,0', '1,1', '1,2']],
  },
}

function makeV2Vil(overrides?: Partial<VilFile>): VilFile {
  return {
    version: 2,
    uid: '0x1234567890ABCDEF',
    keymap: {
      '0,0,0': 4, '0,0,1': 5, '0,0,2': 6,
      '0,1,0': 7, '0,1,1': 8, '0,1,2': 9,
      '1,0,0': 10, '1,0,1': 11, '1,0,2': 12,
      '1,1,0': 13, '1,1,1': 14, '1,1,2': 15,
    },
    encoderLayout: {},
    macros: [],
    layoutOptions: 0,
    tapDance: [{ onTap: 4, onHold: 5, onDoubleTap: 6, onTapHold: 7, tappingTerm: 200 }],
    combo: [{ key1: 4, key2: 5, key3: 0, key4: 0, output: 6 }],
    keyOverride: [],
    altRepeatKey: [],
    qmkSettings: { '1': [100], '2': [200] },
    layerNames: ['Base', 'Nav'],
    definition: testDefinition,
    ...overrides,
  }
}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).vialAPI = {
    setKeycode: vi.fn().mockResolvedValue(undefined),
    setEncoder: vi.fn().mockResolvedValue(undefined),
    setLayoutOptions: vi.fn().mockResolvedValue(undefined),
    setMacroBuffer: vi.fn().mockResolvedValue(undefined),
    setTapDance: vi.fn().mockResolvedValue(undefined),
    setCombo: vi.fn().mockResolvedValue(undefined),
    setKeyOverride: vi.fn().mockResolvedValue(undefined),
    setAltRepeatKey: vi.fn().mockResolvedValue(undefined),
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useKeyboard — pipette file mode', () => {
  describe('loadPipetteFile', () => {
    it('populates full state from v2 vil file', () => {
      const { result } = renderHook(() => useKeyboard())
      const vil = makeV2Vil()

      act(() => {
        result.current.loadPipetteFile(vil)
      })

      expect(result.current.isDummy).toBe(true)
      expect(result.current.uid).toBe('0x1234567890ABCDEF')
      expect(result.current.rows).toBe(2)
      expect(result.current.cols).toBe(3)
      expect(result.current.layers).toBe(2)
      expect(result.current.definition).toEqual(testDefinition)
    })

    it('populates keymap data', () => {
      const { result } = renderHook(() => useKeyboard())
      const vil = makeV2Vil()

      act(() => {
        result.current.loadPipetteFile(vil)
      })

      expect(result.current.keymap.get('0,0,0')).toBe(4)
      expect(result.current.keymap.get('1,1,2')).toBe(15)
    })

    it('populates dynamic entries', () => {
      const { result } = renderHook(() => useKeyboard())
      const vil = makeV2Vil()

      act(() => {
        result.current.loadPipetteFile(vil)
      })

      expect(result.current.tapDanceEntries).toHaveLength(1)
      expect(result.current.tapDanceEntries[0].tappingTerm).toBe(200)
      expect(result.current.comboEntries).toHaveLength(1)
      expect(result.current.dynamicCounts.tapDance).toBe(1)
      expect(result.current.dynamicCounts.combo).toBe(1)
    })

    it('populates QMK settings and supportedQsids', () => {
      const { result } = renderHook(() => useKeyboard())
      const vil = makeV2Vil()

      act(() => {
        result.current.loadPipetteFile(vil)
      })

      expect(result.current.supportedQsids.has(1)).toBe(true)
      expect(result.current.supportedQsids.has(2)).toBe(true)
      expect(result.current.qmkSettingsValues).toEqual({ '1': [100], '2': [200] })
    })

    it('populates layer names', () => {
      const { result } = renderHook(() => useKeyboard())
      const vil = makeV2Vil()

      act(() => {
        result.current.loadPipetteFile(vil)
      })

      expect(result.current.layerNames).toEqual(['Base', 'Nav'])
    })

    it('sets unlockStatus to unlocked', () => {
      const { result } = renderHook(() => useKeyboard())
      const vil = makeV2Vil()

      act(() => {
        result.current.loadPipetteFile(vil)
      })

      expect(result.current.unlockStatus.unlocked).toBe(true)
    })

    it('throws for v1 files without definition', () => {
      const { result } = renderHook(() => useKeyboard())
      const vil = makeV2Vil({ definition: undefined })

      expect(() => {
        act(() => {
          result.current.loadPipetteFile(vil)
        })
      }).toThrow('v2 file with an embedded definition')
    })
  })

  describe('pipetteFile QMK settings wrappers', () => {
    it('pipetteFileQmkSettingsGet reads from local state', async () => {
      const { result } = renderHook(() => useKeyboard())

      act(() => {
        result.current.loadPipetteFile(makeV2Vil())
      })

      const data = await result.current.pipetteFileQmkSettingsGet(1)
      expect(data).toEqual([100])
    })

    it('pipetteFileQmkSettingsGet returns empty array for unknown qsid', async () => {
      const { result } = renderHook(() => useKeyboard())

      act(() => {
        result.current.loadPipetteFile(makeV2Vil())
      })

      const data = await result.current.pipetteFileQmkSettingsGet(999)
      expect(data).toEqual([])
    })

    it('pipetteFileQmkSettingsSet updates local state', async () => {
      const { result } = renderHook(() => useKeyboard())

      act(() => {
        result.current.loadPipetteFile(makeV2Vil())
      })

      await act(async () => {
        await result.current.pipetteFileQmkSettingsSet(1, [42])
      })

      expect(result.current.qmkSettingsValues['1']).toEqual([42])
      // Other values unchanged
      expect(result.current.qmkSettingsValues['2']).toEqual([200])
    })

    it('pipetteFileQmkSettingsReset restores baseline values', async () => {
      const { result } = renderHook(() => useKeyboard())

      act(() => {
        result.current.loadPipetteFile(makeV2Vil())
      })

      // Modify a setting
      await act(async () => {
        await result.current.pipetteFileQmkSettingsSet(1, [42])
      })
      expect(result.current.qmkSettingsValues['1']).toEqual([42])

      // Reset to baseline
      await act(async () => {
        await result.current.pipetteFileQmkSettingsReset()
      })

      expect(result.current.qmkSettingsValues['1']).toEqual([100])
      expect(result.current.qmkSettingsValues['2']).toEqual([200])
    })
  })
})
