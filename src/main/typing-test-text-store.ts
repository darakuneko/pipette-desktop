// SPDX-License-Identifier: GPL-2.0-or-later
// Local store for imported Typing Test texts — mirrors key-label-store's
// index + per-entry layout. Cross-keyboard (global), entry-level LWW.

import { app, dialog, BrowserWindow } from 'electron'
import { join, basename } from 'node:path'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { notifyChange } from './sync/sync-service'
import { isKanaOnlyText } from '../shared/kana-purity'
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
  normalizeFileImportText,
} from '../shared/types/typing-test-text-store'

export const TYPING_TEST_TEXT_SYNC_UNIT = 'typing-test-texts'
const MAX_NAME_LENGTH = 100

// `romajiCapable` is computed from content, not persisted (see the field's
// doc comment in shared/types/typing-test-text-store.ts). Scanning every
// entry's file on each list call would mean an extra disk read per text, so
// results are cached in-process keyed by id + the record's `updatedAt`
// (already bumped on every content-changing write). A stale cache entry —
// wrong id, or same id with a newer `updatedAt` — is simply recomputed.
const romajiCapableCache = new Map<string, { updatedAt: string; capable: boolean }>()

function getCachedRomajiCapable(meta: TypingTestTextMeta): boolean | undefined {
  const cached = romajiCapableCache.get(meta.id)
  return cached && cached.updatedAt === meta.updatedAt ? cached.capable : undefined
}

function setCachedRomajiCapable(meta: TypingTestTextMeta, capable: boolean): void {
  romajiCapableCache.set(meta.id, { updatedAt: meta.updatedAt, capable })
}

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
    if (Array.isArray(parsed?.entries)) {
      // Unknown/optional fields pass through untouched; `source` is the one
      // field validated here since malformed values (e.g. a non-string
      // workId) would otherwise reach catalog-matching logic unchecked.
      return { entries: parsed.entries.map((e) => ({ ...e, source: sanitizeSource(e.source) })) }
    }
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

function sanitizeSource(value: unknown): TypingTestTextMeta['source'] {
  if (!value || typeof value !== 'object') return undefined
  const obj = value as Record<string, unknown>
  if (typeof obj.provider !== 'string' || typeof obj.workId !== 'string') return undefined
  return { provider: obj.provider, workId: obj.workId }
}

function normalizeFile(parsed: unknown): TypingTestTextEntryFile | null {
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.name !== 'string') return null
  if (typeof obj.text !== 'string') return null
  return { name: obj.name, text: obj.text }
}

// Attaches the computed `romajiCapable` field to a meta for an API response.
// Uses the cache when the entry's content hasn't changed since it was last
// scanned; otherwise reads the entry file and scans its text. A read/parse
// failure (e.g. a tombstoned entry whose file was since removed) is not
// romaji-capable rather than a hard error, since this is a best-effort
// display flag, not the record's source of truth.
async function withRomajiCapable(meta: TypingTestTextMeta): Promise<TypingTestTextMeta> {
  const cached = getCachedRomajiCapable(meta)
  if (cached !== undefined) return { ...meta, romajiCapable: cached }
  let capable = false
  try {
    const raw = await readFile(getEntryPath(meta.filename), 'utf-8')
    const parsed = normalizeFile(JSON.parse(raw))
    capable = parsed !== null && isKanaOnlyText(parsed.text)
  } catch {
    // Missing/corrupt entry file — treat as not romaji-capable.
  }
  setCachedRomajiCapable(meta, capable)
  return { ...meta, romajiCapable: capable }
}

async function listInternal(includeDeleted: boolean): Promise<TypingTestTextMeta[]> {
  const { entries } = await readIndex()
  const filtered = includeDeleted ? entries : entries.filter((e) => !e.deletedAt)
  return Promise.all(filtered.map(withRomajiCapable))
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
    // Content is already in hand here, so scan directly instead of going
    // through withRomajiCapable (which would re-read the file on a cache miss).
    const cached = getCachedRomajiCapable(meta)
    const romajiCapable = cached ?? isKanaOnlyText(parsed.text)
    if (cached === undefined) setCachedRomajiCapable(meta, romajiCapable)
    return ok({ meta: { ...meta, romajiCapable }, data: parsed })
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
  /** Set when saving a catalog import (e.g. Aozora Bunko). Renderer-facing
   *  file imports never pass this — only main-process catalog importers do. */
  source?: TypingTestTextMeta['source']
}

async function writeRecord(meta: TypingTestTextMeta, data: TypingTestTextEntryFile): Promise<void> {
  await mkdir(getStoreDir(), { recursive: true })
  await writeFile(getEntryPath(meta.filename), JSON.stringify(data, null, 2), 'utf-8')
}

export async function saveRecord(input: SaveTextInput): Promise<TypingTestTextStoreResult<TypingTestTextMeta>> {
  const validated = validateName(input.name)
  if (!validated.success || validated.data === undefined) {
    return fail(validated.errorCode ?? 'INVALID_NAME', validated.error ?? 'Invalid name')
  }
  const name = validated.data

  const { text, wordCount, lineCount } = normalizeFileImportText(typeof input.text === 'string' ? input.text : '')
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
      lineCount,
      filename,
      savedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      source: input.source,
    }

    await writeRecord(meta, data)
    // Prime the romajiCapable cache from the text already in hand, so the
    // next list/get call is a cache hit instead of re-reading the file we
    // just wrote.
    setCachedRomajiCapable(meta, isKanaOnlyText(text))

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
  if (!validated.success || validated.data === undefined) {
    return fail(validated.errorCode ?? 'INVALID_NAME', validated.error ?? 'Invalid name')
  }
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
    // Content (parsed.text) is unchanged by a rename — carry the scan
    // forward under the new updatedAt instead of forcing a re-read on the
    // next list/get call.
    setCachedRomajiCapable(meta, isKanaOnlyText(parsed.text))

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
