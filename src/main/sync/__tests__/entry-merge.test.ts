// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { canonicalJson, type ClockedEntry, type EntryClocks } from '../entry-clocks'
import { EPOCH_ISO } from '../entry-clocks'
import { applyRunLogRetention, compareBodies, gcTombstones, isDeadEntry, mergeEntries } from '../entry-merge'
import { TOMBSTONE_TTL_MS } from '../merge'
import type { SavedFavoriteMeta } from '../../../shared/types/favorite-store'
import type { SnapshotMeta } from '../../../shared/types/snapshot-store'
import type { RunLogMeta } from '../../../shared/types/typing-run-log'
import type { I18nPackMeta } from '../../../shared/types/i18n-store'

const BASE = Date.UTC(2026, 0, 1)
const T = (s: number): string => new Date(BASE + s * 1000).toISOString()
const NOW = BASE + 24 * 60 * 60 * 1000

function withUpdated<T extends { clocks: EntryClocks; deletedAt?: string }>(e: T): T & { updatedAt: string } {
  const all = [...Object.values(e.clocks), e.deletedAt].filter((v): v is string => typeof v === 'string')
  return { ...e, updatedAt: all.sort().at(-1) ?? T(0) }
}

function fav(id: string, clocks: Partial<EntryClocks>, over: Partial<SavedFavoriteMeta> = {}): ClockedEntry<SavedFavoriteMeta> {
  return withUpdated({
    id, label: `L-${id}`, savedAt: T(0), filename: `f_${id}.json`, ...over,
    clocks: { created: T(1), body: T(1), name: T(1), hub: T(1), ...clocks },
  })
}

function snap(id: string, clocks: Partial<EntryClocks>, over: Partial<SnapshotMeta> = {}): ClockedEntry<SnapshotMeta> {
  return withUpdated({
    id, label: `S-${id}`, savedAt: T(0), filename: `s_${id}.pipette`, vilVersion: 2, ...over,
    clocks: { created: T(1), body: T(1), name: T(1), hub: T(1), ...clocks },
  })
}

const ALL = (): boolean => true

const byIdSorted = <T extends { id: string }>(entries: readonly T[]): string =>
  canonicalJson(entries.slice().sort((a, b) => (a.id < b.id ? -1 : 1)))

