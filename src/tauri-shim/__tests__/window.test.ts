// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// onWindowVisibilityChanged passes each window:visibility-changed event the
// backend emits to the callback, until unsubscribed. The members of the
// Typing Test's view-only window invoke their commands with the members'
// arguments by name and resolve with the commands' answers.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { emit } from '@tauri-apps/api/event'
import { windowApi } from '../api/window'

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

afterEach(() => {
  clearMocks()
})

describe('windowApi.onWindowVisibilityChanged', () => {
  it('passes the visibility the backend sends until unsubscribed', async () => {
    mockIPC(() => {}, { shouldMockEvents: true })
    const callback = vi.fn()
    const unsubscribe = windowApi.onWindowVisibilityChanged(callback)
    await settle()
    await emit('window:visibility-changed', false)
    await emit('window:visibility-changed', true)
    unsubscribe()
    await emit('window:visibility-changed', false)
    expect(callback.mock.calls).toEqual([[false], [true]])
  })
})

describe('windowApi view-only window members', () => {
  function record(answers: Record<string, unknown> = {}): { cmd: string; args: unknown }[] {
    const calls: { cmd: string; args: unknown }[] = []
    mockIPC((cmd, args) => {
      calls.push({ cmd, args })
      return answers[cmd] ?? null
    })
    return calls
  }

  it('enters compact mode with the content size and resolves null', async () => {
    const calls = record()
    await expect(windowApi.setWindowCompactMode(true, { width: 400, height: 120 })).resolves.toBeNull()
    expect(calls).toEqual([{ cmd: 'set_window_compact_mode', args: { enabled: true, compactSize: { width: 400, height: 120 } } }])
  })

  it('leaves compact mode without a size and resolves the size before it', async () => {
    const calls = record({ set_window_compact_mode: { width: 400, height: 157 } })
    await expect(windowApi.setWindowCompactMode(false)).resolves.toEqual({ width: 400, height: 157 })
    expect(calls).toEqual([{ cmd: 'set_window_compact_mode', args: { enabled: false } }])
  })

  it('passes the aspect ratio, always on top, opacity and minimum size and resolves undefined', async () => {
    const calls = record()
    await expect(windowApi.setWindowAspectRatio(0)).resolves.toBeUndefined()
    await expect(windowApi.setWindowAlwaysOnTop(false)).resolves.toBeUndefined()
    await expect(windowApi.setWindowOpacity(0.49)).resolves.toBeUndefined()
    await expect(windowApi.setWindowMinSize(1.5, 0.25)).resolves.toBeUndefined()
    expect(calls).toEqual([
      { cmd: 'set_window_aspect_ratio', args: { ratio: 0 } },
      { cmd: 'set_window_always_on_top', args: { enabled: false } },
      { cmd: 'set_window_opacity', args: { opacity: 0.49 } },
      { cmd: 'set_window_min_size', args: { width: 1.5, height: 0.25 } },
    ])
  })

  it('resolves whether always on top is supported as the backend answers', async () => {
    record({ is_always_on_top_supported: false })
    await expect(windowApi.isAlwaysOnTopSupported()).resolves.toBe(false)
    clearMocks()
    record({ is_always_on_top_supported: true })
    await expect(windowApi.isAlwaysOnTopSupported()).resolves.toBe(true)
  })
})
