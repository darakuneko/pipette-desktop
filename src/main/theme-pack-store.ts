// SPDX-License-Identifier: GPL-2.0-or-later
//
// Local store for user-imported theme packs.
//
// Layout (under userData):
//   sync/themes/index.json                   — ThemePackIndex (LWW + tombstone, drag order)
//   sync/themes/packs/{packId}.json          — ThemePackEntryFile (pack JSON verbatim)
//
// Uses two sync unit families: `themes/index` for the index and
// `themes/packs/{packId}` for each pack body. notifyChange is split
// accordingly so a single pack edit does not bump every other pack's
// remote LWW timestamp.

import { app, dialog, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { notifyChange } from './sync/sync-service'
import { gcTombstones, mergeEntries, MalformedSyncBundleError } from './sync/merge'
import { log } from './logger'
import { safeFilename } from './utils/safe-filename'
import { validateThemePack } from '../shared/theme/validate'
import {
  THEME_INDEX_SYNC_UNIT,
  THEME_PACK_TOMBSTONE_TTL_MS,
  THEME_PACK_LIMITS,
  type ThemePackIndex,
  type ThemePackMeta,
  type ThemePackRecord,
  type ThemePackStoreErrorCode as SharedErrorCode,
  type ThemePackStoreResult as SharedResult,
  type ThemePackEntryFile,
} from '../shared/types/theme-store'

export type { ThemePackRecord }

const STORE_DIRNAME = 'themes'
const PACKS_DIRNAME = 'packs'
const INDEX_FILENAME = 'index.json'

// --- Path helpers ------------------------------------------------------------

function getStoreDir(): string {
  return join(app.getPath('userData'), 'sync', STORE_DIRNAME)
}

function getPacksDir(): string {
  return join(getStoreDir(), PACKS_DIRNAME)
}

function getIndexPath(): string {
  return join(getStoreDir(), INDEX_FILENAME)
}

function isSafePackId(id: string): boolean {
  // UUID-like form. Reject anything that could escape the packs dir.
  return /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

/** True when `m` is at least shaped enough to read `.id` off of safely —
 *  a non-null object with a string `id` field. Guards `mergeSyncedIndex`'s
 *  per-entry filter against a remote `metas` array containing `null` or
 *  other non-object garbage (attacker-reachable data). */
function isPackMetaCandidate(m: unknown): m is ThemePackMeta {
  return typeof m === 'object' && m !== null && typeof (m as { id?: unknown }).id === 'string'
}

function getPackPath(packId: string): string {
  if (!isSafePackId(packId)) throw new Error(`Invalid packId: ${packId}`)
  return join(getPacksDir(), `${packId}.json`)
}

function packSyncUnit(packId: string): `themes/packs/${string}` {
  return `themes/packs/${packId}`
}

function nowIso(): string {
  return new Date().toISOString()
}

// --- Write serialization ------------------------------------------------------
//
// Every whole-index read-modify-write path (save/rename/delete/
// setHubPostId/reorder/purge) shares one promise chain so a concurrent
// pair can't each read a stale snapshot and clobber the other's write —
// mirrors `i18n-pack-store.ts`'s `withIndexWriteLock` (itself mirroring
// `sync/keyboard-meta.ts`'s `withMetaWriteLock`). This store used to
// scope the lock to only the two sync entry points below
// (applySyncedIndex/applySyncedPackBody) on the theory that its other
// mutation methods had no real second writer to race — but the
// index-merge landed (mergeSyncedIndex below), which makes remote sync
// a genuine concurrent writer of `themes/index.json`, so every method
// that reads-then-writes the index needs the same lock the sync entry
// points already had.
let indexWriteChain: Promise<unknown> = Promise.resolve()

async function withIndexWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = indexWriteChain.then(() => fn(), () => fn())
  indexWriteChain = next.catch(() => undefined)
  return next
}

/** Write `content` to `path` via a temp-file-then-rename so a reader can
 *  never observe a torn (partially-written) file. See the i18n-pack-store
 *  equivalent for the full rationale. */
async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmpPath = `${path}.tmp`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, path)
}

// --- Sync entry points (pack-bundle-merge.ts) --------------------------------
//
// See i18n-pack-store.ts's equivalent section doc for the full
// rationale (isSafePackId at the least-trusted boundary, atomic write,
// lock-scoped serialization) — mirrored here for themes.