describe('mergeEntries — group matrix', () => {
  it('a rename on one side and a body save on the other both survive', () => {
    const local = [snap('a', { name: T(5) }, { label: 'renamed' })]
    const remote = [snap('a', { body: T(6) }, { vilVersion: 3 })]
    const r = mergeEntries('snapshots', local, remote, { now: NOW, hasBody: ALL })
    expect(r.entries[0]).toMatchObject({ label: 'renamed', vilVersion: 3, clocks: { name: T(5), body: T(6) }, updatedAt: T(6) })
    expect(r.byId.get('a')?.bodyFromRemote).toBe(true)
    expect(r.remoteFilesToCopy).toEqual([{ from: 's_a.pipette', to: 's_a.pipette' }])
    expect(r.remoteNeedsUpdate).toBe(true)
    expect(r.localNeedsWrite).toBe(true)
  })

  it('hub and name merge independently', () => {
    const local = [fav('a', { hub: T(5) }, { hubPostId: 'post' })]
    const remote = [fav('a', { name: T(6) }, { label: 'new' })]
    expect(mergeEntries('favorites', local, remote, { now: NOW, hasBody: ALL }).entries[0]).toMatchObject({ label: 'new', hubPostId: 'post' })
  })

  it('a later hub unlink removes the field', () => {
    const local = [fav('a', { hub: T(2) }, { hubPostId: 'post' })]
    const remote = [fav('a', { hub: T(3) })]
    expect(mergeEntries('favorites', local, remote, { now: NOW, hasBody: ALL }).entries[0]).not.toHaveProperty('hubPostId')
  })

  it('a delete beats a later rename', () => {
    const local = [fav('a', { name: T(6) }, { label: 'renamed' })]
    const remote = [fav('a', {}, { deletedAt: T(5) })]
    const e = mergeEntries('favorites', local, remote, { now: NOW, hasBody: ALL }).entries[0]
    expect(e).toMatchObject({ deletedAt: T(5), label: 'renamed', clocks: { created: T(1) } })
    expect(isDeadEntry(e)).toBe(true)
  })

  it('a delete beats a later body save and copies nothing', () => {
    const local = [snap('a', {}, { deletedAt: T(5) })]
    const remote = [snap('a', { body: T(6) }, { vilVersion: 3 })]
    const r = mergeEntries('snapshots', local, remote, { now: NOW, hasBody: ALL })
    expect(r.entries[0].deletedAt).toBe(T(5))
    expect(r.remoteFilesToCopy).toEqual([])
  })

  it('a re-create after a delete brings the entry back without deletedAt', () => {
    const local = [fav('a', {}, { deletedAt: T(5) })]
    const remote = [fav('a', { created: T(6), body: T(6) }, { filename: 'g_a.json' })]
    const r = mergeEntries('favorites', local, remote, { now: NOW, hasBody: ALL })
    expect(r.entries[0]).not.toHaveProperty('deletedAt')
    expect(r.entries[0].filename).toBe('g_a.json')
    expect(r.remoteFilesToCopy).toEqual([{ from: 'g_a.json', to: 'g_a.json' }])
  })

  it('created equal to deletedAt is deleted', () => {
    const r = mergeEntries('favorites', [fav('a', { created: T(5) })], [fav('a', {}, { deletedAt: T(5) })], { now: NOW, hasBody: ALL })
    expect(r.entries[0].deletedAt).toBe(T(5))
  })

  it('a clock tie is decided by the values, the same way on both sides', () => {
    const a = [fav('x', { name: T(5) }, { label: 'apple' })]
    const b = [fav('x', { name: T(5) }, { label: 'banana' })]
    expect(mergeEntries('favorites', a, b, { now: NOW, hasBody: ALL }).entries[0].label).toBe('banana')
    expect(mergeEntries('favorites', b, a, { now: NOW, hasBody: ALL }).entries[0].label).toBe('banana')
    expect(mergeEntries('favorites', b, a, { now: NOW, hasBody: ALL }).remoteNeedsUpdate).toBe(true)
  })

  it('equal clocks and fields are decided by the body hash', () => {
    const local = [snap('a', {})]
    const remote = [snap('a', {})]
    const hashes = { local: 'aaa', remote: 'bbb' }
    const r = mergeEntries('snapshots', local, remote, { now: NOW, hasBody: ALL, bodyHash: (side) => hashes[side] })
    expect(r.byId.get('a')?.bodyFromRemote).toBe(true)
    const swapped = mergeEntries('snapshots', local, remote, { now: NOW, hasBody: ALL, bodyHash: (side) => (side === 'local' ? 'bbb' : 'aaa') })
    expect(swapped.byId.get('a')?.bodyFromRemote).toBe(false)
  })

  it('a local body that wins only by its hash still asks for an upload', () => {
    const r = mergeEntries('snapshots', [snap('a', {})], [snap('a', {})], { now: NOW, hasBody: ALL, bodyHash: (side) => (side === 'local' ? 'bbb' : 'aaa') })
    expect(r.byId.get('a')?.bodyFromRemote).toBe(false)
    expect(r.remoteNeedsUpdate).toBe(true)
  })

  it('calls bodyHash only on an exact clock and fields tie', () => {
    const calls: string[] = []
    const bodyHash = (side: string) => { calls.push(side); return side }
    mergeEntries('snapshots', [snap('a', { body: T(2) })], [snap('a', {})], { now: NOW, hasBody: ALL, bodyHash })
    mergeEntries('snapshots', [snap('a', {}, { vilVersion: 1 })], [snap('a', {})], { now: NOW, hasBody: ALL, bodyHash })
    expect(calls).toEqual([])
    mergeEntries('snapshots', [snap('a', {})], [snap('a', {})], { now: NOW, hasBody: ALL, bodyHash })
    expect(calls.sort()).toEqual(['local', 'remote'])
  })

  it('compareBodies is the same total order', () => {
    const a = snap('a', { body: T(2) })
    const b = snap('a', {})
    expect(compareBodies('snapshots', a, b)).toBeGreaterThan(0)
    expect(compareBodies('snapshots', b, a)).toBeLessThan(0)
    expect(compareBodies('snapshots', b, b, (e) => (e === b ? 'x' : 'y'))).toBe(0)
    expect(compareBodies('snapshots', b, { ...b }, (e) => (e === b ? 'y' : 'x'))).toBeGreaterThan(0)
  })

  it('a full tie keeps the local body and needs no copy or upload', () => {
    const r = mergeEntries('snapshots', [snap('a', {})], [snap('a', {})], { now: NOW, hasBody: ALL })
    expect(r.byId.get('a')?.bodyFromRemote).toBe(false)
    expect(r.remoteNeedsUpdate).toBe(false)
    expect(r.localNeedsWrite).toBe(false)
  })

  it('one-sided entries: local-only needs an upload, remote-only is copied', () => {
    const r = mergeEntries('favorites', [fav('a', {})], [fav('b', {})], { now: NOW, hasBody: ALL })
    expect(r.remoteNeedsUpdate).toBe(true)
    expect(r.remoteFilesToCopy).toEqual([{ from: 'f_b.json', to: 'f_b.json' }])
  })

  it('normalizes v1 inputs and writes them back with clocks', () => {
    const v1: SavedFavoriteMeta = { id: 'a', label: 'L', savedAt: T(1), filename: 'f_a.json', updatedAt: T(2) }
    const r = mergeEntries('favorites', [v1], [v1], { now: NOW, hasBody: ALL })
    expect(r.entries[0].clocks).toEqual({ created: T(1), body: T(1), name: T(2), hub: T(2) })
    expect(r.localNeedsWrite).toBe(true)
    expect(r.remoteNeedsUpdate).toBe(true)
  })
})

