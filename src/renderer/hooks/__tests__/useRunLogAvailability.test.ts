// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useRunLogAvailability } from '../useRunLogAvailability'

const listSpy = vi.fn()

beforeEach(() => {
  listSpy.mockReset()
  window.vialAPI = { typingRunLogList: listSpy } as unknown as typeof window.vialAPI
})

describe('useRunLogAvailability', () => {
  it('skips the fetch entirely when uid is null', () => {
    const { result } = renderHook(() => useRunLogAvailability(null, 0))
    expect(listSpy).not.toHaveBeenCalled()
    expect(result.current.availableRunIds.size).toBe(0)
  })

  it('resolves to a Set of runIds from a successful list', async () => {
    listSpy.mockResolvedValue({
      success: true,
      entries: [
        { id: 'run-1', startedAt: '2026-01-01T00:00:00Z', filename: 'a.json', savedAt: '2026-01-01T00:00:00Z' },
        { id: 'run-2', startedAt: '2026-01-02T00:00:00Z', filename: 'b.json', savedAt: '2026-01-02T00:00:00Z' },
      ],
    })
    const { result } = renderHook(() => useRunLogAvailability('uid-1', 1))
    await waitFor(() => expect(result.current.availableRunIds.has('run-1')).toBe(true))
    expect(result.current.availableRunIds.has('run-2')).toBe(true)
    expect(result.current.availableRunIds.has('run-3')).toBe(false)
    expect(listSpy).toHaveBeenCalledWith('uid-1')
  })

  it('falls back to an empty set on a failed list, without throwing', async () => {
    listSpy.mockResolvedValue({ success: false, error: 'nope' })
    const { result } = renderHook(() => useRunLogAvailability('uid-1', 1))
    await waitFor(() => expect(listSpy).toHaveBeenCalled())
    expect(result.current.availableRunIds.size).toBe(0)
  })

  it('falls back to an empty set when the IPC call itself rejects', async () => {
    listSpy.mockRejectedValue(new Error('ipc down'))
    const { result } = renderHook(() => useRunLogAvailability('uid-1', 1))
    await waitFor(() => expect(listSpy).toHaveBeenCalled())
    expect(result.current.availableRunIds.size).toBe(0)
  })

  it('re-fetches when uid changes', async () => {
    listSpy.mockResolvedValueOnce({ success: true, entries: [{ id: 'run-1' }] })
    listSpy.mockResolvedValueOnce({ success: true, entries: [{ id: 'run-2' }] })
    const { result, rerender } = renderHook(({ uid, openSeq }) => useRunLogAvailability(uid, openSeq), { initialProps: { uid: 'uid-1', openSeq: 1 } })
    await waitFor(() => expect(result.current.availableRunIds.has('run-1')).toBe(true))
    rerender({ uid: 'uid-2', openSeq: 1 })
    await waitFor(() => expect(listSpy).toHaveBeenCalledWith('uid-2'))
    await waitFor(() => expect(result.current.availableRunIds.has('run-2')).toBe(true))
  })

  it('re-fetches on every openSeq bump even when uid stays the same (a run finished after the first History open must still surface on reopen)', async () => {
    listSpy.mockResolvedValueOnce({ success: true, entries: [{ id: 'run-1' }] })
    listSpy.mockResolvedValueOnce({ success: true, entries: [{ id: 'run-1' }, { id: 'run-2' }] })
    const { result, rerender } = renderHook(({ openSeq }) => useRunLogAvailability('uid-1', openSeq), { initialProps: { openSeq: 1 } })
    await waitFor(() => expect(result.current.availableRunIds.has('run-1')).toBe(true))
    expect(result.current.availableRunIds.has('run-2')).toBe(false)

    // History reopened (a second, later-finished run now exists on disk) —
    // bumping openSeq alone, with `uid` unchanged, must trigger a refetch.
    rerender({ openSeq: 2 })
    expect(listSpy).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(result.current.availableRunIds.has('run-2')).toBe(true))
  })

  it('keeps the previously-known Set visible while a refetch is in flight (no flicker back to empty)', async () => {
    let resolveSecond: ((v: unknown) => void) | undefined
    listSpy.mockResolvedValueOnce({ success: true, entries: [{ id: 'run-1' }] })
    listSpy.mockReturnValueOnce(new Promise((resolve) => { resolveSecond = resolve }))
    const { result, rerender } = renderHook(({ openSeq }) => useRunLogAvailability('uid-1', openSeq), { initialProps: { openSeq: 1 } })
    await waitFor(() => expect(result.current.availableRunIds.has('run-1')).toBe(true))

    rerender({ openSeq: 2 })
    // The second fetch hasn't resolved yet — the previous Set must still
    // be visible, not reset to empty.
    expect(result.current.availableRunIds.has('run-1')).toBe(true)

    resolveSecond?.({ success: true, entries: [{ id: 'run-1' }, { id: 'run-2' }] })
    await waitFor(() => expect(result.current.availableRunIds.has('run-2')).toBe(true))
  })
})
