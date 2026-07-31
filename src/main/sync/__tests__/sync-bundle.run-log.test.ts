// SPDX-License-Identifier: GPL-2.0-or-later
//
// Focused coverage for the run-log sync unit (keyboards/{uid}/runs) —
// see .claude/tasks/backlog/Task-tm-phase5-run-keystroke-log.md. Mirrors
// sync-bundle.test.ts's scoping/mocking approach.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

vi.mock('../../app-config', () => ({
  loadAppConfig: vi.fn(async () => ({})),
  saveAppConfig: vi.fn(async () => {}),
}))
vi.mock('../../typing-analytics/db/typing-analytics-db', () => ({
  getTypingAnalyticsDB: vi.fn(),
}))
vi.mock('../../typing-analytics/machine-hash', () => ({
  getMachineHash: vi.fn(async () => 'mock-hash'),
}))
vi.mock('../../logger', () => ({
  log: vi.fn(),
}))

import { bundleSyncUnit, collectAllSyncUnits, isRunLogSyncUnit } from '../sync-bundle'

describe('run-log sync unit', () => {
  beforeEach(async () => {
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'sync-bundle-run-log-test-'))
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  describe('isRunLogSyncUnit', () => {
    it('matches a per-keyboard runs unit', () => {
      expect(isRunLogSyncUnit('keyboards/0x1234/runs')).toBe(true)
    })

    it('rejects everything else', () => {
      expect(isRunLogSyncUnit('keyboards/0x1234/snapshots')).toBe(false)
      expect(isRunLogSyncUnit('keyboards/0x1234/analyze_filters')).toBe(false)
      expect(isRunLogSyncUnit('keyboards/0x1234/devices/hash/days/2026-01-01')).toBe(false)
      expect(isRunLogSyncUnit('favorites/macro')).toBe(false)
    })
  })

  it('collectAllSyncUnits picks up keyboards/{uid}/runs when its index exists', async () => {
    const runsDir = join(mockUserDataPath, 'sync', 'keyboards', 'uid-a', 'runs')
    await mkdir(runsDir, { recursive: true })
    await writeFile(join(runsDir, 'index.json'), JSON.stringify({ uid: 'uid-a', entries: [] }), 'utf-8')

    const units = await collectAllSyncUnits()
    expect(units).toContain('keyboards/uid-a/runs')
  })

  it('collectAllSyncUnits does not invent a runs unit when none exists', async () => {
    const units = await collectAllSyncUnits()
    expect(units.some((u) => u.endsWith('/runs'))).toBe(false)
  })

  it('bundleSyncUnit tags a runs unit as type "run-log"', async () => {
    const runsDir = join(mockUserDataPath, 'sync', 'keyboards', 'uid-a', 'runs')
    await mkdir(runsDir, { recursive: true })
    const meta = { id: 'run-1', startedAt: '2026-01-01T00:00:00.000Z', filename: 'run-1.json', savedAt: '2026-01-01T00:00:00.000Z' }
    await writeFile(join(runsDir, 'index.json'), JSON.stringify({ uid: 'uid-a', entries: [meta] }), 'utf-8')
    await writeFile(join(runsDir, 'run-1.json'), JSON.stringify({ runId: 'run-1' }), 'utf-8')

    const bundle = await bundleSyncUnit('keyboards/uid-a/runs')
    expect(bundle).not.toBeNull()
    expect(bundle!.type).toBe('run-log')
    expect(bundle!.key).toBe('uid-a')
    expect(bundle!.files['run-1.json']).toBeDefined()
  })
})