describe('mergeEntries — GC, ordering, referenced files', () => {
  const old = T(0)
  const NOW_LATE = BASE + TOMBSTONE_TTL_MS + 10_000

  it('drops dead tombstones past the TTL but never alive entries', () => {
    const dead = fav('d', {}, { deletedAt: T(1) })
    const aliveWithOldDelete = fav('a', { created: T(2) }, { deletedAt: old })
    const r = mergeEntries('favorites', [dead, aliveWithOldDelete], [], { now: NOW_LATE, hasBody: ALL })
    expect(r.entries.map((e) => e.id)).toEqual(['a'])
    expect(r.entries[0]).not.toHaveProperty('deletedAt')
    expect(gcTombstones([dead], NOW).map((e) => e.id)).toEqual(['d'])
  })

  it('sorts alive by updatedAt and puts tombstones last; preserveLocalOrder keeps local order', () => {
    const local = [fav('old', {}), fav('dead', {}, { deletedAt: T(9) }), fav('new', { name: T(5) })]
    const remote = [fav('remoteOnly', { name: T(3) })]
    expect(mergeEntries('favorites', local, remote, { now: NOW, hasBody: ALL }).entries.map((e) => e.id)).toEqual(['new', 'remoteOnly', 'old', 'dead'])
    expect(mergeEntries('favorites', local, remote, { now: NOW, hasBody: ALL, preserveLocalOrder: true }).entries.map((e) => e.id))
      .toEqual(['old', 'new', 'remoteOnly', 'dead'])
  })

  it('referenced filenames include tombstones', () => {
    const r = mergeEntries('favorites', [fav('a', {}), fav('b', {}, { deletedAt: T(5) })], [], { now: NOW, hasBody: ALL })
    expect([...r.referencedFilenames].sort()).toEqual(['f_a.json', 'f_b.json'])
  })
})

