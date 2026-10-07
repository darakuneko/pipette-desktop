// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

vi.mock('../utils/broadcast', () => ({
  broadcastToAllWindows: vi.fn(),
}))

import {
  backfillKeyboardMeta,
  keyboardMetaFilePath,
  extractDeviceNameFromFilename,
  extractKeyboardUidsFromDriveFiles,
  mergeKeyboardMetaIndex,
  readKeyboardMetaIndex,
  upsertKeyboardMeta,
  nameKeyboardOnConnect,
  tombstoneKeyboardMeta,
  tombstoneAllKeyboardMeta,
  applyRemoteKeyboardMetaIndex,
  getActiveKeyboardMetaMap,
} from '../sync/keyboard-meta'
import type { KeyboardMetaIndex } from '../../shared/types/keyboard-meta'
import { broadcastToAllWindows } from '../utils/broadcast'
import { IpcChannels } from '../../shared/ipc/channels'
import type { DriveFile } from '../sync/google-drive'

function metaAppliedCount(): number {
  return vi.mocked(broadcastToAllWindows).mock.calls.filter(
    ([channel, payload]) => channel === IpcChannels.SYNC_UNIT_APPLIED
      && (payload as { syncUnit: string }).syncUnit === 'meta/keyboard-names',
  ).length
}

beforeEach(async () => {
  vi.mocked(broadcastToAllWindows).mockClear()
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

  // Tombstones older than TOMBSTONE_TTL_MS (30 days) are GC'd by
  // mergeKeyboardMetaIndex, so any test that asserts a tombstone
  // survives the merge must use a deletedAt within the TTL window.
  // Use relative offsets from "now" instead of hard-coded dates so the
  // tests do not rot as the wall clock advances past the fixture date.
  function isoDaysAgo(days: number): string {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
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
    const local = meta([{ uid: '0xA', deviceName: 'A', updatedAt: isoDaysAgo(7) }])
    const remote = meta([{ uid: '0xA', deviceName: 'A', updatedAt: isoDaysAgo(1), deletedAt: isoDaysAgo(1) }])
    const { merged } = mergeKeyboardMetaIndex(local, remote)
    expect(merged.entries[0].deletedAt).toBeDefined()
  })

  it('tombstone older than a save lets the save win', () => {
    const local = meta([{ uid: '0xA', deviceName: 'A', updatedAt: isoDaysAgo(1) }])
    const remote = meta([{ uid: '0xA', deviceName: 'A', updatedAt: isoDaysAgo(7), deletedAt: isoDaysAgo(7) }])
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
    expect(metaAppliedCount()).toBe(1)
  })

  async function writeRawMeta(index: KeyboardMetaIndex): Promise<string> {
    // Compact JSON, unlike the store's pretty-printed writes, so an
    // untouched file is distinguishable from a rewritten one.
    const raw = JSON.stringify(index)
    await mkdir(join(mockUserDataPath, 'sync', 'meta'), { recursive: true })
    await writeFile(keyboardMetaFilePath(), raw, 'utf-8')
    return raw
  }

  it('skips the write and the notification when the merge changes nothing', async () => {
    const index: KeyboardMetaIndex = {
      type: 'keyboard-meta',
      version: 1,
      entries: [{ uid: '0xA', deviceName: 'A', updatedAt: '2026-04-16T00:00:00.000Z' }],
    }
    const raw = await writeRawMeta(index)

    await applyRemoteKeyboardMetaIndex(index)

    expect(await readFile(keyboardMetaFilePath(), 'utf-8')).toBe(raw)
    expect(metaAppliedCount()).toBe(0)
  })

  it('writes and notifies when only tombstone GC changes the index', async () => {
    const live = { uid: '0xA', deviceName: 'A', updatedAt: '2026-04-16T00:00:00.000Z' }
    const expired = { uid: '0xB', deviceName: '', updatedAt: '2020-01-01T00:00:00.000Z', deletedAt: '2020-01-01T00:00:00.000Z' }
    await writeRawMeta({ type: 'keyboard-meta', version: 1, entries: [live, expired] })

    const { remoteNeedsUpdate } = await applyRemoteKeyboardMetaIndex({ type: 'keyboard-meta', version: 1, entries: [live] })

    expect(remoteNeedsUpdate).toBe(true)
    expect((await readKeyboardMetaIndex()).entries.map((e) => e.uid)).toEqual(['0xA'])
    expect(metaAppliedCount()).toBe(1)
  })
})

describe('backfillKeyboardMeta', () => {
  it('notifies after writing backfilled names', async () => {
    const snapDir = join(mockUserDataPath, 'sync', 'keyboards', '0xC', 'snapshots')
    await mkdir(snapDir, { recursive: true })
    await writeFile(join(snapDir, 'index.json'), JSON.stringify({
      uid: '0xC',
      entries: [{ id: 's', label: '', filename: 'Board C_2026-04-16T10-00-00.000Z.pipette', savedAt: '2026-04-16T10:00:00.000Z' }],
    }), 'utf-8')
    const files = [{ id: 'f', name: 'keyboards_0xC_snapshots.enc', modifiedTime: '' }] as DriveFile[]

    const { resolved } = await backfillKeyboardMeta('pw', files)

    expect(resolved).toBe(1)
    expect(metaAppliedCount()).toBe(1)
  })

  it('does not notify when nothing needed a name', async () => {
    await backfillKeyboardMeta('pw', [])
    expect(metaAppliedCount()).toBe(0)
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

describe('nameKeyboardOnConnect', () => {
  it('records the name when the keyboard has none', async () => {
    expect(await nameKeyboardOnConnect('0xc5', 'Ieneko54R')).toBe('upserted')
    const map = getActiveKeyboardMetaMap(await readKeyboardMetaIndex())
    expect(map.get('0xc5')).toBe('Ieneko54R')
  })

  it('does not overwrite an active name (preserves a user rename, no churn)', async () => {
    await upsertKeyboardMeta('0xc5', 'My Custom Name')
    expect(await nameKeyboardOnConnect('0xc5', 'Ieneko54R')).toBe('unchanged')
    const map = getActiveKeyboardMetaMap(await readKeyboardMetaIndex())
    expect(map.get('0xc5')).toBe('My Custom Name')
  })

  it('is a no-op for an empty uid or name', async () => {
    expect(await nameKeyboardOnConnect('', 'Name')).toBe('unchanged')
    expect(await nameKeyboardOnConnect('0xc5', '   ')).toBe('unchanged')
    expect(getActiveKeyboardMetaMap(await readKeyboardMetaIndex()).size).toBe(0)
  })

  it('revives a tombstoned entry so a reconnected keyboard is named again', async () => {
    // Reproduces the "Delete all → reconnect" state: the uid is tombstoned but
    // the physical keyboard is back, so connecting must restore its name.
    await upsertKeyboardMeta('0xc5', 'Ieneko54R')
    await tombstoneKeyboardMeta('0xc5')
    expect(await nameKeyboardOnConnect('0xc5', 'Ieneko54R')).toBe('upserted')
    const map = getActiveKeyboardMetaMap(await readKeyboardMetaIndex())
    expect(map.get('0xc5')).toBe('Ieneko54R')
  })
})
