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

let windowShow: ReturnType<typeof vi.fn>
let windowHide: ReturnType<typeof vi.fn>
let windowStartedHidden: ReturnType<typeof vi.fn>
let windowIsVisible: ReturnType<typeof vi.fn>
let onWindowVisibilityChanged: ReturnType<typeof vi.fn>
let unsubscribeSpy: ReturnType<typeof vi.fn>
let visibilityCallback: ((visible: boolean) => void) | undefined

// Simulates a main-process push (win.on('show') / win.on('hide')) arriving
// at the renderer via onWindowVisibilityChanged.
function pushWindowVisibility(visible: boolean) {
  act(() => {
    visibilityCallback?.(visible)
  })
}

beforeEach(() => {
  windowShow = vi.fn().mockResolvedValue(true)
  windowHide = vi.fn().mockResolvedValue(undefined)
  windowStartedHidden = vi.fn().mockResolvedValue(true)
  // A boot-hidden launch means the BrowserWindow actually starts hidden,
  // so windowIsVisible() reports false until this hook shows it.
  windowIsVisible = vi.fn().mockResolvedValue(false)
  unsubscribeSpy = vi.fn()
  visibilityCallback = undefined
  onWindowVisibilityChanged = vi.fn((callback: (visible: boolean) => void) => {
    visibilityCallback = callback
    return unsubscribeSpy
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).vialAPI = {
    windowShow,
    windowHide,
    windowStartedHidden,
    windowIsVisible,
    onWindowVisibilityChanged,
  }
})

afterEach(() => {
  vi.restoreAllMocks()
})

interface Props {
  visible: boolean
}

function renderBootHiddenWindow(initialProps: Partial<Props> = {}) {
  const utils = renderHook(
    (props: Props) => useBootHiddenWindow({
      unlockDialogVisible: props.visible,
    }),
    {
      initialProps: {
        visible: false,
        ...initialProps,
      },
    },
  )
  return utils
}

describe('useBootHiddenWindow', () => {
  it('shows the window once on the unlock dialog rising edge during a boot-hidden launch', async () => {
    const { rerender } = renderBootHiddenWindow()
    await flushMicrotasks()

    rerender({ visible: true })

    expect(windowShow).toHaveBeenCalledTimes(1)
    expect(windowHide).not.toHaveBeenCalled()
  })

  it('hides the window and ends the boot-hidden phase on the falling edge, with no second show later', async () => {
    const { rerender } = renderBootHiddenWindow()
    await flushMicrotasks()

    rerender({ visible: true })
    expect(windowShow).toHaveBeenCalledTimes(1)

    rerender({ visible: false })
    expect(windowHide).toHaveBeenCalledTimes(1)

    // A later dialog must not trigger auto-show again — the phase already ended.
    rerender({ visible: true })
    expect(windowShow).toHaveBeenCalledTimes(1)
  })

  it('ends the boot-hidden phase without hiding when a foreign visibility push shows the window first', async () => {
    const { rerender } = renderBootHiddenWindow()
    await flushMicrotasks()

    pushWindowVisibility(true)

    expect(windowHide).not.toHaveBeenCalled()

    // The boot-hidden phase already ended, so a later dialog does not auto-show.
    rerender({ visible: true })
    expect(windowShow).not.toHaveBeenCalled()
  })

  it('never hides the window when windowShow reports the user beat it to the reveal', async () => {
    // The user shows the window via the tray in the gap between the
    // WINDOW_IS_VISIBLE snapshot and windowShow()'s invoke resolving.
    // main reports transitioned=false, meaning it was already visible.
    windowShow.mockResolvedValue(false)

    const { rerender } = renderBootHiddenWindow()
    await flushMicrotasks()

    rerender({ visible: true })
    await flushMicrotasks()
    expect(windowShow).toHaveBeenCalledTimes(1)

    // The dialog resolves — ownership was rolled back, so this must not
    // hide the window the user opened themselves.
    rerender({ visible: false })
    expect(windowHide).not.toHaveBeenCalled()
  })

  it('never touches the window when the launch did not start hidden', async () => {
    windowStartedHidden.mockResolvedValue(false)

    const { rerender } = renderBootHiddenWindow()
    await flushMicrotasks()

    rerender({ visible: true })
    rerender({ visible: false })

    expect(windowShow).not.toHaveBeenCalled()
    expect(windowHide).not.toHaveBeenCalled()
  })

  it('never hides the window when an unlock dialog rises and falls during normal use after the window is already visible', async () => {
    // The window started hidden, but by the time the hook learns this the
    // window is already visible (e.g. the tray click happened first).
    windowIsVisible.mockResolvedValue(true)

    const { rerender } = renderBootHiddenWindow()
    await flushMicrotasks()

    // An unlock dialog cycles during normal use — must not hide the window
    // the user is actively looking at.
    rerender({ visible: true })
    expect(windowShow).not.toHaveBeenCalled()

    rerender({ visible: false })
    expect(windowHide).not.toHaveBeenCalled()

    // Nor on a later cycle, since the phase already ended.
    rerender({ visible: true })
    rerender({ visible: false })
    expect(windowShow).not.toHaveBeenCalled()
    expect(windowHide).not.toHaveBeenCalled()
  })

  it('never hides the window when it is revealed before windowStartedHidden resolves (async race)', async () => {
    // Simulate the race: windowStartedHidden() has not resolved yet, but
    // the user reveals the window (tray click → visibility push) first.
    let resolveStartedHidden: (hidden: boolean) => void = () => {}
    windowStartedHidden.mockImplementation(
      () => new Promise<boolean>((resolve) => { resolveStartedHidden = resolve }),
    )

    const { rerender } = renderBootHiddenWindow()

    // The user reveals the window before windowStartedHidden() resolves.
    pushWindowVisibility(true)

    // Now the promise resolves with hidden=true — this must not re-arm the
    // boot-hidden phase using the stale windowIsVisible() snapshot, since
    // the live push already reported the window as visible.
    resolveStartedHidden(true)
    await flushMicrotasks()

    // A later unlock dialog cycle during normal use must not hide the window.
    rerender({ visible: true })
    expect(windowShow).not.toHaveBeenCalled()

    rerender({ visible: false })
    expect(windowHide).not.toHaveBeenCalled()
  })

  it('shows the window for a dialog already visible when arming resolves, and hides it on the falling edge', async () => {
    let resolveStartedHidden: (hidden: boolean) => void = () => {}
    windowStartedHidden.mockImplementation(
      () => new Promise<boolean>((resolve) => { resolveStartedHidden = resolve }),
    )

    // The typingView restore path (or a locked-mode entry in useInputModes)
    // opens the dialog before arming resolves.
    const { rerender } = renderBootHiddenWindow({ visible: true })

    resolveStartedHidden(true)
    await flushMicrotasks()

    expect(windowShow).toHaveBeenCalledTimes(1)

    rerender({ visible: false })
    expect(windowHide).toHaveBeenCalledTimes(1)
  })

  it('never calls windowShow for a boot-hidden launch with a locked keyboard when nothing opens the dialog', async () => {
    // Regression guard: restoring a view that does not require unlocking
    // (e.g. the plain keymap editor) must leave the window hidden — this
    // hook must not infer a prompt from a locked keyboard on its own.
    const { rerender } = renderBootHiddenWindow()
    await flushMicrotasks()

    // Simulate time passing / re-renders with the dialog never opening.
    rerender({ visible: false })
    rerender({ visible: false })

    expect(windowShow).not.toHaveBeenCalled()
    expect(windowHide).not.toHaveBeenCalled()
  })

  it('unsubscribes from window visibility changes on unmount', async () => {
    const { unmount } = renderBootHiddenWindow()
    await flushMicrotasks()

    unmount()

    expect(unsubscribeSpy).toHaveBeenCalledTimes(1)
  })
})
