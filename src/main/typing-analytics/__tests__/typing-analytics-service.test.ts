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

import { setupTypingAnalytics, resetTypingAnalyticsForTests } from '../typing-analytics-service'
import * as installationIdModule from '../installation-id'

describe('typing-analytics-service', () => {
  beforeEach(async () => {
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'pipette-typing-analytics-service-test-'))
    resetTypingAnalyticsForTests()
    installationIdModule.resetInstallationIdCacheForTests()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  it('shares a single in-flight initialization across concurrent callers', async () => {
    const spy = vi.spyOn(installationIdModule, 'getInstallationId')
    await Promise.all([setupTypingAnalytics(), setupTypingAnalytics(), setupTypingAnalytics()])
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('reuses the completed initialization on subsequent calls', async () => {
    const spy = vi.spyOn(installationIdModule, 'getInstallationId')
    await setupTypingAnalytics()
    await setupTypingAnalytics()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('allows retry after an initialization failure', async () => {
    const spy = vi
      .spyOn(installationIdModule, 'getInstallationId')
      .mockRejectedValueOnce(new Error('boom'))

    await expect(setupTypingAnalytics()).rejects.toThrow('boom')

    // After a failure the stored promise should clear so a retry can proceed.
    spy.mockResolvedValueOnce('11111111-2222-3333-4444-555555555555')
    await expect(setupTypingAnalytics()).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('does not leave unhandled rejections when called as fire-and-forget', async () => {
    vi
      .spyOn(installationIdModule, 'getInstallationId')
      .mockRejectedValueOnce(new Error('boom'))

    const handler = vi.fn()
    process.on('unhandledRejection', handler)
    try {
      setupTypingAnalytics().catch(() => {
        // Simulates the main-process `.catch(...)` wrapper that logs the failure.
      })
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.off('unhandledRejection', handler)
    }
    expect(handler).not.toHaveBeenCalled()
  })
})
