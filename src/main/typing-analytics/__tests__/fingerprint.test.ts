// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserDataPath
      return `/mock/${name}`
    },
  },
}))

const mockMachineId = vi.fn<(original?: boolean) => Promise<string>>()

vi.mock('node-machine-id', () => ({
  default: { machineId: (original?: boolean) => mockMachineId(original) },
  machineId: (original?: boolean) => mockMachineId(original),
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    platform: () => 'linux',
    release: () => '6.8.0-test',
    arch: () => 'x64',
  }
})

import { buildFingerprint } from '../fingerprint'
import { resetInstallationIdCacheForTests } from '../installation-id'
import { resetMachineHashCacheForTests } from '../machine-hash'
import { canonicalScopeKey } from '../../../shared/types/typing-analytics'

describe('fingerprint', () => {
  beforeEach(async () => {
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'pipette-fingerprint-test-'))
    resetInstallationIdCacheForTests()
    resetMachineHashCacheForTests()
    mockMachineId.mockReset()
    mockMachineId.mockResolvedValue('fixed-machine-id')
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  const sampleKeyboard = {
    uid: '0xAABB',
    vendorId: 0xFEED,
    productId: 0x0000,
    productName: 'Pipette Keyboard',
  }

  it('builds a fingerprint with machineHash, os info, and keyboard info', async () => {
    const fp = await buildFingerprint(sampleKeyboard)

    expect(fp.machineHash).toMatch(/^[0-9a-f]{64}$/)
    expect(fp.os).toEqual({ platform: 'linux', release: '6.8.0-test', arch: 'x64' })
    expect(fp.keyboard).toEqual(sampleKeyboard)
  })

  it('produces the same canonical scope key for the same keyboard across calls', async () => {
    const a = await buildFingerprint(sampleKeyboard)
    const b = await buildFingerprint(sampleKeyboard)
    expect(canonicalScopeKey(a)).toBe(canonicalScopeKey(b))
  })

  it('produces different canonical scope keys for different keyboards', async () => {
    const a = await buildFingerprint(sampleKeyboard)
    const b = await buildFingerprint({ ...sampleKeyboard, uid: '0xCCDD' })
    expect(canonicalScopeKey(a)).not.toBe(canonicalScopeKey(b))
  })

  it('ignores productName changes in the canonical scope key', async () => {
    // Same device may expose a different product descriptor on different OSes;
    // scope key should stay stable.
    const a = await buildFingerprint(sampleKeyboard)
    const b = await buildFingerprint({ ...sampleKeyboard, productName: 'Pipette Keyboard (win)' })
    expect(canonicalScopeKey(a)).toBe(canonicalScopeKey(b))
  })
})
