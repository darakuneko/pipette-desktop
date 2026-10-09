// SPDX-License-Identifier: GPL-2.0-or-later
// Another device's deleted ranges stay hidden while its day files are
// replayed into the cache by a rebuild: each file's rows and the ranges'
// tombstones land in one transaction, so no live in-range row is ever
// visible, and this device's own hash is never touched.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

vi.mock('../../logger', () => ({ log: vi.fn() }))
vi.mock('../jsonl/jsonl-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../jsonl/jsonl-reader')>()
  return { ...actual, readRows: vi.fn(actual.readRows) }
})

import { rebuildCacheFromMasterFiles } from '../cache-rebuild'
import { TypingAnalyticsDB } from '../db/typing-analytics-db'
import { readRows } from '../jsonl/jsonl-reader'
import { minuteStatsRowId, scopeRowId, sessionRowId, type JsonlRow } from '../jsonl/jsonl-row'
import { appendRowsToFile } from '../jsonl/jsonl-writer'
import { deletedRangesPath, deviceDayJsonlPath } from '../jsonl/paths'
import { serializeDeletedRanges, type DeletedRangeEntry } from '../deleted-ranges'

const UID = '0xAABB'
const OWN = 'hash-own'
const REMOTE = 'hash-remote'
const DAY_1 = '2026-04-18'
const DAY_2 = '2026-04-19'
const MIN_1 = Date.UTC(2026, 3, 18, 10, 0)
const MIN_2 = Date.UTC(2026, 3, 19, 10, 0)

const scopeId = (hash: string): string => `${hash}|linux|${UID}`

function rowsFor(hash: string, minuteTs: number): JsonlRow[] {
  return [
    {
      id: scopeRowId(scopeId(hash)),
      kind: 'scope',
      updated_at: 1_000,
      payload: {
        id: scopeId(hash), machineHash: hash, osPlatform: 'linux', osRelease: '6', osArch: 'x64',
        keyboardUid: UID, keyboardVendorId: 1, keyboardProductId: 1, keyboardProductName: 'Pipette',
      },
    },
    {
      id: minuteStatsRowId(scopeId(hash), minuteTs, ''),
      kind: 'minute-stats',
      updated_at: 1_000,
      payload: {
        scopeId: scopeId(hash), minuteTs, keystrokes: 5, activeMs: 1_000, intervalAvgMs: 100,
        intervalMinMs: 50, intervalP25Ms: 75, intervalP50Ms: 100, intervalP75Ms: 150, intervalMaxMs: 200,
      },
    },
    {
      id: sessionRowId(`${hash}-${minuteTs}`),
      kind: 'session',
      updated_at: 1_000,
      payload: { id: `${hash}-${minuteTs}`, scopeId: scopeId(hash), startMs: minuteTs, endMs: minuteTs + 30_000 },
    },
  ]
}

let tmpDir: string
let db: TypingAnalyticsDB

function writeRanges(hash: string, entries: DeletedRangeEntry[]): void {
  const path = deletedRangesPath(tmpDir, UID, hash)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeDeletedRanges(entries))
}

function liveStats(hash: string): number[] {
  return (db.getConnection().prepare(
    'SELECT minute_ts AS m FROM typing_minute_stats WHERE scope_id = ? AND is_deleted = 0 ORDER BY minute_ts',
  ).all(scopeId(hash)) as Array<{ m: number }>).map((r) => r.m)
}

