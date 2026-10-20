// SPDX-License-Identifier: GPL-2.0-or-later
// getDefinition reads the compressed definition over the protocol and has
// the backend decompress it.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../protocol', () => ({
  getDefinitionSize: vi.fn(() => Promise.resolve(3)),
  getDefinitionRaw: vi.fn(() => Promise.resolve(new Uint8Array([1, 2, 3]))),
}))

import { deviceApi } from '../api/device'

beforeEach(() => {
  invoke.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('deviceApi.getDefinition', () => {
  it('sends the raw bytes to decompress_definition and parses the text', async () => {
    const definition = { name: 'K', matrix: { rows: 1, cols: 1 } }
    invoke.mockResolvedValueOnce(JSON.stringify(definition))
    await expect(deviceApi.getDefinition()).resolves.toEqual(definition)
    expect(invoke).toHaveBeenCalledWith('decompress_definition', { data: [1, 2, 3] })
  })

  it('returns null when the backend cannot decompress the bytes', async () => {
    invoke.mockResolvedValueOnce(null)
    await expect(deviceApi.getDefinition()).resolves.toBeNull()
  })

  it('returns null when the command fails', async () => {
    invoke.mockRejectedValueOnce('join error')
    await expect(deviceApi.getDefinition()).resolves.toBeNull()
  })
})
