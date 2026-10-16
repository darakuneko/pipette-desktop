// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the entry merge of src-tauri/crates/pipette-entry-store
// (src/merge.rs): runs the real src/main/sync/entry-merge.ts over the cases
// of its unit tests and over seeded random sides, and records what
// `mergeEntries`, `gcTombstones` and `compareBodies` return, JSON values as
// JSON.stringify texts, so the crate can replay every case and compare the
// bytes.
//
// The hooks are recorded as data: `hasBody` as the filenames each side
// lacks (or `true` / `false` for every entry), `bodyHash` as a hash per
// side and id.
//
// Run: pnpm run generate:sync-fixtures

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'
import { random32 } from '../fixture-random'
import type { EntryClocks, EntryStore } from '../../src/main/sync/entry-clocks'
import { EPOCH_ISO } from '../../src/main/sync/entry-clocks'
import { compareBodies, gcTombstones, mergeEntries, type MergeSide } from '../../src/main/sync/entry-merge'
import { TOMBSTONE_TTL_MS } from '../../src/main/sync/merge'

const OUT = resolve(REPO_ROOT, 'src-tauri/crates/pipette-entry-store/tests/fixtures/ts_entry_merge.json')

const BASE = Date.UTC(2026, 0, 1)
const T = (s: number): string => new Date(BASE + s * 1000).toISOString()
const NOW = BASE + 24 * 60 * 60 * 1000
const NOW_LATE = BASE + TOMBSTONE_TTL_MS + 10_000

type Meta = Record<string, unknown> & { id: string; filename: string }

function withUpdated<E extends { clocks: Partial<EntryClocks>; deletedAt?: string }>(e: E): E & { updatedAt: string } {
  const all = [...Object.values(e.clocks), e.deletedAt].filter((v): v is string => typeof v === 'string')
  return { ...e, updatedAt: all.sort().at(-1) ?? T(0) }
}

const fav = (id: string, clocks: Partial<EntryClocks>, over: Record<string, unknown> = {}): Meta => withUpdated({
  id, label: `L-${id}`, savedAt: T(0), filename: `f_${id}.json`, ...over,
  clocks: { created: T(1), body: T(1), name: T(1), hub: T(1), ...clocks },
})

const snap = (id: string, clocks: Partial<EntryClocks>, over: Record<string, unknown> = {}): Meta => withUpdated({
  id, label: `S-${id}`, savedAt: T(0), filename: `s_${id}.pipette`, vilVersion: 2, ...over,
  clocks: { created: T(1), body: T(1), name: T(1), hub: T(1), ...clocks },
})

const pack = (body: string, version: string, over: Record<string, unknown> = {}, clocks: Partial<EntryClocks> = {}): Meta => withUpdated({
  id: 'p', filename: 'packs/p.json', name: 'N', version, enabled: true, savedAt: T(0), ...over,
  clocks: { created: T(1), body, name: T(1), hub: T(1), enabled: T(1), ...clocks },
})

const run = (id: string, startedAt: string, created = T(1)): Meta => withUpdated({
  id, startedAt, filename: `r_${id}.jsonl`, savedAt: T(0), clocks: { created, body: T(1) },
})

/** `true` / `false` for every entry of the side, or the filenames it lacks. */
type HasBodyRule = boolean | string[]

interface CaseInput {
  name: string
  store: EntryStore
  local: Meta[]
  remote: Meta[]
  now: number
  policy?: 'clock' | 'localIfPresent'
  hasBody?: { local: HasBodyRule; remote: HasBodyRule }
  hashes?: { local: Record<string, string>; remote: Record<string, string> }
  preserveLocalOrder?: boolean
  runLogRetentionMax?: number
}

const ALL = { local: true, remote: true }

function hasBodyOf(rule: { local: HasBodyRule; remote: HasBodyRule }) {
  return (side: MergeSide, e: { filename: string }): boolean => {
    const r = rule[side]
    return typeof r === 'boolean' ? r : !r.includes(e.filename)
  }
}

