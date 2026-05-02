// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureCacheIsFresh,
  rebuildCacheFromMasterFiles,
  truncateCache,
} from '../cache-rebuild'
import { TypingAnalyticsDB } from '../db/typing-analytics-db'
import { SCHEMA_VERSION } from '../db/schema'
import {
  charMinuteRowId,
  minuteStatsRowId,
  scopeRowId,
  type JsonlRow,
} from '../jsonl/jsonl-row'
import { appendRowsToFile } from '../jsonl/jsonl-writer'
import { deviceDayJsonlPath } from '../jsonl/paths'
import {
  emptySyncState,
  loadSyncState,
  saveSyncState,
} from '../sync-state'

const SAMPLE_DAY = '2026-04-19'

const UID_A = '0xAABB'
const MY_HASH = 'hash-self'
const REMOTE_HASH = 'hash-remote'

function scope(machineHash: string, updatedAt = 1_000): JsonlRow {
  const scopeId = `${machineHash}|linux|${UID_A}`
  return {
    id: scopeRowId(scopeId),
    kind: 'scope',
    updated_at: updatedAt,
    payload: {
      id: scopeId,
      machineHash,
      osPlatform: 'linux',
      osRelease: '6.8.0',
      osArch: 'x64',
      keyboardUid: UID_A,
      keyboardVendorId: 0xFEED,
      keyboardProductId: 0x0001,
      keyboardProductName: 'Pipette',
    },
  }
}

function char(machineHash: string, char: string, count: number, updatedAt = 1_000): JsonlRow {
  const scopeId = `${machineHash}|linux|${UID_A}`
  return {
    id: charMinuteRowId(scopeId, 60_000, char),
    kind: 'char-minute',
    updated_at: updatedAt,
    payload: { scopeId, minuteTs: 60_000, char, count },
  }
}

function stats(machineHash: string, keystrokes: number, updatedAt = 1_000): JsonlRow {
  const scopeId = `${machineHash}|linux|${UID_A}`
  return {
    id: minuteStatsRowId(scopeId, 60_000),
    kind: 'minute-stats',
    updated_at: updatedAt,
    payload: {
      scopeId,
      minuteTs: 60_000,
      keystrokes,
      activeMs: 1_000,
      intervalAvgMs: 100,
      intervalMinMs: 50,
      intervalP25Ms: 75,
      intervalP50Ms: 100,
      intervalP75Ms: 150,
      intervalMaxMs: 200,
    },
  }
}

describe('truncateCache', () => {
  let tmpDir: string
  let db: TypingAnalyticsDB

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipette-cache-truncate-'))
    db = new TypingAnalyticsDB(join(tmpDir, 'cache.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('drops user rows but keeps schema + meta intact', () => {
    db.upsertScope({
      id: 'scope-1',
      machineHash: MY_HASH,
      osPlatform: 'linux',
      osRelease: '6.8.0',
      osArch: 'x64',
      keyboardUid: UID_A,
      keyboardVendorId: 0xFEED,
      keyboardProductId: 0x0001,
      keyboardProductName: 'Pipette',
      updatedAt: 1_000,
    })
    db.writeMinute(
      {
        scopeId: 'scope-1',
        minuteTs: 60_000,
        keystrokes: 3,
        activeMs: 1_000,
        intervalAvgMs: 100,
        intervalMinMs: 50,
        intervalP25Ms: 75,
        intervalP50Ms: 100,
        intervalP75Ms: 150,
        intervalMaxMs: 200,
      },
      [{ scopeId: 'scope-1', minuteTs: 60_000, char: 'a', count: 3 }],
      [],
      2_000,
    )
    truncateCache(db)
    const conn = db.getConnection()
    expect((conn.prepare('SELECT COUNT(*) AS n FROM typing_scopes').get() as { n: number }).n).toBe(0)
    expect((conn.prepare('SELECT COUNT(*) AS n FROM typing_char_minute').get() as { n: number }).n).toBe(0)
    expect(db.getMeta('schema_version')).toBe(String(SCHEMA_VERSION))
  })
})

