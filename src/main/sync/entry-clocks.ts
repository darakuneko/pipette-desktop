// SPDX-License-Identifier: GPL-2.0-or-later
// Per-group clocks for index entries (sync format v2): field groups per
// store, clock parsing, canonical JSON, the v1 → v2 entry normalization
// that `entry-merge.ts` builds on, and the clock writers every v2 write
// path uses so `updatedAt` always equals `derivedUpdatedAt`.

import type { SavedFavoriteMeta } from '../../shared/types/favorite-store'
import type { SnapshotMeta } from '../../shared/types/snapshot-store'
import type { AnalyzeFilterSnapshotMeta } from '../../shared/types/analyze-filter-store'
import type { KeyLabelMeta } from '../../shared/types/key-label-store'
import type { TypingTestTextMeta } from '../../shared/types/typing-test-text-store'
import type { RunLogMeta } from '../../shared/types/typing-run-log'
import type { I18nPackMeta } from '../../shared/types/i18n-store'
import type { ThemePackMeta } from '../../shared/types/theme-store'
import { createHash } from 'node:crypto'
import { safeTimestamp } from './merge'

/** Clocks of one entry, one per field group (ISO 8601). `created` is set
 *  when an id is created or written again after being deleted / missing;
 *  it is the only clock that can bring an entry back after a delete. */
export interface EntryClocks {
  created: string
  body: string
  name?: string
  hub?: string
  enabled?: string
}

export type MetaGroup = 'name' | 'hub' | 'enabled'
/** Every merge group. `created` carries `createdFields`, `body` carries
 *  every field no other group claims (see `bodyFieldsOf`). */
export type EntryGroup = 'created' | 'body' | MetaGroup

export const META_GROUPS: readonly MetaGroup[] = ['name', 'hub', 'enabled']

export interface StoreMetaMap {
  favorites: SavedFavoriteMeta
  snapshots: SnapshotMeta
  analyzeFilters: AnalyzeFilterSnapshotMeta
  keyLabels: KeyLabelMeta
  typingTestTexts: TypingTestTextMeta
  i18nPacks: I18nPackMeta
  themePacks: ThemePackMeta
  runLogs: RunLogMeta
}

export type EntryStore = keyof StoreMetaMap

/** Fields every store meta shares; `updatedAt` is optional on some stores. */
export interface BaseEntryMeta {
  id: string
  filename: string
  savedAt: string
  updatedAt?: string
  deletedAt?: string
}

/** A store meta carrying v2 clocks. `updatedAt` is always
 *  max(all clocks, deletedAt) so ordering and display keep working. */
export type ClockedEntry<T extends BaseEntryMeta = BaseEntryMeta> = T & { clocks: EntryClocks; updatedAt: string }

/** How v1 entries (no `clocks`) get their body clock:
 *  - `savedAt`: `savedAt` moves with every body save (immutable bodies, or
 *    a new filename and `savedAt` on every save).
 *  - `updatedAtOrSavedAt`: the body is overwritten in place and `updatedAt`
 *    also moves on renames, so v1 cannot tell them apart.
 *  - `epoch`: the body lives in its own sync unit (packs); the index body
 *    clock starts at 0 and the body unit sets it. */
export type V1BodyClockRule = 'savedAt' | 'updatedAtOrSavedAt' | 'epoch'

export interface StoreGroupDef {
  /** Fields of the body group. Documents the store's shape; the merge puts
   *  every field outside the other groups into the body group, so a field
   *  added later still travels with the body. */
  body: readonly string[]
  /** Fields that travel with the winning `created` clock. */
  createdFields: readonly string[]
  name?: readonly string[]
  hub?: readonly string[]
  enabled?: readonly string[]
  v1BodyClock: V1BodyClockRule
  /** Where the entry id sits in the body filename (see `idBodyFilename`). */
  filenameId: FilenameIdRule
  /** Extension of the store's body files. */
  bodyExt: '.json' | '.pipette'
  /** The store saves over one filename in place, so equal body clocks and
   *  fields can still hide different bytes: the merge breaks that tie by
   *  the body's hash (`bodyHash`). */
  hashBody?: true
}

