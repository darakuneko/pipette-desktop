// SPDX-License-Identifier: GPL-2.0-or-later
// Local store for imported Typing Test texts — mirrors key-label-store's
// index + per-entry layout. Cross-keyboard (global), entry-level LWW.

import { app, dialog, BrowserWindow } from 'electron'
import { join, basename } from 'node:path'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { notifyChange } from './sync/sync-service'
import type {
  TypingTestTextMeta,
  TypingTestTextIndex,
  TypingTestTextEntryFile,
  TypingTestTextRecord,
  TypingTestTextStoreResult,
  TypingTestTextStoreErrorCode,
} from '../shared/types/typing-test-text-store'
import {
  TYPING_TEST_TEXT_MAX_FILE_BYTES,
  normalizeCustomText,
} from '../shared/types/typing-test-text-store'

export const TYPING_TEST_TEXT_SYNC_UNIT = 'typing-test-texts'
const MAX_NAME_LENGTH = 100

// An import that collided with an existing name, parsed but not yet saved.
// Held here so confirmImportOverwrite() can commit it without re-picking the
// file. Single-slot: a newer import replaces any earlier pending one.
let pendingImport: { name: string; text: string; existingId: string } | null = null

function getStoreDir(): string {
  return join(app.getPath('userData'), 'sync', TYPING_TEST_TEXT_SYNC_UNIT)
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

function fail<T>(errorCode: TypingTestTextStoreErrorCode, error: string): TypingTestTextStoreResult<T> {
  return { success: false, errorCode, error }
}

function ok<T>(data?: T): TypingTestTextStoreResult<T> {
  return { success: true, data }
}

function nowIso(): string {
  return new Date().toISOString()
}

function tsForFilename(now: Date = new Date()): string {
  return now.toISOString().replace(/:/g, '-')
}

async function readIndex(): Promise<TypingTestTextIndex> {
  try {
    const raw = await readFile(getIndexPath(), 'utf-8')
    const parsed = JSON.parse(raw) as TypingTestTextIndex
    if (Array.isArray(parsed?.entries)) return parsed
  } catch {
    // missing / corrupt — return empty
  }
  return { entries: [] }
}

async function writeIndex(index: TypingTestTextIndex): Promise<void> {
  await mkdir(getStoreDir(), { recursive: true })
  await writeFile(getIndexPath(), JSON.stringify(index, null, 2), 'utf-8')
}

function findActiveByName(entries: TypingTestTextMeta[], name: string, excludeId?: string): TypingTestTextMeta | undefined {
  const target = name.trim().toLowerCase()
  return entries.find((e) => !e.deletedAt && e.id !== excludeId && e.name.trim().toLowerCase() === target)
}

function validateName(value: unknown): TypingTestTextStoreResult<string> {
  if (typeof value !== 'string') return fail('INVALID_NAME', 'name must be a string')
  const trimmed = value.trim()
  if (!trimmed) return fail('INVALID_NAME', 'name must not be empty')
  if (trimmed.length > MAX_NAME_LENGTH) {
    return fail('INVALID_NAME', `name must be at most ${String(MAX_NAME_LENGTH)} characters`)
  }
  return ok(trimmed)
}

function normalizeFile(parsed: unknown): TypingTestTextEntryFile | null {
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.name !== 'string') return null
  if (typeof obj.text !== 'string') return null
  return { name: obj.name, text: obj.text }
}

async function listInternal(includeDeleted: boolean): Promise<TypingTestTextMeta[]> {
  const { entries } = await readIndex()
  return includeDeleted ? entries : entries.filter((e) => !e.deletedAt)
}

export async function listMetas(): Promise<TypingTestTextMeta[]> {
  return listInternal(false)
}

export async function listAllMetas(): Promise<TypingTestTextMeta[]> {
  return listInternal(true)
}

