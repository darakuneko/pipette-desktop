// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useKeyboardReload } from '../useKeyboardReload'
import { emptyState } from '../keyboard-types'
import type { KeyboardState, KeyboardRefs } from '../keyboard-types'
import type { KeyboardDefinition } from '../../../shared/types/protocol'
import { encoderLabel } from '../../../shared/kle/__tests__/encoder-label'
import { ECHO_DETECTED_MSG } from '../../../shared/constants/protocol'

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

const ENCODER_DEFINITION: KeyboardDefinition = {
  name: 'Test KB w/ encoder',
  matrix: { rows: 2, cols: 3 },
  layouts: {
    keymap: [
      ['0,0', '0,1', '0,2'],
      ['1,0', '1,1', encoderLabel(0, 0)],
    ],
  },
}

const LIGHTING_DEFINITION: KeyboardDefinition = {
  ...BASE_DEFINITION,
  name: 'Test KB w/ lighting',
  lighting: 'qmk_backlight',
}

/** A qmkSettingsQuery response that reports exactly one supported qsid and
 * then the 0xffff terminator, ending discovery in a single round trip. */
function qmkQueryWithOneSupported(qsid: number) {
  return vi.fn().mockResolvedValue([qsid & 0xff, (qsid >> 8) & 0xff, 0xff, 0xff])
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
  vi.useRealTimers()
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

  it('case 2: reports loadFailed and does not commit a completed state when getMacroBuffer rejects', async () => {
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      getMacroBufferSize: vi.fn().mockResolvedValue(4),
      getMacroBuffer: vi.fn().mockRejectedValue(new Error('no response')),
    })
    const { setState, getState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, makeRefs()))

    const reloadResult = await result.current.reload()

    expect(reloadResult).toEqual({ ok: false, reason: 'loadFailed' })
    // The committed state must never carry the partial buffer this reload
    // built up before it failed.
    expect(getState().macroBuffer).toEqual([])
    expect(getState().loading).toBe(false)
  })

  it('case 3: reports loadFailed when a tap dance entry mid-range rejects', async () => {
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      getDynamicEntryCount: vi.fn().mockResolvedValue({
        tapDance: 3, combo: 0, keyOverride: 0, altRepeatKey: 0, featureFlags: 0,
      }),
      getTapDance: vi.fn().mockImplementation((index: number) =>
        index === 1
          ? Promise.reject(new Error('no response'))
          : Promise.resolve({ onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 }),
      ),
    })
    const { setState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, makeRefs()))

    const reloadResult = await result.current.reload()

    expect(reloadResult).toEqual({ ok: false, reason: 'loadFailed' })
  })

  it('case 4: reports loadFailed when a combo entry mid-range rejects', async () => {
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      getDynamicEntryCount: vi.fn().mockResolvedValue({
        tapDance: 0, combo: 2, keyOverride: 0, altRepeatKey: 0, featureFlags: 0,
      }),
      getCombo: vi.fn().mockImplementation((index: number) =>
        index === 1
          ? Promise.reject(new Error('no response'))
          : Promise.resolve({ key1: 0, key2: 0, key3: 0, key4: 0, output: 0 }),
      ),
    })
    const { setState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, makeRefs()))

    const reloadResult = await result.current.reload()

    expect(reloadResult).toEqual({ ok: false, reason: 'loadFailed' })
  })

  it('case 4b: reports loadFailed when a key override entry mid-range rejects', async () => {
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      getDynamicEntryCount: vi.fn().mockResolvedValue({
        tapDance: 0, combo: 0, keyOverride: 2, altRepeatKey: 0, featureFlags: 0,
      }),
      getKeyOverride: vi.fn().mockImplementation((index: number) =>
        index === 1
          ? Promise.reject(new Error('no response'))
          : Promise.resolve({
            triggerKey: 0, replacementKey: 0, layers: 0, triggerMods: 0,
            negativeMods: 0, suppressedMods: 0, options: 0, enabled: false,
          }),
      ),
    })
    const { setState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, makeRefs()))

    const reloadResult = await result.current.reload()

    expect(reloadResult).toEqual({ ok: false, reason: 'loadFailed' })
  })

  it('case 4c: reports loadFailed when an alt repeat key entry mid-range rejects', async () => {
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      getDynamicEntryCount: vi.fn().mockResolvedValue({
        tapDance: 0, combo: 0, keyOverride: 0, altRepeatKey: 2, featureFlags: 0,
      }),
      getAltRepeatKey: vi.fn().mockImplementation((index: number) =>
        index === 1
          ? Promise.reject(new Error('no response'))
          : Promise.resolve({ lastKey: 0, altKey: 0, allowedMods: 0, options: 0, enabled: false }),
      ),
    })
    const { setState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, makeRefs()))

    const reloadResult = await result.current.reload()

    expect(reloadResult).toEqual({ ok: false, reason: 'loadFailed' })
  })

  it('case 5: reports loadFailed when the keymap buffer fetch rejects on a later chunk', async () => {
    const bigDefinition: KeyboardDefinition = {
      name: 'Big KB',
      matrix: { rows: 4, cols: 4 },
      layouts: {
        keymap: Array.from({ length: 4 }, (_, row) =>
          Array.from({ length: 4 }, (_, col) => `${row},${col}`),
        ),
      },
    }
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      getDefinition: vi.fn().mockResolvedValue(bigDefinition),
      getLayerCount: vi.fn().mockResolvedValue(2),
      // totalSize = 2 * 4 * 4 * 2 = 64, so this needs 3 chunks (28/28/8) —
      // reject on the 2nd chunk.
      getKeymapBuffer: vi.fn().mockImplementation((offset: number, size: number) =>
        offset === 28
          ? Promise.reject(new Error('no response'))
          : Promise.resolve(new Array(size).fill(0)),
      ),
    })
    const { setState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, makeRefs()))

    const reloadResult = await result.current.reload()

    expect(reloadResult).toEqual({ ok: false, reason: 'loadFailed' })
  })

  it('case 6: reports loadFailed when an encoder read rejects', async () => {
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      getDefinition: vi.fn().mockResolvedValue(ENCODER_DEFINITION),
      getEncoder: vi.fn().mockRejectedValue(new Error('no response')),
    })
    const { setState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, makeRefs()))

    const reloadResult = await result.current.reload()

    expect(reloadResult).toEqual({ ok: false, reason: 'loadFailed' })
  })

  it('case 7: keeps echoDetected handling for getDynamicEntryCount (unchanged)', async () => {
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      getDynamicEntryCount: vi.fn().mockRejectedValue(new Error(ECHO_DETECTED_MSG)),
    })
    const { setState, getState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, makeRefs()))

    const reloadResult = await result.current.reload()

    expect(reloadResult).toEqual({ ok: true, uid: 'uid-1' })
    expect(getState().connectionWarning).toBe('warning.echoDetected')
  })

  it('case 8: reports loadFailed when getDynamicEntryCount rejects with a non-echo error', async () => {
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      getDynamicEntryCount: vi.fn().mockRejectedValue(new Error('no response')),
    })
    const { setState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, makeRefs()))

    const reloadResult = await result.current.reload()

    expect(reloadResult).toEqual({ ok: false, reason: 'loadFailed' })
  })

  it('case 11: continues with warning.partialLoad when lighting data fails to load', async () => {
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      getDefinition: vi.fn().mockResolvedValue(LIGHTING_DEFINITION),
      getLightingValue: vi.fn().mockRejectedValue(new Error('no response')),
    })
    const { setState, getState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, makeRefs()))

    const reloadResult = await result.current.reload()

    expect(reloadResult).toEqual({ ok: true, uid: 'uid-1' })
    expect(getState().connectionWarning).toBe('warning.partialLoad')
  })

  it('case 12: clears qmkSettingsValues and the baseline when one qsid fails to read', async () => {
    const refs = makeRefs()
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      qmkSettingsQuery: qmkQueryWithOneSupported(1),
      qmkSettingsGet: vi.fn().mockRejectedValue(new Error('no response')),
    })
    const { setState, getState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, refs))

    const reloadResult = await result.current.reload()

    expect(reloadResult).toEqual({ ok: true, uid: 'uid-1' })
    expect(getState().connectionWarning).toBe('warning.partialLoad')
    expect(getState().qmkSettingsValues).toEqual({})
    expect(refs.qmkSettingsBaselineRef.current).toEqual({})
  })

  it('case 13: keeps warning.echoDetected when a QMK settings discovery echo follows a lighting failure', async () => {
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      getDefinition: vi.fn().mockResolvedValue(LIGHTING_DEFINITION),
      getLightingValue: vi.fn().mockRejectedValue(new Error('no response')),
      qmkSettingsQuery: vi.fn().mockRejectedValue(new Error(ECHO_DETECTED_MSG)),
    })
    const { setState, getState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, makeRefs()))

    const reloadResult = await result.current.reload()

    expect(reloadResult).toEqual({ ok: true, uid: 'uid-1' })
    expect(getState().connectionWarning).toBe('warning.echoDetected')
  })

  it('case 16: keeps warning.echoDetected when dynamic entry count echo follows a lighting failure', async () => {
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      getDefinition: vi.fn().mockResolvedValue(LIGHTING_DEFINITION),
      getLightingValue: vi.fn().mockRejectedValue(new Error('no response')),
      getDynamicEntryCount: vi.fn().mockRejectedValue(new Error(ECHO_DETECTED_MSG)),
    })
    const { setState, getState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, makeRefs()))

    const reloadResult = await result.current.reload()

    expect(reloadResult).toEqual({ ok: true, uid: 'uid-1' })
    expect(getState().connectionWarning).toBe('warning.echoDetected')
  })

  it('case 17: clears qmkSettingsValues when the value fetch is cut off at the 5s timeout', async () => {
    vi.useFakeTimers()
    const refs = makeRefs()
    ;(window as unknown as { vialAPI: unknown }).vialAPI = makeApi({
      qmkSettingsQuery: qmkQueryWithOneSupported(1),
      // Never resolves — the 5s Promise.race timeout must cut it off.
      qmkSettingsGet: vi.fn().mockImplementation(() => new Promise(() => {})),
    })
    const { setState, getState } = createStateRecorder()
    const { result } = renderHook(() => useKeyboardReload(setState, refs))

    const reloadPromise = result.current.reload()
    await vi.advanceTimersByTimeAsync(5000)
    const reloadResult = await reloadPromise

    expect(reloadResult).toEqual({ ok: true, uid: 'uid-1' })
    expect(getState().connectionWarning).toBe('warning.partialLoad')
    expect(getState().qmkSettingsValues).toEqual({})
    expect(refs.qmkSettingsBaselineRef.current).toEqual({})
  })
})
