// SPDX-License-Identifier: GPL-2.0-or-later
// Local store for Key Labels — mirrors favorite-store's index + per-entry layout.

import { app, dialog, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { notifyChange } from './sync/sync-service'
import type {
  KeyLabelMeta,
  KeyLabelIndex,
  KeyLabelEntryFile,
  KeyLabelRecord,
  KeyLabelStoreResult,
  KeyLabelStoreErrorCode,
} from '../shared/types/key-label-store'

export const KEY_LABEL_SYNC_UNIT = 'key-labels'
/** Stable id for the built-in QWERTY entry so renames / reorders survive sync. */
const QWERTY_ENTRY_ID = 'qwerty'
const MAX_NAME_LENGTH = 100

function getStoreDir(): string {
  return join(app.getPath('userData'), 'sync', 'key-labels')
}

function getIndexPath(): string {
  return join(getStoreDir(), 'index.json')
}

function isSafePathSegment(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..') return false
  return !/[/\\]/.test(segment)
}

function getEntryPath(filename: string): string {
  if (!isSafePathSegment(filename)) throw new Error('Invalid filename')
  return join(getStoreDir(), filename)
}

function fail<T>(errorCode: KeyLabelStoreErrorCode, error: string): KeyLabelStoreResult<T> {
  return { success: false, errorCode, error }
}

function ok<T>(data?: T): KeyLabelStoreResult<T> {
  return { success: true, data }
}

function nowIso(): string {
  return new Date().toISOString()
}

function tsForFilename(now: Date = new Date()): string {
  return now.toISOString().replace(/:/g, '-')
}

async function readIndex(): Promise<KeyLabelIndex> {
  try {
    const raw = await readFile(getIndexPath(), 'utf-8')
    const parsed = JSON.parse(raw) as KeyLabelIndex
    if (Array.isArray(parsed?.entries)) return parsed
  } catch {
    // missing / corrupt — return empty
  }
  return { entries: [] }
}

async function writeIndex(index: KeyLabelIndex): Promise<void> {
  await mkdir(getStoreDir(), { recursive: true })
  await writeFile(getIndexPath(), JSON.stringify(index, null, 2), 'utf-8')
}

function findActiveByName(entries: KeyLabelMeta[], name: string, excludeId?: string): KeyLabelMeta | undefined {
  const target = name.trim().toLowerCase()
  return entries.find((e) => !e.deletedAt && e.id !== excludeId && e.name.trim().toLowerCase() === target)
}

function validateName(value: unknown): KeyLabelStoreResult<string> {
  if (typeof value !== 'string') return fail('INVALID_NAME', 'name must be a string')
  const trimmed = value.trim()
  if (!trimmed) return fail('INVALID_NAME', 'name must not be empty')
  if (trimmed.length > MAX_NAME_LENGTH) {
    return fail('INVALID_NAME', `name must be at most ${String(MAX_NAME_LENGTH)} characters`)
  }
  return ok(trimmed)
}

function isLabelMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object') return false
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v !== 'string') return false
  }
  return true
}

function normalizeFile(parsed: unknown): KeyLabelEntryFile | null {
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.name !== 'string') return null
  if (!isLabelMap(obj.map)) return null

  const compositeRaw = obj.compositeLabels ?? obj.composite_labels
  let compositeLabels: Record<string, string> | undefined
  if (compositeRaw == null) {
    compositeLabels = undefined
  } else if (isLabelMap(compositeRaw)) {
    compositeLabels = compositeRaw
  } else {
    return null
  }

  return {
    name: obj.name,
    map: obj.map,
    ...(compositeLabels ? { compositeLabels } : {}),
  }
}

/**
 * Make sure the index has a QWERTY entry. The store now drives the
 * full row list on the modal (including the built-in QWERTY) so that
 * a user-defined order can be persisted *and* synced like any other
 * label. The entry carries an empty `map` — the renderer falls back
 * to the qmkId-derived label when the map is empty, matching the
 * historical built-in behaviour.
 */
