// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
// onWindowVisibilityChanged passes each window:visibility-changed event the
// backend emits to the callback, until unsubscribed.

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
