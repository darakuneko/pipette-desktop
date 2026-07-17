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
  keyboardLocked: boolean | null
  onRequestUnlockDialog: () => void
}

function renderBootHiddenWindow(initialProps: Partial<Props> = {}) {
  const onRequestUnlockDialog = initialProps.onRequestUnlockDialog ?? vi.fn()
  const utils = renderHook(
    (props: Props) => useBootHiddenWindow({
      unlockDialogVisible: props.visible,
      keyboardLocked: props.keyboardLocked,
      onRequestUnlockDialog: props.onRequestUnlockDialog,
    }),
    {
      initialProps: {
        visible: false,
        keyboardLocked: null,
        onRequestUnlockDialog,
        ...initialProps,
      },
    },
  )
  return { ...utils, onRequestUnlockDialog }
}

describe('useBootHiddenWindow', () => {
  it('shows the window once on the unlock dialog rising edge during a boot-hidden launch', async () => {
    const { rerender } = renderBootHiddenWindow()
    await flushMicrotasks()

    rerender({ visible: true, keyboardLocked: null, onRequestUnlockDialog: vi.fn() })

    expect(windowShow).toHaveBeenCalledTimes(1)
    expect(windowHide).not.toHaveBeenCalled()
  })

  it('hides the window and ends the boot-hidden phase on the falling edge, with no second show later', async () => {
    const { rerender } = renderBootHiddenWindow()
    await flushMicrotasks()

    rerender({ visible: true, keyboardLocked: null, onRequestUnlockDialog: vi.fn() })
    expect(windowShow).toHaveBeenCalledTimes(1)

    rerender({ visible: false, keyboardLocked: null, onRequestUnlockDialog: vi.fn() })
    expect(windowHide).toHaveBeenCalledTimes(1)

    // A later dialog must not trigger auto-show again — the phase already ended.
    rerender({ visible: true, keyboardLocked: null, onRequestUnlockDialog: vi.fn() })
    expect(windowShow).toHaveBeenCalledTimes(1)
  })

  it('ends the boot-hidden phase without hiding when a foreign visibility push shows the window first', async () => {
    const { rerender } = renderBootHiddenWindow()
    await flushMicrotasks()

    pushWindowVisibility(true)

    expect(windowHide).not.toHaveBeenCalled()

    // The boot-hidden phase already ended, so a later dialog does not auto-show.
    rerender({ visible: true, keyboardLocked: null, onRequestUnlockDialog: vi.fn() })
    expect(windowShow).not.toHaveBeenCalled()
  })

  it('never hides the window when windowShow reports the user beat it to the reveal', async () => {
    // The user shows the window via the tray in the gap between the
    // WINDOW_IS_VISIBLE snapshot and windowShow()'s invoke resolving.
    // main reports transitioned=false, meaning it was already visible.
    windowShow.mockResolvedValue(false)

    const { rerender } = renderBootHiddenWindow()
    await flushMicrotasks()

    rerender({ visible: true, keyboardLocked: null, onRequestUnlockDialog: vi.fn() })
    await flushMicrotasks()
    expect(windowShow).toHaveBeenCalledTimes(1)

    // The dialog resolves — ownership was rolled back, so this must not
    // hide the window the user opened themselves.
    rerender({ visible: false, keyboardLocked: null, onRequestUnlockDialog: vi.fn() })
    expect(windowHide).not.toHaveBeenCalled()
  })

  it('never touches the window when the launch did not start hidden', async () => {
    windowStartedHidden.mockResolvedValue(false)

    const { rerender } = renderBootHiddenWindow()
    await flushMicrotasks()

    rerender({ visible: true, keyboardLocked: null, onRequestUnlockDialog: vi.fn() })
    rerender({ visible: false, keyboardLocked: null, onRequestUnlockDialog: vi.fn() })

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
    rerender({ visible: true, keyboardLocked: null, onRequestUnlockDialog: vi.fn() })
    expect(windowShow).not.toHaveBeenCalled()

    rerender({ visible: false, keyboardLocked: null, onRequestUnlockDialog: vi.fn() })
    expect(windowHide).not.toHaveBeenCalled()

    // Nor on a later cycle, since the phase already ended.
    rerender({ visible: true, keyboardLocked: null, onRequestUnlockDialog: vi.fn() })
    rerender({ visible: false, keyboardLocked: null, onRequestUnlockDialog: vi.fn() })
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
    rerender({ visible: true, keyboardLocked: null, onRequestUnlockDialog: vi.fn() })
    expect(windowShow).not.toHaveBeenCalled()

    rerender({ visible: false, keyboardLocked: null, onRequestUnlockDialog: vi.fn() })
    expect(windowHide).not.toHaveBeenCalled()
  })

  it('requests the unlock dialog once when a boot-hidden launch reconnects a locked keyboard', async () => {
    const { rerender, onRequestUnlockDialog } = renderBootHiddenWindow({ keyboardLocked: null })
    await flushMicrotasks()

    rerender({ visible: false, keyboardLocked: true, onRequestUnlockDialog })
    expect(onRequestUnlockDialog).toHaveBeenCalledTimes(1)

    // Further rerenders (even with locked still true) must not re-call it.
    rerender({ visible: false, keyboardLocked: true, onRequestUnlockDialog })
    expect(onRequestUnlockDialog).toHaveBeenCalledTimes(1)
  })

  it('requests the unlock dialog even if keyboardLocked becomes true before windowStartedHidden resolves', async () => {
    let resolveStartedHidden: (hidden: boolean) => void = () => {}
    windowStartedHidden.mockImplementation(
      () => new Promise<boolean>((resolve) => { resolveStartedHidden = resolve }),
    )

    const { rerender, onRequestUnlockDialog } = renderBootHiddenWindow({ keyboardLocked: null })

    // keyboardLocked resolves to true before windowStartedHidden() does.
    rerender({ visible: false, keyboardLocked: true, onRequestUnlockDialog })
    expect(onRequestUnlockDialog).not.toHaveBeenCalled()

    resolveStartedHidden(true)
    await flushMicrotasks()

    expect(onRequestUnlockDialog).toHaveBeenCalledTimes(1)
  })

  it('shows the window for a dialog already visible when arming resolves, and hides it on the falling edge', async () => {
    let resolveStartedHidden: (hidden: boolean) => void = () => {}
    windowStartedHidden.mockImplementation(
      () => new Promise<boolean>((resolve) => { resolveStartedHidden = resolve }),
    )

    // The typingView restore path opens the dialog before arming resolves.
    const { rerender, onRequestUnlockDialog } = renderBootHiddenWindow({
      visible: true,
      keyboardLocked: true,
    })

    resolveStartedHidden(true)
    await flushMicrotasks()

    expect(windowShow).toHaveBeenCalledTimes(1)
    // The dialog was already visible, so this hook must not also request it.
    expect(onRequestUnlockDialog).not.toHaveBeenCalled()

    rerender({ visible: false, keyboardLocked: false, onRequestUnlockDialog })
    expect(windowHide).toHaveBeenCalledTimes(1)
  })

  it('never requests the unlock dialog when windowStartedHidden resolves false', async () => {
    windowStartedHidden.mockResolvedValue(false)

    const { rerender, onRequestUnlockDialog } = renderBootHiddenWindow({ keyboardLocked: null })
    await flushMicrotasks()

    rerender({ visible: false, keyboardLocked: true, onRequestUnlockDialog })
    expect(onRequestUnlockDialog).not.toHaveBeenCalled()
  })

  it('never requests the unlock dialog when the user reveals the window first', async () => {
    const { rerender, onRequestUnlockDialog } = renderBootHiddenWindow({ keyboardLocked: null })
    await flushMicrotasks()

    pushWindowVisibility(true)

    rerender({ visible: false, keyboardLocked: true, onRequestUnlockDialog })
    expect(onRequestUnlockDialog).not.toHaveBeenCalled()
  })

  it('ends the phase on confirmed-unlocked without prompting, and ignores a later lock transition', async () => {
    const { rerender, onRequestUnlockDialog } = renderBootHiddenWindow({ keyboardLocked: null })
    await flushMicrotasks()

    rerender({ visible: false, keyboardLocked: false, onRequestUnlockDialog })
    expect(onRequestUnlockDialog).not.toHaveBeenCalled()

    // Startup-only: a later lock transition must not prompt or reveal.
    rerender({ visible: false, keyboardLocked: true, onRequestUnlockDialog })
    expect(onRequestUnlockDialog).not.toHaveBeenCalled()

    rerender({ visible: true, keyboardLocked: true, onRequestUnlockDialog })
    expect(windowShow).not.toHaveBeenCalled()
  })

  it('never requests the unlock dialog while keyboardLocked stays unknown', async () => {
    const { rerender, onRequestUnlockDialog } = renderBootHiddenWindow({ keyboardLocked: null })
    await flushMicrotasks()

    rerender({ visible: false, keyboardLocked: null, onRequestUnlockDialog })
    rerender({ visible: false, keyboardLocked: null, onRequestUnlockDialog })

    expect(onRequestUnlockDialog).not.toHaveBeenCalled()
  })

  it('does not re-prompt on reconnect (locked → unknown → locked again)', async () => {
    const { rerender, onRequestUnlockDialog } = renderBootHiddenWindow({ keyboardLocked: null })
    await flushMicrotasks()

    rerender({ visible: false, keyboardLocked: true, onRequestUnlockDialog })
    expect(onRequestUnlockDialog).toHaveBeenCalledTimes(1)

    // Disconnect: keyboardLocked goes back to unknown.
    rerender({ visible: false, keyboardLocked: null, onRequestUnlockDialog })
    expect(onRequestUnlockDialog).toHaveBeenCalledTimes(1)

    // Reconnect: locked is confirmed true again — must not re-prompt.
    rerender({ visible: false, keyboardLocked: true, onRequestUnlockDialog })
    expect(onRequestUnlockDialog).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes from window visibility changes on unmount', async () => {
    const { unmount } = renderBootHiddenWindow()
    await flushMicrotasks()

    unmount()

    expect(unsubscribeSpy).toHaveBeenCalledTimes(1)
  })
})