function record(c: CaseInput) {
  const options = {
    now: c.now,
    preserveLocalOrder: c.preserveLocalOrder,
    runLogRetentionMax: c.runLogRetentionMax,
    bodyHash: c.hashes ? (side: MergeSide, e: { id: string }) => c.hashes?.[side][e.id] : undefined,
  }
  const r = c.policy === 'localIfPresent'
    ? mergeEntries(c.store, c.local as never[], c.remote as never[], { ...options, bodyPolicy: 'localIfPresent' })
    : mergeEntries(c.store, c.local as never[], c.remote as never[], { ...options, hasBody: hasBodyOf(c.hasBody ?? ALL) })
  return {
    name: c.name,
    store: c.store,
    local: JSON.stringify(c.local),
    remote: JSON.stringify(c.remote),
    now: c.now,
    policy: c.policy ?? 'clock',
    hasBody: c.hasBody ?? ALL,
    hashes: c.hashes ?? null,
    preserveLocalOrder: c.preserveLocalOrder === true,
    runLogRetentionMax: c.runLogRetentionMax ?? null,
    result: {
      entries: JSON.stringify(r.entries),
      byId: JSON.stringify([...r.byId]),
      remoteFilesToCopy: JSON.stringify(r.remoteFilesToCopy),
      referencedFilenames: [...r.referencedFilenames].sort(),
      localNeedsWrite: r.localNeedsWrite,
      remoteNeedsUpdate: r.remoteNeedsUpdate,
      evicted: JSON.stringify(r.evicted),
    },
  }
}

// ---- The cases of entry-merge.test.ts ----

const gone = (names: string[]) => ({ local: names, remote: names })
const packOpts = { now: NOW, policy: 'localIfPresent' as const }