/** Entry-level LWW merge + persist for a synced remote index. See
 *  i18n-pack-store.ts's `mergeSyncedIndex` for the full rationale
 *  (replaces whole-file "remote newer wholesale-replaces local", closes
 *  the outside-lock TOCTOU, filters/rederives unsafe metas before they
 *  can reach `collectAllSyncUnits`/`bundleSyncUnit`'s generic tail) —
 *  identical here for themes, just without a built-in-entry special
 *  case (themes has none).
 *
 *  `remoteMetas` is typed `unknown[]` (not `ThemePackMeta[]`) since it's
 *  attacker-reachable remote data — `isPackMetaCandidate` drops any
 *  non-object entry (e.g. `null`) the same way as a rejected id, via the
 *  same unit-name-only warn path, rather than crashing on `m.id`. A
 *  non-array `metas` field is a stronger malformation, rejected one
 *  layer up by `mergePackIndexBundle` (pack-bundle-merge.ts) before this
 *  function is ever called.
 *
 *  Returns `applied: false` (never throws) only on an I/O failure
 *  persisting the merged index. */
export async function mergeSyncedIndex(
  remoteMetas: readonly unknown[],
): Promise<{ applied: boolean; remoteNeedsUpdate: boolean }> {
  return withIndexWriteLock(async () => {
    try {
      const localIndex = await readIndex()
      const rejectedCount = remoteMetas.filter((m) => !isPackMetaCandidate(m) || !isSafePackId(m.id)).length
      if (rejectedCount > 0) {
        log('warn', `sync: dropped ${rejectedCount} unsafe remote meta id(s) for ${THEME_INDEX_SYNC_UNIT}`)
      }
      const safeRemoteMetas = remoteMetas
        .filter((m): m is ThemePackMeta => isPackMetaCandidate(m) && isSafePackId(m.id))
        .map((m) => ({ ...m, filename: `${PACKS_DIRNAME}/${m.id}.json` }))
      const localMetas = gcTombstones(localIndex.metas)
      const remoteMetasGced = gcTombstones(safeRemoteMetas)
      const result = mergeEntries(localMetas, remoteMetasGced, { preserveLocalOrder: true })
      await mkdir(getStoreDir(), { recursive: true })
      await writeFileAtomic(getIndexPath(), JSON.stringify({ metas: result.entries }, null, 2))
      return { applied: true, remoteNeedsUpdate: result.remoteNeedsUpdate }
    } catch {
      return { applied: false, remoteNeedsUpdate: false }
    }
  })
}

/** Local mtime (ms) of a pack body file, or `null` when `packId` is
 *  unsafe or the file doesn't exist yet. */
export async function statLocalPackMtime(packId: string): Promise<number | null> {
  if (!isSafePackId(packId)) return null
  try {
    const stats = await stat(getPackPath(packId))
    return stats.mtime.getTime()
  } catch {
    return null
  }
}

/** Outcome of `applySyncedPackBody` — see i18n-pack-store.ts's
 *  `ApplyPackBodyOutcome` for the full contract each state carries. */
export type ApplyPackBodyOutcome = 'applied' | 'local-wins' | 'io-error'

/** Apply an already-LWW-won remote pack body, pinning its mtime to the
 *  remote's own `modifiedTime` so the next LWW comparison sees the two
 *  sides as equal instead of re-uploading the just-downloaded copy
 *  forever. Throws `MalformedSyncBundleError` for an unsafe `packId`
 *  (so the sync poll stops retrying a permanently-rejected revision
 *  instead of treating it like a transient failure) and re-checks local
 *  mtime under the lock immediately before writing (CAS) so a
 *  concurrent local save can't be clobbered by a stale remote-wins
 *  decision made outside the lock. See i18n-pack-store.ts's equivalent
 *  for the full rationale — identical here for themes, including the
 *  mtime pin being a SEPARATE try/catch from the body write: a utimes
 *  failure after a successful write is logged as a unit-name-only warn
 *  and still reported `'applied'` (a redundant future re-upload beats
 *  failing the unit and re-entering the clock-skew loop). Returns
 *  `'io-error'` (never throws for this case) on any other I/O
 *  failure. */
