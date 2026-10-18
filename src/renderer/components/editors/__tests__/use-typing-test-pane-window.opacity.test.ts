// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { clearMocks } from '@tauri-apps/api/mocks'
import { useTypingTestPaneWindow } from '../use-typing-test-pane-window'
import { windowBackends } from './window-backends'

type Props = { viewOnly: boolean; viewOnlyOpacity?: number }

const setWindowOpacity = vi.fn()
const spies = {
  isAlwaysOnTopSupported: vi.fn(),
  setWindowAlwaysOnTop: vi.fn(),
  setWindowAspectRatio: vi.fn(),
  setWindowCompactMode: vi.fn(),
  setWindowOpacity,
}

beforeEach(() => {
  spies.isAlwaysOnTopSupported.mockReset().mockResolvedValue(false)
  spies.setWindowAlwaysOnTop.mockReset().mockResolvedValue(undefined)
  spies.setWindowAspectRatio.mockReset().mockResolvedValue(undefined)
  spies.setWindowCompactMode.mockReset().mockResolvedValue(null)
  setWindowOpacity.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('requestAnimationFrame', () => 0)
})

afterEach(() => {
  clearMocks()
  vi.unstubAllGlobals()
})

function renderWindowHook(initial: Props) {
  // keys stays empty so the default-size effect never runs; it is unrelated
  // to opacity.
  const keys: never[] = []
  const layoutOptions = new Map<number, number>()
  const typingTest = {} as Parameters<typeof useTypingTestPaneWindow>[0]['typingTest']
  return renderHook(
    ({ viewOnly, viewOnlyOpacity }: Props) => useTypingTestPaneWindow({
      typingTest,
      viewOnly,
      keys,
      layoutOptions,
      viewOnlyOpacity,
    }),
    { initialProps: initial },
  )
}

describe.each(windowBackends(spies))('useTypingTestPaneWindow — opacity ($name)', (backend) => {
  beforeEach(() => {
    backend.install()
  })

  it('does not touch the window opacity outside Typing View', () => {
    renderWindowHook({ viewOnly: false, viewOnlyOpacity: 0.7 })
    expect(setWindowOpacity).not.toHaveBeenCalled()
  })

  it('applies the saved opacity on entering Typing View', () => {
    renderWindowHook({ viewOnly: true, viewOnlyOpacity: 0.7 })
    expect(setWindowOpacity.mock.calls).toEqual([[0.7]])
  })

  it('applies the default (1) when no value is saved', () => {
    renderWindowHook({ viewOnly: true })
    expect(setWindowOpacity.mock.calls).toEqual([[1]])
  })

  it('applies the saved opacity when switching from the editor into Typing View', () => {
    const { rerender } = renderWindowHook({ viewOnly: false, viewOnlyOpacity: 0.6 })
    rerender({ viewOnly: true, viewOnlyOpacity: 0.6 })
    expect(setWindowOpacity.mock.calls).toEqual([[0.6]])
  })

  it('sends only the new value on change, without an intermediate 1', () => {
    const { rerender } = renderWindowHook({ viewOnly: true, viewOnlyOpacity: 0.9 })
    rerender({ viewOnly: true, viewOnlyOpacity: 0.85 })
    rerender({ viewOnly: true, viewOnlyOpacity: 0.8 })
    expect(setWindowOpacity.mock.calls).toEqual([[0.9], [0.85], [0.8]])
  })

  it('restores 1 on leaving Typing View', () => {
    const { rerender } = renderWindowHook({ viewOnly: true, viewOnlyOpacity: 0.7 })
    rerender({ viewOnly: false, viewOnlyOpacity: 0.7 })
    expect(setWindowOpacity.mock.calls).toEqual([[0.7], [1]])
  })

  it('restores 1 on unmount', () => {
    const { unmount } = renderWindowHook({ viewOnly: true, viewOnlyOpacity: 0.7 })
    unmount()
    expect(setWindowOpacity.mock.calls).toEqual([[0.7], [1]])
  })
})
