// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  emptySyncState,
  isReconcilePending,
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
      uploaded: { [readPointerKey('0xAABB', 'hash-self')]: ['2026-04-17'] },
      reconciled_at: { [readPointerKey('0xAABB', 'hash-self')]: 1_700_000 },
      last_synced_at: 1_234_567,
    }
    await saveSyncState(tmpDir, state)
    const loaded = await loadSyncState(tmpDir)
    expect(loaded).toEqual(state)
  })

  it('loadSyncState rejects a document with a newer _rev than we know', async () => {
    const path = syncStatePath(tmpDir)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        _rev: SYNC_STATE_REV + 1,
        my_device_id: 'x',
        uploaded: {},
        reconciled_at: {},
        last_synced_at: 0,
      }),
    )
    expect(await loadSyncState(tmpDir)).toBeNull()
  })

  it('migrates a v1 document by dropping read_pointers and initialising the new fields', async () => {
    const path = syncStatePath(tmpDir)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        _rev: 1,
        my_device_id: 'hash-self',
        read_pointers: { [readPointerKey('0xAABB', 'hash-a')]: 'char|s|60000|a' },
        last_synced_at: 42,
      }),
    )
    expect(await loadSyncState(tmpDir)).toEqual({
      _rev: SYNC_STATE_REV,
      my_device_id: 'hash-self',
      uploaded: {},
      reconciled_at: {},
      last_synced_at: 42,
    })
  })

  it('migrates a v2 document by dropping read_pointers and keeping uploaded + reconciled_at', async () => {
    const path = syncStatePath(tmpDir)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        _rev: 2,
        my_device_id: 'hash-self',
        read_pointers: { [readPointerKey('0xAABB', 'hash-a')]: 'char|s|60000|a' },
        uploaded: { [readPointerKey('0xAABB', 'hash-self')]: ['2026-04-17'] },
        reconciled_at: { [readPointerKey('0xAABB', 'hash-self')]: 1_700_000 },
        last_synced_at: 99,
      }),
    )
    expect(await loadSyncState(tmpDir)).toEqual({
      _rev: SYNC_STATE_REV,
      my_device_id: 'hash-self',
      uploaded: { [readPointerKey('0xAABB', 'hash-self')]: ['2026-04-17'] },
      reconciled_at: { [readPointerKey('0xAABB', 'hash-self')]: 1_700_000 },
      last_synced_at: 99,
    })
  })

  it('round-trips a current-rev document with uploaded + reconciled_at populated', async () => {
    const state = {
      ...emptySyncState('hash-self'),
      uploaded: { [readPointerKey('0xAABB', 'hash-self')]: ['2026-04-17', '2026-04-18'] },
      reconciled_at: { [readPointerKey('0xAABB', 'hash-self')]: 1_700_000 },
    }
    await saveSyncState(tmpDir, state)
    expect(await loadSyncState(tmpDir)).toEqual(state)
  })

  it('loadSyncState rejects a document with non-ISO dates in uploaded', async () => {
    const path = syncStatePath(tmpDir)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        _rev: SYNC_STATE_REV,
        my_device_id: 'x',
        uploaded: { 'k': ['2026/04/17'] },
        reconciled_at: {},
        last_synced_at: 0,
      }),
    )
    expect(await loadSyncState(tmpDir)).toBeNull()
  })

  it('loadSyncState rejects a document with non-finite reconciled_at', async () => {
    const path = syncStatePath(tmpDir)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        _rev: SYNC_STATE_REV,
        my_device_id: 'x',
        uploaded: {},
        reconciled_at: { 'k': 'not-a-number' },
        last_synced_at: 0,
      }),
    )
    expect(await loadSyncState(tmpDir)).toBeNull()
  })

  it('loadSyncState accepts a null reconciled_at entry (pending reconcile)', async () => {
    const path = syncStatePath(tmpDir)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        _rev: SYNC_STATE_REV,
        my_device_id: 'x',
        uploaded: {},
        reconciled_at: { 'k': null },
        last_synced_at: 0,
      }),
    )
    const loaded = await loadSyncState(tmpDir)
    expect(loaded?.reconciled_at).toEqual({ 'k': null })
  })

  it('loadSyncState rejects garbled JSON', async () => {
    const path = syncStatePath(tmpDir)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{ not json')
    expect(await loadSyncState(tmpDir)).toBeNull()
  })

  describe('isReconcilePending', () => {
    it('treats a missing entry the same as null', () => {
      const state = emptySyncState('hash-self')
      expect(isReconcilePending(state, '0xAABB', 'hash-self')).toBe(true)
    })

    it('returns true for an explicitly null entry', () => {
      const state = emptySyncState('hash-self')
      state.reconciled_at[readPointerKey('0xAABB', 'hash-self')] = null
      expect(isReconcilePending(state, '0xAABB', 'hash-self')).toBe(true)
    })

    it('returns false once reconcile has run (timestamp set)', () => {
      const state = emptySyncState('hash-self')
      state.reconciled_at[readPointerKey('0xAABB', 'hash-self')] = 1_700_000
      expect(isReconcilePending(state, '0xAABB', 'hash-self')).toBe(false)
    })

    it('a v1-migrated state reports pending for any own-hash key', async () => {
      const path = syncStatePath(tmpDir)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(
        path,
        JSON.stringify({
          _rev: 1,
          my_device_id: 'hash-self',
          read_pointers: {},
          last_synced_at: 0,
        }),
      )
      const loaded = await loadSyncState(tmpDir)
      expect(loaded).not.toBeNull()
      expect(isReconcilePending(loaded!, '0xAABB', 'hash-self')).toBe(true)
    })
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
