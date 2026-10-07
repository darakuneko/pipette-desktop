// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useDevicePrefs } from '../useDevicePrefs'
import { useDevicePrefsReloadLinks } from '../use-device-prefs-reload'
import { dispatchSyncUnitApplied } from '../use-sync-unit-applied'
import type { PipetteSettingsPatch } from '../../../shared/types/pipette-settings'
import { setupAppConfigMock, renderHookWithConfig, vialAPIMock } from './test-helpers'

type Stored = Record<string, unknown>

const mockGet = vi.fn<(uid: string) => Promise<Stored | null>>()
const mockPatch = vi.fn<(uid: string, partial: PipetteSettingsPatch) => Promise<{ success: boolean }>>()
const replaceLayerNames = vi.fn<(uid: string, names: string[]) => void>()

let typingTestMode = false
let keyboardUid = 'UID1'
let liveKeyboard = true

const BASE: Stored = {
  _rev: 1,
  keyboardLayout: 'qwerty',
  autoAdvance: true,
  layerNames: ['Base'],
  keymapScale: 1,
  viewMode: 'editor',
  typingTestViewOnly: false,
  typingRecordEnabled: false,
  typingTestConfig: { mode: 'words', wordCount: 25, punctuation: false, numbers: false },
  typingTestLanguage: 'english',
  keycodeTabOrder: ['basic', 'layers'],
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => {
  mockGet.mockReset()
  mockPatch.mockReset()
  replaceLayerNames.mockReset()
  mockGet.mockResolvedValue(null)
  mockPatch.mockResolvedValue({ success: true })
  typingTestMode = false
  keyboardUid = 'UID1'
  liveKeyboard = true
  setupAppConfigMock()
  Object.defineProperty(window, 'vialAPI', {
    value: {
      ...vialAPIMock(),
      pipetteSettingsGet: mockGet,
      pipetteSettingsPatch: mockPatch,
      pipetteSettingsEnsureDir: vi.fn().mockResolvedValue({ success: true }),
    },
    writable: true,
    configurable: true,
  })
})

function render() {
  return renderHookWithConfig(() => {
    const prefs = useDevicePrefs()
    useDevicePrefsReloadLinks({ devicePrefs: prefs, keyboardUid, liveKeyboard, replaceLayerNamesFromSync: replaceLayerNames, typingTestMode })
    return prefs
  })
}

type Rendered = ReturnType<typeof render>

