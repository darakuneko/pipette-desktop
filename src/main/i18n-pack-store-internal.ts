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
import { mkdir, readFile } from 'node:fs/promises'
import { notifyChange } from './sync/sync-service'
import { isSafePackId } from './utils/safe-filename'
import { writeFileAtomic } from './utils/write-file-atomic'
import {
  BUILTIN_ENGLISH_PACK_ID,
  type I18nPackIndex,
  type I18nPackMeta,
  type I18nPackStoreErrorCode as SharedErrorCode,
  type I18nPackStoreResult as SharedResult,
} from '../shared/types/i18n-store'
import type { ClockedEntry } from './sync/entry-clocks'
import { readPackMetas } from './sync/pack-sync'

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

/** Ids whose body never syncs: the built-in English placeholder every
 *  device creates itself (`ensureBuiltinEnglishEntry`, i18n-pack-store-crud.ts). */
export const LOCAL_ONLY_PACK_IDS: ReadonlySet<string> = new Set([BUILTIN_ENGLISH_PACK_ID])

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

// --- Write serialization ------------------------------------------------------
//
// Every whole-index read-modify-write path (ensure/save/rename/
// setEnabled/delete/setHubPostId/reorder/purge) shares one promise
// chain so a concurrent pair can't each read a stale snapshot and
// clobber the other's write — mirrors `sync/keyboard-meta.ts`'s
// `withMetaWriteLock` precedent. Scoped to this store only; Key Labels
// has the same gap (not fixed here). Theme Packs has its own
// equivalent lock across all mutation methods (`theme-pack-store.ts`'s
// `withIndexWriteLock`).
let indexWriteChain: Promise<unknown> = Promise.resolve()

export async function withIndexWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = indexWriteChain.then(() => fn(), () => fn())
  indexWriteChain = next.catch(() => undefined)
  return next
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

export type I18nPackEntry = ClockedEntry<I18nPackMeta>

export interface ClockedI18nPackIndex {
  metas: I18nPackEntry[]
}

// The index with every meta read as a v2 entry (`normalizeEntries`); a
// missing or unparseable index reads as `{ metas: [] }`.
export async function readIndex(): Promise<ClockedI18nPackIndex> {
  try {
    const raw = await readFile(getIndexPath(), 'utf-8')
    const parsed = JSON.parse(raw) as I18nPackIndex
    if (Array.isArray(parsed?.metas)) return { ...parsed, metas: await readPackMetas('i18nPacks', parsed.metas, getPackPath, LOCAL_ONLY_PACK_IDS) }
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
