// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
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

import { cleanupArchiveForKeyboard } from '../archive-cleanup'
import {
  dailyDir,
  sessionsDir,
  archivedDailyFilePath,
  archivedSessionsFilePath,
} from '../typing-analytics-paths'
import { stat } from 'node:fs/promises'

const UID = '0xAABB'

async function seedDaily(date: string, content = '{}'): Promise<void> {
  const dir = dailyDir(UID)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${date}.json`), content, 'utf-8')
}

async function seedSessions(date: string, content = ''): Promise<void> {
  const dir = sessionsDir(UID)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${date}.jsonl`), content, 'utf-8')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('archive-cleanup', () => {
  beforeEach(async () => {
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'pipette-archive-cleanup-test-'))
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  it('keeps files within the sync span in place', async () => {
    await seedDaily('2026-04-10')
    await seedDaily('2026-04-14')
    await seedSessions('2026-04-10')
    await seedSessions('2026-04-14')

    const result = await cleanupArchiveForKeyboard(UID, { today: '2026-04-14', syncSpanDays: 7 })

    expect(result).toEqual({ movedDaily: 0, movedSessions: 0 })
    const daily = await readdir(dailyDir(UID))
    expect(daily.sort()).toEqual(['2026-04-10.json', '2026-04-14.json'])
  })

  it('moves expired daily and sessions files into archive/YYYY-MM/', async () => {
    await seedDaily('2026-03-20')
    await seedDaily('2026-04-14')
    await seedSessions('2026-03-20')
    await seedSessions('2026-04-14')

    const result = await cleanupArchiveForKeyboard(UID, { today: '2026-04-14', syncSpanDays: 7 })

    expect(result).toEqual({ movedDaily: 1, movedSessions: 1 })
    expect(await exists(archivedDailyFilePath(UID, '2026-03-20'))).toBe(true)
    expect(await exists(archivedSessionsFilePath(UID, '2026-03-20'))).toBe(true)

    const remainingDaily = await readdir(dailyDir(UID))
    expect(remainingDaily).toEqual(['2026-04-14.json'])
  })

  it('ignores files that do not match the expected YYYY-MM-DD pattern', async () => {
    const dir = dailyDir(UID)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'notes.txt'), 'keep me', 'utf-8')
    await writeFile(join(dir, 'weird.json'), '{}', 'utf-8')

    const result = await cleanupArchiveForKeyboard(UID, { today: '2026-04-14', syncSpanDays: 7 })

    expect(result).toEqual({ movedDaily: 0, movedSessions: 0 })
    const remaining = await readdir(dir)
    expect(remaining.sort()).toEqual(['notes.txt', 'weird.json'])
  })

  it('is a no-op when the live directories do not exist yet', async () => {
    const result = await cleanupArchiveForKeyboard(UID, { today: '2026-04-14', syncSpanDays: 7 })
    expect(result).toEqual({ movedDaily: 0, movedSessions: 0 })
  })

  it('keeps the exact boundary date in place', async () => {
    // syncSpanDays = 7 with today = 2026-04-14 → cutoff = 2026-04-08, so 04-08 stays
    await seedDaily('2026-04-08')
    await seedDaily('2026-04-07')

    const result = await cleanupArchiveForKeyboard(UID, { today: '2026-04-14', syncSpanDays: 7 })

    expect(result.movedDaily).toBe(1)
    const remaining = await readdir(dailyDir(UID))
    expect(remaining).toEqual(['2026-04-08.json'])
  })
})
