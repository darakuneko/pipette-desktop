// SPDX-License-Identifier: GPL-2.0-or-later
// Entry merge for sync format v2: every field group (created / body / name /
// hub / enabled) merges on its own clock, and an entry is alive only while
// its newest `created` is later than its newest `deletedAt`.
//
// Each group's winner is the larger (clock, canonical JSON of the group's
// values, caller-supplied body hash) tuple. That is a total order, so under
// `bodyPolicy: 'clock'` the merge is commutative, associative and
// idempotent and every device converges on the same entries; there is no
// "keep local on a tie".
//
// Two rules keep a body file and its index entry together:
// - Every body filename carries its entry id (`idBodyFilename`,
//   `entry-clocks.ts`), so two ids never share a file. Local entries are
//   expected in that form already; remote names are converted here.
// - A side whose body file is missing cannot win the body group.

import type { RunLogMeta } from '../../shared/types/typing-run-log'
import {
  type BaseEntryMeta,
  type ClockedEntry,
  type EntryClocks,
  type EntryGroup,
  type EntryStore,
  type StoreGroupDef,
  type StoreMetaMap,
  EPOCH_ISO,
  META_GROUPS,
  STORE_GROUPS,
  bodyFieldsOf,
  canonicalJson,
  clockMs,
  derivedUpdatedAt,
  groupValues,
  idBodyFilename,
  markDeleted,
  normalizeEntry,
} from './entry-clocks'
import { TOMBSTONE_TTL_MS } from './merge'

export type MergeSide = 'local' | 'remote'

/** How the body group merges:
 *  - `clock`: by the body tuple, like every other group, among the sides
 *    that have their body file.
 *  - `localIfPresent` (pack indexes, whose body travels in its own sync
 *    unit): a live local entry keeps its body group whatever the clocks;
 *    a remote-only or revived entry takes the remote body fields for
 *    display with `clocks.body` = epoch, and the body unit fetches the
 *    file. The body group is left out of `remoteNeedsUpdate`, and
 *    `hasBody` is not consulted. */
export type BodyPolicy = 'clock' | 'localIfPresent'

interface MergeOptionsBase<S extends EntryStore> {
  /** Keep the local array's order for alive entries (remote-only ids go
   *  after them) instead of sorting by `updatedAt`, newest first. */
  preserveLocalOrder?: boolean
  /** Hash of the entry's body file, for stores that overwrite the same
   *  filename (snapshots, analyze filters). Called only when both sides'
   *  body clocks and fields are equal. */
  bodyHash?: (side: MergeSide, entry: ClockedEntry<StoreMetaMap[S]>) => string | undefined
  /** Keep the newest N alive run logs (see `applyRunLogRetentionV2`). */
  runLogRetentionMax?: S extends 'runLogs' ? number : never
  /** Current time in ms for tombstone GC and retention. Defaults to now. */
  now?: number
}

/** `hasBody` is required under `clock` so no caller can skip the
 *  missing-body rule: whether the side holds the entry's body file (the
 *  local store for `local`, the remote bundle for `remote`). For the remote
 *  side here and in `bodyHash`, `entry.filename` is the name in the remote
 *  bundle, which may lack the id. */
export type EntryMergeV2Options<S extends EntryStore> = MergeOptionsBase<S> & (
  | { bodyPolicy?: 'clock'; hasBody: (side: MergeSide, entry: ClockedEntry<StoreMetaMap[S]>) => boolean }
  | { bodyPolicy: 'localIfPresent'; hasBody?: undefined }
)

export interface RemoteFileCopy {
  /** Key in `remoteBundle.files`. */
  from: string
  /** Local filename to save it under (carries the id). */
  to: string
}

export interface EntryMergeOutcome<T extends BaseEntryMeta> {
  entry: ClockedEntry<T>
  /** The alive result's body is the remote one and differs from the local
   *  one, so the caller copies the remote file (see `remoteFilesToCopy`). */
  bodyFromRemote: boolean
  /** `localIfPresent` only: the alive result shows remote body fields the
   *  local store has no file for, so the body unit has to be fetched. */
  bodyFetchNeeded: boolean
  /** The merge would make the entry alive but no side has its body file:
   *  the local entry is kept exactly as it is (an id only the remote side
   *  has is left out of `entries`), and the id is left out of
   *  `remoteNeedsUpdate`. */
  bodyMissing: boolean
}

/** The caller applies a result under the store's lock: save every
 *  `remoteFilesToCopy` file under its `to` name, write `entries` as the
 *  local index, then unlink local body files outside `referencedFilenames`.
 *  The bundle to upload is built from the local index and files as usual,
 *  leaving out alive entries whose file is missing (`bodyMissing`). */