const NAMED: CaseInput[] = [
  { name: 'rename and body save both survive', store: 'snapshots', local: [snap('a', { name: T(5) }, { label: 'renamed' })], remote: [snap('a', { body: T(6) }, { vilVersion: 3 })], now: NOW },
  { name: 'hub and name merge independently', store: 'favorites', local: [fav('a', { hub: T(5) }, { hubPostId: 'post' })], remote: [fav('a', { name: T(6) }, { label: 'new' })], now: NOW },
  { name: 'a later hub unlink removes the field', store: 'favorites', local: [fav('a', { hub: T(2) }, { hubPostId: 'post' })], remote: [fav('a', { hub: T(3) })], now: NOW },
  { name: 'a delete beats a later rename', store: 'favorites', local: [fav('a', { name: T(6) }, { label: 'renamed' })], remote: [fav('a', {}, { deletedAt: T(5) })], now: NOW },
  { name: 'a delete beats a later body save', store: 'snapshots', local: [snap('a', {}, { deletedAt: T(5) })], remote: [snap('a', { body: T(6) }, { vilVersion: 3 })], now: NOW },
  { name: 'a re-create after a delete', store: 'favorites', local: [fav('a', {}, { deletedAt: T(5) })], remote: [fav('a', { created: T(6), body: T(6) }, { filename: 'g_a.json' })], now: NOW },
  { name: 'created equal to deletedAt is deleted', store: 'favorites', local: [fav('a', { created: T(5) })], remote: [fav('a', {}, { deletedAt: T(5) })], now: NOW },
  { name: 'a clock tie by values (a, b)', store: 'favorites', local: [fav('x', { name: T(5) }, { label: 'apple' })], remote: [fav('x', { name: T(5) }, { label: 'banana' })], now: NOW },
  { name: 'a clock tie by values (b, a)', store: 'favorites', local: [fav('x', { name: T(5) }, { label: 'banana' })], remote: [fav('x', { name: T(5) }, { label: 'apple' })], now: NOW },
  { name: 'a clock tie by UTF-16 order', store: 'favorites', local: [fav('x', { name: T(5) }, { label: '～' })], remote: [fav('x', { name: T(5) }, { label: '\u{1f600}' })], now: NOW },
  { name: 'equal clocks and fields by the body hash', store: 'snapshots', local: [snap('a', {})], remote: [snap('a', {})], now: NOW, hashes: { local: { a: 'aaa' }, remote: { a: 'bbb' } } },
  { name: 'a local body that wins only by its hash', store: 'snapshots', local: [snap('a', {})], remote: [snap('a', {})], now: NOW, hashes: { local: { a: 'bbb' }, remote: { a: 'aaa' } } },
  { name: 'a hash only on one side', store: 'analyzeFilters', local: [snap('a', {}, { filename: 'q_a.json', summary: 's' })], remote: [snap('a', {}, { filename: 'q_a.json', summary: 's' })], now: NOW, hashes: { local: {}, remote: { a: 'x' } } },
  { name: 'a full tie', store: 'snapshots', local: [snap('a', {})], remote: [snap('a', {})], now: NOW },
  { name: 'one-sided entries', store: 'favorites', local: [fav('a', {})], remote: [fav('b', {})], now: NOW },
  { name: 'v1 inputs', store: 'favorites', local: [{ id: 'a', label: 'L', savedAt: T(1), filename: 'f_a.json', updatedAt: T(2) }], remote: [{ id: 'a', label: 'L', savedAt: T(1), filename: 'f_a.json', updatedAt: T(2) }], now: NOW },
  { name: 'GC of dead tombstones', store: 'favorites', local: [fav('d', {}, { deletedAt: T(1) }), fav('a', { created: T(2) }, { deletedAt: T(0) })], remote: [], now: NOW_LATE },
  { name: 'order by updatedAt', store: 'favorites', local: [fav('old', {}), fav('dead', {}, { deletedAt: T(9) }), fav('new', { name: T(5) })], remote: [fav('remoteOnly', { name: T(3) })], now: NOW },
  { name: 'preserveLocalOrder', store: 'favorites', local: [fav('old', {}), fav('dead', {}, { deletedAt: T(9) }), fav('new', { name: T(5) })], remote: [fav('remoteOnly', { name: T(3) })], now: NOW, preserveLocalOrder: true },
  { name: 'referenced filenames include tombstones', store: 'favorites', local: [fav('a', {}), fav('b', {}, { deletedAt: T(5) })], remote: [], now: NOW },
  { name: 'a legacy remote filename', store: 'snapshots', local: [], remote: [snap('a', {}, { filename: 'kb_2025.pipette' })], now: NOW },
  { name: 'a migrated local entry and its legacy remote copy', store: 'snapshots', local: [snap('a', {}, { filename: 'kb_2025_a.pipette' })], remote: [snap('a', {}, { filename: 'kb_2025.pipette' })], now: NOW },
  { name: 'two remote ids on one legacy filename', store: 'favorites', local: [], remote: [fav('a', {}, { filename: 'x.json' }), fav('b', {}, { filename: 'x.json' })], now: NOW },
  { name: 'a remote filename naming another id', store: 'favorites', local: [fav('b', {})], remote: [fav('a', {}, { filename: 'f_b.json' })], now: NOW },
  { name: 'a prefix store with a legacy name', store: 'keyLabels', local: [], remote: [{ id: 'k', name: 'K', filename: 'legacy.json', savedAt: T(1), clocks: { created: T(1), body: T(1), name: T(1), hub: T(1) }, updatedAt: T(1) }], now: NOW },
  { name: 'a remote body the bundle lacks', store: 'snapshots', local: [snap('a', {})], remote: [snap('a', { body: T(6) }, { vilVersion: 3 })], now: NOW, hasBody: { local: true, remote: false } },
  { name: 'a local entry without its file', store: 'snapshots', local: [snap('a', { body: T(6) }, { vilVersion: 3 })], remote: [snap('a', {})], now: NOW, hasBody: { local: false, remote: true } },
  { name: 'Drive lacks the file of an equal entry', store: 'favorites', local: [fav('a', {})], remote: [fav('a', {})], now: NOW, hasBody: { local: true, remote: false } },
  { name: 'only Drive has the file of an equal entry', store: 'favorites', local: [fav('a', {})], remote: [fav('a', {})], now: NOW, hasBody: { local: false, remote: true } },
  { name: 'neither side has the file', store: 'snapshots', local: [snap('a', {}, { label: 'mine' })], remote: [snap('a', { body: T(6), name: T(6) }, { label: 'theirs' })], now: NOW, hasBody: { local: false, remote: false } },
  { name: 'a remote-only entry without its file', store: 'favorites', local: [], remote: [fav('a', {})], now: NOW, hasBody: { local: false, remote: false } },
  { name: 'a local-only entry without its file', store: 'favorites', local: [fav('a', {})], remote: [], now: NOW, hasBody: { local: false, remote: false } },
  { name: 'a revival whose local tombstone has no file', store: 'favorites', local: [fav('a', { body: T(7) }, { deletedAt: T(8), filename: 'old_a.json' })], remote: [fav('a', { created: T(9), body: T(2) }, { filename: 'new_a.json' })], now: NOW, hasBody: gone(['old_a.json']) },
  { name: 'tombstones merge without files', store: 'favorites', local: [fav('a', { body: T(3) }, { deletedAt: T(5) })], remote: [fav('a', {}, { deletedAt: T(4) })], now: NOW, hasBody: { local: false, remote: false } },
  { name: 'pack: live local keeps its body', store: 'i18nPacks', local: [pack(T(1), '1')], remote: [pack(T(5), '2')], ...packOpts },
  { name: 'pack: the clock policy takes the newer body', store: 'i18nPacks', local: [pack(T(1), '1')], remote: [pack(T(5), '2')], now: NOW },
  { name: 'pack: meta differences', store: 'i18nPacks', local: [pack(T(5), '2', { name: 'renamed' }, { name: T(6) })], remote: [pack(T(1), '1')], ...packOpts },
  { name: 'pack: remote-only', store: 'i18nPacks', local: [], remote: [pack(T(5), '2')], ...packOpts },
  { name: 'pack: revival', store: 'i18nPacks', local: [pack(T(3), '1', { deletedAt: T(4), enabled: false })], remote: [pack(T(5), '2', {}, { created: T(5), enabled: T(5) })], ...packOpts },
  { name: 'pack: a local tombstone that stays deleted', store: 'i18nPacks', local: [pack(T(3), '1', { deletedAt: T(4) })], remote: [pack(T(5), '2')], ...packOpts },
  { name: 'pack: empty sides', store: 'i18nPacks', local: [], remote: [], ...packOpts },
  { name: 'pack: remote clocks as an array', store: 'themePacks', local: [pack(T(1), '1')], remote: [{ ...pack(T(1), '1'), clocks: [T(1)] as never }], ...packOpts },
  { name: 'run logs: retention in the merge', store: 'runLogs', local: [run('a', T(1)), run('b', T(3))], remote: [run('a', T(1)), run('b', T(3))], now: NOW, runLogRetentionMax: 1 },
  { name: 'run logs: retention evicts a remote copy', store: 'runLogs', local: [run('b', T(3))], remote: [run('a', T(1)), run('c', T(2))], now: NOW, runLogRetentionMax: 2 },
  { name: 'run logs: retention keeps created', store: 'runLogs', local: [run('a', T(1), new Date(NOW + 60_000).toISOString()), run('b', T(3))], remote: [], now: NOW, runLogRetentionMax: 1 },
  { name: 'duplicate ids, the last kept wins', store: 'favorites', local: [fav('a', {}, { label: 'first' }), fav('b', {}), fav('a', {}, { label: 'second' })], remote: [fav('a', { name: T(2) }, { label: 'r1' }), fav('a', {}, { label: 'r2', deletedAt: T(0) })], now: NOW_LATE },
  { name: 'a deletedAt that is not a time', store: 'favorites', local: [fav('a', {}, { deletedAt: 'garbage' })], remote: [fav('a', {})], now: NOW },
  { name: 'unknown fields travel with the body', store: 'favorites', local: [fav('a', {}, { extra: 1 })], remote: [fav('a', { body: T(4) }, { extra: 2, '7': 'n' })], now: NOW },
]