async function ensureQwertyEntry(): Promise<void> {
  const index = await readIndex()
  const existing = index.entries.find((e) => e.id === QWERTY_ENTRY_ID)
  if (existing) {
    // Backfill uploaderName for stores created before the field was set
    // so the Author column reads "pipette" without requiring a manual
    // re-import. No file rewrite needed — the meta is the source of
    // truth for the column.
    if (!existing.uploaderName) {
      existing.uploaderName = 'pipette'
      await writeIndex(index)
      notifyChange(KEY_LABEL_SYNC_UNIT)
    }
    return
  }
  const now = new Date()
  const filename = `${QWERTY_ENTRY_ID}_${tsForFilename(now)}.json`
  const data: KeyLabelEntryFile = { name: 'QWERTY', map: {} }
  const meta: KeyLabelMeta = {
    id: QWERTY_ENTRY_ID,
    name: 'QWERTY',
    uploaderName: 'pipette',
    filename,
    savedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }
  await writeRecord(meta, data)
  // Pin QWERTY to the head on first creation so behaviour matches the
  // pre-migration UX. The user can drag it elsewhere afterwards.
  index.entries.unshift(meta)
  await writeIndex(index)
  notifyChange(KEY_LABEL_SYNC_UNIT)
}

async function listInternal(includeDeleted: boolean): Promise<KeyLabelMeta[]> {
  await ensureQwertyEntry()
  const { entries } = await readIndex()
  return includeDeleted ? entries : entries.filter((e) => !e.deletedAt)
}

export async function listMetas(): Promise<KeyLabelMeta[]> {
  return listInternal(false)
}

export async function listAllMetas(): Promise<KeyLabelMeta[]> {
  return listInternal(true)
}

