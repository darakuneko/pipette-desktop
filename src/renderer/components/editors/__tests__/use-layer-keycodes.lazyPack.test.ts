// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// Integration regression for the lazy-pack-load freeze (Plan-qwerty-
// select-no-rewrite follow-up, useKeyLabelLookup identity fix). Wires
// `useDevicePrefs` (the actual `remapLabel`/`isRemapped` source) straight
// into `useLayerKeycodes` (the actual keymap-legend consumer) — the same
// pairing `KeymapEditor` does — and simulates the async Key Label pack
// fetch `ensure(layout)` triggers. Before the fix, `layerKeycodes` /
// `remappedKeys` stayed on their pre-fetch fallback (raw qmkId, no tint)
// forever once the pack resolved, because `remapLabel`/`isRemapped` never
// changed identity so `buildKeycodesForLayer`'s memo never reran.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { useDevicePrefs } from '../../../hooks/useDevicePrefs'
import { useLayerKeycodes } from '../use-layer-keycodes'
import { setupAppConfigMock, renderHookWithConfig, vialAPIMock } from '../../../hooks/__tests__/test-helpers'
import type { KeyLabelRecord, KeyLabelStoreResult } from '../../../../shared/types/key-label-store'

const mockPipetteSettingsGet = vi.fn<(uid: string) => Promise<unknown>>()
const mockPipetteSettingsPatch = vi.fn<(uid: string, prefs: unknown) => Promise<{ success: boolean }>>()
const mockKeyLabelStoreGet = vi.fn<(id: string) => Promise<KeyLabelStoreResult<KeyLabelRecord>>>()

beforeEach(() => {
  vi.clearAllMocks()
  mockPipetteSettingsGet.mockReset()
  mockPipetteSettingsPatch.mockReset()
  mockKeyLabelStoreGet.mockReset()
  mockPipetteSettingsPatch.mockResolvedValue({ success: true })
})

function setupMocks() {
  const mocks = setupAppConfigMock()
  Object.defineProperty(window, 'vialAPI', {
    value: {
      ...vialAPIMock(),
      pipetteSettingsGet: mockPipetteSettingsGet,
      pipetteSettingsPatch: mockPipetteSettingsPatch,
      keyLabelStoreGet: mockKeyLabelStoreGet,
    },
    writable: true,
    configurable: true,
  })
  return mocks
}

// KC_A = 0x04 in the real keycode table — a real (non-mocked) keycode so
// this exercises the actual `serialize`/`isMask` chain, not a stub.
// Hoisted to module scope (rather than built fresh per render) so its
// identity stays stable across the hook's renders — the ONLY thing that
// should change identity between the "pending fetch" and "resolved fetch"
// checks below is `remapLabel`/`isRemapped` itself. A fresh Map literal
// per render would rebuild `buildKeycodesForLayer` on its own and mask
// the very bug this test guards against.
const KC_A_CODE = 0x04
const KEYMAP = new Map<string, number>([['0,0,0', KC_A_CODE]])
const ENCODER_LAYOUT = new Map<string, number>()

function useCombined() {
  const devicePrefs = useDevicePrefs()
  const layer = useLayerKeycodes({
    remapLabel: devicePrefs.remapLabel,
    isRemapped: devicePrefs.isRemapped,
    keymap: KEYMAP,
    encoderLayout: ENCODER_LAYOUT,
    encoderCount: 0,
    currentLayer: 0,
    typingTestEffectiveLayer: 0,
  })
  return { devicePrefs, layer }
}

describe('useLayerKeycodes + useDevicePrefs — lazy pack load rebuilds the keymap legend', () => {
  it('reacts once the async keyLabelStoreGet resolves: raw label/no tint before, pack label/tint after', async () => {
    setupMocks()
    mockPipetteSettingsGet.mockResolvedValue({
      _rev: 1,
      keyboardLayout: 'custom-pack',
      autoAdvance: true,
      layerNames: [],
    })
    let resolveGet!: (value: KeyLabelStoreResult<KeyLabelRecord>) => void
    mockKeyLabelStoreGet.mockReturnValue(new Promise((resolve) => { resolveGet = resolve }))

    const { result } = renderHookWithConfig(() => useCombined())
    await act(async () => {})
    await act(async () => {
      await result.current.devicePrefs.applyDevicePrefs('0xAABB')
    })

    // Pack fetch is pending — legend falls back to the raw qmkId, no tint.
    expect(result.current.layer.layerKeycodes.get('0,0')).toBe('KC_A')
    expect(result.current.layer.remappedKeys.has('0,0')).toBe(false)

    await act(async () => {
      resolveGet({
        success: true,
        data: {
          meta: { id: 'custom-pack', name: 'Custom', filename: 'x', savedAt: '', updatedAt: '' },
          data: { name: 'Custom', map: { KC_A: 'Custom A' } },
        },
      })
      // Flush the ensure() effect's own async chain.
      await new Promise((r) => setTimeout(r, 0))
    })

    // Pack resolved — the SAME `layerKeycodes`/`remappedKeys` (no unrelated
    // prop changed) now reflect the fetched map.
    expect(result.current.layer.layerKeycodes.get('0,0')).toBe('Custom A')
    expect(result.current.layer.remappedKeys.has('0,0')).toBe(true)
  })
})
