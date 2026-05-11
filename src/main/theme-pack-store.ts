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
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { notifyChange } from './sync/sync-service'
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

async function readIndex(): Promise<ThemePackIndex> {
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
  const index = await readIndex()
  const result = await purgeExpiredTombstonesInPlace(index)
  if (result.touched) {
    await writeIndex(index)
    notifyChange(THEME_INDEX_SYNC_UNIT)
  }
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
}): Promise<ThemePackStoreResult<ThemePackMeta>> {
  const validation = validateThemePack(input.raw)
  if (!validation.ok || !validation.header) {
    return fail('INVALID_FILE', validation.errors.join('; '))
  }
  const { name, version } = validation.header

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
    const nextHubPostId = resolveOptionalField(input.hubPostId, existing?.hubPostId)
    const nextHubUpdatedAt = resolveOptionalField(hubUpdatedAtInput, existing?.hubUpdatedAt)
    const meta: ThemePackMeta = {
      id,
      filename: `${PACKS_DIRNAME}/${id}.json`,
      name,
      version,
      ...(nextHubPostId ? { hubPostId: nextHubPostId } : {}),
      ...(nextHubUpdatedAt ? { hubUpdatedAt: nextHubUpdatedAt } : {}),
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
}

export async function renamePack(id: string, newName: string): Promise<ThemePackStoreResult<ThemePackMeta>> {
  const trimmed = typeof newName === 'string' ? newName.trim() : ''
  if (!trimmed) return fail('INVALID_NAME', 'Name must not be empty')
  if (trimmed.length > THEME_PACK_LIMITS.MAX_NAME_LENGTH) return fail('INVALID_NAME', `Name must be at most ${THEME_PACK_LIMITS.MAX_NAME_LENGTH} characters`)

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
}

export async function deletePack(id: string): Promise<ThemePackStoreResult<void>> {
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
}

export async function setHubPostId(
  id: string,
  hubPostId: string | null,
): Promise<ThemePackStoreResult<ThemePackMeta>> {
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
    meta.updatedAt = nowIso()
    await writeIndex(index)
    notifyChange(THEME_INDEX_SYNC_UNIT)
    return ok(meta)
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export async function hasActiveName(name: string, excludeId?: string): Promise<ThemePackStoreResult<boolean>> {
  try {
    const index = await readIndex()
    return ok(Boolean(findActiveByName(index.metas, name, excludeId)))
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
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
