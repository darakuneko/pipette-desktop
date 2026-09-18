// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useKeyboardReload } from '../useKeyboardReload'
import { emptyState } from '../keyboard-types'
import type { KeyboardState, KeyboardRefs } from '../keyboard-types'
import type { KeyboardDefinition } from '../../../shared/types/protocol'

const BASE_DEFINITION: KeyboardDefinition = {
  name: 'Test KB',
  matrix: { rows: 2, cols: 3 },
  layouts: {
    keymap: [
      ['0,0', '0,1', '0,2'],
      ['1,0', '1,1', '1,2'],
    ],
  },
}

/** Full happy-path read surface for window.vialAPI. Each test overrides only
 * the methods it needs to fail. */
function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    getProtocolVersion: vi.fn().mockResolvedValue(9),
    getKeyboardId: vi.fn().mockResolvedValue({ vialProtocol: 5, uid: 'uid-1' }),
    getLayerCount: vi.fn().mockResolvedValue(1),
    pipetteSettingsGet: vi.fn().mockResolvedValue(null),
    getMacroCount: vi.fn().mockResolvedValue(1),
    getMacroBufferSize: vi.fn().mockResolvedValue(0),
    getDefinition: vi.fn().mockResolvedValue(BASE_DEFINITION),
    getLayoutOptions: vi.fn().mockResolvedValue(0),
    getKeymapBuffer: vi.fn().mockImplementation((_offset: number, size: number) =>
      Promise.resolve(new Array(size).fill(0)),
    ),
    getEncoder: vi.fn().mockResolvedValue([0, 0]),
    getDynamicEntryCount: vi.fn().mockResolvedValue({
      tapDance: 0, combo: 0, keyOverride: 0, altRepeatKey: 0, featureFlags: 0,
    }),
    getMacroBuffer: vi.fn().mockResolvedValue([]),
    getTapDance: vi.fn().mockResolvedValue({ onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 }),
    getCombo: vi.fn().mockResolvedValue({ key1: 0, key2: 0, key3: 0, key4: 0, output: 0 }),
    getKeyOverride: vi.fn().mockResolvedValue({
      triggerKey: 0, replacementKey: 0, layers: 0, triggerMods: 0,
      negativeMods: 0, suppressedMods: 0, options: 0, enabled: false,
    }),
    getAltRepeatKey: vi.fn().mockResolvedValue({ lastKey: 0, altKey: 0, allowedMods: 0, options: 0, enabled: false }),
    getVialRGBInfo: vi.fn().mockResolvedValue({ version: 1, maxBrightness: 255 }),
    getVialRGBSupported: vi.fn().mockResolvedValue([]),
    getVialRGBMode: vi.fn().mockResolvedValue({ mode: 0, speed: 0, hue: 0, sat: 0, val: 0 }),
    getLightingValue: vi.fn().mockResolvedValue([0, 0]),
    qmkSettingsQuery: vi.fn().mockResolvedValue([0xff, 0xff]),
    qmkSettingsGet: vi.fn().mockResolvedValue([0]),
    getUnlockStatus: vi.fn().mockResolvedValue({ unlocked: true, inProgress: false, keys: [] }),
    ...overrides,
  }
}

/** Mimics React's setState semantics (functional + object updates) so tests
 * can inspect what was actually committed, not just call arguments. */
function createStateRecorder() {
  let current = emptyState()
  const setState = vi.fn((updater: KeyboardState | ((s: KeyboardState) => KeyboardState)) => {
    current = typeof updater === 'function'
      ? (updater as (s: KeyboardState) => KeyboardState)(current)
      : updater
  })
  return { setState, getState: () => current }
}

function makeRefs(): Pick<KeyboardRefs, 'stateRef' | 'qmkSettingsBaselineRef'> {
  return {
    stateRef: { current: emptyState() },
    qmkSettingsBaselineRef: { current: {} },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useKeyboardReload', () => {
  it('case 1: resolves ok with the uid when every section loads', async () => {
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi()
    const { setState, getState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, makeRefs()))

    const reloadResult = await result.current.reload()

    expect(reloadResult).toEqual({ ok: true, uid: 'uid-1' })
    expect(getState().connectionWarning).toBeNull()
    expect(getState().loading).toBe(false)
  })

  it('case 9: reports loadFailed when getDefinition resolves null after the keyboard id is known', async () => {
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      getDefinition: vi.fn().mockResolvedValue(null),
    })
    const { setState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, makeRefs()))

    const reloadResult = await result.current.reload()

    expect(reloadResult).toEqual({ ok: false, reason: 'loadFailed' })
  })

  it('case 10: reports notVial when getKeyboardId rejects', async () => {
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      getKeyboardId: vi.fn().mockRejectedValue(new Error('no response')),
    })
    const { setState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, makeRefs()))

    const reloadResult = await result.current.reload()

    expect(reloadResult).toEqual({ ok: false, reason: 'notVial' })
  })

  it('case 14: loading is committed back to false after a failed reload', async () => {
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      getKeyboardId: vi.fn().mockRejectedValue(new Error('no response')),
    })
    const { setState, getState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, makeRefs()))

    await result.current.reload()

    expect(getState().loading).toBe(false)
  })

  it('case 15: reports loadFailed (not notVial) when getLayerCount rejects after the keyboard id is known', async () => {
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      getLayerCount: vi.fn().mockRejectedValue(new Error('no response')),
    })
    const { setState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, makeRefs()))

    const reloadResult = await result.current.reload()

    expect(reloadResult).toEqual({ ok: false, reason: 'loadFailed' })
  })
})
