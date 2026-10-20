// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Protocol from '../protocol'
import { createProtocolMembers } from '../protocol-members'

function fakeProtocol(raw: Uint8Array): typeof Protocol {
  return {
    getDefinitionSize: vi.fn(() => Promise.resolve(raw.length)),
    getDefinitionRaw: vi.fn(() => Promise.resolve(raw)),
    setLightingValue: vi.fn(() => Promise.resolve()),
    getVialRGBSupported: vi.fn(() => Promise.resolve(new Set([3, 1]))),
  } as unknown as typeof Protocol
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('createProtocolMembers', () => {
  it('passes the raw definition to the host as a number array and parses the text', async () => {
    const decompress = vi.fn(() => Promise.resolve('{"name":"K"}'))
    const members = createProtocolMembers(fakeProtocol(new Uint8Array([9, 8])), decompress)
    await expect(members.getDefinition()).resolves.toEqual({ name: 'K' })
    expect(decompress).toHaveBeenCalledWith([9, 8])
  })

  it('returns null when decompression fails, the text is not JSON, or the host throws', async () => {
    const protocol = fakeProtocol(new Uint8Array([1]))
    await expect(createProtocolMembers(protocol, () => Promise.resolve(null)).getDefinition()).resolves.toBeNull()
    await expect(createProtocolMembers(protocol, () => Promise.resolve('{')).getDefinition()).resolves.toBeNull()
    await expect(
      createProtocolMembers(protocol, () => Promise.reject(new Error('ipc'))).getDefinition(),
    ).resolves.toBeNull()
  })

  it('forwards arguments to the protocol and converts byte containers to arrays', async () => {
    const protocol = fakeProtocol(new Uint8Array())
    const members = createProtocolMembers(protocol, () => Promise.resolve(null))
    await members.setLightingValue(0x80, 1, 2)
    expect(protocol.setLightingValue).toHaveBeenCalledWith(0x80, 1, 2)
    await expect(members.getVialRGBSupported()).resolves.toEqual([3, 1])
  })
})
