// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Layer hover preview started from an encoder direction.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import {
  resolveEncoderLayerHoverTarget, useLayerHoverPreview, type UseLayerHoverPreviewOptions,
} from '../use-layer-hover-preview'
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
  21: 'KC_P',
  22: 'KC_Q',
}

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => CODES[code] ?? 'KC_NO',
  isMask: () => false,
  findInnerKeycode: () => undefined,
}))

// Encoder 0 on layer 0: CW = MO(1), CCW = LT2(KC_B). Encoder 1: CW = KC_A,
// CCW = MO(1). Layer 1: encoder 0 = KC_1 / KC_2, encoder 1 = KC_P / KC_Q.
// Layer 2: encoder 0 = KC_2 / KC_2. Key (0,1) on layer 0 is KC_A, so
// `posKey(0,1)` and `encoderPosKey(0,1)` collide as strings.
function makeEncoders(): Map<string, number> {
  return new Map([
    ['0,0,0', 1], ['0,0,1', 2], ['0,1,0', 10], ['0,1,1', 1],
    ['1,0,0', 11], ['1,0,1', 12], ['1,1,0', 21], ['1,1,1', 22],
    ['2,0,0', 12], ['2,0,1', 12],
  ])
}
function makeKeymap(): Map<string, number> {
  return new Map([['0,0,0', 1], ['0,0,1', 10], ['1,0,0', 11], ['1,0,1', 12], ['2,0,0', 12], ['2,0,1', 12]])
}

const REAL_KEYCODES = new Map([['0,0', 'MO(1)'], ['0,1', 'KC_A']])
const REAL_ENCODERS = new Map<string, [string, string]>([['0', ['MO(1)', 'LT2(KC_B)']], ['1', ['KC_A', 'MO(1)']]])