export async function applySyncedPackBody(
  packId: string,
  rawJson: string,
  remoteModifiedTime: string,
): Promise<ApplyPackBodyOutcome> {
  if (!isSafePackId(packId)) {
    throw new MalformedSyncBundleError(packSyncUnit(packId))
  }
  return withIndexWriteLock(async () => {
    try {
      const path = getPackPath(packId)
      const modMs = new Date(remoteModifiedTime).getTime()
      if (!Number.isNaN(modMs)) {
        try {
          const currentStat = await stat(path)
          if (currentStat.mtime.getTime() >= modMs) return 'local-wins'
        } catch {
          // no local file yet — nothing to race against, proceed
        }
      }
      await mkdir(getPacksDir(), { recursive: true })
      await writeFileAtomic(path, rawJson)
      if (!Number.isNaN(modMs)) {
        try {
          const pinned = new Date(modMs)
          await utimes(path, pinned, pinned)
        } catch {
          log('warn', `sync: failed to pin mtime for ${packSyncUnit(packId)} after apply`)
        }
      }
      return 'applied'
    } catch {
      return 'io-error'
    }
  })
}

/** Pin a pack body file's mtime to the Drive `modifiedTime` a
 *  just-completed local-wins upload was assigned. See
 *  i18n-pack-store.ts's equivalent for the full clock-skew rationale,
 *  including the `expectedLocalMtimeMs` compare-and-swap guard: the
 *  caller snapshots the local mtime before bundling/uploading (outside
 *  this store's lock), and this function only pins if the file's
 *  current mtime still matches that snapshot when the lock is finally
 *  acquired — otherwise a concurrent local save's fresh content would
 *  get stamped with this stale upload's Drive time, and the new edit
 *  would never get re-uploaded (the next LWW compares as a tie). `null`
 *  means the caller had no snapshot to compare, so this skips rather
 *  than guessing. Best-effort beyond the CAS check: swallows any I/O
 *  error (stat or utimes) with a unit-name-only warn. */
export async function pinPackBodyMtime(
  packId: string,
  modifiedTime: string,
  expectedLocalMtimeMs: number | null,
): Promise<void> {
  if (!isSafePackId(packId)) return
  await withIndexWriteLock(async () => {
    const modMs = new Date(modifiedTime).getTime()
    if (Number.isNaN(modMs)) return
    if (expectedLocalMtimeMs === null) {
      log('debug', `sync: skipped mtime pin for ${packSyncUnit(packId)} — no local snapshot to compare`)
      return
    }
    try {
      const path = getPackPath(packId)
      const currentStat = await stat(path)
      if (currentStat.mtime.getTime() !== expectedLocalMtimeMs) {
        log('debug', `sync: skipped mtime pin for ${packSyncUnit(packId)} — local file changed since upload snapshot`)
        return
      }
      const pinned = new Date(modMs)
      await utimes(path, pinned, pinned)
    } catch {
      log('warn', `sync: failed to pin mtime for ${packSyncUnit(packId)} after upload`)
    }
  })
}

// --- Result type -------------------------------------------------------------

export type ThemePackStoreErrorCode = SharedErrorCode
export type ThemePackStoreResult<T> = SharedResult<T>

function ok<T>(data?: T): ThemePackStoreResult<T> {
  return { success: true, data }
}

function fail<T>(errorCode: ThemePackStoreErrorCode, error: string): ThemePackStoreResult<T> {
  return { success: false, errorCode, error }
}

// --- Index I/O ---------------------------------------------------------------

// Exported so `mergePackIndexBundle` (pack-bundle-merge.ts) can read the
// current local index for its LWW comparison — see the i18n-pack-store
// equivalent's doc.
export async function readIndex(): Promise<ThemePackIndex> {
  try {
    const raw = await readFile(getIndexPath(), 'utf-8')
    const parsed = JSON.parse(raw) as ThemePackIndex
    if (Array.isArray(parsed?.metas)) return parsed
  } catch {
    // missing / corrupt — return empty
  }
  return { metas: [] }
}

async function writeIndex(index: ThemePackIndex): Promise<void> {
  await mkdir(getStoreDir(), { recursive: true })
  await writeFile(getIndexPath(), JSON.stringify(index, null, 2), 'utf-8')
}

function findActiveByName(metas: ThemePackMeta[], name: string, excludeId?: string): ThemePackMeta | undefined {
  const target = name.trim().toLowerCase()
  return metas.find((m) => !m.deletedAt && m.id !== excludeId && m.name.trim().toLowerCase() === target)
}

