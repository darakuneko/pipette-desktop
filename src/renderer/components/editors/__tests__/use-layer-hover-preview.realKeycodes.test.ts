// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// Target resolution against the real keycode serializer (no mock), so a
// change in how layer keycodes serialize can't silently stop the preview.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { deserialize, serialize, recreateKeyboardKeycodes } from '../../../../shared/keycodes/keycodes'
import { resolveLayerHoverTarget, useLayerHoverPreview } from '../use-layer-hover-preview'
import { SHARED_BUBBLE_OPEN_DELAY_MS } from '../../../hooks/use-shared-hover-bubble'
import type { KleKey } from '../../../../shared/kle/types'

describe('layer hover preview — real keycode parsing', () => {
  // Layer keycodes (MO / TG / ...) are only registered for the connected
  // keyboard's layer count, the same way the app sets them up on connect.
  beforeEach(() => {
    recreateKeyboardKeycodes({
      vialProtocol: 6, layers: 4, macroCount: 0, tapDanceCount: 0,
      customKeycodes: null, midi: '', supportedFeatures: new Set(),
    })
  })

  it.each([
    ['MO(1)', 1],
    ['LT2(KC_B)', 2],
    ['TG(3)', 3],
  ])('resolves %s to layer %i', (qmkId, layer) => {
    const code = deserialize(qmkId)
    expect(serialize(code)).toBe(qmkId)
    const keymap = new Map([['0,0,0', code]])
    expect(resolveLayerHoverTarget(keymap, 0, 4, 0, 0)).toBe(layer)
  })

  it('does not resolve a plain key', () => {
    const keymap = new Map([['0,0,0', deserialize('KC_A')]])
    expect(resolveLayerHoverTarget(keymap, 0, 4, 0, 0)).toBeNull()
  })

  describe('through the hook', () => {
    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('previews the layer an LT key targets and shows its keycodes', () => {
      const keymap = new Map([['0,0,0', deserialize('LT2(KC_B)')], ['2,0,1', deserialize('KC_Z')]])
      const encoderLayout = new Map<string, number>()
      const realKeycodes = new Map([['0,0', 'LT2(KC_B)']])
      const realRemappedKeys = new Set<string>()
      const { result } = renderHook(() => useLayerHoverPreview({
        layers: 3, currentLayer: 0, keymap, encoderLayout, encoderCount: 0,
        raw: false, disabled: false, surfaceKey: 'none', realKeycodes, realRemappedKeys,
      }))
      act(() => result.current.onKeyHover({ row: 0, col: 0 } as KleKey))
      act(() => { vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS) })
      expect(result.current.previewLayer).toBe(2)
      expect(result.current.keycodes.get('0,1')).toBe('KC_Z')
      expect(result.current.keycodes.get('0,0')).toBe('LT2(KC_B)')
    })
  })
})