/** - `suffix`: `{stem}_{id}{ext}` (snapshots `{device}_{ts}_{id}.pipette`,
 *    run logs `{ts}_{id}.json`; favorites and analyze filters get the id
 *    appended to their `{…}_{ts}_{random}.json` names).
 *  - `prefix`: `{id}_{ts}.json` (key labels, typing-test texts).
 *  - `fixed`: `packs/{id}.json` (i18n and theme packs). */
export type FilenameIdRule = 'suffix' | 'prefix' | 'fixed'

const HUB_LINK = ['hubPostId', 'hubPrivate'] as const
const HUB_CACHE = ['hubPostId', 'hubUpdatedAt', 'uploaderName'] as const

/** `savedAt` sits in the body group where the store rewrites it on every
 *  body save (key labels, typing-test texts, run logs re-saved by id) and
 *  in the created group where it is the first save time (every other
 *  store). */
export const STORE_GROUPS: Readonly<Record<EntryStore, StoreGroupDef>> = {
  favorites: { body: ['filename'], createdFields: ['savedAt'], name: ['label'], hub: HUB_LINK, v1BodyClock: 'savedAt', filenameId: 'suffix', bodyExt: '.json' },
  snapshots: {
    body: ['filename', 'vilVersion'],
    createdFields: ['savedAt'],
    name: ['label'],
    hub: HUB_LINK,
    v1BodyClock: 'updatedAtOrSavedAt',
    filenameId: 'suffix',
    bodyExt: '.pipette',
    hashBody: true,
  },
  analyzeFilters: {
    body: ['filename', 'summary'],
    createdFields: ['savedAt'],
    name: ['label'],
    hub: HUB_LINK,
    v1BodyClock: 'updatedAtOrSavedAt',
    filenameId: 'suffix',
    bodyExt: '.json',
    hashBody: true,
  },
  keyLabels: { body: ['filename', 'savedAt'], createdFields: [], name: ['name'], hub: HUB_CACHE, v1BodyClock: 'savedAt', filenameId: 'prefix', bodyExt: '.json' },
  typingTestTexts: {
    body: ['filename', 'savedAt', 'wordCount', 'lineCount', 'source'],
    createdFields: [],
    name: ['name'],
    v1BodyClock: 'savedAt',
    filenameId: 'prefix',
    bodyExt: '.json',
  },
  i18nPacks: {
    body: ['filename', 'version', 'coverage', 'matchedBaseVersion', 'dangerousKeyCount', 'appVersionAtImport'],
    createdFields: ['savedAt'],
    name: ['name'],
    hub: HUB_CACHE,
    enabled: ['enabled'],
    v1BodyClock: 'epoch',
    filenameId: 'fixed',
    bodyExt: '.json',
  },
  themePacks: { body: ['filename', 'version'], createdFields: ['savedAt'], name: ['name'], hub: HUB_CACHE, v1BodyClock: 'epoch', filenameId: 'fixed', bodyExt: '.json' },
  runLogs: { body: ['filename', 'startedAt', 'savedAt'], createdFields: [], v1BodyClock: 'savedAt', filenameId: 'suffix', bodyExt: '.json' },
}

function splitExtension(filename: string): [string, string] {
  const slash = filename.lastIndexOf('/')
  const dot = filename.lastIndexOf('.')
  return dot > slash + 1 ? [filename.slice(0, dot), filename.slice(dot)] : [filename, '']
}

/** The id as it appears in a body filename: as it is when it is only
 *  letters, digits and `-` and does not start with `x`, otherwise `x` and
 *  4 hex digits per UTF-16 code unit (lossless, lone surrogates included). The segment never contains `_`, the
 *  separator, and plain and hex forms cannot meet (only hex starts with
 *  `x`), so one segment names exactly one id. */
