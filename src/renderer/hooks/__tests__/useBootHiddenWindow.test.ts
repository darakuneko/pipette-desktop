// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useBootHiddenWindow } from '../useBootHiddenWindow'

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve()
  })
}

function setVisibilityState(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}

let windowShow: ReturnType<typeof vi.fn>
let windowHide: ReturnType<typeof vi.fn>
let windowStartedHidden: ReturnType<typeof vi.fn>

beforeEach(() => {
  windowShow = vi.fn().mockResolvedValue(undefined)
  windowHide = vi.fn().mockResolvedValue(undefined)
  windowStartedHidden = vi.fn().mockResolvedValue(true)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).vialAPI = { windowShow, windowHide, windowStartedHidden }
  setVisibilityState('visible')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useBootHiddenWindow', () => {
  it('shows the window once on the unlock dialog rising edge during a boot-hidden launch', async () => {
    const { rerender } = renderHook(({ visible }) => useBootHiddenWindow(visible), {
      initialProps: { visible: false },
    })
    await flushMicrotasks()

    rerender({ visible: true })

    expect(windowShow).toHaveBeenCalledTimes(1)
    expect(windowHide).not.toHaveBeenCalled()
  })

  it('hides the window and ends the boot-hidden phase on the falling edge, with no second show later', async () => {
    const { rerender } = renderHook(({ visible }) => useBootHiddenWindow(visible), {
      initialProps: { visible: false },
    })
    await flushMicrotasks()

    rerender({ visible: true })
    expect(windowShow).toHaveBeenCalledTimes(1)

    rerender({ visible: false })
    expect(windowHide).toHaveBeenCalledTimes(1)

    // A later dialog must not trigger auto-show again — the phase already ended.
    rerender({ visible: true })
    expect(windowShow).toHaveBeenCalledTimes(1)
  })

  it('ends the boot-hidden phase without hiding when a foreign visibilitychange shows the window first', async () => {
    const { rerender } = renderHook(({ visible }) => useBootHiddenWindow(visible), {
      initialProps: { visible: false },
    })
    await flushMicrotasks()

    setVisibilityState('visible')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(windowHide).not.toHaveBeenCalled()

    // The boot-hidden phase already ended, so a later dialog does not auto-show.
    rerender({ visible: true })
    expect(windowShow).not.toHaveBeenCalled()
  })

  it('never touches the window when the launch did not start hidden', async () => {
    windowStartedHidden.mockResolvedValue(false)

    const { rerender } = renderHook(({ visible }) => useBootHiddenWindow(visible), {
      initialProps: { visible: false },
    })
    await flushMicrotasks()

    rerender({ visible: true })
    rerender({ visible: false })

    expect(windowShow).not.toHaveBeenCalled()
    expect(windowHide).not.toHaveBeenCalled()
  })
})
