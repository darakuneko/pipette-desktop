// SPDX-License-Identifier: GPL-2.0-or-later
//
// Local store for user-imported i18n language packs.
//
// Layout (under userData):
//   sync/i18n/index.json                    — I18nPackIndex (LWW + tombstone, drag order)
//   sync/i18n/packs/{packId}.json           — I18nPackEntryFile.raw (pack JSON verbatim)
//
// Unlike `key-labels` (one sync unit covering both index + files), i18n
// uses two sync unit families: `i18n/index` for the index and
// `i18n/packs/{packId}` for each pack body. notifyChange is split
// accordingly so a single pack edit does not bump every other pack's
// remote LWW timestamp.

import { app, dialog, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { notifyChange } from './sync/sync-service'
import { safeFilename } from './utils/safe-filename'
import {
  I18N_INDEX_SYNC_UNIT,
  I18N_PACK_TOMBSTONE_TTL_MS,
  type I18nPackIndex,
  type I18nPackMeta,
  type I18nPackRecord,
  type I18nPackStoreErrorCode as SharedErrorCode,
  type I18nPackStoreResult as SharedResult,
} from '../shared/types/i18n-store'

export type { I18nPackRecord }

const STORE_DIRNAME = 'i18n'
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

function packSyncUnit(packId: string): `i18n/packs/${string}` {
  return `i18n/packs/${packId}`
}

function nowIso(): string {
  return new Date().toISOString()
}

// --- Result type -------------------------------------------------------------

export type I18nPackStoreErrorCode = SharedErrorCode
export type I18nPackStoreResult<T> = SharedResult<T>

function ok<T>(data?: T): I18nPackStoreResult<T> {
  return { success: true, data }
}

function fail<T>(errorCode: I18nPackStoreErrorCode, error: string): I18nPackStoreResult<T> {
  return { success: false, errorCode, error }
}

// --- Index I/O ---------------------------------------------------------------

async function readIndex(): Promise<I18nPackIndex> {
  try {
    const raw = await readFile(getIndexPath(), 'utf-8')
    const parsed = JSON.parse(raw) as I18nPackIndex
    if (Array.isArray(parsed?.metas)) return parsed
  } catch {
    // missing / corrupt — return empty
  }
  return { metas: [] }
}

async function writeIndex(index: I18nPackIndex): Promise<void> {
  await mkdir(getStoreDir(), { recursive: true })
  await writeFile(getIndexPath(), JSON.stringify(index, null, 2), 'utf-8')
}

function findActiveByName(metas: I18nPackMeta[], name: string, excludeId?: string): I18nPackMeta | undefined {
  const target = name.trim().toLowerCase()
  return metas.find((m) => !m.deletedAt && m.id !== excludeId && m.name.trim().toLowerCase() === target)
}

// --- GC: purge tombstones older than the TTL --------------------------------

async function purgeExpiredTombstonesInPlace(index: I18nPackIndex): Promise<{ removed: number; touched: boolean }> {
  const cutoff = Date.now() - I18N_PACK_TOMBSTONE_TTL_MS
  const kept: I18nPackMeta[] = []
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

export async function purgeExpiredTombstones(): Promise<number> {
  const index = await readIndex()
  const result = await purgeExpiredTombstonesInPlace(index)
  if (result.touched) {
    await writeIndex(index)
    notifyChange(I18N_INDEX_SYNC_UNIT)
  }
  return result.removed
}

// --- Public API --------------------------------------------------------------

export async function listMetas(): Promise<I18nPackMeta[]> {
  const index = await readIndex()
  return index.metas.filter((m) => !m.deletedAt)
}

export async function listAllMetas(): Promise<I18nPackMeta[]> {
  const index = await readIndex()
  return index.metas
}

export async function getPack(id: string): Promise<I18nPackStoreResult<I18nPackRecord>> {
  if (!isSafePackId(id)) return fail('NOT_FOUND', 'Invalid pack id')
  try {
    const index = await readIndex()
    const meta = index.metas.find((m) => m.id === id)
    if (!meta || meta.deletedAt) return fail('NOT_FOUND', 'Language pack not found')
    const raw = await readFile(getPackPath(id), 'utf-8')
    const pack: unknown = JSON.parse(raw)
    return ok({ meta, pack })
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export interface SavePackInput {
  /** Use when overwriting an existing pack — preserves enabled / hubPostId. */
  id?: string
  /** Pack JSON body (with name, version + translations at top level). */
  pack: unknown
  /** Defaults to true on first import. */
  enabled?: boolean
  hubPostId?: string | null
  appVersionAtImport?: string
}

interface PackHeader {
  name: string
  version: string
}

function extractHeader(pack: unknown): PackHeader | null {
  if (!pack || typeof pack !== 'object') return null
  const obj = pack as Record<string, unknown>
  if (typeof obj.name !== 'string' || !obj.name.trim()) return null
  if (typeof obj.version !== 'string' || !obj.version.trim()) return null
  return { name: obj.name.trim(), version: obj.version.trim() }
}

export async function savePack(input: SavePackInput): Promise<I18nPackStoreResult<I18nPackMeta>> {
  const header = extractHeader(input.pack)
  if (!header) return fail('INVALID_FILE', 'Pack JSON missing required name/version fields')

  try {
    const index = await readIndex()
    if (findActiveByName(index.metas, header.name, input.id)) {
      return fail('DUPLICATE_NAME', 'A language pack with the same name already exists')
    }

    const id = input.id ?? randomUUID()
    if (!isSafePackId(id)) return fail('INVALID_FILE', 'Generated pack id is unsafe')

    await mkdir(getPacksDir(), { recursive: true })
    await writeFile(getPackPath(id), JSON.stringify(input.pack, null, 2), 'utf-8')

    const now = nowIso()
    const existing = index.metas.find((m) => m.id === id)
    // hubPostId precedence: caller's null = explicit detach, caller's
    // string = adopt, omitted = inherit existing entry.
    let nextHubPostId: string | undefined
    if (input.hubPostId === null) nextHubPostId = undefined
    else if (typeof input.hubPostId === 'string') nextHubPostId = input.hubPostId
    else nextHubPostId = existing?.hubPostId
    const meta: I18nPackMeta = {
      id,
      filename: `${PACKS_DIRNAME}/${id}.json`,
      name: header.name,
      version: header.version,
      enabled: input.enabled ?? existing?.enabled ?? true,
      hubPostId: nextHubPostId,
      savedAt: existing?.savedAt ?? now,
      updatedAt: now,
      ...(input.appVersionAtImport ? { appVersionAtImport: input.appVersionAtImport } : {}),
    }

    const existingIndex = index.metas.findIndex((m) => m.id === id)
    if (existingIndex >= 0) {
      index.metas[existingIndex] = meta
    } else {
      index.metas.push(meta)
    }
    await writeIndex(index)

    notifyChange(packSyncUnit(id))
    notifyChange(I18N_INDEX_SYNC_UNIT)
    return ok(meta)
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export async function renamePack(id: string, newName: string): Promise<I18nPackStoreResult<I18nPackMeta>> {
  const trimmed = typeof newName === 'string' ? newName.trim() : ''
  if (!trimmed) return fail('INVALID_NAME', 'Name must not be empty')
  if (trimmed.length > 64) return fail('INVALID_NAME', 'Name must be at most 64 characters')

  try {
    const index = await readIndex()
    const meta = index.metas.find((m) => m.id === id && !m.deletedAt)
    if (!meta) return fail('NOT_FOUND', 'Language pack not found')
    if (findActiveByName(index.metas, trimmed, id)) {
      return fail('DUPLICATE_NAME', 'A language pack with the same name already exists')
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
    notifyChange(I18N_INDEX_SYNC_UNIT)
    return ok(meta)
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export async function setEnabled(id: string, enabled: boolean): Promise<I18nPackStoreResult<I18nPackMeta>> {
  try {
    const index = await readIndex()
    const meta = index.metas.find((m) => m.id === id && !m.deletedAt)
    if (!meta) return fail('NOT_FOUND', 'Language pack not found')
    if (meta.enabled === enabled) return ok(meta)
    meta.enabled = enabled
    meta.updatedAt = nowIso()
    await writeIndex(index)

    notifyChange(I18N_INDEX_SYNC_UNIT)
    return ok(meta)
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export async function deletePack(id: string): Promise<I18nPackStoreResult<void>> {
  try {
    const index = await readIndex()
    const meta = index.metas.find((m) => m.id === id)
    if (!meta) return fail('NOT_FOUND', 'Language pack not found')

    const now = nowIso()
    meta.deletedAt = now
    meta.updatedAt = now
    meta.enabled = false
    await writeIndex(index)

    notifyChange(packSyncUnit(id))
    notifyChange(I18N_INDEX_SYNC_UNIT)
    return ok()
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export async function setHubPostId(
  id: string,
  hubPostId: string | null,
): Promise<I18nPackStoreResult<I18nPackMeta>> {
  try {
    const index = await readIndex()
    const meta = index.metas.find((m) => m.id === id)
    if (!meta) return fail('NOT_FOUND', 'Language pack not found')
    const normalized = hubPostId?.trim() || null
    if (normalized === null) {
      delete meta.hubPostId
    } else {
      meta.hubPostId = normalized
    }
    meta.updatedAt = nowIso()
    await writeIndex(index)
    notifyChange(I18N_INDEX_SYNC_UNIT)
    return ok(meta)
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export async function hasActiveName(name: string, excludeId?: string): Promise<boolean> {
  const index = await readIndex()
  return Boolean(findActiveByName(index.metas, name, excludeId))
}

/** Save a single pack body to a user-chosen file. The exported JSON
 * matches the on-disk pack format so a round-trip (export → import)
 * is symmetric. Caller supplies the BrowserWindow to anchor the
 * native save dialog. */
export async function exportPackToDialog(
  win: BrowserWindow,
  id: string,
): Promise<I18nPackStoreResult<{ filePath: string }>> {
  const record = await getPack(id)
  if (!record.success || !record.data) {
    return { success: false, errorCode: 'NOT_FOUND', error: record.error ?? 'Language pack not found' }
  }
  const safeName = safeFilename(record.data.meta.name, 'language-pack')
  try {
    const result = await dialog.showSaveDialog(win, {
      title: 'Export Language Pack',
      defaultPath: `i18n-packs-${safeName}.json`,
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

/** Wipe all i18n pack data from disk. Called by the Local Reset flow. */
export async function resetAllI18nPacks(): Promise<void> {
  await rm(getStoreDir(), { recursive: true, force: true })
}

/** Best-effort orphan sweep: pack files on disk without an index entry
 * are deleted. Triggered after sync downloads to keep the packs dir
 * tidy when remote tombstones are reconciled. */
export async function sweepOrphans(): Promise<number> {
  let removed = 0
  try {
    const index = await readIndex()
    const known = new Set(index.metas.map((m) => `${m.id}.json`))
    const entries = await readdir(getPacksDir())
    for (const file of entries) {
      if (!file.endsWith('.json')) continue
      if (known.has(file)) continue
      try {
        await unlink(join(getPacksDir(), file))
        removed += 1
      } catch { /* swallow */ }
    }
  } catch {
    // packs dir may not exist yet
  }
  return removed
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