// ---- Seeded random sides (the property tests' generator) ----

function rng(seed: number): () => number {
  const next = random32(seed)
  return () => next() / 4294967296
}

function snapSide(rand: () => number, missing: boolean): Meta[] {
  const pick = <V>(xs: readonly V[]): V => xs[Math.floor(rand() * xs.length)]
  const times = [T(1), T(2), T(3)]
  const out: Meta[] = []
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

function packSide(rand: () => number): Meta[] {
  const pick = <V>(xs: readonly V[]): V => xs[Math.floor(rand() * xs.length)]
  const times = [T(1), T(2), T(3), EPOCH_ISO]
  const out: Meta[] = []
  for (const id of ['p', 'q', 'r']) {
    if (rand() < 0.3) continue
    out.push(withUpdated({
      id, filename: `packs/${id}.json`, name: pick(['A', 'B']), version: pick(['1', '2']), enabled: pick([true, false]),
      savedAt: T(0), ...(rand() < 0.4 ? { coverage: pick([10, 20]) } : {}),
      ...(rand() < 0.3 ? { deletedAt: pick(times) } : {}),
      clocks: { created: pick(times), body: pick(times), name: pick(times), hub: pick(times), enabled: pick(times) },
    }))
  }
  return out
}

function runSide(rand: () => number): Meta[] {
  const pick = <V>(xs: readonly V[]): V => xs[Math.floor(rand() * xs.length)]
  const out: Meta[] = []
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    if (rand() < 0.2) continue
    const deleted = rand() < 0.2
    out.push(withUpdated({
      id, startedAt: pick([T(1), T(2), T(3)]), filename: `r_${id}.json`, savedAt: pick([T(0), T(1)]),
      clocks: { created: pick([T(1), T(2)]), body: pick([T(1), T(2)]) }, ...(deleted ? { deletedAt: T(2) } : {}),
    }))
  }
  return out
}

