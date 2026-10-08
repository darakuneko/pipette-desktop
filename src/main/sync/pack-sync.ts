// SPDX-License-Identifier: GPL-2.0-or-later
// Sync of the i18n / theme pack stores (sync format v2), shared by both
// stores through a small adapter (`PackSyncStore`).
//
// A pack has two sync units: the roster (`{i18n|themes}/index`, every
// pack's meta) and one body unit per pack (`…/packs/{id}`, the pack JSON).
// The body group of a meta (`version`, and coverage etc. for i18n) always
// describes the local body file:
// - The index merge keeps a local entry's body group whatever the remote
//   clocks say (`bodyPolicy: 'localIfPresent'`). An entry this device has
//   no live copy of takes the remote body fields for display with body
//   clock 0; the caller forgets the body unit's remote revision so the
//   next pass fetches it (`mergePackIndexBundle`, pack-bundle-merge.ts).
// - A body bundle carries its own clock and body fields, read from the
//   local meta under the store's lock. Applying one compares them with the
//   local meta (`compareBodies`, `entry-merge.ts`) and, when the remote
//   body wins, writes the file and the meta's body group in one locked
//   step.

import { dirname } from 'node:path'
import { mkdir, readFile, stat } from 'node:fs/promises'
import {
  type ClockedEntry,
  type StoreMetaMap,
  EPOCH_ISO,
  STORE_GROUPS,
  bodyFieldsOf,
  bodyHash,
  canonicalJson,
  clockMs,
  groupValues,
  normalizeEntry,
  setClock,
  validClock,
} from './entry-clocks'
import { compareBodies, mergeEntries } from './entry-merge'
import { normalizeEntries } from './entry-write'
import { MalformedSyncBundleError } from './merge'
import { log } from '../logger'
import { isSafePackId } from '../utils/safe-filename'
import { writeFileAtomic } from '../utils/write-file-atomic'
import type { PackBodyClock, SyncBundle } from '../../shared/types/sync'
import { I18N_INDEX_SYNC_UNIT } from '../../shared/types/i18n-store'
import { THEME_INDEX_SYNC_UNIT } from '../../shared/types/theme-store'

export type PackStore = 'i18nPacks' | 'themePacks'
type PackMeta<S extends PackStore> = StoreMetaMap[S]
type PackEntry<S extends PackStore> = ClockedEntry<PackMeta<S>>

/** What the shared sync code needs from a pack store. Every function runs
 *  inside `withLock`, the store's own index write lock. */
export interface PackSyncStore<S extends PackStore> {
  store: S
  bodySyncUnit: (id: string) => string
  withLock: <T>(fn: () => Promise<T>) => Promise<T>
  /** The index with every meta read as a v2 entry (`readPackMetas`). */
  readIndex: () => Promise<{ metas: PackEntry<S>[] }>
  writeIndex: (index: { metas: PackEntry<S>[] }) => Promise<void>
  indexPath: () => string
  packPath: (id: string) => string
  /** Ids whose body never syncs (the built-in English pack). */
  localOnlyIds?: ReadonlySet<string>
}

function isPackMetaCandidate(m: unknown): m is { id: string } {
  return typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string'
}

async function readBody<S extends PackStore>(s: PackSyncStore<S>, id: string): Promise<string | null> {
  try {
    return await readFile(s.packPath(id), 'utf-8')
  } catch {
    return null
  }
}

/** The metas of a pack index read from disk, as v2 entries. A meta stored
 *  without `clocks` was written by the v1 pack sync, which kept the body
 *  file's mtime equal to Drive's `modifiedTime`: its body clock is that
 *  mtime, its body fields stay as they are. Metas that already carry
 *  clocks are left alone, including one waiting for its body (body clock
 *  0), so a leftover old file never stands in for the body it waits for.
 *  The value is written to disk with the next write of the index. */
