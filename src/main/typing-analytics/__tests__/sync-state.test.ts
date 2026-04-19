// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  emptySyncState,
  loadSyncState,
  readPointerKey,
  saveSyncState,
  SYNC_STATE_REV,
  syncStatePath,
} from '../sync-state'

describe('sync-state persistence', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pipette-sync-state-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('syncStatePath is under userData/local/typing-analytics/', () => {
    expect(syncStatePath('/u')).toBe(join('/u', 'local', 'typing-analytics', 'sync_state.json'))
  })

  it('loadSyncState returns null when the file is missing', async () => {
    expect(await loadSyncState(tmpDir)).toBeNull()
  })

  it('saves and round-trips a state document', async () => {
    const state = {
      ...emptySyncState('hash-self'),
      read_pointers: { [readPointerKey('0xAABB', 'hash-a')]: 'char|s|60000|a' },
      last_synced_at: 1_234_567,
    }
    await saveSyncState(tmpDir, state)
    const loaded = await loadSyncState(tmpDir)
    expect(loaded).toEqual(state)
  })

  it('loadSyncState rejects a document with a wrong _rev', async () => {
    const path = syncStatePath(tmpDir)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({ _rev: SYNC_STATE_REV + 1, my_device_id: 'x', read_pointers: {}, last_synced_at: 0 }),
    )
    expect(await loadSyncState(tmpDir)).toBeNull()
  })

  it('loadSyncState rejects garbled JSON', async () => {
    const path = syncStatePath(tmpDir)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{ not json')
    expect(await loadSyncState(tmpDir)).toBeNull()
  })

  it('saveSyncState writes the final file atomically (no leftover tmp)', async () => {
    await saveSyncState(tmpDir, emptySyncState('hash-self'))
    const path = syncStatePath(tmpDir)
    expect(readFileSync(path, 'utf-8')).toContain('"my_device_id": "hash-self"')
    // The rename atomic-write means no .tmp sibling should remain.
    const { readdirSync } = await import('node:fs')
    const entries = readdirSync(dirname(path))
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([])
  })
})
