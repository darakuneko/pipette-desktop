// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

import { appendSessionRecord } from '../sessions-file-store'
import { sessionsFilePath } from '../typing-analytics-paths'
import type { TypingSessionRecord } from '../../../shared/types/typing-analytics'

const UID = '0xAABB'

function record(start: string, end: string, keystrokeCount: number, scope = 'scope-1'): TypingSessionRecord {
  return { start, end, keystrokeCount, scope }
}

describe('sessions-file-store', () => {
  beforeEach(async () => {
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'pipette-sessions-file-store-test-'))
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  it('appends a session record to the start-date JSONL file', async () => {
    const r = record('2026-04-14T10:00:00.000Z', '2026-04-14T10:15:00.000Z', 150)
    await appendSessionRecord(UID, r)

    const path = sessionsFilePath(UID, '2026-04-14')
    const content = await readFile(path, 'utf-8')
    expect(content.trimEnd()).toBe(JSON.stringify(r))
  })

  it('appends additional records on later calls (one per line)', async () => {
    const a = record('2026-04-14T10:00:00.000Z', '2026-04-14T10:15:00.000Z', 100)
    const b = record('2026-04-14T14:00:00.000Z', '2026-04-14T14:20:00.000Z', 200)
    await appendSessionRecord(UID, a)
    await appendSessionRecord(UID, b)

    const path = sessionsFilePath(UID, '2026-04-14')
    const content = await readFile(path, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0])).toEqual(a)
    expect(JSON.parse(lines[1])).toEqual(b)
  })

  it('routes a session that crosses midnight to the start-date file', async () => {
    const crossing = record('2026-01-01T23:59:50.000Z', '2026-01-02T00:04:00.000Z', 50)
    await appendSessionRecord(UID, crossing)

    const startPath = sessionsFilePath(UID, '2026-01-01')
    const startContent = await readFile(startPath, 'utf-8')
    expect(startContent.trim()).toBe(JSON.stringify(crossing))

    // The end-date file is not created.
    const endPath = sessionsFilePath(UID, '2026-01-02')
    await expect(readFile(endPath, 'utf-8')).rejects.toThrow()
  })
})