export function idFilenameSegment(id: string): string {
  if (/^[A-Za-z0-9-]+$/.test(id) && !id.startsWith('x')) return id
  let hex = ''
  for (let i = 0; i < id.length; i++) hex += id.charCodeAt(i).toString(16).padStart(4, '0')
  return `x${hex}`
}

/** Whether `filename` carries `id` the way `store` names its body files:
 *  the id segment is exactly the part after the last `_` of the stem
 *  (`suffix`) or before the first `_` (`prefix`). Two different ids can
 *  then never own the same body file. */
export function bodyFilenameHasId(store: EntryStore, id: string, filename: string): boolean {
  const seg = idFilenameSegment(id)
  switch (STORE_GROUPS[store].filenameId) {
    case 'suffix': {
      const stem = splitExtension(filename)[0]
      const sep = stem.lastIndexOf('_')
      return sep >= 0 && stem.slice(sep + 1) === seg
    }
    case 'prefix': {
      const sep = filename.indexOf('_')
      return sep >= 0 && filename.slice(0, sep) === seg
    }
    case 'fixed': return filename === `packs/${id}.json`
  }
}

/** `filename` in the id-carrying form of `store`; a name that already
 *  carries the id is returned as it is. Deterministic, so every device
 *  maps a legacy name to the same new one. Pack filenames are fixed per id
 *  (`isSafePackId` restricts those ids). */
export function idBodyFilename(store: EntryStore, id: string, filename: string): string {
  if (bodyFilenameHasId(store, id, filename)) return filename
  const seg = idFilenameSegment(id)
  switch (STORE_GROUPS[store].filenameId) {
    case 'suffix': {
      const [stem, ext] = splitExtension(filename)
      return `${stem}_${seg}${ext}`
    }
    case 'prefix': return `${seg}_${filename}`
    case 'fixed': return `packs/${id}.json`
  }
}

/** Fields no group owns: identity, the clocks themselves and the derived /
 *  delete markers the merge computes. */
export const RESERVED_FIELDS: ReadonlySet<string> = new Set(['id', 'clocks', 'updatedAt', 'deletedAt'])

export const EPOCH_ISO = new Date(0).toISOString()

export function groupFields(def: StoreGroupDef, group: Exclude<EntryGroup, 'body'>): readonly string[] {
  return group === 'created' ? def.createdFields : def[group] ?? []
}

const claimedFields = new Map<StoreGroupDef, ReadonlySet<string>>()

/** Every non-reserved field of `entry` that no non-body group claims. */
export function bodyFieldsOf(def: StoreGroupDef, entry: object): string[] {
  let claimed = claimedFields.get(def)
  if (!claimed) {
    claimed = new Set([...def.createdFields, ...(def.name ?? []), ...(def.hub ?? []), ...(def.enabled ?? [])])
    claimedFields.set(def, claimed)
  }
  const owned = claimed
  return Object.keys(entry).filter((k) => !RESERVED_FIELDS.has(k) && !owned.has(k))
}

/** Epoch ms of an ISO clock; anything that is not a parseable string is 0
 *  so a corrupt remote clock always loses. */
export function clockMs(value: unknown): number {
  return typeof value === 'string' ? safeTimestamp(value) : 0
}

/** The canonical ISO form of a clock, or undefined when it is not valid. */
export function validClock(value: unknown): string | undefined {
  const ms = clockMs(value)
  return ms > 0 ? new Date(ms).toISOString() : undefined
}

/** JSON with object keys sorted at every level and `undefined` members
 *  dropped, so equal values always give equal strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? 'null'
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key]
    if (v !== undefined) out[key] = sortValue(v)
  }
  return out
}

/** max(all clocks, deletedAt) — the only value v2 writes to `updatedAt`. */
export function derivedUpdatedAt(clocks: EntryClocks, deletedAt: string | undefined): string {
  let best = 0
  for (const v of [clocks.created, clocks.body, clocks.name, clocks.hub, clocks.enabled, deletedAt]) best = Math.max(best, clockMs(v))
  return new Date(best).toISOString()
}