async function flush(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

async function connect(rendered: Rendered, uid = 'UID1', stored: Stored = BASE): Promise<void> {
  mockGet.mockResolvedValueOnce(stored)
  await act(async () => { await rendered.result.current.applyDevicePrefs(uid) })
  mockGet.mockClear()
  replaceLayerNames.mockClear()
}

function notify(syncUnit = 'keyboards/UID1/settings'): void {
  act(() => { dispatchSyncUnitApplied(syncUnit) })
}

describe('useDevicePrefsReload', () => {
  it('re-reads and applies the settings of the connected keyboard on its notification', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)

    mockGet.mockResolvedValueOnce({ ...BASE, autoAdvance: false, keymapScale: 1.5, layerNames: ['Base', 'Nav'] })
    notify()
    await flush()

    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockGet).toHaveBeenCalledWith('UID1')
    expect(rendered.result.current.autoAdvance).toBe(false)
    expect(rendered.result.current.keymapScale).toBe(1.5)
    expect(rendered.result.current.layerNames).toEqual(['Base', 'Nav'])
  })

  it('ignores another keyboard and other units', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)

    notify('keyboards/OTHER/settings')
    notify('keyboards/UID1/snapshots')
    notify('favorites/macro')
    await flush()

    expect(mockGet).not.toHaveBeenCalled()
  })

  it('does nothing before any keyboard is connected', async () => {
    render()
    await flush()
    notify()
    await flush()
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('leaves the session fields as they are', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)

    mockGet.mockResolvedValueOnce({
      ...BASE,
      autoAdvance: false,
      viewMode: 'typingView',
      typingTestViewOnly: true,
      typingTestMemory: { words: [], wordIndex: 0, currentInput: '', elapsedMs: 1000, textId: 't' },
      typingTestViewOnlyWindowSize: { width: 400, height: 200 },
      typingRecordEnabled: true,
    })
    notify()
    await flush()

    const prefs = rendered.result.current
    expect(prefs.autoAdvance).toBe(false)
    expect(prefs.viewMode).toBe('editor')
    expect(prefs.typingTestViewOnly).toBe(false)
    expect(prefs.typingTestMemory).toBeUndefined()
    expect(prefs.typingTestViewOnlyWindowSize).toBeUndefined()
    expect(prefs.typingRecordEnabled).toBe(false)
  })

  it('applies zoom, always-on-top and opacity without saving them back', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)

    mockGet.mockResolvedValueOnce({
      ...BASE,
      keyEditorZoom: 120,
      typingTestViewOnlyAlwaysOnTop: true,
      typingTestViewOnlyOpacity: 0.6,
      layerNames: ['Base', 'Fn'],
    })
    notify()
    await flush()

    const prefs = rendered.result.current
    expect(prefs.keyEditorZoom).toBe(120)
    expect(prefs.typingTestViewOnlyAlwaysOnTop).toBe(true)
    expect(prefs.typingTestViewOnlyOpacity).toBe(0.6)
    expect(mockPatch).not.toHaveBeenCalled()
  })

  it('passes the connect-time layer names of a live keyboard, which may include a merge made during connect', async () => {
    const rendered = render()
    await flush()
    mockGet.mockResolvedValueOnce({ ...BASE, layerNames: ['Base', 'Nav'] })
    await act(async () => { await rendered.result.current.applyDevicePrefs('UID1') })
    await flush()

    expect(replaceLayerNames).toHaveBeenCalledTimes(1)
    expect(replaceLayerNames).toHaveBeenCalledWith('UID1', ['Base', 'Nav'])
    expect(mockPatch).not.toHaveBeenCalled()
  })

  it('waits for the keyboard to hold the applied uid before passing names', async () => {
    keyboardUid = ''
    const rendered = render()
    await flush()
    mockGet.mockResolvedValueOnce(BASE)
    await act(async () => { await rendered.result.current.applyDevicePrefs('UID1') })
    expect(replaceLayerNames).not.toHaveBeenCalled()

    keyboardUid = 'UID1'
    rendered.rerender()
    expect(replaceLayerNames).toHaveBeenCalledWith('UID1', ['Base'])
  })

  it('never passes layer names to a dummy or .pipette keyboard', async () => {
    liveKeyboard = false
    const rendered = render()
    await flush()
    await connect(rendered)
    mockGet.mockResolvedValueOnce({ ...BASE, layerNames: ['Base', 'Nav'] })
    notify()
    await flush()
    renderHook(() => useDevicePrefsReloadLinks({
      devicePrefs: rendered.result.current, keyboardUid, liveKeyboard, replaceLayerNamesFromSync: replaceLayerNames, typingTestMode: false,
    }))

    expect(rendered.result.current.layerNames).toEqual(['Base', 'Nav'])
    expect(replaceLayerNames).not.toHaveBeenCalled()
  })

  it('does not pass unchanged layer names to the keyboard', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)

    mockGet.mockResolvedValueOnce({ ...BASE, autoAdvance: false })
    notify()
    await flush()

    expect(rendered.result.current.autoAdvance).toBe(false)
    expect(replaceLayerNames).not.toHaveBeenCalled()
  })

  it('passes a local rename to the keyboard once, which saves only through the setter', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)

    act(() => { rendered.result.current.setLayerNames(['Base', 'Nav']) })
    await flush()

    expect(replaceLayerNames).toHaveBeenCalledTimes(1)
    expect(replaceLayerNames).toHaveBeenCalledWith('UID1', ['Base', 'Nav'])
    expect(mockPatch).toHaveBeenCalledTimes(1)
  })

  it('catches the keyboard up with names reloaded while the links were unmounted', async () => {
    const rendered = renderHookWithConfig(() => useDevicePrefs())
    await flush()
    mockGet.mockResolvedValueOnce(BASE)
    await act(async () => { await rendered.result.current.applyDevicePrefs('UID1') })
    mockGet.mockResolvedValueOnce({ ...BASE, layerNames: ['Base', 'Nav'] })
    notify()
    await flush()

    renderHook(() => useDevicePrefsReloadLinks({
      devicePrefs: rendered.result.current, keyboardUid, liveKeyboard, replaceLayerNamesFromSync: replaceLayerNames, typingTestMode: false,
    }))

    expect(replaceLayerNames).toHaveBeenCalledWith('UID1', ['Base', 'Nav'])
  })

  it('passes the layer names to the keyboard without saving', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)

    mockGet.mockResolvedValueOnce({ ...BASE, layerNames: ['Base', 'Nav'] })
    notify()
    await flush()

    expect(replaceLayerNames).toHaveBeenCalledWith('UID1', ['Base', 'Nav'])
    expect(mockPatch).not.toHaveBeenCalled()
  })

  it('keeps unchanged arrays and objects as the same instances', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)
    const before = rendered.result.current

    mockGet.mockResolvedValueOnce({ ...BASE, autoAdvance: false })
    notify()
    await flush()

    const after = rendered.result.current
    expect(after.autoAdvance).toBe(false)
    expect(after.layerNames).toBe(before.layerNames)
    expect(after.typingTestConfig).toBe(before.typingTestConfig)
    expect(after.keycodeTabOrder).toBe(before.keycodeTabOrder)
  })

  it('does nothing when the read returns null or fails', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)
    const before = rendered.result.current

    mockGet.mockResolvedValueOnce(null)
    notify()
    await flush()
    mockGet.mockRejectedValueOnce(new Error('ipc'))
    notify()
    await flush()

    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(rendered.result.current.autoAdvance).toBe(before.autoAdvance)
    expect(rendered.result.current.layerNames).toBe(before.layerNames)
    expect(replaceLayerNames).not.toHaveBeenCalled()
  })

  it('runs one read at a time and one more for notifications that arrived meanwhile', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)

    const first = deferred<Stored | null>()
    mockGet.mockReturnValueOnce(first.promise)
    mockGet.mockResolvedValueOnce({ ...BASE, keymapScale: 2 })
    notify()
    notify()
    notify()
    expect(mockGet).toHaveBeenCalledTimes(1)

    await act(async () => { first.resolve({ ...BASE, keymapScale: 1.5 }) })
    await flush()

    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(rendered.result.current.keymapScale).toBe(2)
  })

  it('drops a read that a save overlapped and reads again once the save settles', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)

    const read = deferred<Stored | null>()
    const save = deferred<{ success: boolean }>()
    mockGet.mockReturnValueOnce(read.promise)
    mockPatch.mockReturnValueOnce(save.promise)
    notify()
    act(() => { rendered.result.current.setAutoAdvance(false) })

    // The overlapped read carries the value from before the save.
    await act(async () => { read.resolve({ ...BASE, autoAdvance: true, keymapScale: 1.5 }) })
    await flush()
    expect(rendered.result.current.autoAdvance).toBe(false)
    expect(rendered.result.current.keymapScale).toBe(1)
    expect(mockGet).toHaveBeenCalledTimes(1)

    mockGet.mockResolvedValueOnce({ ...BASE, autoAdvance: false, keymapScale: 1.5 })
    await act(async () => { save.resolve({ success: true }) })
    await flush()

    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(rendered.result.current.autoAdvance).toBe(false)
    expect(rendered.result.current.keymapScale).toBe(1.5)
  })

  it('still reads again when the overlapping save fails', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)

    const read = deferred<Stored | null>()
    const save = deferred<{ success: boolean }>()
    mockGet.mockReturnValueOnce(read.promise)
    mockPatch.mockReturnValueOnce(save.promise)
    notify()
    act(() => { rendered.result.current.setKeymapScale(1.5) })

    await act(async () => { read.resolve({ ...BASE, autoAdvance: false }) })
    await flush()
    expect(mockGet).toHaveBeenCalledTimes(1)

    mockGet.mockResolvedValueOnce({ ...BASE, autoAdvance: false, keymapScale: 1.5 })
    await act(async () => { save.reject(new Error('ipc')) })
    await flush()

    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(rendered.result.current.autoAdvance).toBe(false)
  })

  it('reads again at once when the overlapping save already settled', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)

    const read = deferred<Stored | null>()
    mockGet.mockReturnValueOnce(read.promise)
    notify()
    act(() => { rendered.result.current.setKeymapScale(1.5) })
    await flush()

    mockGet.mockResolvedValueOnce({ ...BASE, autoAdvance: false, keymapScale: 1.5 })
    await act(async () => { read.resolve({ ...BASE, keymapScale: 1 }) })
    await flush()

    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(rendered.result.current.keymapScale).toBe(1.5)
    expect(rendered.result.current.autoAdvance).toBe(false)
  })

  it('does not get stuck when the save call throws synchronously', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)

    mockPatch.mockImplementationOnce(() => { throw new Error('ipc') })
    act(() => { rendered.result.current.setAutoAdvance(false) })
    await flush()
    mockGet.mockResolvedValueOnce({ ...BASE, autoAdvance: false, keymapScale: 1.5 })
    notify()
    await flush()

    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(rendered.result.current.keymapScale).toBe(1.5)
  })

  it('waits for a save in flight before reading', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)

    const save = deferred<{ success: boolean }>()
    mockPatch.mockReturnValueOnce(save.promise)
    act(() => { rendered.result.current.setAutoAdvance(false) })
    notify()
    expect(mockGet).not.toHaveBeenCalled()

    mockGet.mockResolvedValueOnce({ ...BASE, autoAdvance: false, keymapScale: 1.5 })
    await act(async () => { save.resolve({ success: true }) })
    await flush()

    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(rendered.result.current.keymapScale).toBe(1.5)
  })

  it('drops a read when the keyboard changes meanwhile', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)

    const read = deferred<Stored | null>()
    mockGet.mockReturnValueOnce(read.promise)
    notify()
    notify()
    await connect(rendered, 'UID2', { ...BASE, keymapScale: 0.8 })

    await act(async () => { read.resolve({ ...BASE, keymapScale: 1.5, layerNames: ['Old'] }) })
    await flush()

    // The notifications were for the old keyboard: nothing is read for the new one.
    expect(mockGet).not.toHaveBeenCalled()
    expect(rendered.result.current.keymapScale).toBe(0.8)
    expect(rendered.result.current.layerNames).toEqual(['Base'])
  })

  it('reloads once for a notification about the new keyboard that arrived during its connect', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)

    const oldRead = deferred<Stored | null>()
    mockGet.mockReturnValueOnce(oldRead.promise)
    notify()
    const connectRead = deferred<Stored | null>()
    mockGet.mockReturnValueOnce(connectRead.promise)
    let applying!: Promise<void>
    act(() => { applying = rendered.result.current.applyDevicePrefs('UID2') })
    notify('keyboards/UID2/settings')
    await act(async () => { oldRead.resolve({ ...BASE, keymapScale: 1.5 }) })
    await flush()

    mockGet.mockResolvedValueOnce({ ...BASE, keymapScale: 0.8 })
    await act(async () => {
      connectRead.resolve(BASE)
      await applying
    })
    await flush()

    expect(mockGet.mock.calls).toEqual([['UID1'], ['UID2'], ['UID2']])
    expect(rendered.result.current.keymapScale).toBe(0.8)
  })

  it('handles a notification that arrived during the connect-time read once that read is applied', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)

    const connectRead = deferred<Stored | null>()
    mockGet.mockReturnValueOnce(connectRead.promise)
    let applying!: Promise<void>
    act(() => { applying = rendered.result.current.applyDevicePrefs('UID1') })
    notify()
    expect(mockGet).toHaveBeenCalledTimes(1)

    mockGet.mockResolvedValueOnce({ ...BASE, keymapScale: 1.5 })
    await act(async () => {
      connectRead.resolve(BASE)
      await applying
    })
    await flush()

    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(rendered.result.current.keymapScale).toBe(1.5)
  })

  it('holds the typing test config and language while the typing test mode is on and reads them once it ends', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)
    typingTestMode = true
    rendered.rerender()

    const remote = {
      ...BASE,
      autoAdvance: false,
      typingTestConfig: { mode: 'time', duration: 60, punctuation: false, numbers: false },
      typingTestLanguage: 'japanese',
    }
    mockGet.mockResolvedValueOnce(remote)
    notify()
    await flush()

    expect(rendered.result.current.autoAdvance).toBe(false)
    expect(rendered.result.current.typingTestConfig).toEqual(BASE.typingTestConfig)
    expect(rendered.result.current.typingTestLanguage).toBe('english')

    mockGet.mockResolvedValueOnce(remote)
    typingTestMode = false
    rendered.rerender()
    await flush()

    expect(mockGet).toHaveBeenCalledTimes(2)
    expect(rendered.result.current.typingTestConfig).toEqual(remote.typingTestConfig)
    expect(rendered.result.current.typingTestLanguage).toBe('japanese')
  })

  it('does not read again after the typing test mode ends when nothing was held back', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)
    typingTestMode = true
    rendered.rerender()
    typingTestMode = false
    rendered.rerender()
    await flush()

    expect(mockGet).not.toHaveBeenCalled()
  })

  it('does not read again after a hold when the held fields were unchanged in the file', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)
    typingTestMode = true
    rendered.rerender()

    mockGet.mockResolvedValueOnce({ ...BASE, autoAdvance: false })
    notify()
    await flush()
    typingTestMode = false
    rendered.rerender()
    await flush()

    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(rendered.result.current.autoAdvance).toBe(false)
  })

  it('holds the key picker tab order while the reorder mode is open', async () => {
    const rendered = render()
    await flush()
    await connect(rendered)

    let release!: () => void
    act(() => { release = rendered.result.current.holdSyncReload('keycodeTabOrder') })
    const remote = { ...BASE, autoAdvance: false, keycodeTabOrder: ['layers', 'basic'] }
    mockGet.mockResolvedValueOnce(remote)
    notify()
    await flush()

    expect(rendered.result.current.autoAdvance).toBe(false)
    expect(rendered.result.current.keycodeTabOrder).toEqual(['basic', 'layers'])

    mockGet.mockResolvedValueOnce(remote)
    act(() => { release() })
    await flush()

    expect(rendered.result.current.keycodeTabOrder).toEqual(['layers', 'basic'])
  })
})