function liveSessions(hash: string): number {
  return (db.getConnection().prepare(
    'SELECT COUNT(*) AS n FROM typing_sessions WHERE scope_id = ? AND is_deleted = 0',
  ).get(scopeId(hash)) as { n: number }).n
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'pipette-ranges-replay-'))
  db = new TypingAnalyticsDB(join(tmpDir, 'cache.db'))
  for (const hash of [OWN, REMOTE]) {
    await appendRowsToFile(deviceDayJsonlPath(tmpDir, UID, hash, DAY_1), rowsFor(hash, MIN_1))
    await appendRowsToFile(deviceDayJsonlPath(tmpDir, UID, hash, DAY_2), rowsFor(hash, MIN_2))
  }
  const actual = await vi.importActual<typeof import('../jsonl/jsonl-reader')>('../jsonl/jsonl-reader')
  vi.mocked(readRows).mockReset().mockImplementation(actual.readRows)
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('rebuildCacheFromMasterFiles with deleted ranges', () => {
  it('hides the remote hash\'s rows inside a range up to its cutoff', async () => {
    writeRanges(REMOTE, [{ id: 'r1', startMs: MIN_1, endMs: MIN_1 + 60_000, cutoffMs: MIN_2 + 3_600_000 }])
    await rebuildCacheFromMasterFiles(db, tmpDir, OWN)
    expect(liveStats(REMOTE)).toEqual([MIN_2])
    expect(liveSessions(REMOTE)).toBe(1)
  })

  it('keeps rows after the cutoff', async () => {
    writeRanges(REMOTE, [{ id: 'r1', startMs: 0, endMs: MIN_2 + 60_000, cutoffMs: MIN_1 }])
    await rebuildCacheFromMasterFiles(db, tmpDir, OWN)
    expect(liveStats(REMOTE)).toEqual([MIN_2])
  })

  it('never applies a ranges file to this device\'s own hash', async () => {
    writeRanges(OWN, [{ id: 'r1', startMs: 0, endMs: MIN_2 + 60_000, cutoffMs: MIN_2 + 60_000 }])
    await rebuildCacheFromMasterFiles(db, tmpDir, OWN)
    expect(liveStats(OWN)).toEqual([MIN_1, MIN_2])
    expect(liveSessions(OWN)).toBe(2)
  })

  it('shows no live in-range row between the files it replays', async () => {
    writeRanges(REMOTE, [{ id: 'all', startMs: 0, endMs: MIN_2 + 60_001, cutoffMs: MIN_2 + 60_000 }])
    const seen: number[][] = []
    const actual = await vi.importActual<typeof import('../jsonl/jsonl-reader')>('../jsonl/jsonl-reader')
    vi.mocked(readRows).mockImplementation(async (path) => {
      seen.push(liveStats(REMOTE))
      return actual.readRows(path)
    })
    await rebuildCacheFromMasterFiles(db, tmpDir, OWN)
    seen.push(liveStats(REMOTE))
    expect(seen.length).toBe(5)
    expect(seen.every((live) => live.length === 0)).toBe(true)
    expect(liveStats(OWN)).toEqual([MIN_1, MIN_2])
  })

  it('uses a ranges file written while the rebuild runs, from the next file on', async () => {
    const actual = await vi.importActual<typeof import('../jsonl/jsonl-reader')>('../jsonl/jsonl-reader')
    vi.mocked(readRows).mockImplementation(async (path) => {
      const result = await actual.readRows(path)
      if (path === deviceDayJsonlPath(tmpDir, UID, REMOTE, DAY_2)) {
        writeRanges(REMOTE, [{ id: 'late', startMs: 0, endMs: MIN_2 + 60_001, cutoffMs: MIN_2 + 60_000 }])
      }
      return result
    })
    await rebuildCacheFromMasterFiles(db, tmpDir, OWN)
    // Day 1 was replayed before the file existed; its writer hides it in
    // the cache itself (typing-device-delete.ts, typing-deleted-ranges-merge.ts).
    expect(liveStats(REMOTE)).toEqual([MIN_1])
  })

  it('replays normally when the ranges file is unreadable', async () => {
    const path = deletedRangesPath(tmpDir, UID, REMOTE)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{broken')
    await rebuildCacheFromMasterFiles(db, tmpDir, OWN)
    expect(liveStats(REMOTE)).toEqual([MIN_1, MIN_2])
  })
})