describe('mergeEntries — id-carrying filenames', () => {
  it('saves a legacy remote filename under the id-carrying name', () => {
    const remote = [snap('a', {}, { filename: 'kb_2025.pipette' })]
    const r = mergeEntries('snapshots', [], remote, { now: NOW, hasBody: ALL })
    expect(r.entries[0].filename).toBe('kb_2025_a.pipette')
    expect(r.remoteFilesToCopy).toEqual([{ from: 'kb_2025.pipette', to: 'kb_2025_a.pipette' }])
    expect(r.remoteNeedsUpdate).toBe(true)
  })

  it('a migrated local entry and the legacy remote copy of it are the same body', () => {
    const local = [snap('a', {}, { filename: 'kb_2025_a.pipette' })]
    const remote = [snap('a', {}, { filename: 'kb_2025.pipette' })]
    const r = mergeEntries('snapshots', local, remote, { now: NOW, hasBody: ALL })
    expect(r.remoteFilesToCopy).toEqual([])
    expect(r.localNeedsWrite).toBe(false)
    expect(r.remoteNeedsUpdate).toBe(true)
  })

  it('two remote ids on one legacy filename end on two files', () => {
    const remote = [fav('a', {}, { filename: 'x.json' }), fav('b', {}, { filename: 'x.json' })]
    const r = mergeEntries('favorites', [], remote, { now: NOW, hasBody: ALL })
    expect(r.entries.map((e) => e.filename).sort()).toEqual(['x_a.json', 'x_b.json'])
    expect(r.remoteFilesToCopy).toEqual([{ from: 'x.json', to: 'x_a.json' }, { from: 'x.json', to: 'x_b.json' }])
  })

  it('a remote filename naming another id still gets this id', () => {
    const r = mergeEntries('favorites', [fav('b', {})], [fav('a', {}, { filename: 'f_b.json' })], { now: NOW, hasBody: ALL })
    expect(r.byId.get('a')?.entry.filename).toBe('f_b_a.json')
  })
})

describe('mergeEntries — missing bodies', () => {
  const missing = (names: string[]) => (_side: string, e: { filename: string }) => !names.includes(e.filename)

  it('a remote body the bundle lacks never wins', () => {
    const local = [snap('a', {})]
    const remote = [snap('a', { body: T(6) }, { vilVersion: 3 })]
    const r = mergeEntries('snapshots', local, remote, { now: NOW, hasBody: (side) => side === 'local' })
    expect(r.byId.get('a')).toMatchObject({ bodyFromRemote: false, entry: { vilVersion: 2 } })
    expect(r.remoteNeedsUpdate).toBe(true)
  })

  it('a local entry without its file takes the remote body even when its own is newer', () => {
    const local = [snap('a', { body: T(6) }, { vilVersion: 3 })]
    const remote = [snap('a', {})]
    const r = mergeEntries('snapshots', local, remote, { now: NOW, hasBody: (side) => side === 'remote' })
    expect(r.byId.get('a')).toMatchObject({ bodyFromRemote: true, entry: { vilVersion: 2, clocks: { body: T(1) } } })
    expect(r.remoteNeedsUpdate).toBe(false)
  })

  it('Drive lacking the file of an equal entry asks for an upload, and stops once it has it', () => {
    const local = [fav('a', {})]
    const remote = [fav('a', {})]
    expect(mergeEntries('favorites', local, remote, { now: NOW, hasBody: (side) => side === 'local' }).remoteNeedsUpdate).toBe(true)
    expect(mergeEntries('favorites', local, remote, { now: NOW, hasBody: ALL }).remoteNeedsUpdate).toBe(false)
    expect(mergeEntries('favorites', local, remote, { now: NOW, hasBody: (side) => side === 'remote' }).remoteNeedsUpdate).toBe(false)
  })

  it('hasBody is required under the clock policy', () => {
    // @ts-expect-error hasBody is missing
    mergeEntries('favorites', [], [], { now: NOW })
    // @ts-expect-error hasBody is missing
    mergeEntries('favorites', [], [], { now: NOW, bodyPolicy: 'clock' })
    expect(mergeEntries('i18nPacks', [], [], { now: NOW, bodyPolicy: 'localIfPresent' }).entries).toEqual([])
  })

  it('when neither side has the file the local entry stays as it is and nothing is sent', () => {
    const local = [snap('a', {}, { label: 'mine' })]
    const remote = [snap('a', { body: T(6), name: T(6) }, { label: 'theirs' })]
    const r = mergeEntries('snapshots', local, remote, { now: NOW, hasBody: () => false })
    expect(r.byId.get('a')).toMatchObject({ bodyMissing: true, entry: { label: 'mine' } })
    expect(r.localNeedsWrite).toBe(false)
    expect(r.remoteNeedsUpdate).toBe(false)
  })

  it('a remote-only entry without its file is neither written nor counted', () => {
    const r = mergeEntries('favorites', [], [fav('a', {})], { now: NOW, hasBody: () => false })
    expect(r.entries).toEqual([])
    expect(r.remoteNeedsUpdate).toBe(false)
  })

  it('a local-only entry without its file is kept but not sent', () => {
    const r = mergeEntries('favorites', [fav('a', {})], [], { now: NOW, hasBody: () => false })
    expect(r.entries.map((e) => e.id)).toEqual(['a'])
    expect(r.remoteNeedsUpdate).toBe(false)
  })

  it('a revival whose local tombstone has no file adopts the remote body', () => {
    const local = [fav('a', { body: T(7) }, { deletedAt: T(8), filename: 'old_a.json' })]
    const remote = [fav('a', { created: T(9), body: T(2) }, { filename: 'new_a.json' })]
    const r = mergeEntries('favorites', local, remote, { now: NOW, hasBody: missing(['old_a.json']) })
    expect(r.entries[0]).not.toHaveProperty('deletedAt')
    expect(r.byId.get('a')).toMatchObject({ bodyFromRemote: true, entry: { filename: 'new_a.json' } })
  })

  it('tombstones merge without looking at files', () => {
    const r = mergeEntries('favorites', [fav('a', { body: T(3) }, { deletedAt: T(5) })], [fav('a', {}, { deletedAt: T(4) })], { now: NOW, hasBody: () => false })
    expect(r.entries[0]).toMatchObject({ deletedAt: T(5), clocks: { body: T(3) } })
    expect(r.byId.get('a')?.bodyMissing).toBe(false)
  })

  it('passes the remote bundle name to hasBody', () => {
    const seen: string[] = []
    mergeEntries('favorites', [], [fav('a', {}, { filename: 'x.json' })], { now: NOW, hasBody: (_s, e) => { seen.push(e.filename); return true } })
    expect(seen).toEqual(['x.json'])
  })
})

