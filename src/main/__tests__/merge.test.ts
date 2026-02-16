// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mergeEntries, gcTombstones, effectiveTime } from '../sync/merge'
import type { SavedFavoriteMeta } from '../../shared/types/favorite-store'

type Entry = SavedFavoriteMeta

function makeEntry(overrides: Partial<Entry> & { id: string }): Entry {
  return {
    label: `Label ${overrides.id}`,
    filename: `file_${overrides.id}.json`,
    savedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('mergeEntries', () => {
  describe('local only / remote only', () => {
    it('keeps local-only entries and marks remoteNeedsUpdate', () => {
      const local = [makeEntry({ id: 'a', savedAt: '2025-01-01T00:00:00.000Z' })]
      const remote: Entry[] = []

      const result = mergeEntries(local, remote)

      expect(result.entries).toHaveLength(1)
      expect(result.entries[0].id).toBe('a')
      expect(result.remoteNeedsUpdate).toBe(true)
      expect(result.remoteFilesToCopy).toEqual([])
    })

    it('includes remote-only entries and lists files to copy', () => {
      const local: Entry[] = []
      const remote = [makeEntry({ id: 'b', savedAt: '2025-01-01T00:00:00.000Z' })]

      const result = mergeEntries(local, remote)

      expect(result.entries).toHaveLength(1)
      expect(result.entries[0].id).toBe('b')
      expect(result.remoteFilesToCopy).toContain(remote[0].filename)
      expect(result.remoteNeedsUpdate).toBe(false)
    })
  })

  describe('LWW resolution', () => {
    it('remote wins when remote is newer', () => {
      const local = [makeEntry({ id: 'x', savedAt: '2025-01-01T00:00:00.000Z', label: 'old' })]
      const remote = [makeEntry({ id: 'x', savedAt: '2025-06-01T00:00:00.000Z', label: 'new' })]

      const result = mergeEntries(local, remote)

      expect(result.entries).toHaveLength(1)
      expect(result.entries[0].label).toBe('new')
      expect(result.remoteFilesToCopy).toContain(remote[0].filename)
      expect(result.remoteNeedsUpdate).toBe(false)
    })

    it('local wins when local is newer', () => {
      const local = [makeEntry({ id: 'x', savedAt: '2025-06-01T00:00:00.000Z', label: 'local' })]
      const remote = [makeEntry({ id: 'x', savedAt: '2025-01-01T00:00:00.000Z', label: 'remote' })]

      const result = mergeEntries(local, remote)

      expect(result.entries).toHaveLength(1)
      expect(result.entries[0].label).toBe('local')
      expect(result.remoteNeedsUpdate).toBe(true)
      expect(result.remoteFilesToCopy).toEqual([])
    })

    it('local wins on tie (same timestamp)', () => {
      const ts = '2025-03-01T00:00:00.000Z'
      const local = [makeEntry({ id: 'x', savedAt: ts, label: 'local' })]
      const remote = [makeEntry({ id: 'x', savedAt: ts, label: 'remote' })]

      const result = mergeEntries(local, remote)

      expect(result.entries[0].label).toBe('local')
      expect(result.remoteNeedsUpdate).toBe(false)
      expect(result.remoteFilesToCopy).toEqual([])
    })
  })

  describe('updatedAt fallback', () => {
    it('uses updatedAt when present instead of savedAt', () => {
      const local = [makeEntry({
        id: 'x',
        savedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-07-01T00:00:00.000Z',
        label: 'local-updated',
      })]
      const remote = [makeEntry({
        id: 'x',
        savedAt: '2025-06-01T00:00:00.000Z',
        label: 'remote',
      })]

      const result = mergeEntries(local, remote)

      expect(result.entries[0].label).toBe('local-updated')
      expect(result.remoteNeedsUpdate).toBe(true)
    })

    it('falls back to savedAt when updatedAt is absent', () => {
      const local = [makeEntry({ id: 'x', savedAt: '2025-01-01T00:00:00.000Z', label: 'local' })]
      const remote = [makeEntry({
        id: 'x',
        savedAt: '2025-03-01T00:00:00.000Z',
        updatedAt: '2025-06-01T00:00:00.000Z',
        label: 'remote-updated',
      })]

      const result = mergeEntries(local, remote)

      expect(result.entries[0].label).toBe('remote-updated')
      expect(result.remoteFilesToCopy).toContain(remote[0].filename)
    })
  })

  describe('tombstone handling', () => {
    it('propagates deletion from remote', () => {
      const local = [makeEntry({ id: 'x', savedAt: '2025-01-01T00:00:00.000Z' })]
      const remote = [makeEntry({
        id: 'x',
        savedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-06-01T00:00:00.000Z',
        deletedAt: '2025-06-01T00:00:00.000Z',
      })]

      const result = mergeEntries(local, remote)

      expect(result.entries).toHaveLength(1)
      expect(result.entries[0].deletedAt).toBe('2025-06-01T00:00:00.000Z')
      expect(result.remoteNeedsUpdate).toBe(false)
    })

    it('propagates deletion from local', () => {
      const local = [makeEntry({
        id: 'x',
        savedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-06-01T00:00:00.000Z',
        deletedAt: '2025-06-01T00:00:00.000Z',
      })]
      const remote = [makeEntry({ id: 'x', savedAt: '2025-01-01T00:00:00.000Z' })]

      const result = mergeEntries(local, remote)

      expect(result.entries[0].deletedAt).toBe('2025-06-01T00:00:00.000Z')
      expect(result.remoteNeedsUpdate).toBe(true)
    })

    it('revives entry when remote is newer than deletion', () => {
      const local = [makeEntry({
        id: 'x',
        savedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-03-01T00:00:00.000Z',
        deletedAt: '2025-03-01T00:00:00.000Z',
      })]
      const remote = [makeEntry({
        id: 'x',
        savedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-06-01T00:00:00.000Z',
        label: 'revived',
      })]

      const result = mergeEntries(local, remote)

      expect(result.entries[0].deletedAt).toBeUndefined()
      expect(result.entries[0].label).toBe('revived')
      expect(result.remoteFilesToCopy).toContain(remote[0].filename)
    })
  })

  describe('mixed entries', () => {
    it('merges multiple entries from both sides', () => {
      const local = [
        makeEntry({ id: 'a', savedAt: '2025-01-01T00:00:00.000Z' }),
        makeEntry({ id: 'b', savedAt: '2025-02-01T00:00:00.000Z' }),
      ]
      const remote = [
        makeEntry({ id: 'b', savedAt: '2025-03-01T00:00:00.000Z', label: 'remote-b' }),
        makeEntry({ id: 'c', savedAt: '2025-01-01T00:00:00.000Z' }),
      ]

      const result = mergeEntries(local, remote)

      expect(result.entries).toHaveLength(3)
      const ids = result.entries.map((e) => e.id).sort()
      expect(ids).toEqual(['a', 'b', 'c'])
      expect(result.entries.find((e) => e.id === 'b')?.label).toBe('remote-b')
      expect(result.remoteNeedsUpdate).toBe(true) // local-only 'a' exists
      expect(result.remoteFilesToCopy).toContain(remote[0].filename) // remote 'b' won
      expect(result.remoteFilesToCopy).toContain(remote[1].filename) // remote-only 'c'
    })

    it('sorts merged entries newest-first by effective time', () => {
      const local = [
        makeEntry({ id: 'old', savedAt: '2025-01-01T00:00:00.000Z' }),
      ]
      const remote = [
        makeEntry({ id: 'new', savedAt: '2025-06-01T00:00:00.000Z' }),
      ]

      const result = mergeEntries(local, remote)

      expect(result.entries[0].id).toBe('new')
      expect(result.entries[1].id).toBe('old')
    })
  })

  describe('tombstone file copy optimization', () => {
    it('does not copy files for remote-only tombstoned entries', () => {
      const local: Entry[] = []
      const remote = [makeEntry({
        id: 'deleted',
        savedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-06-01T00:00:00.000Z',
        deletedAt: '2025-06-01T00:00:00.000Z',
      })]

      const result = mergeEntries(local, remote)

      expect(result.entries).toHaveLength(1)
      expect(result.entries[0].deletedAt).toBeTruthy()
      expect(result.remoteFilesToCopy).toEqual([])
    })

    it('does not copy files when remote tombstone wins LWW', () => {
      const local = [makeEntry({ id: 'x', savedAt: '2025-01-01T00:00:00.000Z' })]
      const remote = [makeEntry({
        id: 'x',
        savedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-06-01T00:00:00.000Z',
        deletedAt: '2025-06-01T00:00:00.000Z',
      })]

      const result = mergeEntries(local, remote)

      expect(result.entries[0].deletedAt).toBeTruthy()
      expect(result.remoteFilesToCopy).toEqual([])
    })
  })

  describe('invalid timestamp handling', () => {
    it('treats invalid timestamps as epoch zero', () => {
      expect(effectiveTime(makeEntry({ id: 'x', savedAt: 'not-a-date' }))).toBe(0)
    })

    it('remote with valid time wins over local with invalid time', () => {
      const local = [makeEntry({ id: 'x', savedAt: 'invalid', label: 'local' })]
      const remote = [makeEntry({ id: 'x', savedAt: '2025-01-01T00:00:00.000Z', label: 'remote' })]

      const result = mergeEntries(local, remote)

      expect(result.entries[0].label).toBe('remote')
    })
  })

  describe('remoteNeedsUpdate accuracy', () => {
    it('returns false when remote and local are identical', () => {
      const entry = makeEntry({ id: 'x', savedAt: '2025-01-01T00:00:00.000Z' })
      const result = mergeEntries([{ ...entry }], [{ ...entry }])
      expect(result.remoteNeedsUpdate).toBe(false)
    })

    it('returns true when local has entries not in remote', () => {
      const result = mergeEntries(
        [makeEntry({ id: 'a', savedAt: '2025-01-01T00:00:00.000Z' })],
        [],
      )
      expect(result.remoteNeedsUpdate).toBe(true)
    })

    it('returns true when local entry wins LWW', () => {
      const result = mergeEntries(
        [makeEntry({ id: 'x', savedAt: '2025-06-01T00:00:00.000Z' })],
        [makeEntry({ id: 'x', savedAt: '2025-01-01T00:00:00.000Z' })],
      )
      expect(result.remoteNeedsUpdate).toBe(true)
    })
  })
})

describe('gcTombstones', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-15T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('removes tombstones older than 30 days', () => {
    const entries = [
      makeEntry({
        id: 'old',
        savedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-05-01T00:00:00.000Z',
        deletedAt: '2025-05-01T00:00:00.000Z',
      }),
    ]

    const result = gcTombstones(entries)
    expect(result).toHaveLength(0)
  })

  it('keeps tombstones within 30 days', () => {
    const entries = [
      makeEntry({
        id: 'recent',
        savedAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-06-01T00:00:00.000Z',
        deletedAt: '2025-06-01T00:00:00.000Z',
      }),
    ]

    const result = gcTombstones(entries)
    expect(result).toHaveLength(1)
  })

  it('keeps non-deleted entries untouched', () => {
    const entries = [
      makeEntry({ id: 'alive', savedAt: '2025-01-01T00:00:00.000Z' }),
    ]

    const result = gcTombstones(entries)
    expect(result).toHaveLength(1)
  })

  it('handles mixed entries correctly', () => {
    const entries = [
      makeEntry({ id: 'alive', savedAt: '2025-01-01T00:00:00.000Z' }),
      makeEntry({
        id: 'old-tombstone',
        savedAt: '2025-01-01T00:00:00.000Z',
        deletedAt: '2025-04-01T00:00:00.000Z',
        updatedAt: '2025-04-01T00:00:00.000Z',
      }),
      makeEntry({
        id: 'recent-tombstone',
        savedAt: '2025-01-01T00:00:00.000Z',
        deletedAt: '2025-06-10T00:00:00.000Z',
        updatedAt: '2025-06-10T00:00:00.000Z',
      }),
    ]

    const result = gcTombstones(entries)
    expect(result).toHaveLength(2)
    expect(result.map((e) => e.id)).toEqual(['alive', 'recent-tombstone'])
  })
})
