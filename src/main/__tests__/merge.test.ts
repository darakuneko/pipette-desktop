// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mergeEntries, gcTombstones, effectiveTime, applyRunLogRetention } from '../sync/merge'
import type { SavedFavoriteMeta } from '../../shared/types/favorite-store'
import type { RunLogMeta } from '../../shared/types/typing-run-log'
import { MAX_RUN_LOGS_PER_KEYBOARD } from '../../shared/types/typing-run-log'

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

    it('sorts merged active entries newest-first by effective time', () => {
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

    it('places tombstones after active entries', () => {
      const local = [
        makeEntry({ id: 'alive', savedAt: '2025-01-01T00:00:00.000Z' }),
        makeEntry({
          id: 'dead',
          savedAt: '2025-06-01T00:00:00.000Z',
          updatedAt: '2025-06-01T00:00:00.000Z',
          deletedAt: '2025-06-01T00:00:00.000Z',
        }),
      ]
      const remote: Entry[] = []

      const result = mergeEntries(local, remote)

      expect(result.entries).toHaveLength(2)
      expect(result.entries[0].id).toBe('alive')
      expect(result.entries[1].id).toBe('dead')
      expect(result.entries[1].deletedAt).toBeTruthy()
    })
  })

  describe('preserveLocalOrder', () => {
    it('keeps local array order when preserveLocalOrder is true', () => {
      const local = [
        makeEntry({ id: 'c', savedAt: '2025-01-01T00:00:00.000Z' }),
        makeEntry({ id: 'a', savedAt: '2025-06-01T00:00:00.000Z' }),
        makeEntry({ id: 'b', savedAt: '2025-03-01T00:00:00.000Z' }),
      ]
      const remote: Entry[] = []

      const result = mergeEntries(local, remote, { preserveLocalOrder: true })

      expect(result.entries.map((e) => e.id)).toEqual(['c', 'a', 'b'])
    })

    it('appends remote-only entries at the end when preserveLocalOrder is true', () => {
      const local = [
        makeEntry({ id: 'b', savedAt: '2025-03-01T00:00:00.000Z' }),
        makeEntry({ id: 'a', savedAt: '2025-01-01T00:00:00.000Z' }),
      ]
      const remote = [
        makeEntry({ id: 'a', savedAt: '2025-01-01T00:00:00.000Z' }),
        makeEntry({ id: 'c', savedAt: '2025-06-01T00:00:00.000Z' }),
      ]

      const result = mergeEntries(local, remote, { preserveLocalOrder: true })

      expect(result.entries.map((e) => e.id)).toEqual(['b', 'a', 'c'])
    })

    it('separates tombstones to end even with preserveLocalOrder', () => {
      const local = [
        makeEntry({
          id: 'dead',
          savedAt: '2025-06-01T00:00:00.000Z',
          updatedAt: '2025-06-01T00:00:00.000Z',
          deletedAt: '2025-06-01T00:00:00.000Z',
        }),
        makeEntry({ id: 'alive', savedAt: '2025-01-01T00:00:00.000Z' }),
      ]
      const remote: Entry[] = []

      const result = mergeEntries(local, remote, { preserveLocalOrder: true })

      expect(result.entries.map((e) => e.id)).toEqual(['alive', 'dead'])
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

describe('applyRunLogRetention (pure, deterministic)', () => {
  function makeMeta(overrides: Partial<RunLogMeta> & { id: string; startedAt: string }): RunLogMeta {
    return { filename: `${overrides.id}.json`, savedAt: overrides.startedAt, ...overrides }
  }

  function makeMetas(count: number): RunLogMeta[] {
    return Array.from({ length: count }, (_, i) => makeMeta({ id: `id-${i}`, startedAt: new Date(2026, 0, 1, 0, 0, i).toISOString() }))
  }

  it('is a no-op under the cap', () => {
    const entries = makeMetas(MAX_RUN_LOGS_PER_KEYBOARD)
    const { entries: result, evicted } = applyRunLogRetention(entries, MAX_RUN_LOGS_PER_KEYBOARD)
    expect(result).toHaveLength(MAX_RUN_LOGS_PER_KEYBOARD)
    expect(evicted).toHaveLength(0)
  })

  it('keeps the newest N regardless of input order (shuffled)', () => {
    const entries = makeMetas(MAX_RUN_LOGS_PER_KEYBOARD + 10)
    const shuffled = [...entries].sort(() => Math.random() - 0.5)
    const { entries: result } = applyRunLogRetention(shuffled, MAX_RUN_LOGS_PER_KEYBOARD)
    const keptIds = new Set(result.filter((e) => !e.deletedAt).map((e) => e.id))
    expect(keptIds.size).toBe(MAX_RUN_LOGS_PER_KEYBOARD)
    // Newest 50 (highest index, since index tracks minute-offset here) survive.
    for (let i = 10; i < MAX_RUN_LOGS_PER_KEYBOARD + 10; i++) {
      expect(keptIds.has(`id-${i}`)).toBe(true)
    }
    for (let i = 0; i < 10; i++) {
      expect(keptIds.has(`id-${i}`)).toBe(false)
    }
  })

  it('converges two divergent 50+ sets onto the same kept set after a union', () => {
    // Simulate two devices that each recorded slightly different extra
    // runs beyond the cap, then a merge that unions everything. Ranking
    // by immutable startedAt (not by whichever device's LWW timestamp
    // is newer) must yield the identical kept set regardless of which
    // side's array order the union happens to preserve.
    const shared = makeMetas(MAX_RUN_LOGS_PER_KEYBOARD)
    const deviceAExtra = [makeMeta({ id: 'device-a-1', startedAt: new Date(2025, 0, 1).toISOString() })]
    const deviceBExtra = [makeMeta({ id: 'device-b-1', startedAt: new Date(2025, 0, 2).toISOString() })]

    const unionOrderA = [...shared, ...deviceAExtra, ...deviceBExtra]
    const unionOrderB = [...deviceBExtra, ...deviceAExtra, ...shared].reverse()

    const resultA = applyRunLogRetention(unionOrderA, MAX_RUN_LOGS_PER_KEYBOARD)
    const resultB = applyRunLogRetention(unionOrderB, MAX_RUN_LOGS_PER_KEYBOARD)

    const keptIdsA = new Set(resultA.entries.filter((e) => !e.deletedAt).map((e) => e.id))
    const keptIdsB = new Set(resultB.entries.filter((e) => !e.deletedAt).map((e) => e.id))
    expect(keptIdsA).toEqual(keptIdsB)
    // Both older, single extra entries lose to the 50 newer `shared` runs.
    expect(keptIdsA.has('device-a-1')).toBe(false)
    expect(keptIdsA.has('device-b-1')).toBe(false)
  })

  it('mergeEntries applies retention via runLogRetentionMax and reports evicted entries', () => {
    const local = makeMetas(MAX_RUN_LOGS_PER_KEYBOARD)
    const remote: RunLogMeta[] = [makeMeta({ id: 'newcomer', startedAt: new Date(2027, 0, 1).toISOString() })]

    const result = mergeEntries(local, remote, { runLogRetentionMax: MAX_RUN_LOGS_PER_KEYBOARD })

    const keptIds = new Set(result.entries.filter((e) => !e.deletedAt).map((e) => e.id))
    expect(keptIds.size).toBe(MAX_RUN_LOGS_PER_KEYBOARD)
    expect(keptIds.has('newcomer')).toBe(true)
    // The oldest local entry (id-0) was evicted to make room.
    expect(result.evicted.map((e) => e.id)).toContain('id-0')
    expect(keptIds.has('id-0')).toBe(false)
  })

  it('marks remoteNeedsUpdate when retention evicts entries even though the LWW pass alone found nothing to upload (P8)', () => {
    // Remote-only-so-far merge: an empty local side merged against a
    // remote bundle that already has MORE than the cap active — every
    // entry lands in the "remote only" branch, which never sets
    // remoteNeedsUpdate on its own (there's nothing local-only to report
    // back). Retention then evicts the overflow into FRESH tombstones
    // that remote doesn't have yet — those must upload on THIS sync.
    const remote = makeMetas(MAX_RUN_LOGS_PER_KEYBOARD + 1)

    const result = mergeEntries([], remote, { runLogRetentionMax: MAX_RUN_LOGS_PER_KEYBOARD })

    expect(result.evicted.length).toBeGreaterThan(0)
    expect(result.remoteNeedsUpdate).toBe(true)
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