describe("mergeEntries — bodyPolicy 'localIfPresent' (pack indexes)", () => {
  const pack = (body: string, version: string, over: Partial<I18nPackMeta> = {}, clocks: Partial<EntryClocks> = {}): ClockedEntry<I18nPackMeta> => withUpdated({
    id: 'p', filename: 'packs/p.json', name: 'N', version, enabled: true, savedAt: T(0), ...over,
    clocks: { created: T(1), body, name: T(1), hub: T(1), enabled: T(1), ...clocks },
  })
  const opts = { now: NOW, bodyPolicy: 'localIfPresent' as const }

  it('a live local entry keeps its body fields whatever the clocks, and the body is not compared', () => {
    const r = mergeEntries('i18nPacks', [pack(T(1), '1')], [pack(T(5), '2')], opts)
    expect(r.entries[0]).toMatchObject({ version: '1', clocks: { body: T(1) } })
    expect(r.byId.get('p')).toMatchObject({ bodyFromRemote: false, bodyFetchNeeded: false })
    expect(r.remoteNeedsUpdate).toBe(false)
    expect(mergeEntries('i18nPacks', [pack(T(1), '1')], [pack(T(5), '2')], { now: NOW, hasBody: ALL }).entries[0].version).toBe('2')
  })

  it('still reports meta differences', () => {
    const local = [pack(T(5), '2', { name: 'renamed' }, { name: T(6) })]
    expect(mergeEntries('i18nPacks', local, [pack(T(1), '1')], opts).remoteNeedsUpdate).toBe(true)
  })

  it('a remote-only entry shows the remote body fields with body clock 0 and asks for the body unit', () => {
    const r = mergeEntries('i18nPacks', [], [pack(T(5), '2')], opts)
    expect(r.entries[0]).toMatchObject({ version: '2', clocks: { body: EPOCH_ISO } })
    expect(r.byId.get('p')).toMatchObject({ bodyFromRemote: false, bodyFetchNeeded: true })
    expect(r.remoteFilesToCopy).toEqual([])
    expect(r.remoteNeedsUpdate).toBe(false)
  })

  it('a revival takes the remote body fields the same way', () => {
    const local = [pack(T(3), '1', { deletedAt: T(4), enabled: false })]
    const remote = [pack(T(5), '2', {}, { created: T(5), enabled: T(5) })]
    const r = mergeEntries('i18nPacks', local, remote, opts)
    expect(r.entries[0]).not.toHaveProperty('deletedAt')
    expect(r.entries[0]).toMatchObject({ version: '2', enabled: true, clocks: { body: EPOCH_ISO } })
    expect(r.byId.get('p')?.bodyFetchNeeded).toBe(true)
  })

  it('a local tombstone that stays deleted keeps its own body', () => {
    const r = mergeEntries('i18nPacks', [pack(T(3), '1', { deletedAt: T(4) })], [pack(T(5), '2')], opts)
    expect(r.entries[0]).toMatchObject({ version: '1', deletedAt: T(4) })
    expect(r.byId.get('p')?.bodyFetchNeeded).toBe(false)
  })
})

