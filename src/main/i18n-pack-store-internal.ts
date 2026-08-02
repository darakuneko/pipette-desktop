// SPDX-License-Identifier: GPL-2.0-or-later
//
// Path helpers, write-lock serialization, result-type primitives, and
// index I/O for the i18n pack store. This is the ONLY module across
// the i18n-pack-store split holding mutable state (`indexWriteChain`)
// — see `withIndexWriteLock`'s doc below. Every other sibling module
// (`-sync.ts` / `-gc.ts` / `-crud.ts`) imports its lock/path/index
// primitives from here rather than re-deriving them. Never import this
// module from outside the i18n-pack-store split — external consumers
// use the facade (`i18n-pack-store.ts`).

import { app } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { notifyChange } from './sync/sync-service'
import { isSafePackId } from './utils/safe-filename'
import {
  BUILTIN_ENGLISH_PACK_ID,
  type I18nPackIndex,
  type I18nPackMeta,
  type I18nPackStoreErrorCode as SharedErrorCode,
  type I18nPackStoreResult as SharedResult,
} from '../shared/types/i18n-store'

const STORE_DIRNAME = 'i18n'
export const PACKS_DIRNAME = 'packs'
const INDEX_FILENAME = 'index.json'

// --- Path helpers ------------------------------------------------------------

export function getStoreDir(): string {
  return join(app.getPath('userData'), 'sync', STORE_DIRNAME)
}

export function getPacksDir(): string {
  return join(getStoreDir(), PACKS_DIRNAME)
}

export function getIndexPath(): string {
  return join(getStoreDir(), INDEX_FILENAME)
}

/** True when `m` is at least shaped enough to read `.id` off of safely —
 *  a non-null object with a string `id` field. Guards `mergeSyncedIndex`'s
 *  per-entry filter against a remote `metas` array containing `null` or
 *  other non-object garbage (attacker-reachable data). */
export function isPackMetaCandidate(m: unknown): m is I18nPackMeta {
  return typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string'
}

export function getPackPath(packId: string): string {
  if (!isSafePackId(packId)) throw new Error(`Invalid packId: ${packId}`)
  return join(getPacksDir(), `${packId}.json`)
}

export function packSyncUnit(packId: string): `i18n/packs/${string}` {
  return `i18n/packs/${packId}`
}

/**
 * Dirty-marks a single pack body's sync unit — except for the built-in
 * English entry, whose body is a placeholder deliberately excluded from
 * sync entirely (see `ensureBuiltinEnglishEntry`'s doc). Every write
 * path that touches a pack body (`savePack`/`renamePack`/`deletePack`)
 * routes through this instead of calling `notifyChange(packSyncUnit(id))`
 * directly, so the exclusion can't be missed at a new call site.
 */
export function notifyPackChange(id: string): void {
  if (id === BUILTIN_ENGLISH_PACK_ID) return
  notifyChange(packSyncUnit(id))
}

export function nowIso(): string {
  return new Date().toISOString()
}

// --- Write serialization ------------------------------------------------------
//
// Every whole-index read-modify-write path (ensure/save/rename/
// setEnabled/delete/setHubPostId/reorder/purge) shares one promise
// chain so a concurrent pair can't each read a stale snapshot and
// clobber the other's write — mirrors `sync/keyboard-meta.ts`'s
// `withMetaWriteLock` precedent. Scoped to this store only; Key Labels
// has the same pre-existing gap (see the module report, not fixed
// here). Theme Packs used to share this gap too but now has its own
// equivalent lock across all mutation methods (`theme-pack-store.ts`'s
// `withIndexWriteLock`) — that store gained a real second writer
// (remote sync) once its index-merge landed, so its own lock could no
// longer stay scoped to only the two sync entry points.
let indexWriteChain: Promise<unknown> = Promise.resolve()

export async function withIndexWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = indexWriteChain.then(() => fn(), () => fn())
  indexWriteChain = next.catch(() => undefined)
  return next
}

/** Write `content` to `path` via a temp-file-then-rename so a reader can
 *  never observe a torn (partially-written) file — a plain `writeFile`
 *  racing a concurrent read is how `readIndex`'s parse-failure fallback
 *  (`{ metas: [] }`) could otherwise get persisted right over a real
 *  roster by a subsequent read-modify-write. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, path)
}

// --- Result type -------------------------------------------------------------

export type I18nPackStoreErrorCode = SharedErrorCode
export type I18nPackStoreResult<T> = SharedResult<T>

export function ok<T>(data?: T): I18nPackStoreResult<T> {
  return { success: true, data }
}

export function fail<T>(errorCode: I18nPackStoreErrorCode, error: string): I18nPackStoreResult<T> {
  return { success: false, errorCode, error }
}

// --- Index I/O ---------------------------------------------------------------

// Exported (in addition to internal use throughout the split) so
// `mergePackIndexBundle` (pack-bundle-merge.ts) can read the current
// local index for its LWW comparison without pack-bundle-merge.ts
// knowing this store's on-disk path — same parse-failure-tolerant
// fallback (`{ metas: [] }`) callers relied on before.
export async function readIndex(): Promise<I18nPackIndex> {
  try {
    const raw = await readFile(getIndexPath(), 'utf-8')
    const parsed = JSON.parse(raw) as I18nPackIndex
    if (Array.isArray(parsed?.metas)) return parsed
  } catch {
    // missing / corrupt — return empty
  }
  return { metas: [] }
}

// Routed through writeFileAtomic (temp-file-then-rename) — the sync merge
// path (mergeSyncedIndex, i18n-pack-store-sync.ts) already wrote atomically;
// this local read-modify-write path (save/rename/setEnabled/delete/
// setHubPostId/reorder/purge) did not, leaving a crash-during-write window
// where a reader (including this same store's own readIndexForGc) could
// observe a torn file and mistake it for a corrupt index.
export async function writeIndex(index: I18nPackIndex): Promise<void> {
  await mkdir(getStoreDir(), { recursive: true })
  await writeFileAtomic(getIndexPath(), JSON.stringify(index, null, 2))
}

export function findActiveByName(metas: I18nPackMeta[], name: string, excludeId?: string): I18nPackMeta | undefined {
  const target = name.trim().toLowerCase()
  return metas.find((m) => !m.deletedAt && m.id !== excludeId && m.name.trim().toLowerCase() === target)
}

/** Three-state precedence used by `savePack` for every optional meta field
 *  the caller can either set, clear, or inherit:
 *    - `null`        → explicit clear (drop the existing value)
 *    - other value   → adopt the new value
 *    - `undefined`   → inherit `existing` (no change)
 *  Pulling this out keeps the savePack body declarative and prevents the
 *  three-branch pattern from being re-derived per field. */
export function resolveOptionalField<T>(input: T | null | undefined, existing: T | undefined): T | undefined {
  if (input === null) return undefined
  if (input !== undefined) return input
  return existing
}

// --- Test-only helpers -------------------------------------------------------

export const __testing = {
  getStoreDir,
  getPacksDir,
  getIndexPath,
  getPackPath,
  readIndex,
  writeIndex,
  packSyncUnit,
}
