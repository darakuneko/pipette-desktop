// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useKeyboard } from '../useKeyboard'
import type { KeyboardDefinition } from '../../../shared/types/protocol'

const dummyDefinition: KeyboardDefinition = {
  name: 'Dummy 2x3',
  matrix: { rows: 2, cols: 3 },
  layouts: {
    keymap: [['0,0', '0,1', '0,2'], ['1,0', '1,1', '1,2']],
  },
}

const mockSetKeycode = vi.fn<() => Promise<void>>()
const mockSetEncoder = vi.fn<() => Promise<void>>()
const mockSetLayoutOptions = vi.fn<() => Promise<void>>()
const mockSetMacroBuffer = vi.fn<() => Promise<void>>()
const mockSetTapDance = vi.fn<() => Promise<void>>()
const mockSetCombo = vi.fn<() => Promise<void>>()
const mockSetKeyOverride = vi.fn<() => Promise<void>>()
const mockSetAltRepeatKey = vi.fn<() => Promise<void>>()

beforeEach(() => {
  mockSetKeycode.mockResolvedValue(undefined)
  mockSetEncoder.mockResolvedValue(undefined)
  mockSetLayoutOptions.mockResolvedValue(undefined)
  mockSetMacroBuffer.mockResolvedValue(undefined)
  mockSetTapDance.mockResolvedValue(undefined)
  mockSetCombo.mockResolvedValue(undefined)
  mockSetKeyOverride.mockResolvedValue(undefined)
  mockSetAltRepeatKey.mockResolvedValue(undefined)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).vialAPI = {
    setKeycode: mockSetKeycode,
    setEncoder: mockSetEncoder,
    setLayoutOptions: mockSetLayoutOptions,
    setMacroBuffer: mockSetMacroBuffer,
    setTapDance: mockSetTapDance,
    setCombo: mockSetCombo,
    setKeyOverride: mockSetKeyOverride,
    setAltRepeatKey: mockSetAltRepeatKey,
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useKeyboard — dummy mode', () => {
  describe('loadDummy', () => {
    it('initializes state from definition', () => {
      const { result } = renderHook(() => useKeyboard())

      act(() => {
        result.current.loadDummy(dummyDefinition)
      })

      expect(result.current.isDummy).toBe(true)
      expect(result.current.rows).toBe(2)
      expect(result.current.cols).toBe(3)
      expect(result.current.definition).toEqual(dummyDefinition)
    })

    it('sets layers=4, macroCount=16, macroBufferSize=900', () => {
      const { result } = renderHook(() => useKeyboard())

      act(() => {
        result.current.loadDummy(dummyDefinition)
      })

      expect(result.current.layers).toBe(4)
      expect(result.current.macroCount).toBe(16)
      expect(result.current.macroBufferSize).toBe(900)
    })

    it('initializes keymap with all keys as KC_NO (0x0000)', () => {
      const { result } = renderHook(() => useKeyboard())

      act(() => {
        result.current.loadDummy(dummyDefinition)
      })

      // 4 layers * 2 rows * 3 cols = 24 keys
      expect(result.current.keymap.size).toBe(24)
      for (const keycode of result.current.keymap.values()) {
        expect(keycode).toBe(0x0000)
      }
    })

    it('sets unlocked=true', () => {
      const { result } = renderHook(() => useKeyboard())

      act(() => {
        result.current.loadDummy(dummyDefinition)
      })

      expect(result.current.unlockStatus.unlocked).toBe(true)
      expect(result.current.unlockStatus.inProgress).toBe(false)
    })

    it('sets layoutOptions=0', () => {
      const { result } = renderHook(() => useKeyboard())

      act(() => {
        result.current.loadDummy(dummyDefinition)
      })

      expect(result.current.layoutOptions).toBe(0)
    })

    it('parses KLE layout', () => {
      const { result } = renderHook(() => useKeyboard())

      act(() => {
        result.current.loadDummy(dummyDefinition)
      })

      expect(result.current.layout).not.toBeNull()
      expect(result.current.layout!.keys.length).toBeGreaterThan(0)
    })

    it('initializes macro buffer with zeros', () => {
      const { result } = renderHook(() => useKeyboard())

      act(() => {
        result.current.loadDummy(dummyDefinition)
      })

      expect(result.current.macroBuffer.length).toBe(900)
      expect(result.current.macroBuffer.every((b) => b === 0)).toBe(true)
    })
  })

  describe('setters skip vialAPI when isDummy', () => {
    it('setKey updates state without calling vialAPI.setKeycode', async () => {
      const { result } = renderHook(() => useKeyboard())

      act(() => {
        result.current.loadDummy(dummyDefinition)
      })

      await act(async () => {
        await result.current.setKey(0, 0, 0, 0x0004)
      })

      expect(mockSetKeycode).not.toHaveBeenCalled()
      expect(result.current.keymap.get('0,0,0')).toBe(0x0004)
    })

    it('setEncoder updates state without calling vialAPI.setEncoder', async () => {
      const { result } = renderHook(() => useKeyboard())

      act(() => {
        result.current.loadDummy(dummyDefinition)
      })

      await act(async () => {
        await result.current.setEncoder(0, 0, 0, 0x0004)
      })

      expect(mockSetEncoder).not.toHaveBeenCalled()
      expect(result.current.encoderLayout.get('0,0,0')).toBe(0x0004)
    })

    it('setLayoutOptions updates state without calling vialAPI.setLayoutOptions', async () => {
      const { result } = renderHook(() => useKeyboard())

      act(() => {
        result.current.loadDummy(dummyDefinition)
      })

      await act(async () => {
        await result.current.setLayoutOptions(1)
      })

      expect(mockSetLayoutOptions).not.toHaveBeenCalled()
      expect(result.current.layoutOptions).toBe(1)
    })

    it('setMacroBuffer updates state without calling vialAPI.setMacroBuffer', async () => {
      const { result } = renderHook(() => useKeyboard())

      act(() => {
        result.current.loadDummy(dummyDefinition)
      })

      const newBuffer = [1, 2, 3]
      await act(async () => {
        await result.current.setMacroBuffer(newBuffer)
      })

      expect(mockSetMacroBuffer).not.toHaveBeenCalled()
      expect(result.current.macroBuffer).toEqual(newBuffer)
    })
  })
})