describe('applyRunLogRetention', () => {
  const run = (id: string, startedAt: string, created = T(1)): ClockedEntry<RunLogMeta> => withUpdated({
    id, startedAt, filename: `r_${id}.jsonl`, savedAt: T(0), clocks: { created, body: T(1) },
  })

  it('tombstones the oldest by startedAt as dead v2 entries', () => {
    const r = applyRunLogRetention([run('a', T(1)), run('b', T(3)), run('c', T(2))], 2, NOW)
    expect(r.evicted.map((e) => e.id)).toEqual(['a'])
    expect(r.evicted[0].deletedAt).toBe(new Date(NOW).toISOString())
    expect(isDeadEntry(r.evicted[0])).toBe(true)
  })

  it('never puts deletedAt before created', () => {
    const future = new Date(NOW + 60_000).toISOString()
    const r = applyRunLogRetention([run('a', T(1), future), run('b', T(3))], 1, NOW)
    expect(r.evicted[0].deletedAt).toBe(future)
    expect(isDeadEntry(r.evicted[0])).toBe(true)
  })

  it('runs as part of the merge and asks for an upload', () => {
    const r = mergeEntries('runLogs', [run('a', T(1)), run('b', T(3))], [run('a', T(1)), run('b', T(3))], { now: NOW, hasBody: ALL, runLogRetentionMax: 1 })
    expect(r.evicted.map((e) => e.id)).toEqual(['a'])
    expect(r.byId.get('a')?.entry.deletedAt).toBeDefined()
    expect(r.remoteNeedsUpdate).toBe(true)
  })
})

