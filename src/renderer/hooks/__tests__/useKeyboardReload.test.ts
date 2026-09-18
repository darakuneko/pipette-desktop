// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useKeyboardReload } from '../useKeyboardReload'
import { emptyState } from '../keyboard-types'
import type { KeyboardState, KeyboardRefs, ReloadResult } from '../keyboard-types'
import type { KeyboardDefinition } from '../../../shared/types/protocol'
import { encoderLabel } from '../../../shared/kle/__tests__/encoder-label'
import { ECHO_DETECTED_MSG, BUFFER_FETCH_CHUNK } from '../../../shared/constants/protocol'

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
  ...BASE_DEFINITION,
  name: 'Test KB w/ encoder',
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

const TAP_DANCE_ENTRY = { onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 }
const COMBO_ENTRY = { key1: 0, key2: 0, key3: 0, key4: 0, output: 0 }
const KEY_OVERRIDE_ENTRY = {
  triggerKey: 0, replacementKey: 0, layers: 0, triggerMods: 0,
  negativeMods: 0, suppressedMods: 0, options: 0, enabled: false,
}
const ALT_REPEAT_ENTRY = { lastKey: 0, altKey: 0, allowedMods: 0, options: 0, enabled: false }

/** Builds a qmkSettingsQuery response payload reporting the given supported
 * qsids, followed by the 0xffff terminator. */
function qmkQueryPayload(qsids: number[]): number[] {
  const pairs = qsids.flatMap((qsid) => [qsid & 0xff, (qsid >> 8) & 0xff])
  return [...pairs, 0xff, 0xff]
}

/** A qmkSettingsQuery response that reports the given supported qsids and
 * then the 0xffff terminator, ending discovery in a single round trip. */
function qmkQueryWithSupported(qsids: number[]) {
  return vi.fn().mockResolvedValue(qmkQueryPayload(qsids))
}

/** A mock that resolves `entry` for every call except `index`, which rejects. */
function rejectAtIndex<T>(index: number, entry: T) {
  return vi.fn().mockImplementation((i: number) =>
    i === index ? Promise.reject(new Error('no response')) : Promise.resolve(entry),
  )
}

/** A fresh rejecting mock, standing in for a dropped/timed-out HID read. */
function noResponse() {
  return vi.fn().mockRejectedValue(new Error('no response'))
}

const SLOW_READ_MS = 8000

/** A mock that resolves `value` after `ms`, standing in for a slow-but-alive
 * HID read that still completes rather than timing out. */
