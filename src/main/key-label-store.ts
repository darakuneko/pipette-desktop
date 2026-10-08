// SPDX-License-Identifier: GPL-2.0-or-later
// Local store for Key Labels — mirrors favorite-store's index + per-entry layout.

import { app, dialog, BrowserWindow } from 'electron'
import { basename, join } from 'node:path'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { notifyChange } from './sync/sync-service'
import { withWriteLock } from './per-uid-write-lock'
import { safeFilename, isSafePathSegment, tsForFilename } from './utils/safe-filename'
import type {
  KeyLabelMeta,
  KeyLabelIndex,
  KeyLabelEntryFile,
  KeyLabelRecord,
  KeyLabelStoreResult,
  KeyLabelStoreErrorCode,
  KeyLabelImportBatchResult,
  KeyLabelImportRejection,
  KeyLabelImportSuccess,
} from '../shared/types/key-label-store'
import { type ClockedEntry, EPOCH_ISO, idBodyFilename, markDeleted, setClock, touchClock } from './sync/entry-clocks'
import { builtinEntry, normalizeEntries, overwriteEntry } from './sync/entry-write'
import { readIndexMigrated } from './sync/body-filename-migration'
import { writeFileAtomic } from './utils/write-file-atomic'

type KeyLabelEntry = ClockedEntry<KeyLabelMeta>

interface ClockedKeyLabelIndex {
  entries: KeyLabelEntry[]
}

export const KEY_LABEL_SYNC_UNIT = 'key-labels'
/** Stable id for the built-in QWERTY entry so renames / reorders survive sync. */
const QWERTY_ENTRY_ID = 'qwerty'
/** The same on every device, like every other field of the created entry. */
const QWERTY_FILENAME = idBodyFilename('keyLabels', QWERTY_ENTRY_ID, 'builtin.json')
const MAX_NAME_LENGTH = 100

function getStoreDir(): string {
  return join(app.getPath('userData'), 'sync', 'key-labels')
}

function getIndexPath(): string {
  return join(getStoreDir(), 'index.json')
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

async function readIndex(): Promise<ClockedKeyLabelIndex> {
  try {
    const raw = await readFile(getIndexPath(), 'utf-8')
    const parsed = JSON.parse(raw) as KeyLabelIndex
    if (Array.isArray(parsed?.entries)) return { ...parsed, entries: normalizeEntries('keyLabels', parsed.entries) }
  } catch {
    // missing / corrupt — return empty
  }
  return { entries: [] }
}

async function writeIndex(index: ClockedKeyLabelIndex): Promise<void> {
  await mkdir(getStoreDir(), { recursive: true })
  await writeFileAtomic(getIndexPath(), JSON.stringify(index, null, 2))
}

/** `readIndex` for a caller holding the store lock: also moves body files
 *  to id-carrying names (`migrateBodyFilenames`). */
function readIndexLocked(): Promise<ClockedKeyLabelIndex> {
  return readIndexMigrated('keyLabels', getStoreDir(), readIndex, writeIndex)
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

const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

function isLabelMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object') return false
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(k)) return false
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

  // Deliberately more lenient than `compositeLabels` above: a malformed
  // `compositeLabels` rejects the whole file because there is no other
  // validator downstream to catch a bad shape. `keymapApplicable` gets
  // the opposite treatment — only a literal `true` is kept, anything
  // else (missing, `false`, a stray string/number) quietly becomes
  // absent — because `buildKeymapRewriteTable` (keymap-apply.ts) always
  // re-derives applicability from the map itself before anything acts
  // on the flag. A malformed flag can therefore fall back to "not
  // applicable" instead of blocking import/download of an otherwise
  // valid label set.
  const keymapApplicableRaw = obj.keymapApplicable ?? obj.keymap_applicable
  const keymapApplicable = keymapApplicableRaw === true ? true : undefined

  return {
    name: obj.name,
    map: obj.map,
    ...(compositeLabels ? { compositeLabels } : {}),
    ...(keymapApplicable ? { keymapApplicable } : {}),
  }
}

/**
 * Make sure the index has a QWERTY entry. The store drives the full
 * row list on the modal (including the built-in QWERTY) so that a
 * user-defined order can be persisted like any other label. The order
 * is per device: a sync merge keeps this device's order
 * (`preserveLocalOrder`, `merge.ts`). The entry carries an empty
 * `map` — the renderer falls back to the qmkId-derived label when the
 * map is empty, matching the historical built-in behaviour.
 */