export interface EntryMergeV2Result<T extends BaseEntryMeta> {
  /** The index to write locally. An id only a body-less remote entry has is
   *  not in it. */
  entries: ClockedEntry<T>[]
  byId: Map<string, EntryMergeOutcome<T>>
  /** One per `bodyFromRemote` outcome. */
  remoteFilesToCopy: RemoteFileCopy[]
  /** Every filename `entries` still points at, tombstones included. A
   *  local body file outside this set is an orphan. */
  referencedFilenames: Set<string>
  /** `entries` differs from the local input (order included). */
  localNeedsWrite: boolean
  /** Some entry with a body differs from the remote input after GC, or
   *  Drive needs this device's body file (it lacks it, or the body won only
   *  by its hash). */
  remoteNeedsUpdate: boolean
  /** Entries of `entries` tombstoned by `runLogRetentionMax`; the caller
   *  unlinks their files. Empty without that option. */
  evicted: ClockedEntry<T>[]
}

interface Candidate<T extends BaseEntryMeta> {
  side: MergeSide
  entry: ClockedEntry<T>
  hash: () => string
  hasBody: () => boolean
}

export function isDeadEntry(entry: ClockedEntry): boolean {
  return entry.deletedAt !== undefined && clockMs(entry.clocks.created) <= clockMs(entry.deletedAt)
}

function keepAfterGc(entry: ClockedEntry, now: number): boolean {
  return !isDeadEntry(entry) || now - clockMs(entry.deletedAt) < TOMBSTONE_TTL_MS
}

/** Drops dead entries whose `deletedAt` is older than the TTL. Alive
 *  entries are always kept. */
export function gcTombstonesV2<T extends BaseEntryMeta>(entries: readonly ClockedEntry<T>[], now = Date.now()): ClockedEntry<T>[] {
  return entries.filter((e) => keepAfterGc(e, now))
}

/** (clock, canonical values) order of one group; 0 means only the body
 *  hash can still tell the two apart. */
function compareClockAndValues(def: StoreGroupDef, group: EntryGroup, a: ClockedEntry, b: ClockedEntry): number {
  const byClock = clockMs(a.clocks[group]) - clockMs(b.clocks[group])
  if (byClock !== 0) return byClock
  const av = canonicalJson(groupValues(def, a, group))
  const bv = canonicalJson(groupValues(def, b, group))
  return av === bv ? 0 : av > bv ? 1 : -1
}

function compareHashes(a: string, b: string): number {
  return a === b ? 0 : a > b ? 1 : -1
}

/** Total order of two bodies: >0 when `a` wins. `hashOf` is called only on
 *  an exact (clock, fields) tie. The body-unit apply of packs uses the same
 *  order so index and body unit agree. */
export function compareBodies<S extends EntryStore>(
  store: S,
  a: ClockedEntry<StoreMetaMap[S]>,
  b: ClockedEntry<StoreMetaMap[S]>,
  hashOf?: (entry: ClockedEntry<StoreMetaMap[S]>) => string | undefined,
): number {
  const byValues = compareClockAndValues(STORE_GROUPS[store], 'body', a, b)
  if (byValues !== 0 || !hashOf) return byValues
  return compareHashes(hashOf(a) ?? '', hashOf(b) ?? '')
}

function compareGroup<T extends BaseEntryMeta>(def: StoreGroupDef, group: EntryGroup, a: Candidate<T>, b: Candidate<T>): number {
  const byValues = compareClockAndValues(def, group, a.entry, b.entry)
  if (byValues !== 0 || group !== 'body') return byValues
  return compareHashes(a.hash(), b.hash())
}

/** The winning candidate; the first (local) one on a full tie, where the
 *  values are equal. */
function winner<T extends BaseEntryMeta>(def: StoreGroupDef, group: EntryGroup, cands: readonly Candidate<T>[]): Candidate<T> {
  let best = cands[0]
  for (const c of cands.slice(1)) if (compareGroup(def, group, c, best) > 0) best = c
  return best
}


interface Assembled<T extends BaseEntryMeta> {
  entry: ClockedEntry<T>
  bodySide: MergeSide
  bodyFetchNeeded: boolean
  bodyMissing: boolean
}