function resolvesAfter<T>(value: T, ms = SLOW_READ_MS) {
  return vi.fn().mockImplementation(
    () => new Promise((resolve) => setTimeout(() => resolve(value), ms)),
  )
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
    getTapDance: vi.fn().mockResolvedValue(TAP_DANCE_ENTRY),
    getCombo: vi.fn().mockResolvedValue(COMBO_ENTRY),
    getKeyOverride: vi.fn().mockResolvedValue(KEY_OVERRIDE_ENTRY),
    getAltRepeatKey: vi.fn().mockResolvedValue(ALT_REPEAT_ENTRY),
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

function makeRefs(): Pick<KeyboardRefs, 'qmkSettingsBaselineRef'> {
  return { qmkSettingsBaselineRef: { current: {} } }
}

/** Installs window.vialAPI the way the rest of the suite does — merged onto
 * whatever setup.ts's default stub already put there. */
function setupApi(overrides: Record<string, unknown> = {}) {
  const existing = (window as unknown as { vialAPI?: Record<string, unknown> }).vialAPI ?? {}
  Object.defineProperty(window, 'vialAPI', {
    value: { ...existing, ...makeApi(overrides) },
    writable: true,
    configurable: true,
  })
}

/** Starts a reload without awaiting it, for tests that need to drive fake
 * timers before the promise settles. `initialBaseline`, when given, seeds
 * refs.qmkSettingsBaselineRef.current before reload() runs, so a test can
 * prove the baseline was actually cleared rather than merely left empty. */
function startReload(
  overrides: Record<string, unknown> = {},
  initialBaseline?: Record<string, number[]>,
) {
  setupApi(overrides)
  const { setState, getState } = createStateRecorder()
  const refs = makeRefs()
  if (initialBaseline) {
    refs.qmkSettingsBaselineRef.current = initialBaseline
  }
  const { result } = renderHook(() => useKeyboardReload(setState, refs))
  return { promise: result.current.reload(), getState, refs }
}

async function runReload(
  overrides: Record<string, unknown> = {},
  initialBaseline?: Record<string, number[]>,
): Promise<{
  result: ReloadResult
  getState: () => KeyboardState
  refs: Pick<KeyboardRefs, 'qmkSettingsBaselineRef'>
}> {
  const { promise, getState, refs } = startReload(overrides, initialBaseline)
  const result = await promise
  return { result, getState, refs }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('useKeyboardReload', () => {
  it('resolves ok with the uid when every section loads', async () => {
    const { result, getState } = await runReload()

    expect(result).toEqual({ ok: true, uid: 'uid-1' })
    expect(getState().connectionWarning).toBeNull()
    expect(getState().loading).toBe(false)
  })

  describe('failure classification', () => {
    // getKeyboardId() doesn't validate anything, so a VIA-only board can
    // echo it back and "succeed" — the definition load is what actually
    // proves Vial support. Both failures are classified notVial.
    const notVialCases: Array<[string, Record<string, unknown>]> = [
      ['getKeyboardId rejects', { getKeyboardId: noResponse() }],
      ['getDefinition resolves null', { getDefinition: vi.fn().mockResolvedValue(null) }],
    ]

    it.each(notVialCases)(
      'reports notVial and resets loading when %s',
      async (_label, overrides) => {
        const { result, getState } = await runReload(overrides)

        expect(result).toEqual({ ok: false, reason: 'notVial' })
        expect(getState().loading).toBe(false)
      },
    )

    it('reports loadFailed (not notVial) when getLayerCount rejects after the keyboard id is known', async () => {
      const { result } = await runReload({ getLayerCount: noResponse() })
      expect(result).toEqual({ ok: false, reason: 'loadFailed' })
    })
  })

  describe('fatal sections', () => {
    it('reports loadFailed and does not commit a completed state when getMacroBuffer rejects', async () => {
      const { result, getState } = await runReload({
        getMacroBufferSize: vi.fn().mockResolvedValue(4),
        getMacroBuffer: noResponse(),
      })

      expect(result).toEqual({ ok: false, reason: 'loadFailed' })
      // Assert on fields that would differ if the partial state had been
      // committed — `macroBuffer` alone can't tell, since `[]` is both its
      // recorder-initial value and its would-be committed value here.
      // `definition`/`layers` stay at emptyState()'s initial values only if
      // setState(newState) was never called.
      expect(getState().definition).toBeNull()
      expect(getState().layers).toBe(0)
      expect(getState().loading).toBe(false)
    })

    const dynamicEntrySections: Array<[string, string, string, unknown]> = [
      ['tap dance', 'tapDance', 'getTapDance', TAP_DANCE_ENTRY],
      ['combo', 'combo', 'getCombo', COMBO_ENTRY],
      ['key override', 'keyOverride', 'getKeyOverride', KEY_OVERRIDE_ENTRY],
      ['alt repeat key', 'altRepeatKey', 'getAltRepeatKey', ALT_REPEAT_ENTRY],
    ]

    describe.each(dynamicEntrySections)('%s entries', (_label, countKey, getterName, entry) => {
      it('reports loadFailed when a mid-range entry rejects', async () => {
        const { result } = await runReload({
          getDynamicEntryCount: vi.fn().mockResolvedValue({
            tapDance: 0, combo: 0, keyOverride: 0, altRepeatKey: 0, featureFlags: 0,
            [countKey]: 2,
          }),
          [getterName]: rejectAtIndex(1, entry),
        })

        expect(result).toEqual({ ok: false, reason: 'loadFailed' })
      })
    })

    it('reports loadFailed when the keymap buffer fetch rejects on a later chunk', async () => {
      const bigDefinition: KeyboardDefinition = {
        name: 'Big KB',
        matrix: { rows: 4, cols: 4 },
        layouts: {
          keymap: Array.from({ length: 4 }, (_, row) =>
            Array.from({ length: 4 }, (_, col) => `${row},${col}`),
          ),
        },
      }
      // totalSize = 2 layers * 4 rows * 4 cols * 2 = 64, so this needs 3
      // chunks — reject on the 2nd.
      const { result } = await runReload({
        getDefinition: vi.fn().mockResolvedValue(bigDefinition),
        getLayerCount: vi.fn().mockResolvedValue(2),
        getKeymapBuffer: vi.fn().mockImplementation((offset: number, size: number) =>
          offset === BUFFER_FETCH_CHUNK
            ? Promise.reject(new Error('no response'))
            : Promise.resolve(new Array(size).fill(0)),
        ),
      })

      expect(result).toEqual({ ok: false, reason: 'loadFailed' })
    })

    it('reports loadFailed when an encoder read rejects', async () => {
      const { result } = await runReload({
        getDefinition: vi.fn().mockResolvedValue(ENCODER_DEFINITION),
        getEncoder: noResponse(),
      })

      expect(result).toEqual({ ok: false, reason: 'loadFailed' })
    })

    it('reports loadFailed when getDynamicEntryCount rejects with a non-echo error', async () => {
      const { result } = await runReload({ getDynamicEntryCount: noResponse() })

      expect(result).toEqual({ ok: false, reason: 'loadFailed' })
    })
  })

  describe('partial-load warnings', () => {
    it('continues with warning.echoDetected when dynamic entry count echoes', async () => {
      const { result, getState } = await runReload({
        getDynamicEntryCount: vi.fn().mockRejectedValue(new Error(ECHO_DETECTED_MSG)),
      })

      expect(result).toEqual({ ok: true, uid: 'uid-1' })
      expect(getState().connectionWarning).toBe('warning.echoDetected')
    })

    it('continues with warning.partialLoad when lighting data fails to load', async () => {
      const { result, getState } = await runReload({
        getDefinition: vi.fn().mockResolvedValue(LIGHTING_DEFINITION),
        getLightingValue: noResponse(),
      })

      expect(result).toEqual({ ok: true, uid: 'uid-1' })
      expect(getState().connectionWarning).toBe('warning.partialLoad')
    })

    it('continues with warning.partialLoad and no supported qsids when QMK settings discovery fails with a non-echo error', async () => {
      const { result, getState } = await runReload({ qmkSettingsQuery: noResponse() })

      expect(result).toEqual({ ok: true, uid: 'uid-1' })
      expect(getState().connectionWarning).toBe('warning.partialLoad')
      expect(getState().supportedQsids.size).toBe(0)
      expect(getState().qmkSettingsValues).toEqual({})
    })

    const echoMethods: Array<[string, string]> = [
      ['qmkSettingsQuery', 'qmkSettingsQuery'],
      ['getDynamicEntryCount', 'getDynamicEntryCount'],
    ]

    it.each(echoMethods)(
      'promotes warning.partialLoad to warning.echoDetected when %s echoes after a lighting failure',
      async (_label, method) => {
        const { result, getState } = await runReload({
          getDefinition: vi.fn().mockResolvedValue(LIGHTING_DEFINITION),
          getLightingValue: noResponse(),
          [method]: vi.fn().mockRejectedValue(new Error(ECHO_DETECTED_MSG)),
        })

        expect(result).toEqual({ ok: true, uid: 'uid-1' })
        expect(getState().connectionWarning).toBe('warning.echoDetected')
      },
    )

    it('keeps warning.echoDetected when it fires before a later unlock status failure', async () => {
      const { result, getState } = await runReload({
        getDynamicEntryCount: vi.fn().mockRejectedValue(new Error(ECHO_DETECTED_MSG)),
        getUnlockStatus: noResponse(),
      })

      expect(result).toEqual({ ok: true, uid: 'uid-1' })
      expect(getState().connectionWarning).toBe('warning.echoDetected')
    })

    it('clears qmkSettingsValues and the baseline when one qsid fails to read after another already succeeded', async () => {
      const { result, getState, refs } = await runReload(
        {
          qmkSettingsQuery: qmkQueryWithSupported([1, 2]),
          qmkSettingsGet: vi.fn().mockImplementation((qsid: number) =>
            qsid === 2 ? Promise.reject(new Error('no response')) : Promise.resolve([0]),
          ),
        },
        { '99': [1] },
      )

      expect(result).toEqual({ ok: true, uid: 'uid-1' })
      expect(getState().connectionWarning).toBe('warning.partialLoad')
      expect(getState().qmkSettingsValues).toEqual({})
      expect(refs.qmkSettingsBaselineRef.current).toEqual({})
    })

    it('continues with warning.partialLoad and unlockStatusKnown false when getUnlockStatus rejects', async () => {
      const { result, getState } = await runReload({ getUnlockStatus: noResponse() })

      expect(result).toEqual({ ok: true, uid: 'uid-1' })
      expect(getState().connectionWarning).toBe('warning.partialLoad')
      expect(getState().unlockStatusKnown).toBe(false)
    })
  })

  describe('slow QMK settings reads', () => {
    it('keeps the value read when qmkSettingsGet takes 8s to resolve', async () => {
      vi.useFakeTimers()
      const { promise, getState, refs } = startReload({
        qmkSettingsQuery: qmkQueryWithSupported([1]),
        qmkSettingsGet: vi.fn().mockImplementation(
          (qsid: number) =>
            new Promise((resolve) => setTimeout(() => resolve([qsid]), SLOW_READ_MS)),
        ),
      })

      await vi.advanceTimersByTimeAsync(SLOW_READ_MS)
      const result = await promise

      expect(result).toEqual({ ok: true, uid: 'uid-1' })
      expect(getState().connectionWarning).toBeNull()
      expect(getState().qmkSettingsValues).toEqual({ '1': [1] })
      expect(refs.qmkSettingsBaselineRef.current).toEqual({ '1': [1] })
    })

    it('keeps discovery results when qmkSettingsQuery takes 8s to resolve', async () => {
      vi.useFakeTimers()
      const { promise, getState } = startReload({
        qmkSettingsQuery: resolvesAfter(qmkQueryPayload([1])),
      })

      await vi.advanceTimersByTimeAsync(SLOW_READ_MS)
      const result = await promise

      expect(result).toEqual({ ok: true, uid: 'uid-1' })
      expect(getState().connectionWarning).toBeNull()
      expect(getState().supportedQsids).toEqual(new Set([1]))
    })
  })
})