function randomCases(): CaseInput[] {
  const cases: CaseInput[] = []
  const gonePrefix = (side: Meta[]): string[] => side.map((e) => e.filename).filter((f) => f.startsWith('gone_'))
  for (let i = 0; i < 40; i++) {
    const rand = rng(1 + i)
    const missing = i >= 20
    const a = snapSide(rand, missing)
    const b = snapSide(rand, missing)
    const hasBody = { local: gonePrefix(a), remote: gonePrefix(b) }
    const hashes = rand() < 0.5 ? { local: { a: 'h1', b: 'h2', c: 'h1' }, remote: { a: 'h2', b: 'h2', d: 'h3' } } : undefined
    cases.push({ name: `random snapshots ${i}`, store: 'snapshots', local: a, remote: b, now: NOW, hasBody, hashes })
    const ab = mergeEntries('snapshots', a as never[], b as never[], { now: NOW, hasBody: hasBodyOf(hasBody) }).entries as unknown as Meta[]
    cases.push({ name: `random snapshots ${i} again`, store: 'snapshots', local: ab, remote: b, now: NOW, hasBody: { local: gonePrefix(ab), remote: gonePrefix(b) } })
  }
  for (let i = 0; i < 30; i++) {
    const rand = rng(1000 + i)
    cases.push({ name: `random packs ${i}`, store: i % 2 === 0 ? 'i18nPacks' : 'themePacks', local: packSide(rand), remote: packSide(rand), now: NOW, policy: 'localIfPresent', preserveLocalOrder: true })
  }
  for (let i = 0; i < 20; i++) {
    const rand = rng(2000 + i)
    cases.push({ name: `random run logs ${i}`, store: 'runLogs', local: runSide(rand), remote: runSide(rand), now: NOW, runLogRetentionMax: 3 })
  }
  return cases
}

// ---- gcTombstones and compareBodies ----

function gcCases() {
  const entries = [fav('d', {}, { deletedAt: T(1) }), fav('a', { created: T(2) }, { deletedAt: T(0) }), fav('b', {}), fav('n', {}, { deletedAt: 'nope' })]
  return [NOW, NOW_LATE, BASE + TOMBSTONE_TTL_MS + 1000, BASE + TOMBSTONE_TTL_MS + 999].map((now) => ({
    entries: JSON.stringify(entries),
    now,
    out: JSON.stringify(gcTombstones(entries as never[], now)),
  }))
}

function compareCases() {
  const pairs: Array<[Meta, Meta, [string, string] | null]> = [
    [snap('a', { body: T(2) }), snap('a', {}), null],
    [snap('a', {}), snap('a', { body: T(2) }), null],
    [snap('a', {}), snap('a', {}), ['x', 'x']],
    [snap('a', {}), snap('a', {}), ['y', 'x']],
    [snap('a', {}), snap('a', {}), ['x', 'y']],
    [snap('a', {}), snap('a', {}), null],
    [snap('a', {}, { vilVersion: 3 }), snap('a', {}), ['a', 'z']],
    [snap('a', {}, { filename: 'b.pipette' }), snap('a', {}), null],
  ]
  return pairs.map(([a, b, hashes]) => {
    const order = hashes
      ? compareBodies('snapshots', a as never, b as never, (e) => (e === (a as unknown) ? hashes[0] : hashes[1]))
      : compareBodies('snapshots', a as never, b as never)
    return { a: JSON.stringify(a), b: JSON.stringify(b), hashes, sign: Math.sign(order) }
  })
}

describe('entry merge fixtures', () => {
  it('records the merge of every case', () => {
    const cases = [...NAMED, ...randomCases()].map(record)
    expect(cases.length).toBeGreaterThan(130)
    writeJsonFixture(OUT, { merges: cases, gcTombstones: gcCases(), compareBodies: compareCases() })
  })
})