export async function readPackMetas<S extends PackStore>(
  store: S,
  raw: unknown,
  packPath: (id: string) => string,
  localOnlyIds?: ReadonlySet<string>,
): Promise<PackEntry<S>[]> {
  const v1Ids = new Set<string>()
  if (Array.isArray(raw)) {
    for (const m of raw) {
      if (isPackMetaCandidate(m) && !hasClocks(m)) v1Ids.add(m.id)
    }
  }
  const metas = normalizeEntries(store, raw)
  for (let i = 0; i < metas.length; i++) {
    const meta = metas[i]
    if (!v1Ids.has(meta.id) || localOnlyIds?.has(meta.id) || !isSafePackId(meta.id)) continue
    try {
      const mtime = (await stat(packPath(meta.id))).mtime.getTime()
      if (mtime > 0) metas[i] = setClock(meta, 'body', new Date(mtime).toISOString())
    } catch {
      // No body file: the body clock stays 0 and the body unit fetches it.
    }
  }
  return metas
}

function hasClocks(m: object): boolean {
  const clocks = (m as { clocks?: unknown }).clocks
  return clocks !== null && typeof clocks === 'object'
}

/** The index file as stored: missing, unreadable or without a `metas`
 *  array (`corrupt`), or holding metas some of which v1 wrote (no
 *  `clocks`). */
type RawPackIndex = { state: 'missing' } | { state: 'corrupt' } | { state: 'ok'; hasV1: boolean }

async function readRawPackIndex<S extends PackStore>(s: PackSyncStore<S>): Promise<RawPackIndex> {
  let raw: string
  try {
    raw = await readFile(s.indexPath(), 'utf-8')
  } catch (err) {
    return (err as { code?: unknown }).code === 'ENOENT' ? { state: 'missing' } : { state: 'corrupt' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: 'corrupt' }
  }
  const metas = parsed !== null && typeof parsed === 'object' ? (parsed as { metas?: unknown }).metas : undefined
  if (!Array.isArray(metas)) return { state: 'corrupt' }
  return { state: 'ok', hasV1: metas.some((m) => isPackMetaCandidate(m) && !hasClocks(m)) }
}

/** The roster bundle: every meta as a v2 entry, read under the store's
 *  lock. Null when the index is missing or unreadable. Sending the
 *  normalized metas (not the file as stored) is what lets two devices
 *  holding the same v1 packs converge: both send the same clocks. */
export async function bundlePackIndex<S extends PackStore>(
  s: PackSyncStore<S>,
  type: SyncBundle['type'],
): Promise<SyncBundle | null> {
  return s.withLock(async () => {
    if ((await readRawPackIndex(s)).state !== 'ok') return null
    const index = await s.readIndex()
    return { type, key: type, index: { ...index, metas: index.metas } as SyncBundle['index'], files: {} }
  })
}

export interface PackIndexMergeResult {
  /** False only when writing the index failed. */
  applied: boolean
  remoteNeedsUpdate: boolean
  /** Ids whose meta now shows a body this device does not hold yet. */
  bodyFetchIds: string[]
}

/** Merges a remote roster into the local one and writes it. A remote meta
 *  that is not an object with a safe pack id is dropped (and logged by
 *  count only); kept metas get `filename` derived from the id. */
export async function mergeSyncedPackIndex<S extends PackStore>(
  s: PackSyncStore<S>,
  remoteMetas: readonly unknown[],
): Promise<PackIndexMergeResult> {
  return s.withLock(async () => {
    try {
      // An index that exists but cannot be read is not overwritten; the
      // unit fails and is tried again.
      const raw = await readRawPackIndex(s)
      if (raw.state === 'corrupt') return { applied: false, remoteNeedsUpdate: false, bodyFetchIds: [] }
      const localIndex = await s.readIndex()
      const safe = remoteMetas.filter((m): m is PackMeta<S> => isPackMetaCandidate(m) && isSafePackId(m.id))
      if (safe.length < remoteMetas.length) {
        log('warn', `sync: dropped ${remoteMetas.length - safe.length} unsafe remote meta id(s) for ${s.store === 'i18nPacks' ? I18N_INDEX_SYNC_UNIT : THEME_INDEX_SYNC_UNIT}`)
      }
      const remote = safe.map((m) => ({ ...m, filename: `packs/${m.id}.json` }))
      const result = mergeEntries(s.store, localIndex.metas, remote, { bodyPolicy: 'localIfPresent', preserveLocalOrder: true })
      // v1 metas are written in their v2 form once, so their body clock no
      // longer depends on reading the file's mtime.
      if (result.localNeedsWrite || (raw.state === 'ok' && raw.hasV1)) {
        await s.writeIndex({ ...localIndex, metas: result.entries as PackEntry<S>[] })
      }
      const bodyFetchIds = [...result.byId].filter(([id, o]) => o.bodyFetchNeeded && !s.localOnlyIds?.has(id)).map(([id]) => id)
      return {
        applied: true,
        remoteNeedsUpdate: result.remoteNeedsUpdate || bodyAheadOfRemote(s.store, localIndex.metas, remote),
        bodyFetchIds,
      }
    } catch {
      return { applied: false, remoteNeedsUpdate: false, bodyFetchIds: [] }
    }
  })
}

