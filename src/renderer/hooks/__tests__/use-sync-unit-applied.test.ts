// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

type Bridge = typeof import('../use-sync-unit-applied')

let emit: ((syncUnit: string) => void) | null = null
const subscribe = vi.fn((cb: (syncUnit: string) => void) => {
  emit = cb
  return () => undefined
})

async function loadBridge(): Promise<Bridge> {
  // The bridge is a per-window singleton, so each test gets a fresh module.
  vi.resetModules()
  return import('../use-sync-unit-applied')
}

beforeEach(() => {
  subscribe.mockClear()
  emit = null
  Object.defineProperty(window, 'vialAPI', {
    value: { ...window.vialAPI, syncOnUnitApplied: subscribe },
    writable: true,
    configurable: true,
  })
})

describe('useSyncUnitApplied', () => {
  it('calls back only for matching units', async () => {
    const { useSyncUnitApplied } = await loadBridge()
    const onApplied = vi.fn()
    renderHook(() => useSyncUnitApplied((u) => u === 'favorites/macro', onApplied))

    act(() => { emit?.('favorites/tapDance') })
    expect(onApplied).not.toHaveBeenCalled()
    act(() => { emit?.('favorites/macro') })
    expect(onApplied).toHaveBeenCalledTimes(1)
  })

  it('uses the latest callback without resubscribing', async () => {
    const { useSyncUnitApplied } = await loadBridge()
    const addSpy = vi.spyOn(window, 'addEventListener')
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ cb }) => useSyncUnitApplied(() => true, cb), { initialProps: { cb: first } })
    const subscriptions = addSpy.mock.calls.filter(([type]) => type === 'pipette:sync-unit-applied').length

    rerender({ cb: second })
    act(() => { emit?.('x') })

    expect(addSpy.mock.calls.filter(([type]) => type === 'pipette:sync-unit-applied').length).toBe(subscriptions)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
    addSpy.mockRestore()
  })

  it('stops calling back after unmount', async () => {
    const { useSyncUnitApplied } = await loadBridge()
    const onApplied = vi.fn()
    const { unmount } = renderHook(() => useSyncUnitApplied(() => true, onApplied))
    unmount()
    act(() => { emit?.('x') })
    expect(onApplied).not.toHaveBeenCalled()
  })

  it('subscribes to IPC once for many listeners', async () => {
    const { useSyncUnitApplied } = await loadBridge()
    const a = vi.fn()
    const b = vi.fn()
    renderHook(() => useSyncUnitApplied(() => true, a))
    renderHook(() => useSyncUnitApplied(() => true, b))

    act(() => { emit?.('x') })

    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('re-dispatches the key-labels and typing-test-texts change events', async () => {
    const { ensureSyncUnitAppliedBridge } = await loadBridge()
    const keyLabels = vi.fn()
    const texts = vi.fn()
    window.addEventListener('pipette:key-labels-changed', keyLabels)
    window.addEventListener('pipette:typing-test-texts-changed', texts)
    ensureSyncUnitAppliedBridge()

    emit?.('key-labels')
    emit?.('typing-test-texts')
    emit?.('favorites/macro')

    expect(keyLabels).toHaveBeenCalledTimes(1)
    expect(texts).toHaveBeenCalledTimes(1)
    window.removeEventListener('pipette:key-labels-changed', keyLabels)
    window.removeEventListener('pipette:typing-test-texts-changed', texts)
  })

  it('moves to a replaced subscription function without a module reset', async () => {
    const { useSyncUnitApplied } = await loadBridge()
    const unsubscribeFirst = vi.fn()
    subscribe.mockReturnValueOnce(unsubscribeFirst)
    const onApplied = vi.fn()
    renderHook(() => useSyncUnitApplied(() => true, onApplied))

    let replacedEmit: ((syncUnit: string) => void) | null = null
    const replacement = vi.fn((cb: (syncUnit: string) => void) => {
      replacedEmit = cb
      return () => undefined
    })
    Object.defineProperty(window, 'vialAPI', {
      value: { ...window.vialAPI, syncOnUnitApplied: replacement },
      writable: true,
      configurable: true,
    })
    // A later consumer mount re-checks the subscription.
    renderHook(() => useSyncUnitApplied(() => false, vi.fn()))

    expect(unsubscribeFirst).toHaveBeenCalledTimes(1)
    expect(replacement).toHaveBeenCalledTimes(1)
    act(() => { (replacedEmit as ((syncUnit: string) => void) | null)?.('x') })
    expect(onApplied).toHaveBeenCalledTimes(1)
  })
})
