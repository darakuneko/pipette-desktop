// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { PipetteSettings } from '../../../shared/types/pipette-settings'
import { keepIfSame, useKeyboardSettingsReader, type KeyboardSettingsReaderOptions } from '../use-keyboard-settings-reader'
import { dispatchSyncUnitApplied } from '../use-sync-unit-applied'

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

function settings(layerNames: string[]): PipetteSettings {
  return { _rev: 1, keyboardLayout: 'qwerty', autoAdvance: true, layerNames }
}

const getSpy = vi.fn<(uid: string) => Promise<PipetteSettings | null>>()

beforeEach(() => {
  getSpy.mockReset()
  Object.defineProperty(window, 'vialAPI', {
    value: { pipetteSettingsGet: (uid: string) => getSpy(uid) },
    writable: true,
    configurable: true,
  })
})

function renderReader(uid: string | null, options?: KeyboardSettingsReaderOptions) {
  const onRead = vi.fn<(prefs: PipetteSettings | null) => void>()
  const hook = renderHook(
    ({ u, o }: { u: string | null; o?: KeyboardSettingsReaderOptions }) => useKeyboardSettingsReader(u, onRead, o),
    { initialProps: { u: uid, o: options } },
  )
  return { onRead, ...hook }
}

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

describe('useKeyboardSettingsReader', () => {
  it('reads on mount and re-reads only for its own keyboard\'s settings unit', async () => {
    getSpy.mockResolvedValueOnce(settings(['a']))
    const { onRead } = renderReader('kb-b')
    await waitFor(() => expect(onRead).toHaveBeenCalledWith(settings(['a'])))
    expect(getSpy).toHaveBeenCalledTimes(1)

    act(() => {
      dispatchSyncUnitApplied('keyboards/kb-a/settings')
      dispatchSyncUnitApplied('keyboards/kb-b/snapshots')
    })
    expect(getSpy).toHaveBeenCalledTimes(1)

    getSpy.mockResolvedValueOnce(settings(['b']))
    act(() => { dispatchSyncUnitApplied('keyboards/kb-b/settings') })
    await waitFor(() => expect(onRead).toHaveBeenLastCalledWith(settings(['b'])))
    expect(getSpy).toHaveBeenLastCalledWith('kb-b')
  })

  it('reports null for a null uid without reading', () => {
    const { onRead } = renderReader(null)
    expect(onRead).toHaveBeenCalledWith(null)
    expect(getSpy).not.toHaveBeenCalled()
  })

  it('keeps what is shown when a reload finds no file or fails', async () => {
    getSpy.mockResolvedValueOnce(settings(['a']))
    const { onRead } = renderReader('kb')
    await waitFor(() => expect(onRead).toHaveBeenCalledTimes(1))

    getSpy.mockResolvedValueOnce(null)
    act(() => { dispatchSyncUnitApplied('keyboards/kb/settings') })
    await flush()
    getSpy.mockRejectedValueOnce(new Error('ipc'))
    act(() => { dispatchSyncUnitApplied('keyboards/kb/settings') })
    await flush()
    expect(getSpy).toHaveBeenCalledTimes(3)
    expect(onRead).toHaveBeenCalledTimes(1)
  })

  it('reports null when the first read fails', async () => {
    getSpy.mockRejectedValueOnce(new Error('ipc'))
    const { onRead } = renderReader('kb')
    await waitFor(() => expect(onRead).toHaveBeenCalledWith(null))
  })

  it('drops an older read that finishes after a newer one', async () => {
    getSpy.mockResolvedValueOnce(settings(['initial']))
    const { onRead } = renderReader('kb')
    await waitFor(() => expect(onRead).toHaveBeenCalledTimes(1))

    const first = deferred<PipetteSettings | null>()
    const second = deferred<PipetteSettings | null>()
    getSpy.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    act(() => { dispatchSyncUnitApplied('keyboards/kb/settings') })
    act(() => { dispatchSyncUnitApplied('keyboards/kb/settings') })
    await act(async () => { second.resolve(settings(['new'])) })
    await act(async () => { first.resolve(settings(['old'])) })
    expect(onRead).toHaveBeenCalledTimes(2)
    expect(onRead).toHaveBeenLastCalledWith(settings(['new']))
  })

  it('drops a read of a keyboard that is no longer selected', async () => {
    getSpy.mockResolvedValueOnce(settings(['a']))
    const { onRead, rerender } = renderReader('kb-a')
    await waitFor(() => expect(onRead).toHaveBeenCalledTimes(1))

    const stale = deferred<PipetteSettings | null>()
    getSpy.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(settings(['b']))
    act(() => { dispatchSyncUnitApplied('keyboards/kb-a/settings') })
    rerender({ u: 'kb-b', o: undefined })
    await waitFor(() => expect(onRead).toHaveBeenLastCalledWith(settings(['b'])))
    await act(async () => { stale.resolve(settings(['a-late'])) })
    expect(onRead).not.toHaveBeenCalledWith(settings(['a-late']))
  })

  it('drops a read started before switching away and back (A -> B -> A)', async () => {
    const { onRead, rerender } = renderReader('kb-a', { initialRead: false })
    const stale = deferred<PipetteSettings | null>()
    getSpy.mockReturnValueOnce(stale.promise)
    act(() => { dispatchSyncUnitApplied('keyboards/kb-a/settings') })
    rerender({ u: 'kb-b', o: { initialRead: false } })
    rerender({ u: 'kb-a', o: { initialRead: false } })
    await act(async () => { stale.resolve(settings(['a-old'])) })
    expect(onRead).not.toHaveBeenCalled()
  })

  it('drops a read a local write overlapped and reads again once the write settles', async () => {
    getSpy.mockResolvedValueOnce(settings(['initial']))
    const { onRead, result } = renderReader('kb')
    await waitFor(() => expect(onRead).toHaveBeenCalledTimes(1))

    const staleRead = deferred<PipetteSettings | null>()
    getSpy.mockReturnValueOnce(staleRead.promise)
    act(() => { dispatchSyncUnitApplied('keyboards/kb/settings') })
    const write = deferred<void>()
    let tracked!: Promise<void>
    act(() => { tracked = result.current.trackWrite(write.promise) })
    await act(async () => { staleRead.resolve(settings(['before-write'])) })
    expect(onRead).toHaveBeenCalledTimes(1)

    // A notification during the write waits for it too.
    act(() => { dispatchSyncUnitApplied('keyboards/kb/settings') })
    expect(getSpy).toHaveBeenCalledTimes(2)

    getSpy.mockResolvedValueOnce(settings(['after-write']))
    await act(async () => { write.resolve(); await tracked })
    await waitFor(() => expect(onRead).toHaveBeenLastCalledWith(settings(['after-write'])))
    expect(getSpy).toHaveBeenCalledTimes(3)
  })

  it('reads only after a merge with initialRead off, and reports no null then', async () => {
    const { onRead } = renderReader('kb', { initialRead: false })
    expect(getSpy).not.toHaveBeenCalled()

    getSpy.mockResolvedValueOnce(null)
    act(() => { dispatchSyncUnitApplied('keyboards/kb/settings') })
    await flush()
    expect(onRead).not.toHaveBeenCalled()

    getSpy.mockResolvedValueOnce(settings(['x']))
    act(() => { dispatchSyncUnitApplied('keyboards/kb/settings') })
    await waitFor(() => expect(onRead).toHaveBeenCalledWith(settings(['x'])))
  })
})

describe('keepIfSame', () => {
  it('keeps the previous identity for an equal value', () => {
    const prev = { a: [1, 2] }
    expect(keepIfSame(prev, { a: [1, 2] })).toBe(prev)
    const next = { a: [1, 3] }
    expect(keepIfSame(prev, next)).toBe(next)
  })

  it('compares by the given key', () => {
    const prev = new Map([['a', '1']])
    const key = (m: Map<string, string>): string => JSON.stringify([...m])
    expect(keepIfSame(prev, new Map([['a', '1']]), key)).toBe(prev)
    const next = new Map([['a', '2']])
    expect(keepIfSame(prev, next, key)).toBe(next)
  })
})