/** Whether a live local meta holds a newer body than Drive's roster shows
 *  for it (other body fields under a later body clock). The roster merge
 *  leaves the body group out of its own comparison, so this is what sends
 *  the body fields a body unit applied here, or a local save, back to the
 *  roster on Drive. */
function bodyAheadOfRemote<S extends PackStore>(store: S, local: readonly PackEntry<S>[], remote: readonly PackMeta<S>[]): boolean {
  const def = STORE_GROUPS[store]
  const remoteById = new Map(remote.map((m) => [m.id, m]))
  return local.some((l) => {
    const raw = remoteById.get(l.id)
    if (l.deletedAt !== undefined || !raw) return false
    const r = normalizeEntry(store, raw)
    return clockMs(l.clocks.body) > clockMs(r.clocks.body)
      && canonicalJson(groupValues(def, l, 'body')) !== canonicalJson(groupValues(def, r, 'body'))
  })
}

/** The body bundle of `id`: the pack JSON plus the body clock and body
 *  fields of its live local meta. Null when the id has no live meta, no
 *  body file, or never syncs its body. */
export async function bundlePackBody<S extends PackStore>(
  s: PackSyncStore<S>,
  id: string,
  type: SyncBundle['type'],
): Promise<SyncBundle | null> {
  if (!isSafePackId(id) || s.localOnlyIds?.has(id)) return null
  return s.withLock(async () => {
    const meta = (await s.readIndex()).metas.find((m) => m.id === id)
    if (!meta || meta.deletedAt !== undefined) return null
    const content = await readBody(s, id)
    if (content === null) return null
    return {
      type,
      key: id,
      index: { metas: [] },
      files: { [`${id}.json`]: content },
      body: { clock: meta.clocks.body, fields: bodyFields(s.store, meta) },
    }
  })
}

/** The body group of `meta` without `filename` (fixed per id). */
function bodyFields(store: PackStore, meta: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of bodyFieldsOf(STORE_GROUPS[store], meta)) {
    if (f !== 'filename') out[f] = (meta as Record<string, unknown>)[f]
  }
  return out
}

/** The clock and fields a remote body bundle carries. A bundle written by
 *  a v1 app has neither: its clock is the Drive file's `modifiedTime`, and
 *  its only field is the pack's own `version`, so values that live only in
 *  the index (coverage and the like) are dropped and computed again. */
function remoteBodyClock(bundle: SyncBundle, content: string, remoteModifiedTime: string): PackBodyClock & { v1: boolean } {
  const body: unknown = (bundle as { body?: unknown }).body
  if (body !== null && typeof body === 'object') {
    const { clock, fields } = body as { clock?: unknown; fields?: unknown }
    if (typeof clock === 'string' && fields !== null && typeof fields === 'object' && !Array.isArray(fields)) {
      return { clock: validClock(clock) ?? EPOCH_ISO, fields: fields as Record<string, unknown>, v1: false }
    }
  }
  let version: unknown
  try {
    version = (JSON.parse(content) as { version?: unknown }).version
  } catch {
    version = undefined
  }
  return { clock: validClock(remoteModifiedTime) ?? EPOCH_ISO, fields: typeof version === 'string' ? { version } : {}, v1: true }
}