describe('rebuildCacheFromMasterFiles', () => {
  let tmpDir: string
  let db: TypingAnalyticsDB

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipette-cache-rebuild-'))
    db = new TypingAnalyticsDB(join(tmpDir, 'cache.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('replays every local and remote device file into the cache', async () => {
    await appendRowsToFile(deviceDayJsonlPath(tmpDir, UID_A, MY_HASH, SAMPLE_DAY), [
      scope(MY_HASH),
      stats(MY_HASH, 10),
      char(MY_HASH, 'a', 5),
    ])
    await appendRowsToFile(deviceDayJsonlPath(tmpDir, UID_A, REMOTE_HASH, SAMPLE_DAY), [
      scope(REMOTE_HASH),
      stats(REMOTE_HASH, 3),
      char(REMOTE_HASH, 'b', 2),
    ])

    const result = await rebuildCacheFromMasterFiles(db, tmpDir)
    expect(result.scopes).toBe(2)
    expect(result.charMinutes).toBe(2)
    expect(result.minuteStats).toBe(2)
    expect(result.jsonlFilesRead).toBe(2)

    const conn = db.getConnection()
    const totals = conn.prepare('SELECT COUNT(*) AS n FROM typing_minute_stats').get() as { n: number }
    expect(totals.n).toBe(2)
  })

  it('starts from a clean slate each call (no double-counting on re-run)', async () => {
    await appendRowsToFile(deviceDayJsonlPath(tmpDir, UID_A, MY_HASH, SAMPLE_DAY), [
      scope(MY_HASH),
      char(MY_HASH, 'a', 4),
    ])
    await rebuildCacheFromMasterFiles(db, tmpDir)
    await rebuildCacheFromMasterFiles(db, tmpDir)

    const conn = db.getConnection()
    const row = conn.prepare('SELECT count FROM typing_char_minute').get() as { count: number }
    expect(row.count).toBe(4)
  })

  it('handles a sync tree that does not yet exist', async () => {
    const result = await rebuildCacheFromMasterFiles(db, tmpDir)
    expect(result.jsonlFilesRead).toBe(0)
  })

  it('handles an empty JSONL file without applying any rows', async () => {
    const path = deviceDayJsonlPath(tmpDir, UID_A, MY_HASH, SAMPLE_DAY)
    // Create parent dir + empty file (simulates a freshly-placed download
    // that has not yet been appended to).
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '')
    const result = await rebuildCacheFromMasterFiles(db, tmpDir)
    // Empty file contributes no rows; the rebuild treats it as a no-op
    // rather than an error.
    expect(result.jsonlFilesRead).toBe(0)
    expect(result.charMinutes).toBe(0)
  })

  it('replays multiple per-day files for the same hash in chronological order', async () => {
    await appendRowsToFile(deviceDayJsonlPath(tmpDir, UID_A, MY_HASH, '2026-04-18'), [
      scope(MY_HASH),
      char(MY_HASH, 'a', 3),
    ])
    await appendRowsToFile(deviceDayJsonlPath(tmpDir, UID_A, MY_HASH, '2026-04-19'), [
      char(MY_HASH, 'c', 4, 2_000),
    ])

    const result = await rebuildCacheFromMasterFiles(db, tmpDir)
    expect(result.jsonlFilesRead).toBe(2)

    const conn = db.getConnection()
    const totals = conn.prepare('SELECT COUNT(*) AS n FROM typing_char_minute').get() as { n: number }
    expect(totals.n).toBe(2)
  })
})

describe('ensureCacheIsFresh', () => {
  let tmpDir: string
  let db: TypingAnalyticsDB

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipette-cache-ensure-'))
    db = new TypingAnalyticsDB(join(tmpDir, 'cache.db'))
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('rebuilds when the sync-state file is missing', async () => {
    await appendRowsToFile(deviceDayJsonlPath(tmpDir, UID_A, MY_HASH, SAMPLE_DAY), [
      scope(MY_HASH),
      stats(MY_HASH, 1),
    ])
    const { rebuilt, state } = await ensureCacheIsFresh(db, tmpDir, MY_HASH)
    expect(rebuilt).toBe(true)
    expect(state.my_device_id).toBe(MY_HASH)
    expect(await loadSyncState(tmpDir)).not.toBeNull()
  })

  it('rebuilds when my_device_id changed (machine migration)', async () => {
    await saveSyncState(tmpDir, {
      ...emptySyncState('hash-old'),
      uploaded: { 'stale-key': ['2025-01-01'] },
    })
    const { rebuilt, state } = await ensureCacheIsFresh(db, tmpDir, MY_HASH)
    expect(rebuilt).toBe(true)
    expect(state.my_device_id).toBe(MY_HASH)
    // Migration starts from a clean state — the previous device's
    // upload bookkeeping is dropped.
    expect(Object.keys(state.uploaded)).not.toContain('stale-key')
  })

  it('skips rebuild when sync-state is valid and my_device_id matches', async () => {
    await saveSyncState(tmpDir, emptySyncState(MY_HASH))
    const { rebuilt, state } = await ensureCacheIsFresh(db, tmpDir, MY_HASH)
    expect(rebuilt).toBe(false)
    expect(state.my_device_id).toBe(MY_HASH)
  })

  it('force=true rebuilds even when sync-state is valid', async () => {
    await saveSyncState(tmpDir, emptySyncState(MY_HASH))
    const { rebuilt } = await ensureCacheIsFresh(db, tmpDir, MY_HASH, { force: true })
    expect(rebuilt).toBe(true)
  })
})