/** Three-state precedence used by `savePack` for every optional meta field
 *  the caller can either set, clear, or inherit:
 *    - `null`        → explicit clear (drop the existing value)
 *    - other value   → adopt the new value
 *    - `undefined`   → inherit `existing` (no change)
 */
function resolveOptionalField<T>(input: T | null | undefined, existing: T | undefined): T | undefined {
  if (input === null) return undefined
  if (input !== undefined) return input
  return existing
}

// --- GC: purge tombstones older than the TTL --------------------------------

async function purgeExpiredTombstonesInPlace(index: ThemePackIndex): Promise<{ removed: number; touched: boolean }> {
  const cutoff = Date.now() - THEME_PACK_TOMBSTONE_TTL_MS
  const kept: ThemePackMeta[] = []
  let removed = 0
  for (const meta of index.metas) {
    if (meta.deletedAt && new Date(meta.deletedAt).getTime() < cutoff) {
      removed += 1
      // Best-effort delete the pack body — the meta itself is dropped.
      try { await unlink(getPackPath(meta.id)) } catch { /* swallow */ }
      continue
    }
    kept.push(meta)
  }
  if (removed === 0) return { removed: 0, touched: false }
  index.metas = kept
  return { removed, touched: true }
}

export async function purgeExpiredTombstones(): Promise<void> {
  return withIndexWriteLock(async () => {
    const index = await readIndex()
    const result = await purgeExpiredTombstonesInPlace(index)
    if (result.touched) {
      await writeIndex(index)
      notifyChange(THEME_INDEX_SYNC_UNIT)
    }
  })
}

// --- Public API --------------------------------------------------------------

export async function listMetas(): Promise<ThemePackMeta[]> {
  const index = await readIndex()
  return index.metas.filter((m) => !m.deletedAt)
}

export async function listAllMetas(): Promise<ThemePackMeta[]> {
  const index = await readIndex()
  return index.metas
}