/** The values of `group`'s fields on `entry` (absent fields included as
 *  undefined; the body group is every field `bodyFieldsOf` returns). */
export function groupValues(def: StoreGroupDef, entry: object, group: EntryGroup): Record<string, unknown> {
  const fields = group === 'body' ? bodyFieldsOf(def, entry) : groupFields(def, group)
  const out: Record<string, unknown> = {}
  for (const f of fields) out[f] = (entry as Record<string, unknown>)[f]
  return out
}

/** Clocks for a brand-new entry of `store`: every group the store has
 *  starts at `now`. */
export function newClocks(store: EntryStore, now: Date): EntryClocks {
  const def = STORE_GROUPS[store]
  const iso = now.toISOString()
  const clocks: EntryClocks = { created: iso, body: iso }
  for (const g of META_GROUPS) if (def[g]) clocks[g] = iso
  return clocks
}

/** Sets `group`'s clock to `now`, or 1 ms past its current value when that
 *  is later (a clock running behind must still move the group forward),
 *  and rewrites `updatedAt`. Touching `created` past `deletedAt` brings the
 *  entry back, so `deletedAt` goes. */
export function touchClock<T extends BaseEntryMeta>(entry: ClockedEntry<T>, group: EntryGroup, now: Date): ClockedEntry<T> {
  const next = Math.max(now.getTime(), clockMs(entry.clocks[group]) + 1)
  const clocks: EntryClocks = { ...entry.clocks, [group]: new Date(next).toISOString() }
  const out = { ...entry, clocks }
  if (out.deletedAt !== undefined && clockMs(clocks.created) > clockMs(out.deletedAt)) delete out.deletedAt
  out.updatedAt = derivedUpdatedAt(clocks, out.deletedAt)
  return out
}

/** Sets `group`'s clock to `iso` as it is (no "never move back" rule, see
 *  `touchClock`) and rewrites `updatedAt`. For clocks a write fixes
 *  instead of taking from now: the epoch of built-ins, a migrated or
 *  received body clock. */
export function setClock<T extends BaseEntryMeta>(entry: ClockedEntry<T>, group: EntryGroup, iso: string): ClockedEntry<T> {
  const clocks: EntryClocks = { ...entry.clocks, [group]: iso }
  return { ...entry, clocks, updatedAt: derivedUpdatedAt(clocks, entry.deletedAt) }
}

/** SHA-256 of a body's text, the tie-break of equal body clocks and
 *  fields. */
export function bodyHash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Tombstones `entry` at `now`, never before its `created` clock, so the
 *  entry stays deleted under the merge rule (a tie is deleted) even when
 *  `created` came from a clock that runs ahead. */
export function markDeleted<T extends BaseEntryMeta>(entry: ClockedEntry<T>, now: Date): ClockedEntry<T> {
  const deletedAt = new Date(Math.max(now.getTime(), clockMs(entry.clocks.created))).toISOString()
  return { ...entry, deletedAt, updatedAt: derivedUpdatedAt(entry.clocks, deletedAt) }
}

/** Brings a deleted entry back (an explicit overwrite by the user): sets
 *  `created` to `now`, never earlier than 1 ms past `deletedAt`, so the
 *  revival wins even when `deletedAt` came from a clock that runs ahead.
 *  An entry without `deletedAt` is returned unchanged — saving over a live
 *  entry does not move `created`. */
export function reviveEntry<T extends BaseEntryMeta>(entry: ClockedEntry<T>, now: Date): ClockedEntry<T> {
  if (entry.deletedAt === undefined) return entry
  const created = new Date(Math.max(now.getTime(), clockMs(entry.deletedAt) + 1)).toISOString()
  const clocks: EntryClocks = { ...entry.clocks, created }
  const { deletedAt: _deletedAt, ...rest } = entry
  return { ...rest, clocks, updatedAt: derivedUpdatedAt(clocks, undefined) } as ClockedEntry<T>
}

