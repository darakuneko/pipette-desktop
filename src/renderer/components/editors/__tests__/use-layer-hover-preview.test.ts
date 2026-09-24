// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLayerHoverPreview, type UseLayerHoverPreviewOptions } from '../use-layer-hover-preview'
import { SHARED_BUBBLE_OPEN_DELAY_MS } from '../../../hooks/use-shared-hover-bubble'
import type { KleKey } from '../../../../shared/kle/types'

const CODES: Record<number, string> = {
  1: 'MO(1)',
  2: 'LT2(KC_B)',
  3: 'MO(0)',
  4: 'MO(5)',
  10: 'KC_A',
  11: 'KC_1',
  12: 'KC_2',
  13: 'KC_3',
}

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => CODES[code] ?? 'KC_NO',
  isMask: () => false,
  findInnerKeycode: () => undefined,
}))

// Layer 0 row 0: MO(1), KC_A, LT2(KC_B), MO(0), MO(5), MO(1)
// Layer 1 row 0: KC_1 everywhere; layer 2 row 0: KC_2 everywhere.
const LAYER0 = [1, 10, 2, 3, 4, 1]
function makeKeymap(): Map<string, number> {
  const m = new Map<string, number>()
  LAYER0.forEach((code, col) => m.set(`0,0,${col}`, code))
  for (let col = 0; col < LAYER0.length; col++) {
    m.set(`1,0,${col}`, 11)
    m.set(`2,0,${col}`, 12)
  }
  return m
}

const key = (col: number): KleKey => ({ row: 0, col } as KleKey)

// The real layer as the pane displays it.
const REAL_KEYCODES = new Map(LAYER0.map((code, col) => [`0,${col}`, CODES[code]]))
const REAL_REMAPPED = new Set<string>()

function baseOptions(overrides: Partial<UseLayerHoverPreviewOptions> = {}): UseLayerHoverPreviewOptions {
  return {
    layers: 3,
    currentLayer: 0,
    keymap: makeKeymap(),
    encoderLayout: new Map([['1,0,0', 13], ['1,0,1', 11]]),
    encoderCount: 1,
    raw: false,
    disabled: false,
    surfaceKey: 'none',
    deviceKey: 'uid-a',
    realKeycodes: REAL_KEYCODES,
    realRemappedKeys: REAL_REMAPPED,
    ...overrides,
  }
}

function setup(overrides: Partial<UseLayerHoverPreviewOptions> = {}) {
  return renderHook((props: UseLayerHoverPreviewOptions) => useLayerHoverPreview(props), {
    initialProps: baseOptions(overrides),
  })
}

function dwell(): void {
  act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS) })
}

