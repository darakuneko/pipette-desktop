// SPDX-License-Identifier: GPL-2.0-or-later
// openExternal rejects with the backend's message.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { shellApi } from '../api/shell'

beforeEach(() => {
  invoke.mockReset()
})

describe('shellApi.openExternal', () => {
  it('rejects with the reason the backend refused the URL', async () => {
    invoke.mockRejectedValueOnce('Invalid URL scheme')
    await expect(shellApi.openExternal('file:///etc/passwd')).rejects.toThrow(new Error('Invalid URL scheme'))
    expect(invoke).toHaveBeenCalledWith('open_external', { url: 'file:///etc/passwd' })
  })
})