export async function getPack(id: string): Promise<ThemePackStoreResult<ThemePackRecord>> {
  if (!isSafePackId(id)) return fail('NOT_FOUND', 'Invalid pack id')
  try {
    const index = await readIndex()
    const meta = index.metas.find((m) => m.id === id)
    if (!meta || meta.deletedAt) return fail('NOT_FOUND', 'Theme pack not found')
    const raw = await readFile(getPackPath(id), 'utf-8')
    const pack = JSON.parse(raw) as ThemePackEntryFile
    return ok({ meta, pack })
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export async function savePack(input: {
  raw: unknown
  id?: string
  hubPostId?: string | null
  hubUpdatedAt?: string | null
  /** Hub-side `uploader_name`. Same three-state semantics as `hubUpdatedAt`. */
  uploaderName?: string | null
}): Promise<ThemePackStoreResult<ThemePackMeta>> {
  const validation = validateThemePack(input.raw)
  if (!validation.ok || !validation.header) {
    return fail('INVALID_FILE', validation.errors.join('; '))
  }
  const { name, version } = validation.header

  return withIndexWriteLock(async () => {
    try {
      const index = await readIndex()
      // Auto-overwrite path: if the caller did not specify an id but
      // an active entry already shares this name (case-insensitive),
      // adopt that entry's id so the import replaces the existing pack
      // instead of failing with DUPLICATE_NAME. Mirrors KeyLabels.
      let resolvedId = input.id
      if (!resolvedId) {
        const existingByName = findActiveByName(index.metas, name)
        if (existingByName) resolvedId = existingByName.id
      }
      if (findActiveByName(index.metas, name, resolvedId)) {
        return fail('DUPLICATE_NAME', 'A theme pack with the same name already exists')
      }

      const id = resolvedId ?? randomUUID()
      if (!isSafePackId(id)) return fail('INVALID_FILE', 'Generated pack id is unsafe')

      await mkdir(getPacksDir(), { recursive: true })
      await writeFile(getPackPath(id), JSON.stringify(input.raw, null, 2), 'utf-8')

      const now = nowIso()
      const existing = index.metas.find((m) => m.id === id)
      // hubUpdatedAt: empty/whitespace string is treated the same as null
      // (explicit clear) so a stray '' from a Hub response never persists.
      const hubUpdatedAtInput = typeof input.hubUpdatedAt === 'string'
        ? (input.hubUpdatedAt.trim() || null)
        : input.hubUpdatedAt
      const uploaderNameInput = typeof input.uploaderName === 'string'
        ? (input.uploaderName.trim() || null)
        : input.uploaderName
      const nextHubPostId = resolveOptionalField(input.hubPostId, existing?.hubPostId)
      const nextHubUpdatedAt = resolveOptionalField(hubUpdatedAtInput, existing?.hubUpdatedAt)
      const nextUploaderName = resolveOptionalField(uploaderNameInput, existing?.uploaderName)
      const meta: ThemePackMeta = {
        id,
        filename: `${PACKS_DIRNAME}/${id}.json`,
        name,
        version,
        ...(nextHubPostId ? { hubPostId: nextHubPostId } : {}),
        ...(nextHubUpdatedAt ? { hubUpdatedAt: nextHubUpdatedAt } : {}),
        ...(nextUploaderName ? { uploaderName: nextUploaderName } : {}),
        savedAt: existing?.savedAt ?? now,
        updatedAt: now,
      }

      const existingIndex = index.metas.findIndex((m) => m.id === id)
      if (existingIndex >= 0) {
        index.metas[existingIndex] = meta
      } else {
        index.metas.push(meta)
      }
      await writeIndex(index)

      notifyChange(packSyncUnit(id))
      notifyChange(THEME_INDEX_SYNC_UNIT)
      return ok(meta)
    } catch (err) {
      return fail('IO_ERROR', String(err))
    }
  })
}

export async function renamePack(id: string, newName: string): Promise<ThemePackStoreResult<ThemePackMeta>> {
  const trimmed = typeof newName === 'string' ? newName.trim() : ''
  if (!trimmed) return fail('INVALID_NAME', 'Name must not be empty')
  if (trimmed.length > THEME_PACK_LIMITS.MAX_NAME_LENGTH) return fail('INVALID_NAME', `Name must be at most ${THEME_PACK_LIMITS.MAX_NAME_LENGTH} characters`)

  return withIndexWriteLock(async () => {
    try {
      const index = await readIndex()
      const meta = index.metas.find((m) => m.id === id && !m.deletedAt)
      if (!meta) return fail('NOT_FOUND', 'Theme pack not found')
      if (findActiveByName(index.metas, trimmed, id)) {
        return fail('DUPLICATE_NAME', 'A theme pack with the same name already exists')
      }

      // Rewrite the pack body so the on-disk JSON's `name` mirrors meta.
      const path = getPackPath(id)
      const raw = await readFile(path, 'utf-8')
      const pack = JSON.parse(raw) as Record<string, unknown>
      pack.name = trimmed
      await writeFile(path, JSON.stringify(pack, null, 2), 'utf-8')

      meta.name = trimmed
      meta.updatedAt = nowIso()
      await writeIndex(index)

      notifyChange(packSyncUnit(id))
      notifyChange(THEME_INDEX_SYNC_UNIT)
      return ok(meta)
    } catch (err) {
      return fail('IO_ERROR', String(err))
    }
  })
}

export async function deletePack(id: string): Promise<ThemePackStoreResult<void>> {
  return withIndexWriteLock(async () => {
    try {
      const index = await readIndex()
      const meta = index.metas.find((m) => m.id === id)
      if (!meta) return fail('NOT_FOUND', 'Theme pack not found')

      const now = nowIso()
      meta.deletedAt = now
      meta.updatedAt = now
      await writeIndex(index)

      notifyChange(packSyncUnit(id))
      notifyChange(THEME_INDEX_SYNC_UNIT)
      return ok()
    } catch (err) {
      return fail('IO_ERROR', String(err))
    }
  })
}

/** `uploaderName` / `hubUpdatedAt` mirror `key-label-store.ts`'s
 * `setHubPostId` — see the i18n-pack-store.ts equivalent for the full
 * three-state contract. */
export async function setHubPostId(
  id: string,
  hubPostId: string | null,
  uploaderName?: string | null,
  hubUpdatedAt?: string | null,
): Promise<ThemePackStoreResult<ThemePackMeta>> {
  return withIndexWriteLock(async () => {
    try {
      const index = await readIndex()
      const meta = index.metas.find((m) => m.id === id)
      if (!meta) return fail('NOT_FOUND', 'Theme pack not found')
      const normalized = hubPostId?.trim() || null
      if (normalized === null) {
        delete meta.hubPostId
        // hubUpdatedAt is meaningless once detached from Hub; drop it so a
        // future re-link gets a fresh round-trip rather than comparing
        // against a stale cached timestamp.
        delete meta.hubUpdatedAt
      } else {
        meta.hubPostId = normalized
      }
      if (uploaderName !== undefined) {
        const trimmed = uploaderName?.trim() ?? ''
        if (trimmed) {
          meta.uploaderName = trimmed
        } else {
          delete meta.uploaderName
        }
      }
      if (hubUpdatedAt !== undefined) {
        const trimmed = hubUpdatedAt?.trim() ?? ''
        if (trimmed) {
          meta.hubUpdatedAt = trimmed
        } else {
          delete meta.hubUpdatedAt
        }
      }
      meta.updatedAt = nowIso()
      await writeIndex(index)
      notifyChange(THEME_INDEX_SYNC_UNIT)
      return ok(meta)
    } catch (err) {
      return fail('IO_ERROR', String(err))
    }
  })
}

export async function hasActiveName(name: string, excludeId?: string): Promise<ThemePackStoreResult<boolean>> {
  try {
    const index = await readIndex()
    return ok(Boolean(findActiveByName(index.metas, name, excludeId)))
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

/**
 * Apply a manual order to the active metas. Mirrors
 * `key-label-store.ts`'s `reorderActive`: tombstones and any ids not
 * listed in `orderedIds` keep their relative position behind the
 * sorted prefix, so a stale renderer view never silently drops an
 * entry. Only the index changes — pack bodies are untouched — so only
 * `THEME_INDEX_SYNC_UNIT` is bumped, matching `setHubPostId`.
 *
 * Like `key-labels`, `themes/index` now has entry-level LWW merge wired
 * into `sync-service.ts` (`mergeSyncedIndex`, with `preserveLocalOrder`
 * so drag/Name-sort order survives the merge) — a remote index
 * downloaded during sync merges against this reordered one instead of
 * one side replacing the other wholesale.
 */
export async function reorderActive(orderedIds: string[]): Promise<ThemePackStoreResult<void>> {
  return withIndexWriteLock(async () => {
    try {
      const index = await readIndex()
      const byId = new Map<string, ThemePackMeta>()
      for (const meta of index.metas) byId.set(meta.id, meta)

      const seen = new Set<string>()
      const reordered: ThemePackMeta[] = []
      const now = nowIso()
      for (const id of orderedIds) {
        const meta = byId.get(id)
        if (!meta || meta.deletedAt || seen.has(id)) continue
        meta.updatedAt = now
        reordered.push(meta)
        seen.add(id)
      }

      for (const meta of index.metas) {
        if (seen.has(meta.id)) continue
        reordered.push(meta)
      }

      await writeIndex({ metas: reordered })
      notifyChange(THEME_INDEX_SYNC_UNIT)
      return ok()
    } catch (err) {
      return fail('IO_ERROR', String(err))
    }
  })
}

export async function exportPackToDialog(
  win: BrowserWindow,
  id: string,
): Promise<ThemePackStoreResult<{ filePath: string }>> {
  const record = await getPack(id)
  if (!record.success || !record.data) {
    return { success: false, errorCode: 'NOT_FOUND', error: record.error ?? 'Theme pack not found' }
  }
  const safeName = safeFilename(record.data.meta.name, 'theme-pack')
  try {
    const result = await dialog.showSaveDialog(win, {
      title: 'Export Theme Pack',
      defaultPath: `theme-packs-${safeName}.json`,
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePath) {
      return { success: false, errorCode: 'IO_ERROR', error: 'cancelled' }
    }
    await writeFile(result.filePath, JSON.stringify(record.data.pack, null, 2), 'utf-8')
    return { success: true, data: { filePath: result.filePath } }
  } catch (err) {
    return { success: false, errorCode: 'IO_ERROR', error: String(err) }
  }
}

/** Wipe all theme pack data from disk. Called by the Local Reset flow. */
export async function resetAllThemePacks(): Promise<void> {
  await rm(getStoreDir(), { recursive: true, force: true })
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