describe('useLayerHoverPreview', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('shows the target layer only after the dwell', () => {
    const { result } = setup()
    act(() => result.current.onKeyHover(key(0)))
    act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS - 1) })
    expect(result.current.previewLayer).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current.previewLayer).toBe(1)
    expect(result.current.keycodes.get('0,1')).toBe('KC_1')
    expect(result.current.encoderKeycodes.get('0')).toEqual(['KC_3', 'KC_1'])
  })

  it('resolves LT(n, kc) to layer n', () => {
    const { result } = setup()
    act(() => result.current.onKeyHover(key(2)))
    dwell()
    expect(result.current.previewLayer).toBe(2)
  })

  it('leaving the key before the dwell never shows a preview', () => {
    const { result } = setup()
    act(() => result.current.onKeyHover(key(0)))
    act(() => { vi.advanceTimersByTime(100) })
    act(() => result.current.onKeyHoverEnd())
    dwell()
    expect(result.current.previewLayer).toBeNull()
  })

  it('leaving the key hides a visible preview immediately', () => {
    const { result } = setup()
    act(() => result.current.onKeyHover(key(0)))
    dwell()
    expect(result.current.previewLayer).toBe(1)
    act(() => result.current.onKeyHoverEnd())
    expect(result.current.previewLayer).toBeNull()
  })

  it('moving A -> B quickly restarts the dwell for B only', () => {
    const { result } = setup()
    act(() => result.current.onKeyHover(key(0)))
    act(() => { vi.advanceTimersByTime(200) })
    act(() => result.current.onKeyHoverEnd())
    act(() => result.current.onKeyHover(key(2)))
    act(() => { vi.advanceTimersByTime(200) })
    expect(result.current.previewLayer).toBeNull()
    act(() => { vi.advanceTimersByTime(100) })
    expect(result.current.previewLayer).toBe(2)
  })

  it('ignores a non-layer key', () => {
    const { result } = setup()
    act(() => result.current.onKeyHover(key(1)))
    dwell()
    expect(result.current.previewLayer).toBeNull()
  })

  it('ignores a layer key targeting the current layer', () => {
    const { result } = setup()
    act(() => result.current.onKeyHover(key(3)))
    dwell()
    expect(result.current.previewLayer).toBeNull()
  })

  it('ignores a layer key targeting a layer the keyboard does not have', () => {
    const { result } = setup()
    act(() => result.current.onKeyHover(key(4)))
    dwell()
    expect(result.current.previewLayer).toBeNull()
  })

  it('ignores a position missing from the keymap', () => {
    const { result } = setup()
    act(() => result.current.onKeyHover({ row: 5, col: 5 } as KleKey))
    dwell()
    expect(result.current.previewLayer).toBeNull()
  })

  it('does nothing while disabled', () => {
    const { result } = setup({ disabled: true })
    act(() => result.current.onKeyHover(key(0)))
    dwell()
    expect(result.current.previewLayer).toBeNull()
  })

  it('becoming disabled cancels a visible preview and a pending one', () => {
    const { result, rerender } = setup()
    act(() => result.current.onKeyHover(key(0)))
    dwell()
    rerender(baseOptions({ disabled: true }))
    expect(result.current.previewLayer).toBeNull()
    rerender(baseOptions())
    expect(result.current.previewLayer).toBeNull()

    act(() => result.current.onKeyHover(key(0)))
    rerender(baseOptions({ disabled: true }))
    rerender(baseOptions())
    dwell()
    expect(result.current.previewLayer).toBeNull()
  })

  it('a real layer change cancels the preview', () => {
    const opts = baseOptions()
    const { result, rerender } = setup()
    rerender(opts)
    act(() => result.current.onKeyHover(key(0)))
    dwell()
    rerender({ ...opts, currentLayer: 2 })
    expect(result.current.previewLayer).toBeNull()
    rerender(opts)
    expect(result.current.previewLayer).toBeNull()
  })

  it('a keymap edit cancels a visible and a pending preview', () => {
    const opts = baseOptions()
    const { result, rerender } = setup()
    rerender(opts)
    act(() => result.current.onKeyHover(key(0)))
    dwell()
    rerender({ ...opts, keymap: new Map(opts.keymap) })
    expect(result.current.previewLayer).toBeNull()

    act(() => result.current.onKeyHover(key(0)))
    rerender({ ...opts, keymap: new Map(opts.keymap) })
    dwell()
    expect(result.current.previewLayer).toBeNull()
  })

  it('an encoder edit, a device change or a pack-tab change cancels the preview', () => {
    const opts = baseOptions()
    const { result, rerender } = setup()
    rerender(opts)
    for (const next of [
      { ...opts, encoderLayout: new Map(opts.encoderLayout) },
      { ...opts, deviceKey: 'uid-b' },
      { ...opts, surfaceKey: 'base' },
    ]) {
      rerender(opts)
      act(() => result.current.onKeyHover(key(0)))
      dwell()
      expect(result.current.previewLayer).toBe(1)
      rerender(next)
      expect(result.current.previewLayer).toBeNull()
    }
  })

  it('cancel() drops a visible preview', () => {
    const { result } = setup()
    act(() => result.current.onKeyHover(key(0)))
    dwell()
    act(() => result.current.cancel())
    expect(result.current.previewLayer).toBeNull()
  })

  it('unmounting with a pending dwell does not fire it', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result, unmount } = setup()
    act(() => result.current.onKeyHover(key(0)))
    unmount()
    dwell()
    expect(vi.getTimerCount()).toBe(0)
    expect(errorSpy).not.toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('keeps the hover callbacks stable across keymap edits and layer changes', () => {
    const { result, rerender } = setup()
    const { onKeyHover, onKeyHoverEnd } = result.current
    rerender(baseOptions({ currentLayer: 1 }))
    rerender(baseOptions({ keymap: makeKeymap() }))
    expect(result.current.onKeyHover).toBe(onKeyHover)
    expect(result.current.onKeyHoverEnd).toBe(onKeyHoverEnd)
  })

  it('resolves the target from the raw code under a remapping pack, and remaps the preview', () => {
    // The pack relabels MO(1) as a plain letter and KC_A as a layer key;
    // only the raw codes decide what previews.
    const relabels: Record<string, string> = { 'MO(1)': 'KC_Q', KC_A: 'MO(2)', KC_1: 'KC_EXCLAIM' }
    const remapLabel = (id: string): string => relabels[id] ?? id
    const isRemapped = (id: string): boolean => id === 'KC_1'
    const { result } = setup({ remapLabel, isRemapped })
    act(() => result.current.onKeyHover(key(1)))
    dwell()
    expect(result.current.previewLayer).toBeNull()

    act(() => result.current.onKeyHover(key(0)))
    dwell()
    expect(result.current.previewLayer).toBe(1)
    expect(result.current.keycodes.get('0,1')).toBe('KC_EXCLAIM')
    expect(result.current.remappedKeys.has('0,1')).toBe(true)
  })

  it('builds raw maps for the Base tab', () => {
    const remapLabel = (id: string): string => (id === 'KC_1' ? 'KC_EXCLAIM' : id)
    const isRemapped = (id: string): boolean => id === 'KC_1'
    const { result } = setup({ remapLabel, isRemapped, raw: true })
    act(() => result.current.onKeyHover(key(0)))
    dwell()
    expect(result.current.keycodes.get('0,1')).toBe('KC_1')
    expect(result.current.remappedKeys.size).toBe(0)
  })

  it('does not rebuild the preview maps on re-renders with the same inputs', () => {
    const opts = baseOptions()
    const { result, rerender } = setup()
    rerender(opts)
    act(() => result.current.onKeyHover(key(0)))
    dwell()
    const first = result.current.keycodes
    rerender({ ...opts })
    expect(result.current.keycodes).toBe(first)
  })

  it('keeps the hovered key on its real-layer value', () => {
    const { result } = setup()
    act(() => result.current.onKeyHover(key(0)))
    dwell()
    expect(result.current.keycodes.get('0,0')).toBe('MO(1)')
    expect(result.current.keycodes.get('0,5')).toBe('KC_1')
  })

  it('drops the target layer\'s tint from the hovered key when the real key is untinted', () => {
    // Every layer-1 key (KC_1) is tinted; the real layer shows no tint.
    const isRemapped = (id: string): boolean => id === 'KC_1'
    const { result } = setup({ isRemapped, realRemappedKeys: new Set() })
    act(() => result.current.onKeyHover(key(0)))
    dwell()
    expect(result.current.remappedKeys.has('0,0')).toBe(false)
    expect(result.current.remappedKeys.has('0,5')).toBe(true)
  })

  it('adds the real tint to the hovered key when the target layer has none there', () => {
    const { result } = setup({ realRemappedKeys: new Set(['0,0']) })
    act(() => result.current.onKeyHover(key(0)))
    dwell()
    expect(result.current.remappedKeys.has('0,0')).toBe(true)
    expect(result.current.remappedKeys.has('0,5')).toBe(false)
  })

  it('keeps the right source key when moving between two keys targeting the same layer', () => {
    const { result } = setup()
    act(() => result.current.onKeyHover(key(0)))
    dwell()
    act(() => result.current.onKeyHoverEnd())
    act(() => result.current.onKeyHover(key(5)))
    dwell()
    expect(result.current.previewLayer).toBe(1)
    expect(result.current.keycodes.get('0,5')).toBe('MO(1)')
    expect(result.current.keycodes.get('0,0')).toBe('KC_1')
  })
})