describe('mergeEntries — properties', () => {
  function rng(seed: number): () => number {
    let st = seed >>> 0
    return () => {
      st = (st + 0x6d2b79f5) >>> 0
      let t = st
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  /** `missing` gives some entries a `gone_` filename, which `hasBody`
   *  below reports as absent on either side. */
  function side(rand: () => number, missing = false): ClockedEntry<SnapshotMeta>[] {
    const pick = <V>(xs: readonly V[]): V => xs[Math.floor(rand() * xs.length)]
    const times = [T(1), T(2), T(3)]
    const out: ClockedEntry<SnapshotMeta>[] = []
    for (const id of ['a', 'b', 'c', 'd']) {
      if (rand() < 0.3) continue
      const deleted = rand() < 0.3
      out.push(snap(id, { created: pick(times), body: pick(times), name: pick(times), hub: pick(times) }, {
        filename: `${missing && rand() < 0.3 ? 'gone' : pick(['s', 't'])}_${id}.pipette`,
        label: pick(['x', 'y']),
        vilVersion: pick([1, 2]),
        ...(rand() < 0.5 ? { hubPostId: pick(['p', 'q']) } : {}),
        ...(deleted ? { deletedAt: pick(times) } : {}),
      }))
    }
    return out
  }

  const hasBody = (_side: string, e: { filename: string }) => !e.filename.startsWith('gone_')
  const run = (a: readonly SnapshotMeta[], b: readonly SnapshotMeta[]) => mergeEntries('snapshots', a, b, { now: NOW, hasBody })
  const merge = (a: readonly SnapshotMeta[], b: readonly SnapshotMeta[]) => run(a, b).entries
  /** The merged entries minus ids no side has a body for (those keep the
   *  local entry, so they depend on which side is local). */
  const withBodies = (a: readonly SnapshotMeta[], b: readonly SnapshotMeta[]) => {
    const r = run(a, b)
    return byIdSorted(r.entries.filter((e) => !r.byId.get(e.id)?.bodyMissing))
  }
  const cases = (seed: number, missing: boolean) => Array.from({ length: 200 }, (_, i) => {
    const rand = rng(seed + i)
    return [side(rand, missing), side(rand, missing), side(rand, missing)] as const
  })
  const plain = cases(1, false)
  const gaps = cases(5000, true)

  it('is commutative', () => {
    for (const [a, b] of [...plain, ...gaps]) expect(withBodies(a, b)).toBe(withBodies(b, a))
  })

  it('is associative', () => {
    for (const [a, b, c] of plain) expect(byIdSorted(merge(merge(a, b), c))).toBe(byIdSorted(merge(a, merge(b, c))))
  })

  it('is idempotent', () => {
    for (const [a, b] of [...plain, ...gaps]) {
      const ab = merge(a, b)
      expect(byIdSorted(merge(ab, b))).toBe(byIdSorted(ab))
      expect(byIdSorted(merge(ab, ab))).toBe(byIdSorted(ab))
    }
  })

  it('never returns an alive entry with deletedAt, or two alive ids on one file', () => {
    for (const [a, b] of [...plain, ...gaps]) {
      const entries = merge(a, b)
      for (const e of entries) if (e.deletedAt !== undefined) expect(isDeadEntry(e)).toBe(true)
      const names = entries.filter((e) => e.deletedAt === undefined).map((e) => e.filename)
      expect(new Set(names).size).toBe(names.length)
    }
  })

  it('a body-less side never supplies the merged body', () => {
    for (const [a, b] of gaps) {
      const r = run(a, b)
      for (const o of r.byId.values()) {
        if (o.entry.deletedAt === undefined && !o.bodyMissing) expect(hasBody('', o.entry)).toBe(true)
      }
    }
  })

  it('needs no upload, write or copy once both sides hold the merge result', () => {
    for (const [a, b] of [...plain, ...gaps]) {
      const ab = merge(a, b)
      const again = run(ab, ab)
      expect(again.remoteNeedsUpdate).toBe(false)
      expect(again.localNeedsWrite).toBe(false)
      expect(again.remoteFilesToCopy).toEqual([])
    }
  })

  it('devices with missing files converge and then stay quiet', () => {
    // Files are tracked per device and on Drive. A device uploads its index
    // without the alive entries whose file it lacks, plus those files.
    const aliveWithFile = (entries: readonly ClockedEntry<SnapshotMeta>[], files: Set<string>) =>
      entries.filter((e) => e.deletedAt !== undefined || files.has(e.filename))
    for (const init of gaps.slice(0, 80)) {
      const devices = init.map((entries) => ({
        entries: entries as ClockedEntry<SnapshotMeta>[],
        files: new Set(entries.filter((e) => hasBody('', e)).map((e) => e.filename)),
      }))
      let drive: ClockedEntry<SnapshotMeta>[] = []
      let driveFiles = new Set<string>()
      let now = NOW
      const step = (d: (typeof devices)[number]) => {
        const r = mergeEntries('snapshots', d.entries, drive, {
          now: now++,
          hasBody: (s, e) => (s === 'local' ? d.files : driveFiles).has(e.filename),
        })
        for (const c of r.remoteFilesToCopy) d.files.add(c.to)
        d.entries = r.entries
        if (r.remoteNeedsUpdate) {
          drive = aliveWithFile(r.entries, d.files)
          driveFiles = new Set(drive.filter((e) => e.deletedAt === undefined).map((e) => e.filename))
        }
        return r
      }
      for (let round = 0; round < 4; round++) devices.forEach(step)
      for (const d of devices) {
        const r = step(d)
        expect(r).toMatchObject({ remoteNeedsUpdate: false, localNeedsWrite: false, remoteFilesToCopy: [] })
        // Ids no side has a body for stay as each side has them.
        const settled = (e: { id: string }) => !r.byId.get(e.id)?.bodyMissing && r.byId.has(e.id)
        expect(byIdSorted(d.entries.filter(settled))).toBe(byIdSorted(drive.filter(settled)))
        expect(drive.every((e) => r.byId.has(e.id) || e.deletedAt === undefined)).toBe(true)
      }
    }
  })
})