/** Outcome of `applySyncedPackBody`:
 *  - `applied`: the remote body won; file and meta were written.
 *  - `local-wins`: the local body wins, so Drive needs it.
 *  - `same`: both bodies are identical.
 *  - `skipped`: nothing to apply (no body in the bundle, the meta is a
 *    tombstone, or the meta is missing after the roster was merged). */
export type ApplyPackBodyOutcome = 'applied' | 'local-wins' | 'same' | 'skipped'

/** Thrown when a body arrives for an id the local roster does not know
 *  yet and the roster has not been merged in this run: the roster may
 *  still bring the meta, so the unit is retried rather than recorded. */
export class PackMetaPendingError extends Error {
  constructor(syncUnit: string) {
    super(`sync: no local meta yet for ${syncUnit}`)
    this.name = 'PackMetaPendingError'
  }
}

/** Applies a remote body bundle for `id` against the local meta, under the
 *  store's lock. `rosterMerged` says whether the roster unit has been
 *  merged in this run. Throws `MalformedSyncBundleError` for an unsafe id
 *  and `PackMetaPendingError` for a meta the unmerged roster may still
 *  bring. */
export async function applySyncedPackBody<S extends PackStore>(
  s: PackSyncStore<S>,
  id: string,
  bundle: SyncBundle,
  remoteModifiedTime: string,
  rosterMerged: boolean,
): Promise<ApplyPackBodyOutcome> {
  if (!isSafePackId(id)) throw new MalformedSyncBundleError(s.bodySyncUnit(id))
  const files: unknown = bundle.files
  const content = files !== null && typeof files === 'object' ? (files as Record<string, unknown>)[`${id}.json`] : undefined
  if (typeof content !== 'string' || s.localOnlyIds?.has(id)) return 'skipped'

  return s.withLock(async () => {
    const index = await s.readIndex()
    const at = index.metas.findIndex((m) => m.id === id)
    if (at < 0) {
      if (rosterMerged) return 'skipped'
      throw new PackMetaPendingError(s.bodySyncUnit(id))
    }
    const local = index.metas[at]
    if (local.deletedAt !== undefined) return 'skipped'

    const remote = remoteBodyClock(bundle, content, remoteModifiedTime)
    const localContent = await readBody(s, id)
    // A v1 bundle knows only `version`. With no local body yet (the roster
    // brought this meta) and the same version, the body fields the roster
    // brought (coverage and the like) describe that body, so they stay.
    // Different local bytes keep only `version`: coverage is computed again.
    if (remote.v1 && localContent === null && remote.fields.version === (local as { version?: unknown }).version) {
      remote.fields = bodyFields(s.store, local)
    }
    const allowed = new Set(STORE_GROUPS[s.store].body.filter((f) => f !== 'filename'))
    const candidate: Record<string, unknown> = { ...local }
    for (const f of bodyFieldsOf(STORE_GROUPS[s.store], local)) if (f !== 'filename') delete candidate[f]
    for (const [k, v] of Object.entries(remote.fields)) if (allowed.has(k) && v !== undefined) candidate[k] = v
    const remoteEntry = setClock(candidate as unknown as PackEntry<S>, 'body', remote.clock)

    if (localContent !== null) {
      // The same bytes from a v1 app, or under the same clock, keep the
      // local body group: a v1 bundle knows only `version`, and taking it
      // would drop the coverage and the like of every pack on the first v2
      // pass.
      if (bodyHash(localContent) === bodyHash(content) && (remote.v1 || clockMs(local.clocks.body) === clockMs(remote.clock))) return 'same'
      const cmp = compareBodies(s.store, local, remoteEntry, (e) => bodyHash(e === local ? localContent : content))
      if (cmp > 0) return 'local-wins'
      if (cmp === 0) return 'same'
    }
    await mkdir(dirname(s.packPath(id)), { recursive: true })
    await writeFileAtomic(s.packPath(id), content)
    index.metas[at] = remoteEntry
    await s.writeIndex(index)
    return 'applied'
  })
}
