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

import { getMachineHash, resetMachineHashCacheForTests } from '../machine-hash'
import { resetInstallationIdCacheForTests } from '../installation-id'

const SHA256_HEX = /^[0-9a-f]{64}$/

describe('machine-hash', () => {
  beforeEach(async () => {
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'pipette-machine-hash-test-'))
    resetInstallationIdCacheForTests()
    resetMachineHashCacheForTests()
    mockMachineId.mockReset()
    mockMachineId.mockResolvedValue('aa-bb-cc-dd-machine')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  it('returns a sha256 hex digest combining the machine id and installation id', async () => {
    const hash = await getMachineHash()
    expect(hash).toMatch(SHA256_HEX)
  })

  it('memoizes the hash within a single process', async () => {
    await getMachineHash()
    await getMachineHash()
    expect(mockMachineId).toHaveBeenCalledTimes(1)
  })

  it('deduplicates concurrent first-access callers', async () => {
    const [a, b, c] = await Promise.all([getMachineHash(), getMachineHash(), getMachineHash()])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(mockMachineId).toHaveBeenCalledTimes(1)
  })

  it('produces different hashes for different machine ids', async () => {
    mockMachineId.mockResolvedValueOnce('machine-one')
    const first = await getMachineHash()

    resetMachineHashCacheForTests()
    mockMachineId.mockResolvedValueOnce('machine-two')
    const second = await getMachineHash()

    expect(first).not.toBe(second)
  })

  it('produces different hashes for different installation ids', async () => {
    mockMachineId.mockResolvedValue('same-machine')
    const first = await getMachineHash()

    // Simulate a fresh userData (installation-id regenerated) with the same
    // machine id — should produce a different hash.
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'pipette-machine-hash-test-'))
    resetInstallationIdCacheForTests()
    resetMachineHashCacheForTests()
    const second = await getMachineHash()

    expect(first).not.toBe(second)
  })

  it('retries after a transient failure', async () => {
    mockMachineId.mockRejectedValueOnce(new Error('boom'))
    await expect(getMachineHash()).rejects.toThrow('boom')

    mockMachineId.mockResolvedValueOnce('recovered-machine')
    const hash = await getMachineHash()
    expect(hash).toMatch(SHA256_HEX)
  })
})
