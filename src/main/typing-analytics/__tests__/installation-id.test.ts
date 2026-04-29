// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
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

import {
  getInstallationId,
  resetInstallationIdCacheForTests,
  INSTALLATION_ID_PATTERN as UUID_PATTERN,
} from '../installation-id'

describe('installation-id', () => {
  beforeEach(async () => {
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'pipette-installation-id-test-'))
    resetInstallationIdCacheForTests()
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  it('generates and persists a new UUID on first access', async () => {
    const id = await getInstallationId()
    expect(id).toMatch(UUID_PATTERN)

    const stored = await readFile(join(mockUserDataPath, 'local', 'installation-id'), 'utf-8')
    expect(stored.trim()).toBe(id)
  })

  it('returns the cached value on subsequent calls within the same process', async () => {
    const first = await getInstallationId()
    const second = await getInstallationId()
    expect(second).toBe(first)
  })

  it('reads the persisted UUID across cache resets', async () => {
    const first = await getInstallationId()
    resetInstallationIdCacheForTests()
    const second = await getInstallationId()
    expect(second).toBe(first)
  })

  it('regenerates when the stored value is malformed', async () => {
    await mkdir(join(mockUserDataPath, 'local'), { recursive: true })
    await writeFile(join(mockUserDataPath, 'local', 'installation-id'), 'not-a-uuid\n', 'utf-8')

    const id = await getInstallationId()
    expect(id).toMatch(UUID_PATTERN)
    expect(id).not.toBe('not-a-uuid')

    const stored = await readFile(join(mockUserDataPath, 'local', 'installation-id'), 'utf-8')
    expect(stored.trim()).toBe(id)
  })

  it('regenerates when the stored file is empty', async () => {
    await mkdir(join(mockUserDataPath, 'local'), { recursive: true })
    await writeFile(join(mockUserDataPath, 'local', 'installation-id'), '', 'utf-8')

    const id = await getInstallationId()
    expect(id).toMatch(UUID_PATTERN)
  })

  it('deduplicates concurrent first-access callers', async () => {
    const [a, b, c] = await Promise.all([
      getInstallationId(),
      getInstallationId(),
      getInstallationId(),
    ])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(a).toMatch(UUID_PATTERN)
  })

  it('produces different UUIDs for different userData directories', async () => {
    const first = await getInstallationId()

    // Simulate settings deletion: fresh userData → fresh ID
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'pipette-installation-id-test-'))
    resetInstallationIdCacheForTests()
    const second = await getInstallationId()

    expect(second).not.toBe(first)
    expect(second).toMatch(UUID_PATTERN)
  })
})