function assemble<T extends BaseEntryMeta>(
  def: StoreGroupDef,
  id: string,
  cands: readonly Candidate<T>[],
  policy: BodyPolicy,
): Assembled<T> {
  const createdW = winner(def, 'created', cands)
  let deletedAt: string | undefined
  for (const c of cands) {
    if (c.entry.deletedAt !== undefined && (deletedAt === undefined || clockMs(c.entry.deletedAt) > clockMs(deletedAt))) {
      deletedAt = c.entry.deletedAt
    }
  }
  // An alive result never carries deletedAt: "has deletedAt" stays the
  // single deleted check for every reader and for GC.
  if (deletedAt !== undefined && clockMs(createdW.entry.clocks.created) > clockMs(deletedAt)) deletedAt = undefined
  const alive = deletedAt === undefined
  const local = cands.find((c) => c.side === 'local')

  let bodyW: Candidate<T>
  let bodyClock: string | undefined
  let bodyFetchNeeded = false
  if (policy === 'localIfPresent') {
    if (local && (!isDeadEntry(local.entry) || !alive)) {
      bodyW = local
    } else {
      bodyW = cands.find((c) => c.side === 'remote') ?? cands[0]
      bodyClock = EPOCH_ISO
      bodyFetchNeeded = alive
    }
  } else if (!alive) {
    // A tombstone holds no body, so file presence does not matter.
    bodyW = winner(def, 'body', cands)
  } else {
    const withBody = cands.filter((c) => c.hasBody())
    if (withBody.length === 0) {
      return { entry: (local ?? cands[0]).entry, bodySide: (local ?? cands[0]).side, bodyFetchNeeded: false, bodyMissing: true }
    }
    bodyW = winner(def, 'body', withBody)
  }

  const out: Record<string, unknown> = { id }
  Object.assign(out, groupValues(def, bodyW.entry, 'body'), groupValues(def, createdW.entry, 'created'))
  const clocks: EntryClocks = { created: createdW.entry.clocks.created, body: bodyClock ?? bodyW.entry.clocks.body }
  for (const g of META_GROUPS) {
    if (!def[g]) continue
    const w = winner(def, g, cands)
    Object.assign(out, groupValues(def, w.entry, g))
    if (w.entry.clocks[g] !== undefined) clocks[g] = w.entry.clocks[g]
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  out.clocks = clocks
  if (deletedAt !== undefined) out.deletedAt = deletedAt
  out.updatedAt = derivedUpdatedAt(clocks, deletedAt)
  return { entry: out as unknown as ClockedEntry<T>, bodySide: bodyW.side, bodyFetchNeeded, bodyMissing: false }
}

function stripBody(def: StoreGroupDef, entry: object): unknown {
  const out: Record<string, unknown> = { ...entry }
  for (const f of bodyFieldsOf(def, entry)) delete out[f]
  delete out.updatedAt
  const clocks = out.clocks
  if (clocks !== null && typeof clocks === 'object') {
    const { body: _body, ...rest } = clocks as Record<string, unknown>
    out.clocks = rest
  }
  return out
}

function ordered<T extends BaseEntryMeta>(entries: Iterable<ClockedEntry<T>>, preserveLocalOrder: boolean): ClockedEntry<T>[] {
  const alive: ClockedEntry<T>[] = []
  const dead: ClockedEntry<T>[] = []
  for (const e of entries) (e.deletedAt === undefined ? alive : dead).push(e)
  if (!preserveLocalOrder) alive.sort((a, b) => clockMs(b.updatedAt) - clockMs(a.updatedAt))
  return [...alive, ...dead]
}

export function mergeEntriesV2<S extends EntryStore>(
  store: S,
  local: readonly StoreMetaMap[S][],
  remote: readonly StoreMetaMap[S][],
  options: EntryMergeV2Options<S>,
): EntryMergeV2Result<StoreMetaMap[S]> {
  type T = StoreMetaMap[S]
  const def = STORE_GROUPS[store]
  const now = options.now ?? Date.now()
  const policy = options.bodyPolicy ?? 'clock'
  const prepare = (raw: readonly T[]): Map<string, ClockedEntry<T>> => {
    const out = new Map<string, ClockedEntry<T>>()
    for (const entry of raw) {
      const n = normalizeEntry(store, entry)
      if (keepAfterGc(n, now)) out.set(entry.id, n)
    }
    return out
  }
  const L = prepare(local)
  const R = prepare(remote)
  const remoteRaw = new Map<string, T>()
  for (const entry of remote) if (R.has(entry.id)) remoteRaw.set(entry.id, entry)

  const candidate = (side: MergeSide, asGiven: ClockedEntry<T>): Candidate<T> => {
    const entry = side === 'remote' ? { ...asGiven, filename: idBodyFilename(store, asGiven.id, asGiven.filename) } : asGiven
    let hash: string | undefined
    let has: boolean | undefined
    return {
      side,
      entry,
      hash: () => (hash ??= options.bodyHash?.(side, asGiven) ?? ''),
      hasBody: () => (has ??= options.hasBody?.(side, asGiven) ?? true),
    }
  }

  const byId = new Map<string, EntryMergeOutcome<T>>()
  const remoteFilesToCopy: RemoteFileCopy[] = []
  const bodyMissingIds = new Set<string>()
  let localBodyNeeded = false
  for (const id of [...L.keys(), ...[...R.keys()].filter((key) => !L.has(key))]) {
    const l = L.get(id)
    const r = R.get(id)
    const cands = [l && candidate('local', l), r && candidate('remote', r)].filter((c): c is Candidate<T> => !!c)
    const merged = assemble(def, id, cands, policy)
    if (merged.bodyMissing) bodyMissingIds.add(id)
    if (merged.bodyMissing && !l) continue
    const bodyFromRemote = policy === 'clock' && !merged.bodyMissing && merged.bodySide === 'remote' && merged.entry.deletedAt === undefined
    if (bodyFromRemote && r) remoteFilesToCopy.push({ from: r.filename, to: merged.entry.filename })
    byId.set(id, { entry: merged.entry, bodyFromRemote, bodyFetchNeeded: merged.bodyFetchNeeded, bodyMissing: merged.bodyMissing })

    // Two cases leave the index fields equal while Drive needs this
    // device's body: Drive lacks the file of a body kept from here, or the
    // body won only by its hash.
    const [lc, rc] = cands
    if (policy === 'clock' && cands.length === 2 && !merged.bodyMissing && merged.entry.deletedAt === undefined
      && merged.bodySide === 'local' && lc.hasBody()) {
      if (!rc.hasBody() || (compareClockAndValues(def, 'body', lc.entry, rc.entry) === 0 && lc.hash() !== rc.hash())) {
        localBodyNeeded = true
      }
    }
  }

  let entries = ordered([...byId.values()].map((o) => o.entry), options.preserveLocalOrder === true)
  let evicted: ClockedEntry<T>[] = []
  if (options.runLogRetentionMax !== undefined) {
    const kept = applyRunLogRetentionV2(entries as unknown as ClockedEntry<RunLogMeta>[], options.runLogRetentionMax, now)
    entries = kept.entries as unknown as ClockedEntry<T>[]
    evicted = kept.evicted as unknown as ClockedEntry<T>[]
    for (const e of entries) {
      const prev = byId.get(e.id)
      if (prev) byId.set(e.id, { ...prev, entry: e, bodyFromRemote: prev.bodyFromRemote && e.deletedAt === undefined })
    }
  }

  // Every remote id is either in `entries` or body-less, so comparing the
  // merged entries covers both directions. Body-less ids never count: no
  // side can send a body for them.
  const view = (e: object): string => canonicalJson(policy === 'localIfPresent' ? stripBody(def, e) : e)
  let remoteNeedsUpdate = localBodyNeeded
  for (const e of entries) {
    if (remoteNeedsUpdate) break
    if (bodyMissingIds.has(e.id)) continue
    const r = remoteRaw.get(e.id)
    remoteNeedsUpdate = !r || view(e) !== view(r)
  }

  return {
    entries,
    byId,
    remoteFilesToCopy,
    referencedFilenames: new Set(entries.map((e) => e.filename)),
    localNeedsWrite: canonicalJson(entries) !== canonicalJson(local),
    remoteNeedsUpdate,
    evicted,
  }
}

/** Keeps the newest `max` alive run logs, ranked by immutable `startedAt`
 *  (id breaks an exact tie) so devices that each went over the cap keep
 *  the same set, and turns the rest into v2 tombstones (`markDeleted`). */
export function applyRunLogRetentionV2(
  entries: readonly ClockedEntry<RunLogMeta>[],
  max: number,
  now = Date.now(),
): { entries: ClockedEntry<RunLogMeta>[]; evicted: ClockedEntry<RunLogMeta>[] } {
  const alive = entries.filter((e) => e.deletedAt === undefined)
  const dead = entries.filter((e) => e.deletedAt !== undefined)
  if (alive.length <= max) return { entries: entries.slice(), evicted: [] }

  const ranked = alive.slice().sort((a, b) => {
    const byTime = clockMs(b.startedAt) - clockMs(a.startedAt)
    if (byTime !== 0) return byTime
    if (a.id === b.id) return 0
    return a.id < b.id ? 1 : -1
  })
  const kept = ranked.slice(0, max)
  const evicted = ranked.slice(max).map((e) => markDeleted(e, new Date(now)))
  return { entries: [...kept, ...evicted, ...dead], evicted }
}
