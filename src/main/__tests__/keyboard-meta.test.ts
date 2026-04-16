// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserDataPath
      return `/mock/${name}`
    },
  },
}))

vi.mock('../sync/sync-crypto', () => ({
  decrypt: vi.fn(async () => '{}'),
}))

vi.mock('../sync/google-drive', () => ({
  downloadFile: vi.fn(async () => ({})),
  driveFileName: (syncUnit: string) => syncUnit.replaceAll('/', '_') + '.enc',
}))

import {
  extractDeviceNameFromFilename,
  extractKeyboardUidsFromDriveFiles,
  mergeKeyboardMetaIndex,
  readKeyboardMetaIndex,
  upsertKeyboardMeta,
  tombstoneKeyboardMeta,
  tombstoneAllKeyboardMeta,
  applyRemoteKeyboardMetaIndex,
  getActiveKeyboardMetaMap,
} from '../sync/keyboard-meta'
import type { KeyboardMetaIndex } from '../../shared/types/keyboard-meta'

beforeEach(async () => {
  mockUserDataPath = await mkdtemp(join(tmpdir(), 'keyboard-meta-test-'))
})

afterEach(async () => {
  if (!mockUserDataPath) return
  await rm(mockUserDataPath, { recursive: true, force: true })
  mockUserDataPath = ''
})

describe('extractDeviceNameFromFilename', () => {
  it('returns the device name prefix from a snapshot filename', () => {
    expect(extractDeviceNameFromFilename('GPK60-63R_2026-04-16T10-00-00.000Z.pipette')).toBe('GPK60-63R')
    expect(extractDeviceNameFromFilename('Jeneko Box 42R_2026-03-15T14-35-29.037Z.pipette')).toBe('Jeneko Box 42R')
  })

  it('returns null when the filename does not match the expected pattern', () => {
    expect(extractDeviceNameFromFilename('not-a-snapshot.json')).toBeNull()
    expect(extractDeviceNameFromFilename('')).toBeNull()
  })
})

describe('extractKeyboardUidsFromDriveFiles', () => {
  it('collects unique uids from snapshot filenames only', () => {
    const uids = extractKeyboardUidsFromDriveFiles([
      { id: '1', name: 'keyboards_0xAAA_snapshots.enc', modifiedTime: '' },
      { id: '2', name: 'keyboards_0xAAA_settings.enc', modifiedTime: '' },
      { id: '3', name: 'keyboards_0xBBB_snapshots.enc', modifiedTime: '' },
      { id: '4', name: 'favorites_macro.enc', modifiedTime: '' },
      { id: '5', name: 'meta_keyboard-names.enc', modifiedTime: '' },
    ])
    expect(uids.sort()).toEqual(['0xAAA', '0xBBB'])
  })
})

describe('mergeKeyboardMetaIndex', () => {
  function meta(entries: KeyboardMetaIndex['entries']): KeyboardMetaIndex {
    return { type: 'keyboard-meta', version: 1, entries }
  }

  it('keeps remote entries that are unknown locally', () => {
    const { merged, remoteNeedsUpdate } = mergeKeyboardMetaIndex(
      meta([]),
      meta([{ uid: '0xA', deviceName: 'A', updatedAt: '2026-04-16T00:00:00.000Z' }]),
    )
    expect(merged.entries.map((e) => e.uid)).toEqual(['0xA'])
    expect(remoteNeedsUpdate).toBe(false)
  })

  it('marks remote update needed when local has unique entries', () => {
    const { remoteNeedsUpdate } = mergeKeyboardMetaIndex(
      meta([{ uid: '0xA', deviceName: 'A', updatedAt: '2026-04-16T00:00:00.000Z' }]),
      meta([]),
    )
    expect(remoteNeedsUpdate).toBe(true)
  })

  it('newest updatedAt wins per uid (LWW)', () => {
    const local = meta([{ uid: '0xA', deviceName: 'A-old', updatedAt: '2026-04-10T00:00:00.000Z' }])
    const remote = meta([{ uid: '0xA', deviceName: 'A-new', updatedAt: '2026-04-16T00:00:00.000Z' }])
    const { merged } = mergeKeyboardMetaIndex(local, remote)
    expect(merged.entries[0].deviceName).toBe('A-new')
  })

  it('tombstone with later timestamp keeps deletion', () => {
    const local = meta([{ uid: '0xA', deviceName: 'A', updatedAt: '2026-04-10T00:00:00.000Z' }])
    const remote = meta([{ uid: '0xA', deviceName: 'A', updatedAt: '2026-04-16T00:00:00.000Z', deletedAt: '2026-04-16T00:00:00.000Z' }])
    const { merged } = mergeKeyboardMetaIndex(local, remote)
    expect(merged.entries[0].deletedAt).toBeDefined()
  })

  it('tombstone older than a save lets the save win', () => {
    const local = meta([{ uid: '0xA', deviceName: 'A', updatedAt: '2026-04-16T00:00:00.000Z' }])
    const remote = meta([{ uid: '0xA', deviceName: 'A', updatedAt: '2026-04-10T00:00:00.000Z', deletedAt: '2026-04-10T00:00:00.000Z' }])
    const { merged } = mergeKeyboardMetaIndex(local, remote)
    expect(merged.entries[0].deletedAt).toBeUndefined()
  })
})