/** Reads `entry` as a v2 entry and returns a new object:
 *  - v1 (no `clocks` object): created = `savedAt` (no later than
 *    `deletedAt`, so a v1 tombstone stays deleted), name / hub / enabled =
 *    `updatedAt ?? savedAt`, body per the store's `v1BodyClock`.
 *  - v2: invalid clocks count as 0 (`created` / `body` become epoch, the
 *    others are dropped) and clocks of groups the store lacks are dropped.
 *  - A v2 entry whose `updatedAt` is later than every clock and `deletedAt`
 *    was written by an app that only knows v1 (v2 writes `updatedAt` only
 *    through `derivedUpdatedAt`). Its name / hub / enabled clocks are
 *    raised to that `updatedAt`, and so is `body` for stores whose v1 rule
 *    is `updatedAtOrSavedAt`. `created` is never raised: a v1 write cannot
 *    say whether it re-created the entry.
 *  - An entry alive under the merge rule (created > deletedAt) carries no
 *    `deletedAt`, so "has deletedAt" means deleted on read too. */
export function normalizeEntry<S extends EntryStore>(
  store: S,
  entry: StoreMetaMap[S] & { clocks?: unknown },
): ClockedEntry<StoreMetaMap[S]> {
  const def = STORE_GROUPS[store]
  const raw = entry
  const given = raw.clocks !== null && typeof raw.clocks === 'object' ? (raw.clocks as Record<string, unknown>) : undefined
  let deletedAt = raw.deletedAt === undefined ? undefined : (validClock(raw.deletedAt) ?? EPOCH_ISO)
  const v1Meta = validClock(raw.updatedAt) ?? validClock(raw.savedAt)

  let clocks: EntryClocks
  if (!given) {
    // A v1 tombstone stays deleted: its created is never past its deletedAt.
    const savedMs = clockMs(raw.savedAt)
    const created = deletedAt !== undefined && savedMs > clockMs(deletedAt) ? deletedAt : validClock(raw.savedAt)
    clocks = { created: created ?? EPOCH_ISO, body: v1BodyClock(def.v1BodyClock, raw) ?? EPOCH_ISO }
    for (const g of META_GROUPS) if (def[g] && v1Meta) clocks[g] = v1Meta
  } else {
    clocks = { created: validClock(given.created) ?? EPOCH_ISO, body: validClock(given.body) ?? EPOCH_ISO }
    for (const g of META_GROUPS) {
      const v = def[g] ? validClock(given[g]) : undefined
      if (v) clocks[g] = v
    }
    const written = validClock(raw.updatedAt)
    if (written && clockMs(written) > clockMs(derivedUpdatedAt(clocks, deletedAt))) {
      for (const g of META_GROUPS) if (def[g]) clocks[g] = written
      if (def.v1BodyClock === 'updatedAtOrSavedAt') clocks.body = written
    }
  }
  if (deletedAt !== undefined && clockMs(clocks.created) > clockMs(deletedAt)) deletedAt = undefined

  const out = { ...raw, clocks } as Record<string, unknown>
  if (deletedAt === undefined) delete out.deletedAt
  else out.deletedAt = deletedAt
  out.updatedAt = derivedUpdatedAt(clocks, deletedAt)
  return out as unknown as ClockedEntry<StoreMetaMap[S]>
}

function v1BodyClock(rule: V1BodyClockRule, raw: BaseEntryMeta): string | undefined {
  switch (rule) {
    case 'savedAt': return validClock(raw.savedAt)
    case 'updatedAtOrSavedAt': return validClock(raw.updatedAt) ?? validClock(raw.savedAt)
    case 'epoch': return undefined
  }
}