async function ensureQwertyEntryUnlocked(): Promise<void> {
  const index = await readIndexLocked()
  const at = index.entries.findIndex((e) => e.id === QWERTY_ENTRY_ID)
  if (at >= 0) {
    const existing = index.entries[at]
    // Backfill uploaderName for stores created before the field was set
    // so the Author column reads "pipette" without requiring a manual
    // re-import. No file rewrite needed — the meta is the source of
    // truth for the column. The hub clock is the epoch, like a freshly
    // created QWERTY entry's, so every device backfills the same value
    // at the same clock.
    if (!existing.uploaderName) {
      index.entries[at] = setClock({ ...existing, uploaderName: 'pipette' }, 'hub', EPOCH_ISO)
      await writeIndex(index)
      notifyChange(KEY_LABEL_SYNC_UNIT)
    }
    return
  }
  const data: KeyLabelEntryFile = { name: 'QWERTY', map: {} }
  const meta = builtinEntry('keyLabels', {
    id: QWERTY_ENTRY_ID,
    name: 'QWERTY',
    uploaderName: 'pipette',
    filename: QWERTY_FILENAME,
    savedAt: EPOCH_ISO,
  })
  await writeRecord(meta, data)
  // Pin QWERTY to the head on first creation so behaviour matches the
  // pre-migration UX. The user can drag it elsewhere afterwards.
  index.entries.unshift(meta)
  await writeIndex(index)
  notifyChange(KEY_LABEL_SYNC_UNIT)
}

async function ensureQwertyEntry(): Promise<void> {
  // List calls are reads; they only wait on writers when the entry really has to be created.
  const existing = (await readIndex()).entries.find((e) => e.id === QWERTY_ENTRY_ID)
  if (existing?.uploaderName) return
  return withWriteLock(KEY_LABEL_SYNC_UNIT, () => ensureQwertyEntryUnlocked())
}

async function listInternal(includeDeleted: boolean): Promise<KeyLabelEntry[]> {
  await ensureQwertyEntry()
  const { entries } = await readIndex()
  return includeDeleted ? entries : entries.filter((e) => !e.deletedAt)
}

export async function listMetas(): Promise<KeyLabelEntry[]> {
  return listInternal(false)
}

export async function listAllMetas(): Promise<KeyLabelEntry[]> {
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
    // A rename changes only the meta (`renameRecord`), so the meta's name
    // is the label's name; export and Hub upload read it from here.
    return ok({ meta, data: { ...parsed, name: meta.name } })
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
  /** Opt-in marker that this map is a pure QWERTY-keycode permutation
   *  applicable to bulk keymap rewrite. See `KeyLabelEntryFile.keymapApplicable`. */
  keymapApplicable?: boolean
  hubPostId?: string | null
  /** Hub-side `updated_at` cached for the Updated column. Optional. */
  hubUpdatedAt?: string
  /** Keep the name the entry `id` has when the save runs (under the
   *  store lock) instead of `name`: for a refresh that is not a rename
   *  (the Hub Sync), so a rename made while it waited on the network
   *  stays. `name` is used when the entry is new or deleted. */
  keepCurrentName?: boolean
}

async function writeRecord(meta: KeyLabelMeta, data: KeyLabelEntryFile): Promise<void> {
  await mkdir(getStoreDir(), { recursive: true })
  await writeFileAtomic(getEntryPath(meta.filename), JSON.stringify(data, null, 2))
}

