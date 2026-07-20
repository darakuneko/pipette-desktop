// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// Focused coverage for `useLayerKeycodes`'s remap-tint computation
// (issue #295/#296 follow-up, fix/composite-inner-remap): a masked
// (composite) key whose INNER basic keycode is remapped by the active
// Key Label pack must count as "remapped" for KeyWidget's blue tint,
// same as any plain remapped key — previously `!isMask(qmkId)` excluded
// every masked position outright, so a pack-affected LSFT(KC_8) never
// got the tint even after the label itself was fixed to display
// correctly. No pre-existing test file covered this hook before, so
// this stays scoped to the remap-tint behavior.

import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLayerKeycodes } from '../use-layer-keycodes'

vi.mock('../../../../shared/keycodes/keycodes', () => ({
  serialize: (code: number) => {
    if (code === 0x0208) return 'LSFT(KC_8)' // composite: inner KC_8, remapped by the pack
    if (code === 0x0209) return 'LSFT(KC_9)' // composite: inner KC_9, NOT remapped by the pack
    if (code === 8) return 'KC_8'
    if (code === 9) return 'KC_9'
    return 'KC_NO'
  },
  isMask: (qmkId: string) => /^[A-Z][A-Z0-9_]*\(/.test(qmkId),
  findInnerKeycode: (qmkId: string) => {
    const match = /\(([^)]+)\)/.exec(qmkId)
    return match ? { qmkId: match[1] } : undefined
  },
}))

function keymapOf(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries))
}

describe('useLayerKeycodes — remap tint includes inner-remapped masked keys', () => {
  // Mirrors the reported pack: only KC_8's legend is remapped.
  const remapLabel = (qmkId: string) => (qmkId === 'KC_8' ? '(\n8' : qmkId)
  const isRemapped = (qmkId: string) => qmkId === 'KC_8'

  it('tints a masked key whose INNER keycode is remapped, even though the composite string itself is not', () => {
    const { result } = renderHook(() => useLayerKeycodes({
      remapLabel, isRemapped,
      keymap: keymapOf({ '0,0,0': 0x0208 }), // LSFT(KC_8)
      encoderLayout: new Map(), encoderCount: 0, currentLayer: 0, typingTestEffectiveLayer: 0,
    }))
    const { remapped } = result.current.buildKeycodesForLayer(0)
    expect(remapped.has('0,0')).toBe(true)
  })

  it('does not tint a masked key whose inner keycode the pack does not affect', () => {
    const { result } = renderHook(() => useLayerKeycodes({
      remapLabel, isRemapped,
      keymap: keymapOf({ '0,0,0': 0x0209 }), // LSFT(KC_9)
      encoderLayout: new Map(), encoderCount: 0, currentLayer: 0, typingTestEffectiveLayer: 0,
    }))
    const { remapped } = result.current.buildKeycodesForLayer(0)
    expect(remapped.has('0,0')).toBe(false)
  })

  it('still tints a plain (non-masked) remapped key, unchanged from before', () => {
    const { result } = renderHook(() => useLayerKeycodes({
      remapLabel, isRemapped,
      keymap: keymapOf({ '0,0,0': 8 }), // KC_8
      encoderLayout: new Map(), encoderCount: 0, currentLayer: 0, typingTestEffectiveLayer: 0,
    }))
    const { remapped } = result.current.buildKeycodesForLayer(0)
    expect(remapped.has('0,0')).toBe(true)
  })

  it('does not tint a plain key the pack does not affect', () => {
    const { result } = renderHook(() => useLayerKeycodes({
      remapLabel, isRemapped,
      keymap: keymapOf({ '0,0,0': 9 }), // KC_9
      encoderLayout: new Map(), encoderCount: 0, currentLayer: 0, typingTestEffectiveLayer: 0,
    }))
    const { remapped } = result.current.buildKeycodesForLayer(0)
    expect(remapped.has('0,0')).toBe(false)
  })

  it('without remapLabel/isRemapped at all (no pack active), nothing is tinted', () => {
    const { result } = renderHook(() => useLayerKeycodes({
      keymap: keymapOf({ '0,0,0': 0x0208, '0,0,1': 8 }),
      encoderLayout: new Map(), encoderCount: 0, currentLayer: 0, typingTestEffectiveLayer: 0,
    }))
    const { remapped } = result.current.buildKeycodesForLayer(0)
    expect(remapped.size).toBe(0)
  })
})

describe('useLayerKeycodes — encoder remap tint (Plan-qwerty-select-no-rewrite "also" follow-up)', () => {
  const remapLabel = (qmkId: string) => (qmkId === 'KC_8' ? '(\n8' : qmkId)
  const isRemapped = (qmkId: string) => qmkId === 'KC_8'

  function encoderLayoutOf(entries: Record<string, number>): Map<string, number> {
    return new Map(Object.entries(entries))
  }

  it('tints an encoder CW direction whose keycode the pack affects', () => {
    const { result } = renderHook(() => useLayerKeycodes({
      remapLabel, isRemapped,
      keymap: new Map(), encoderLayout: encoderLayoutOf({ '0,0,0': 8, '0,0,1': 9 }),
      encoderCount: 1, currentLayer: 0, typingTestEffectiveLayer: 0,
    }))
    const remapped = result.current.buildEncoderRemappedForLayer(0)
    expect(remapped.has('0,0')).toBe(true)
    expect(remapped.has('0,1')).toBe(false)
  })

  it('tints an encoder CCW direction independently of CW', () => {
    const { result } = renderHook(() => useLayerKeycodes({
      remapLabel, isRemapped,
      keymap: new Map(), encoderLayout: encoderLayoutOf({ '0,0,0': 9, '0,0,1': 8 }),
      encoderCount: 1, currentLayer: 0, typingTestEffectiveLayer: 0,
    }))
    const remapped = result.current.buildEncoderRemappedForLayer(0)
    expect(remapped.has('0,0')).toBe(false)
    expect(remapped.has('0,1')).toBe(true)
  })

  it('tints a masked encoder direction whose INNER keycode the pack affects', () => {
    const { result } = renderHook(() => useLayerKeycodes({
      remapLabel, isRemapped,
      keymap: new Map(), encoderLayout: encoderLayoutOf({ '0,0,0': 0x0208 }), // LSFT(KC_8)
      encoderCount: 1, currentLayer: 0, typingTestEffectiveLayer: 0,
    }))
    const remapped = result.current.buildEncoderRemappedForLayer(0)
    expect(remapped.has('0,0')).toBe(true)
  })

  it('without remapLabel/isRemapped at all, no encoder direction is tinted', () => {
    const { result } = renderHook(() => useLayerKeycodes({
      keymap: new Map(), encoderLayout: encoderLayoutOf({ '0,0,0': 8, '0,0,1': 8 }),
      encoderCount: 1, currentLayer: 0, typingTestEffectiveLayer: 0,
    }))
    const remapped = result.current.buildEncoderRemappedForLayer(0)
    expect(remapped.size).toBe(0)
  })

  it('layerEncoderRemapped mirrors buildEncoderRemappedForLayer(currentLayer)', () => {
    const { result } = renderHook(() => useLayerKeycodes({
      remapLabel, isRemapped,
      keymap: new Map(), encoderLayout: encoderLayoutOf({ '0,0,0': 8 }),
      encoderCount: 1, currentLayer: 0, typingTestEffectiveLayer: 0,
    }))
    expect(result.current.layerEncoderRemapped.has('0,0')).toBe(true)
  })
})