export async function getRecord(id: string): Promise<TypingTestTextStoreResult<TypingTestTextRecord>> {
  try {
    const index = await readIndex()
    const meta = index.entries.find((e) => e.id === id)
    if (!meta || meta.deletedAt) return fail('NOT_FOUND', 'Text not found')
    const raw = await readFile(getEntryPath(meta.filename), 'utf-8')
    const parsed = normalizeFile(JSON.parse(raw))
    if (!parsed) return fail('INVALID_FILE', 'Stored file is malformed')
    return ok({ meta, data: parsed })
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export interface SaveTextInput {
  /** Carry an existing id to overwrite in place (re-import). */
  id?: string
  name: string
  /** Raw text — normalized + word-capped here. */
  text: string
}

async function writeRecord(meta: TypingTestTextMeta, data: TypingTestTextEntryFile): Promise<void> {
  await mkdir(getStoreDir(), { recursive: true })
  await writeFile(getEntryPath(meta.filename), JSON.stringify(data, null, 2), 'utf-8')
}

export async function saveRecord(input: SaveTextInput): Promise<TypingTestTextStoreResult<TypingTestTextMeta>> {
  const validated = validateName(input.name)
  if (!validated.success || validated.data === undefined) return validated as TypingTestTextStoreResult<TypingTestTextMeta>
  const name = validated.data

  const { text, wordCount } = normalizeCustomText(typeof input.text === 'string' ? input.text : '')
  if (wordCount === 0) return fail('EMPTY_TEXT', 'Text has no typeable words')

  try {
    const index = await readIndex()
    if (findActiveByName(index.entries, name, input.id)) {
      return fail('DUPLICATE_NAME', 'A text with the same name already exists')
    }

    const now = new Date()
    const id = input.id ?? randomUUID()
    const filename = `${id}_${tsForFilename(now)}.json`
    const data: TypingTestTextEntryFile = { name, text }

    const meta: TypingTestTextMeta = {
      id,
      name,
      wordCount,
      filename,
      savedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }

    await writeRecord(meta, data)

    // Overwrite path: drop the previous JSON so the entry keeps a single
    // file on disk. Best-effort — a missing file should not abort.
    const previous = index.entries.find((e) => e.id === id)
    if (previous && previous.filename !== filename) {
      try { await unlink(getEntryPath(previous.filename)) } catch { /* swallow */ }
    }

    const existingIndex = index.entries.findIndex((e) => e.id === id)
    let nextEntries: TypingTestTextMeta[]
    if (existingIndex >= 0) {
      nextEntries = index.entries.slice()
      nextEntries[existingIndex] = meta
    } else {
      nextEntries = [...index.entries, meta]
    }
    await writeIndex({ entries: nextEntries })

    notifyChange(TYPING_TEST_TEXT_SYNC_UNIT)
    return ok(meta)
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export async function renameRecord(id: string, newName: string): Promise<TypingTestTextStoreResult<TypingTestTextMeta>> {
  const validated = validateName(newName)
  if (!validated.success || validated.data === undefined) return validated as TypingTestTextStoreResult<TypingTestTextMeta>
  const name = validated.data

  try {
    const index = await readIndex()
    const meta = index.entries.find((e) => e.id === id && !e.deletedAt)
    if (!meta) return fail('NOT_FOUND', 'Text not found')
    if (findActiveByName(index.entries, name, id)) {
      return fail('DUPLICATE_NAME', 'A text with the same name already exists')
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

    notifyChange(TYPING_TEST_TEXT_SYNC_UNIT)
    return ok(meta)
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

export async function deleteRecord(id: string): Promise<TypingTestTextStoreResult<void>> {
  try {
    const index = await readIndex()
    const meta = index.entries.find((e) => e.id === id)
    if (!meta) return fail('NOT_FOUND', 'Text not found')

    const now = nowIso()
    meta.deletedAt = now
    meta.updatedAt = now
    await writeIndex(index)

    notifyChange(TYPING_TEST_TEXT_SYNC_UNIT)
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

export async function importFromDialog(
  win: BrowserWindow,
): Promise<TypingTestTextStoreResult<TypingTestTextMeta>> {
  try {
    const result = await dialog.showOpenDialog(win, {
      title: 'Import UTF-8 Text',
      // No extension restriction — any file is allowed. Content is validated
      // as UTF-8 below (non-UTF-8 is rejected), so the extension is irrelevant.
      filters: [{ name: 'UTF-8 text', extensions: ['*'] }],
      properties: ['openFile'],
    })

    if (result.canceled || result.filePaths.length === 0) {
      return fail('IO_ERROR', 'cancelled')
    }

    const filePath = result.filePaths[0]
    // Gate on the on-disk size first so an oversized file is never read
    // into memory. (Measuring after decode would also balloon for
    // non-UTF-8 input via U+FFFD replacement chars.)
    const { size } = await stat(filePath)
    if (size > TYPING_TEST_TEXT_MAX_FILE_BYTES) {
      return fail('TOO_LARGE', 'File exceeds the size limit')
    }
    const buf = await readFile(filePath)
    // UTF-8 only. `fatal: true` throws on any invalid byte sequence (e.g.
    // a Shift-JIS / CP932 file) so we reject rather than import mojibake.
    // A leading UTF-8 BOM is stripped by TextDecoder automatically.
    let raw: string
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      return fail('NOT_UTF8', 'File must be UTF-8 encoded')
    }

    // Default name from the file's base name (sans extension).
    const name = basename(filePath).replace(/\.[^/.]+$/, '').trim() || 'Imported text'

    // Re-import of an entry with an existing name overwrites it (the user
    // opted in by picking the same name back).
    const index = await readIndex()
    const existing = findActiveByName(index.entries, name)
    if (existing) {
      // Don't overwrite silently — stash the parsed text and let the renderer
      // confirm. confirmImportOverwrite() commits it. The error carries the
      // colliding name so the prompt can show it.
      pendingImport = { name, text: raw, existingId: existing.id }
      return fail('DUPLICATE_NAME', name)
    }
    // No collision — drop any stale pending and save straight away.
    pendingImport = null
    return saveRecord({ name, text: raw })
  } catch (err) {
    return fail('IO_ERROR', String(err))
  }
}

/** Commit the import stashed by importFromDialog when its name collided,
 *  overwriting the existing entry in place. */
export async function confirmImportOverwrite(): Promise<TypingTestTextStoreResult<TypingTestTextMeta>> {
  if (!pendingImport) return fail('NOT_FOUND', 'No pending import to confirm')
  const { name, text, existingId } = pendingImport
  pendingImport = null
  return saveRecord({ id: existingId, name, text })
}