describe('upsertKeyboardMeta + readKeyboardMetaIndex', () => {
  it('creates and re-reads an entry, then becomes a no-op when unchanged', async () => {
    const first = await upsertKeyboardMeta('0xA', 'A')
    expect(first).toBe('upserted')
    const noop = await upsertKeyboardMeta('0xA', 'A')
    expect(noop).toBe('unchanged')
    const index = await readKeyboardMetaIndex()
    expect(index.entries).toHaveLength(1)
    expect(index.entries[0]).toMatchObject({ uid: '0xA', deviceName: 'A' })
  })

  it('reviving a tombstoned entry updates updatedAt and clears deletedAt', async () => {
    await upsertKeyboardMeta('0xA', 'A')
    await tombstoneKeyboardMeta('0xA')
    const reviveResult = await upsertKeyboardMeta('0xA', 'A')
    expect(reviveResult).toBe('upserted')
    const index = await readKeyboardMetaIndex()
    expect(index.entries[0].deletedAt).toBeUndefined()
  })
})

describe('tombstoneKeyboardMeta', () => {
  it('marks an existing entry deleted and is idempotent', async () => {
    await upsertKeyboardMeta('0xA', 'A')
    const first = await tombstoneKeyboardMeta('0xA')
    expect(first).toBe('tombstoned')
    const second = await tombstoneKeyboardMeta('0xA')
    expect(second).toBe('unchanged')
  })

  it('inserts a tombstone for an unknown uid so other devices learn about the deletion', async () => {
    const result = await tombstoneKeyboardMeta('0xUnknown')
    expect(result).toBe('tombstoned')
    const index = await readKeyboardMetaIndex()
    expect(index.entries).toHaveLength(1)
    expect(index.entries[0].deletedAt).toBeDefined()
  })
})

describe('tombstoneAllKeyboardMeta', () => {
  it('tombstones every active entry and reports the count', async () => {
    await upsertKeyboardMeta('0xA', 'A')
    await upsertKeyboardMeta('0xB', 'B')
    const count = await tombstoneAllKeyboardMeta()
    expect(count).toBe(2)
    const index = await readKeyboardMetaIndex()
    expect(index.entries.every((e) => !!e.deletedAt)).toBe(true)
  })
})

describe('applyRemoteKeyboardMetaIndex', () => {
  it('persists merged result and surfaces remoteNeedsUpdate', async () => {
    await upsertKeyboardMeta('0xA', 'A')
    const remote: KeyboardMetaIndex = {
      type: 'keyboard-meta',
      version: 1,
      entries: [{ uid: '0xB', deviceName: 'B', updatedAt: '2026-04-16T00:00:00.000Z' }],
    }
    const { remoteNeedsUpdate } = await applyRemoteKeyboardMetaIndex(remote)
    expect(remoteNeedsUpdate).toBe(true)
    const stored = await readKeyboardMetaIndex()
    expect(stored.entries.map((e) => e.uid).sort()).toEqual(['0xA', '0xB'])
  })
})

describe('getActiveKeyboardMetaMap', () => {
  it('omits tombstoned entries and entries without a name', () => {
    const map = getActiveKeyboardMetaMap({
      type: 'keyboard-meta',
      version: 1,
      entries: [
        { uid: '0xA', deviceName: 'A', updatedAt: 't' },
        { uid: '0xB', deviceName: 'B', updatedAt: 't', deletedAt: 't' },
        { uid: '0xC', deviceName: '', updatedAt: 't' },
      ],
    })
    expect(map.get('0xA')).toBe('A')
    expect(map.has('0xB')).toBe(false)
    expect(map.has('0xC')).toBe(false)
  })
})
