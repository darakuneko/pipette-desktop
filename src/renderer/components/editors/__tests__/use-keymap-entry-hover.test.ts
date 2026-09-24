// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { hoverTargetOf, useKeymapEntryHover, type UseKeymapEntryHoverOptions } from '../use-keymap-entry-hover'
import { SHARED_BUBBLE_OPEN_DELAY_MS } from '../../../hooks/use-shared-hover-bubble'
import type { KleKey } from '../../../../shared/kle/types'
import type { MacroAction } from '../../../../preload/macro'

const getMacroIndex = vi.fn((code: number) => (code >= 20 && code < 30 ? code - 20 : -1))

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  getMacroIndex: (code: number) => getMacroIndex(code),
  isTapDanceKeycode: (code: number) => (code & 0xff00) === 0x5700,
  getTapDanceIndex: (code: number) => code & 0xff,
}))

const MACROS: MacroAction[][] = [[{ type: 'tap', keycodes: [4] }], [{ type: 'delay', delay: 10 }]]
const key = (col: number): KleKey => ({ row: 0, col } as KleKey)
const rect = new DOMRect(1, 2, 3, 4)

function options(overrides: Partial<UseKeymapEntryHoverOptions> = {}): UseKeymapEntryHoverOptions {
  return {
    macros: MACROS,
    enabled: true,
    disabled: false,
    currentLayer: 0,
    keymap: new Map([['0,0,0', 20], ['0,0,1', 4], ['1,0,0', 21]]),
    encoderLayout: new Map([['0,0,0', 21], ['0,0,1', 20]]),
    deviceKey: 'uid',
    surfaceKey: 'none',
    ...overrides,
  }
}

describe('hoverTargetOf', () => {
  it('returns the macro or Tap Dance a raw keycode points at, and null otherwise', () => {
    expect(hoverTargetOf(21)).toEqual({ kind: 'macro', index: 1 })
    expect(hoverTargetOf(0x5703)).toEqual({ kind: 'tapDance', index: 3 })
    expect(hoverTargetOf(4)).toBeNull()
    expect(hoverTargetOf(undefined)).toBeNull()
  })

  it('checks the Tap Dance range before reading the low byte', () => {
    // 0x5803 has low byte 3 but is not a Tap Dance keycode.
    expect(hoverTargetOf(0x5803)).toBeNull()
  })
})

describe('useKeymapEntryHover', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getMacroIndex.mockClear()
  })
  afterEach(() => { vi.useRealTimers() })

  it('keeps its callbacks stable across edits, layer switches and toggles', () => {
    const { result, rerender } = renderHook((o: UseKeymapEntryHoverOptions) => useKeymapEntryHover(o), { initialProps: options() })
    const first = result.current
    rerender(options({ currentLayer: 1, keymap: new Map(), encoderLayout: new Map(), macros: [], enabled: false, disabled: true }))
    expect(result.current.onKeyHover).toBe(first.onKeyHover)
    expect(result.current.onEncoderHover).toBe(first.onEncoderHover)
    expect(result.current.hide).toBe(first.hide)
  })

  it('resolves keys and encoder directions from the raw maps on the current layer', () => {
    const { result, rerender } = renderHook((o: UseKeymapEntryHoverOptions) => useKeymapEntryHover(o), { initialProps: options() })
    act(() => result.current.onKeyHover(key(0), 'Remapped', rect))
    act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS) })
    expect(result.current.bubble).toEqual({ index: 0, entry: { kind: 'macro', value: MACROS[0] }, rect })

    act(() => result.current.onEncoderHover(0, 0, rect))
    act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS) })
    expect(result.current.bubble?.index).toBe(1)

    rerender(options({ currentLayer: 1 }))
    act(() => result.current.onKeyHover(key(0), 'KC_A', rect))
    act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS) })
    expect(result.current.bubble?.index).toBe(1)
  })

  it('never decodes a keycode while off or disabled', () => {
    const { result } = renderHook(() => useKeymapEntryHover(options({ enabled: false })))
    act(() => result.current.onKeyHover(key(0), 'M0', rect))
    const disabled = renderHook(() => useKeymapEntryHover(options({ disabled: true })))
    act(() => disabled.result.current.onEncoderHover(0, 1, rect))
    act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS) })
    expect(getMacroIndex).not.toHaveBeenCalled()
    expect(result.current.bubble).toBeNull()
    expect(disabled.result.current.bubble).toBeNull()
  })

  it('a device or surface change closes the bubble', () => {
    const { result, rerender } = renderHook((o: UseKeymapEntryHoverOptions) => useKeymapEntryHover(o), { initialProps: options() })
    act(() => result.current.onKeyHover(key(0), 'M0', rect))
    act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS) })
    expect(result.current.bubble).not.toBeNull()
    rerender(options({ deviceKey: 'other' }))
    expect(result.current.bubble).toBeNull()

    act(() => result.current.onKeyHover(key(0), 'M0', rect))
    act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS) })
    rerender(options({ deviceKey: 'other', surfaceKey: 'base' }))
    expect(result.current.bubble).toBeNull()
  })
})