async function saveRecordUnlocked(input: SaveRecordInput): Promise<KeyLabelStoreResult<KeyLabelMeta>> {
  const validated = validateName(input.name)
  if (!validated.success || validated.data === undefined) {
    return fail(validated.errorCode ?? 'INVALID_NAME', validated.error ?? 'Invalid name')
  }
  if (!isLabelMap(input.map)) return fail('INVALID_FILE', 'map must be an object of strings')
  if (input.compositeLabels && !isLabelMap(input.compositeLabels)) {
    return fail('INVALID_FILE', 'compositeLabels must be an object of strings')
  }

  try {
    const index = await readIndexLocked()
    const current = input.keepCurrentName ? index.entries.find((e) => e.id === input.id && !e.deletedAt) : undefined
    const name = current?.name ?? validated.data
    if (findActiveByName(index.entries, name, input.id)) {
      return fail('DUPLICATE_NAME', 'A label with the same name already exists')
    }

    const now = new Date()
    const id = input.id ?? randomUUID()
    const filename = idBodyFilename('keyLabels', id, `${tsForFilename(now)}.json`)
    const data: KeyLabelEntryFile = {
      name,
      map: input.map,
      ...(input.compositeLabels ? { compositeLabels: input.compositeLabels } : {}),
      ...(input.keymapApplicable ? { keymapApplicable: true } : {}),
    }

    const previous = index.entries.find((e) => e.id === id)
    // Every caller is a user action (Hub download / sync, import), so an
    // id saved over is brought back or kept alive (`overwriteEntry`).
    const meta = overwriteEntry('keyLabels', previous, {
      id,
      name,
      filename,
      savedAt: now.toISOString(),
      ...(input.uploaderName ? { uploaderName: input.uploaderName } : {}),
      ...(input.hubPostId ? { hubPostId: input.hubPostId } : {}),
      ...(input.hubUpdatedAt ? { hubUpdatedAt: input.hubUpdatedAt } : {}),
    }, now, { body: true, explicit: true })

    await writeRecord(meta, data)

    // Overwrite path: remove the previous JSON file so the entry's
    // disk footprint stays at one file. Best-effort — a missing or
    // already-renamed file should not abort the save.
    if (previous && previous.filename !== filename) {
      try { await unlink(getEntryPath(previous.filename)) } catch { /* swallow */ }
    }

    // Preserve list position on overwrite: replace the existing
    // entry in place when the id was already known, otherwise append
    // at the end so freshly-downloaded labels grow the modal list
    // downward (matches MacroEditor's append-on-add behaviour).
    const existingIndex = index.entries.findIndex((e) => e.id === id)
    let nextEntries: KeyLabelEntry[]
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

export function saveRecord(input: SaveRecordInput): Promise<KeyLabelStoreResult<KeyLabelMeta>> {
  return withWriteLock(KEY_LABEL_SYNC_UNIT, () => saveRecordUnlocked(input))
}

async function renameRecordUnlocked(id: string, newName: string): Promise<KeyLabelStoreResult<KeyLabelMeta>> {
  const validated = validateName(newName)
  if (!validated.success || validated.data === undefined) {
    return fail(validated.errorCode ?? 'INVALID_NAME', validated.error ?? 'Invalid name')
  }
  const name = validated.data

  try {
    const index = await readIndexLocked()
    const at = index.entries.findIndex((e) => e.id === id && !e.deletedAt)
    if (at < 0) return fail('NOT_FOUND', 'Key label not found')
    const current = index.entries[at]
    if (findActiveByName(index.entries, name, id)) {
      return fail('DUPLICATE_NAME', 'A label with the same name already exists')
    }

    // The meta only: the body file keeps the name it was saved with, and
    // `getRecord` shows the meta's.
    const meta = touchClock({ ...current, name }, 'name', new Date())
    index.entries[at] = meta
    await writeIndex(index)

    notifyChange(KEY_LABEL_SYNC_UNIT)
    return ok(meta)
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export function renameRecord(id: string, newName: string): Promise<KeyLabelStoreResult<KeyLabelMeta>> {
  return withWriteLock(KEY_LABEL_SYNC_UNIT, () => renameRecordUnlocked(id, newName))
}

async function deleteRecordUnlocked(id: string): Promise<KeyLabelStoreResult<void>> {
  if (id === QWERTY_ENTRY_ID) {
    return fail('INVALID_NAME', 'QWERTY cannot be deleted')
  }
  try {
    const index = await readIndexLocked()
    const at = index.entries.findIndex((e) => e.id === id)
    if (at < 0) return fail('NOT_FOUND', 'Key label not found')

    index.entries[at] = markDeleted(index.entries[at], new Date())
    await writeIndex(index)

    notifyChange(KEY_LABEL_SYNC_UNIT)
    return ok()
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export function deleteRecord(id: string): Promise<KeyLabelStoreResult<void>> {
  return withWriteLock(KEY_LABEL_SYNC_UNIT, () => deleteRecordUnlocked(id))
}

async function setHubPostIdUnlocked(
  id: string,
  hubPostId: string | null,
  uploaderName?: string | null,
  hubUpdatedAt?: string | null,
): Promise<KeyLabelStoreResult<KeyLabelMeta>> {
  try {
    const index = await readIndexLocked()
    const at = index.entries.findIndex((e) => e.id === id)
    if (at < 0) return fail('NOT_FOUND', 'Key label not found')
    const meta = { ...index.entries[at] }

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
    const touched = touchClock(meta, 'hub', new Date())
    index.entries[at] = touched
    await writeIndex(index)

    notifyChange(KEY_LABEL_SYNC_UNIT)
    return ok(touched)
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export function setHubPostId(
  id: string,
  hubPostId: string | null,
  uploaderName?: string | null,
  hubUpdatedAt?: string | null,
): Promise<KeyLabelStoreResult<KeyLabelMeta>> {
  return withWriteLock(KEY_LABEL_SYNC_UNIT, () => setHubPostIdUnlocked(id, hubPostId, uploaderName, hubUpdatedAt))
}

/**
 * Import every file selected via the multi-select dialog. Each path is
 * processed independently — a bad file (unreadable / invalid JSON / fails
 * `saveRecord` validation) is recorded in `rejections` rather than aborting
 * the rest of the batch, mirroring `importTypingDataFiles`'s
 * per-file-independent contract. Two same-named files within one batch
 * resolve in file-list order: the second finds the first's just-saved
 * entry via `findActiveByName` and overwrites it — acceptable, since the
 * user picked both files together.
 */
export async function importFromDialog(
  win: BrowserWindow,
): Promise<KeyLabelStoreResult<KeyLabelImportBatchResult>> {
  try {
    const result = await dialog.showOpenDialog(win, {
      title: 'Import Key Label',
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile', 'multiSelections'],
    })

    if (result.canceled || result.filePaths.length === 0) {
      return fail('IO_ERROR', 'cancelled')
    }

    const imported: KeyLabelImportSuccess[] = []
    const rejections: KeyLabelImportRejection[] = []

    for (const filePath of result.filePaths) {
      const fileName = basename(filePath)
      try {
        const raw = await readFile(filePath, 'utf-8')
        const parsed = normalizeFile(JSON.parse(raw))
        if (!parsed) {
          rejections.push({ fileName, errorCode: 'INVALID_FILE', error: 'Invalid key label file' })
          continue
        }

        // Treat re-import of an entry with an existing name as an
        // overwrite: the user explicitly opted in by picking the same
        // file name back. We carry the existing id, uploaderName and
        // hubPostId across so the entry stays linked to its Hub post
        // (the user can detach via Remove if they want a fresh post).
        const index = await readIndex()
        const existing = findActiveByName(index.entries, parsed.name)
        const saved = await saveRecord({
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
          keymapApplicable: parsed.keymapApplicable,
        })
        if (saved.success && saved.data) {
          // Carries the originating filename alongside the saved meta —
          // the renderer needs it to report e.g. a Hub-sync failure
          // against the file the user picked, not the label's name.
          imported.push({ fileName, meta: saved.data })
        } else {
          rejections.push({
            fileName,
            errorCode: saved.errorCode ?? 'IO_ERROR',
            error: saved.error ?? 'Import failed',
          })
        }
      } catch (err) {
        rejections.push({ fileName, errorCode: 'IO_ERROR', error: String(err) })
      }
    }

    return ok({ imported, rejections })
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

/**
 * Apply a manual order to the active entries. Tombstones and any ids
 * not listed in `orderedIds` keep their relative position behind the
 * sorted prefix.
 *
 * The order is per device — a sync merge keeps the local order
 * (`preserveLocalOrder`, `merge.ts`) — so a reorder neither bumps
 * `updatedAt` nor queues a sync. A bumped `updatedAt` would let a drag
 * win the per-entry LWW against another device's concurrent delete or
 * edit, and with no newer timestamp a sync would have nothing to upload.
 */
async function reorderActiveUnlocked(
  orderedIds: string[],
): Promise<KeyLabelStoreResult<void>> {
  try {
    const index = await readIndexLocked()
    const byId = new Map<string, KeyLabelEntry>()
    for (const meta of index.entries) byId.set(meta.id, meta)

    const seen = new Set<string>()
    const reordered: KeyLabelEntry[] = []
    for (const id of orderedIds) {
      const meta = byId.get(id)
      if (!meta || meta.deletedAt || seen.has(id)) continue
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
    return ok()
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export function reorderActive(
  orderedIds: string[],
): Promise<KeyLabelStoreResult<void>> {
  return withWriteLock(KEY_LABEL_SYNC_UNIT, () => reorderActiveUnlocked(orderedIds))
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
    if (!record.success || !record.data) {
      return { success: record.success, errorCode: record.errorCode, error: record.error }
    }

    const { meta, data } = record.data
    const safeName = safeFilename(meta.name, 'key-label')
    const result = await dialog.showSaveDialog(win, {
      title: 'Export Key Label',
      defaultPath: `key-labels-${safeName}.json`,
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
      keymap_applicable: data.keymapApplicable ?? false,
    }
    await writeFile(result.filePath, JSON.stringify(body, null, 2), 'utf-8')
    return ok({ filePath: result.filePath })
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}
