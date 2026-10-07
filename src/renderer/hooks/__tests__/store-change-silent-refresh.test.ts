// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// The store change events (fired by other hook instances and, for sync
// merges, by the sync-unit bridge) re-read the list without flipping
// `loading` or emptying it, and drop out-of-order responses.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useKeyLabels } from '../useKeyLabels'
import { useTypingTestTexts } from '../useTypingTestTexts'

const keyLabelList = vi.fn()
const textList = vi.fn()

beforeEach(() => {
  keyLabelList.mockReset()
  textList.mockReset()
  Object.defineProperty(window, 'vialAPI', {
    value: { ...window.vialAPI, keyLabelStoreList: keyLabelList, typingTestTextStoreList: textList },
    writable: true,
    configurable: true,
  })
})

function meta(id: string): { id: string; name: string; filename: string; savedAt: string; updatedAt: string } {
  return { id, name: id.toUpperCase(), filename: `${id}.json`, savedAt: 'now', updatedAt: 'now' }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

const cases = [
  { name: 'useKeyLabels', event: 'pipette:key-labels-changed', list: keyLabelList, use: () => useKeyLabels() },
  { name: 'useTypingTestTexts', event: 'pipette:typing-test-texts-changed', list: textList, use: () => useTypingTestTexts() },
] as const

describe.each(cases)('$name change-event refresh', ({ event, list, use }) => {
  it('re-reads without flipping loading or emptying the list', async () => {
    list.mockResolvedValue({ success: true, data: [meta('a')] })
    const loadingSeen: boolean[] = []
    const lengths: number[] = []
    const { result } = renderHook(() => {
      const r = use()
      loadingSeen.push(r.loading)
      lengths.push(r.metas.length)
      return r
    })
    await waitFor(() => expect(result.current.metas).toHaveLength(1))
    await waitFor(() => expect(result.current.loading).toBe(false))
    loadingSeen.length = 0
    lengths.length = 0

    const pending = deferred<unknown>()
    list.mockReturnValueOnce(pending.promise)
    act(() => { window.dispatchEvent(new Event(event)) })
    await act(async () => { pending.resolve({ success: true, data: [meta('a'), meta('b')] }) })

    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    expect(loadingSeen).not.toContain(true)
    expect(lengths).not.toContain(0)
  })

  it('drops a response that arrives after a newer one', async () => {
    list.mockResolvedValue({ success: true, data: [meta('a')] })
    const { result } = renderHook(() => use())
    await waitFor(() => expect(result.current.metas).toHaveLength(1))

    const older = deferred<unknown>()
    const newer = deferred<unknown>()
    list.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    act(() => { window.dispatchEvent(new Event(event)) })
    act(() => { window.dispatchEvent(new Event(event)) })
    await act(async () => { newer.resolve({ success: true, data: [meta('new')] }) })
    await act(async () => { older.resolve({ success: true, data: [meta('old')] }) })

    expect(result.current.metas.map((m) => m.id)).toEqual(['new'])
  })
})

describe('useKeyLabels refresh hold', () => {
  it('defers change-event refreshes while held and applies them on release', async () => {
    keyLabelList.mockResolvedValue({ success: true, data: [meta('a')] })
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(1))
    keyLabelList.mockClear()
    keyLabelList.mockResolvedValue({ success: true, data: [meta('a'), meta('b')] })

    act(() => { result.current.holdChangeRefresh(true) })
    act(() => { window.dispatchEvent(new Event('pipette:key-labels-changed')) })
    expect(keyLabelList).not.toHaveBeenCalled()
    expect(result.current.metas).toHaveLength(1)

    act(() => { result.current.holdChangeRefresh(false) })
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    expect(keyLabelList).toHaveBeenCalledTimes(1)
  })

  it('does not re-read on release when nothing arrived', async () => {
    keyLabelList.mockResolvedValue({ success: true, data: [meta('a')] })
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(1))
    keyLabelList.mockClear()

    act(() => { result.current.holdChangeRefresh(true) })
    act(() => { result.current.holdChangeRefresh(false) })

    expect(keyLabelList).not.toHaveBeenCalled()
  })

  it('drops a background read that lands while held and reads again on release', async () => {
    keyLabelList.mockResolvedValue({ success: true, data: [meta('a')] })
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(1))

    const inFlight = deferred<unknown>()
    keyLabelList.mockReturnValueOnce(inFlight.promise)
    act(() => { window.dispatchEvent(new Event('pipette:key-labels-changed')) })
    act(() => { result.current.holdChangeRefresh(true) })
    await act(async () => { inFlight.resolve({ success: true, data: [] }) })
    expect(result.current.metas.map((m) => m.id)).toEqual(['a'])

    keyLabelList.mockClear()
    keyLabelList.mockResolvedValue({ success: true, data: [meta('a'), meta('b')] })
    act(() => { result.current.holdChangeRefresh(false) })
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    expect(keyLabelList).toHaveBeenCalledTimes(1)
  })
})