function baseOptions(overrides: Partial<UseLayerHoverPreviewOptions> = {}): UseLayerHoverPreviewOptions {
  return {
    layers: 3,
    currentLayer: 0,
    keymap: makeKeymap(),
    encoderLayout: makeEncoders(),
    encoderCount: 2,
    raw: false,
    disabled: false,
    surfaceKey: 'none',
    deviceKey: 'uid-a',
    realKeycodes: REAL_KEYCODES,
    realRemappedKeys: new Set(),
    realEncoderKeycodes: REAL_ENCODERS,
    realRemappedEncoders: new Set(),
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

describe('resolveEncoderLayerHoverTarget', () => {
  it.each([
    ['CW MO(1)', 0, 0, 1],
    ['CCW LT2(KC_B)', 0, 1, 2],
    ['a plain keycode', 1, 0, null],
    ['a missing encoder', 5, 0, null],
  ])('resolves %s', (_label, idx, dir, layer) => {
    expect(resolveEncoderLayerHoverTarget(makeEncoders(), 0, 3, idx, dir)).toBe(layer)
  })

  it('ignores the current layer and layers the keyboard does not have', () => {
    const layout = new Map([['0,0,0', 3], ['0,0,1', 4]])
    expect(resolveEncoderLayerHoverTarget(layout, 0, 3, 0, 0)).toBeNull()
    expect(resolveEncoderLayerHoverTarget(layout, 0, 3, 0, 1)).toBeNull()
  })
})

describe('useLayerHoverPreview — encoders', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('previews the CW target after the dwell, keeping only the hovered direction real', () => {
    const { result } = setup()
    act(() => result.current.onEncoderHover(0, 0))
    expect(result.current.previewLayer).toBeNull()
    dwell()
    expect(result.current.previewLayer).toBe(1)
    expect(result.current.encoderKeycodes.get('0')).toEqual(['MO(1)', 'KC_2'])
    expect(result.current.encoderKeycodes.get('1')).toEqual(['KC_P', 'KC_Q'])
    expect(result.current.keycodes.get('0,0')).toBe('KC_1')
  })

  it('previews the CCW target, keeping CCW real and CW on the target layer', () => {
    const { result } = setup()
    act(() => result.current.onEncoderHover(0, 1))
    dwell()
    expect(result.current.previewLayer).toBe(2)
    expect(result.current.encoderKeycodes.get('0')).toEqual(['KC_2', 'LT2(KC_B)'])
  })

  it('does not preview from a plain encoder keycode, and hides on leave', () => {
    const { result } = setup()
    act(() => result.current.onEncoderHover(1, 0))
    dwell()
    expect(result.current.previewLayer).toBeNull()
    act(() => result.current.onEncoderHover(0, 0))
    dwell()
    act(() => result.current.onHoverEnd())
    expect(result.current.previewLayer).toBeNull()
  })

  it('keeps a key and an encoder whose position strings collide apart', () => {
    const { result } = setup()
    // Encoder 0 CCW ("0,1") previews; key "0,1" shows the target layer.
    act(() => result.current.onEncoderHover(0, 1))
    dwell()
    expect(result.current.keycodes.get('0,1')).toBe('KC_2')
    expect(result.current.encoderKeycodes.get('0')?.[1]).toBe('LT2(KC_B)')
    act(() => result.current.onHoverEnd())
    // Key "0,0" previews; encoder 0 CW ("0,0") shows the target layer.
    act(() => result.current.onKeyHover({ row: 0, col: 0 } as KleKey))
    dwell()
    expect(result.current.keycodes.get('0,0')).toBe('MO(1)')
    expect(result.current.encoderKeycodes.get('0')).toEqual(['KC_1', 'KC_2'])
  })

  it('follows the source when two directions point at the same layer', () => {
    const { result } = setup()
    act(() => result.current.onEncoderHover(0, 0))
    dwell()
    act(() => result.current.onHoverEnd())
    act(() => result.current.onEncoderHover(1, 1))
    dwell()
    expect(result.current.previewLayer).toBe(1)
    expect(result.current.encoderKeycodes.get('0')).toEqual(['KC_1', 'KC_2'])
    expect(result.current.encoderKeycodes.get('1')).toEqual(['KC_P', 'MO(1)'])
  })

  it('never mutates the cached target-layer map or its [CW, CCW] pairs', () => {
    const { result } = setup()
    // With a key as the source, the encoder map is the builder's cached
    // target-layer map itself. Moving straight on to an encoder direction
    // that targets the same layer keeps the preview (and that cache) up.
    act(() => result.current.onKeyHover({ row: 0, col: 0 } as KleKey))
    dwell()
    const cached = result.current.encoderKeycodes
    const cachedPair = cached.get('0')
    act(() => result.current.onEncoderHover(0, 0))
    dwell()
    expect(result.current.previewLayer).toBe(1)
    expect(result.current.encoderKeycodes).not.toBe(cached)
    expect(result.current.encoderKeycodes.get('0')).toEqual(['MO(1)', 'KC_2'])
    expect(cached.get('0')).toBe(cachedPair)
    expect(cachedPair).toEqual(['KC_1', 'KC_2'])
    act(() => result.current.onKeyHover({ row: 0, col: 0 } as KleKey))
    dwell()
    expect(result.current.encoderKeycodes).toBe(cached)
  })

  it('draws KC_NO for a hovered direction missing from the real map', () => {
    const { result } = setup({ realEncoderKeycodes: new Map() })
    act(() => result.current.onEncoderHover(0, 0))
    dwell()
    expect(result.current.encoderKeycodes.get('0')).toEqual(['KC_NO', 'KC_2'])
  })

  it('keeps the hook callbacks stable across edits and layer changes', () => {
    const { result, rerender } = setup()
    const { onEncoderHover, onKeyHover, onHoverEnd } = result.current
    rerender(baseOptions({ currentLayer: 1 }))
    rerender(baseOptions({ encoderLayout: makeEncoders(), realEncoderKeycodes: new Map(REAL_ENCODERS) }))
    expect(result.current.onEncoderHover).toBe(onEncoderHover)
    expect(result.current.onKeyHover).toBe(onKeyHover)
    expect(result.current.onHoverEnd).toBe(onHoverEnd)
  })

  it('an encoder edit cancels a visible and a pending encoder preview', () => {
    const { result, rerender } = setup()
    act(() => result.current.onEncoderHover(0, 0))
    dwell()
    rerender(baseOptions({ encoderLayout: makeEncoders() }))
    expect(result.current.previewLayer).toBeNull()
    act(() => result.current.onEncoderHover(0, 0))
    act(() => { vi.advanceTimersByTime(100) })
    rerender(baseOptions({ encoderLayout: makeEncoders() }))
    dwell()
    expect(result.current.previewLayer).toBeNull()
  })

  it('does nothing while disabled', () => {
    const { result } = setup({ disabled: true })
    act(() => result.current.onEncoderHover(0, 0))
    dwell()
    expect(result.current.previewLayer).toBeNull()
  })

  it('reads the raw encoder code, not a remapped legend, and remaps the preview', () => {
    // The pack relabels MO(1) as a letter and KC_A as a layer key.
    const relabels: Record<string, string> = { 'MO(1)': 'KC_Z', KC_A: 'MO(2)', KC_1: 'KC_EXCLAIM' }
    const { result } = setup({ remapLabel: (id) => relabels[id] ?? id })
    act(() => result.current.onEncoderHover(1, 0))
    dwell()
    expect(result.current.previewLayer).toBeNull()
    act(() => result.current.onEncoderHover(1, 1))
    dwell()
    expect(result.current.previewLayer).toBe(1)
    expect(result.current.encoderKeycodes.get('0')).toEqual(['KC_EXCLAIM', 'KC_2'])
  })

  it('drops the target tint from the hovered direction and keeps the other direction tinted', () => {
    const isRemapped = (id: string): boolean => id === 'KC_1' || id === 'KC_2'
    const { result } = setup({ isRemapped })
    act(() => result.current.onEncoderHover(0, 0))
    dwell()
    expect(result.current.remappedEncoders.has('0,0')).toBe(false)
    expect(result.current.remappedEncoders.has('0,1')).toBe(true)
  })

  it('adds the real tint to the hovered direction when the target layer has none there', () => {
    const { result } = setup({ realRemappedEncoders: new Set(['0,0']) })
    act(() => result.current.onEncoderHover(0, 0))
    dwell()
    expect(result.current.remappedEncoders.has('0,0')).toBe(true)
    expect(result.current.remappedEncoders.has('0,1')).toBe(false)
  })

  it('builds raw, untinted encoder maps for the Base tab', () => {
    const isRemapped = (id: string): boolean => id === 'KC_1' || id === 'KC_2'
    const { result } = setup({ isRemapped, remapLabel: (id) => `${id}!`, raw: true })
    act(() => result.current.onEncoderHover(0, 0))
    dwell()
    expect(result.current.encoderKeycodes.get('0')).toEqual(['MO(1)', 'KC_2'])
    expect(result.current.remappedEncoders.size).toBe(0)
  })
})