export async function getRecord(id: string): Promise<KeyLabelStoreResult<KeyLabelRecord>> {
  try {
    const index = await readIndex()
    const meta = index.entries.find((e) => e.id === id)
    if (!meta || meta.deletedAt) return fail('NOT_FOUND', 'Key label not found')
    const raw = await readFile(getEntryPath(meta.filename), 'utf-8')
    const parsed = normalizeFile(JSON.parse(raw))
    if (!parsed) return fail('INVALID_FILE', 'Stored file is malformed')
    return ok({ meta, data: parsed })
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export interface SaveRecordInput {
  /** Use when persisting a Hub post locally — keeps Hub id and own UUID. */
  id?: string
  name: string
  /** Hub `uploader_name` cached for the Author column. Optional. */
  uploaderName?: string
  map: Record<string, string>
  compositeLabels?: Record<string, string>
  hubPostId?: string | null
  /** Hub-side `updated_at` cached for the Updated column. Optional. */
  hubUpdatedAt?: string
}

async function writeRecord(meta: KeyLabelMeta, data: KeyLabelEntryFile): Promise<void> {
  await mkdir(getStoreDir(), { recursive: true })
  await writeFile(getEntryPath(meta.filename), JSON.stringify(data, null, 2), 'utf-8')
}

export async function saveRecord(input: SaveRecordInput): Promise<KeyLabelStoreResult<KeyLabelMeta>> {
  const validated = validateName(input.name)
  if (!validated.success || validated.data === undefined) return validated as KeyLabelStoreResult<KeyLabelMeta>
  const name = validated.data
  if (!isLabelMap(input.map)) return fail('INVALID_FILE', 'map must be an object of strings')
  if (input.compositeLabels && !isLabelMap(input.compositeLabels)) {
    return fail('INVALID_FILE', 'compositeLabels must be an object of strings')
  }

  try {
    const index = await readIndex()
    if (findActiveByName(index.entries, name, input.id)) {
      return fail('DUPLICATE_NAME', 'A label with the same name already exists')
    }

    const now = new Date()
    const id = input.id ?? randomUUID()
    const filename = `${id}_${tsForFilename(now)}.json`
    const data: KeyLabelEntryFile = {
      name,
      map: input.map,
      ...(input.compositeLabels ? { compositeLabels: input.compositeLabels } : {}),
    }

    const meta: KeyLabelMeta = {
      id,
      name,
      filename,
      savedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...(input.uploaderName ? { uploaderName: input.uploaderName } : {}),
      ...(input.hubPostId ? { hubPostId: input.hubPostId } : {}),
      ...(input.hubUpdatedAt ? { hubUpdatedAt: input.hubUpdatedAt } : {}),
    }

    await writeRecord(meta, data)

    // Overwrite path: remove the previous JSON file so the entry's
    // disk footprint stays at one file. Best-effort — a missing or
    // already-renamed file should not abort the save.
    const previous = index.entries.find((e) => e.id === id)
    if (previous && previous.filename !== filename) {
      try { await unlink(getEntryPath(previous.filename)) } catch { /* swallow */ }
    }

    // Preserve list position on overwrite: replace the existing
    // entry in place when the id was already known, otherwise append
    // at the end so freshly-downloaded labels grow the modal list
    // downward (matches MacroEditor's append-on-add behaviour).
    const existingIndex = index.entries.findIndex((e) => e.id === id)
    let nextEntries: KeyLabelMeta[]
    if (existingIndex >= 0) {
      nextEntries = index.entries.slice()
      nextEntries[existingIndex] = meta
    } else {
      nextEntries = [...index.entries, meta]
    }
    await writeIndex({ entries: nextEntries })

    notifyChange(KEY_LABEL_SYNC_UNIT)
    return ok(meta)
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export async function renameRecord(id: string, newName: string): Promise<KeyLabelStoreResult<KeyLabelMeta>> {
  const validated = validateName(newName)
  if (!validated.success || validated.data === undefined) return validated as KeyLabelStoreResult<KeyLabelMeta>
  const name = validated.data

  try {
    const index = await readIndex()
    const meta = index.entries.find((e) => e.id === id && !e.deletedAt)
    if (!meta) return fail('NOT_FOUND', 'Key label not found')
    if (findActiveByName(index.entries, name, id)) {
      return fail('DUPLICATE_NAME', 'A label with the same name already exists')
    }

    const filePath = getEntryPath(meta.filename)
    const raw = await readFile(filePath, 'utf-8')
    const parsed = normalizeFile(JSON.parse(raw))
    if (!parsed) return fail('INVALID_FILE', 'Stored file is malformed')

    parsed.name = name
    await writeFile(filePath, JSON.stringify(parsed, null, 2), 'utf-8')

    meta.name = name
    meta.updatedAt = nowIso()
    await writeIndex(index)

    notifyChange(KEY_LABEL_SYNC_UNIT)
    return ok(meta)
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export async function deleteRecord(id: string): Promise<KeyLabelStoreResult<void>> {
  if (id === QWERTY_ENTRY_ID) {
    return fail('INVALID_NAME', 'QWERTY cannot be deleted')
  }
  try {
    const index = await readIndex()
    const meta = index.entries.find((e) => e.id === id)
    if (!meta) return fail('NOT_FOUND', 'Key label not found')

    const now = nowIso()
    meta.deletedAt = now
    meta.updatedAt = now
    await writeIndex(index)

    notifyChange(KEY_LABEL_SYNC_UNIT)
    return ok()
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export async function setHubPostId(
  id: string,
  hubPostId: string | null,
  uploaderName?: string | null,
  hubUpdatedAt?: string | null,
): Promise<KeyLabelStoreResult<KeyLabelMeta>> {
  try {
    const index = await readIndex()
    const meta = index.entries.find((e) => e.id === id)
    if (!meta) return fail('NOT_FOUND', 'Key label not found')

    const normalized = hubPostId?.trim() || null
    if (normalized === null) {
      delete meta.hubPostId
      // Detaching from Hub also clears the cached Hub timestamp so the
      // Updated column blanks out (rather than showing a stale time).
      delete meta.hubUpdatedAt
    } else {
      meta.hubPostId = normalized
    }
    // Caller passes the response's uploader_name so the local row
    // shows the Author column and the "isMine" check (which gates
    // Update / Remove on hub-posted entries) flips to true without
    // a sync round trip.
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

    notifyChange(KEY_LABEL_SYNC_UNIT)
    return ok(meta)
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export async function importFromDialog(
  win: BrowserWindow,
): Promise<KeyLabelStoreResult<KeyLabelMeta>> {
  try {
    const result = await dialog.showOpenDialog(win, {
      title: 'Import Key Label',
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    })

    if (result.canceled || result.filePaths.length === 0) {
      return fail('IO_ERROR', 'cancelled')
    }

    const raw = await readFile(result.filePaths[0], 'utf-8')
    const parsed = normalizeFile(JSON.parse(raw))
    if (!parsed) return fail('INVALID_FILE', 'Invalid key label file')

    // Treat re-import of an entry with an existing name as an
    // overwrite: the user explicitly opted in by picking the same
    // file name back. We carry the existing id, uploaderName and
    // hubPostId across so the entry stays linked to its Hub post
    // (the user can detach via Remove if they want a fresh post).
    const index = await readIndex()
    const existing = findActiveByName(index.entries, parsed.name)
    return saveRecord({
      ...(existing
        ? {
          id: existing.id,
          ...(existing.uploaderName ? { uploaderName: existing.uploaderName } : {}),
          ...(existing.hubPostId ? { hubPostId: existing.hubPostId } : {}),
          ...(existing.hubUpdatedAt ? { hubUpdatedAt: existing.hubUpdatedAt } : {}),
        }
        : {}),
      name: parsed.name,
      map: parsed.map,
      compositeLabels: parsed.compositeLabels,
    })
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

/**
 * Apply a manual order to the active entries. Tombstones and any ids
 * not listed in `orderedIds` keep their relative position behind the
 * sorted prefix. Each affected meta has its `updatedAt` bumped so
 * remote machines see the rearrangement at the next sync.
 */
export async function reorderActive(
  orderedIds: string[],
): Promise<KeyLabelStoreResult<void>> {
  try {
    const index = await readIndex()
    const byId = new Map<string, KeyLabelMeta>()
    for (const meta of index.entries) byId.set(meta.id, meta)

    const seen = new Set<string>()
    const reordered: KeyLabelMeta[] = []
    const now = nowIso()
    for (const id of orderedIds) {
      const meta = byId.get(id)
      if (!meta || meta.deletedAt || seen.has(id)) continue
      meta.updatedAt = now
      reordered.push(meta)
      seen.add(id)
    }

    // Append everything else (tombstones + unlisted active rows) so we
    // never silently drop entries that the renderer's view did not
    // include in the order array.
    for (const meta of index.entries) {
      if (seen.has(meta.id)) continue
      reordered.push(meta)
    }

    await writeIndex({ entries: reordered })
    notifyChange(KEY_LABEL_SYNC_UNIT)
    return ok()
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

/** Returns true if an active entry with the given name (case-insensitive) exists. */
export async function hasActiveName(name: string, excludeId?: string): Promise<boolean> {
  const index = await readIndex()
  return Boolean(findActiveByName(index.entries, name, excludeId))
}

/**
 * Save the entry to disk via `dialog.showSaveDialog`. The exported JSON
 * matches the Hub `/api/key-labels/:id/download` body so a round-trip
 * (export → import / re-upload) is symmetric.
 */
export async function exportToDialog(
  win: BrowserWindow,
  id: string,
): Promise<KeyLabelStoreResult<{ filePath: string }>> {
  try {
    const record = await getRecord(id)
    if (!record.success || !record.data) return record as KeyLabelStoreResult<{ filePath: string }>

    const { meta, data } = record.data
    const safeName = meta.name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'key-label'
    const result = await dialog.showSaveDialog(win, {
      title: 'Export Key Label',
      defaultPath: `${safeName}.json`,
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    })

    if (result.canceled || !result.filePath) {
      return fail('IO_ERROR', 'cancelled')
    }

    const body = {
      name: data.name,
      map: data.map,
      composite_labels: data.compositeLabels ?? null,
    }
    await writeFile(result.filePath, JSON.stringify(body, null, 2), 'utf-8')
    return ok({ filePath: result.filePath })
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}
