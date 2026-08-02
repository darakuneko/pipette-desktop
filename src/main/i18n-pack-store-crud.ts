// SPDX-License-Identifier: GPL-2.0-or-later
//
// Public CRUD API for the i18n pack store, plus the built-in English
// entry it depends on (`listMetas` → `ensureBuiltinEnglishEntry` is the
// only edge crossing into this module from the rest of the split).

import { dialog, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { notifyChange } from './sync/sync-service'
import { safeFilename, isSafePackId } from './utils/safe-filename'
import {
  BUILTIN_ENGLISH_PACK_ID,
  I18N_INDEX_SYNC_UNIT,
  type I18nPackMeta,
  type I18nPackRecord,
} from '../shared/types/i18n-store'
import {
  PACKS_DIRNAME,
  fail,
  findActiveByName,
  getPackPath,
  getPacksDir,
  getStoreDir,
  notifyPackChange,
  nowIso,
  ok,
  readIndex,
  resolveOptionalField,
  withIndexWriteLock,
  writeIndex,
  type I18nPackStoreResult,
} from './i18n-pack-store-internal'

/**
 * Make sure the index has a built-in English entry. Mirrors
 * `key-label-store.ts`'s `ensureQwertyEntry`: promoting English from a
 * renderer-synthesized row to a real store entry lets it participate in
 * drag reorder and Name sort like any imported pack, while its position
 * and rename history survive sync via the stable `BUILTIN_ENGLISH_PACK_ID`.
 *
 * The pack body is a trivial placeholder (`{ name, version }`, no
 * translation keys) — unlike QWERTY's empty `map` (which the renderer
 * falls back to reading), English is never actually rendered from this
 * entry's body; the renderer always uses the bundled
 * `src/renderer/i18n/locales/english.json` directly. The placeholder
 * only needs to satisfy `extractHeader`'s name/version requirement so
 * `getPack` stays uniform across every id (no special-casing needed
 * there, or in `export`/`rename`, which are intentionally left
 * store-level-unguarded — same as QWERTY. Only delete is guarded, below).
 *
 * The body is also deliberately excluded from `collectAllSyncUnits`
 * (`sync-bundle.ts`) and from `notifyPackChange` — every machine
 * ensures the same trivial content locally, so syncing it would just
 * be wasted bandwidth for a file that is never read.
 */
async function ensureBuiltinEnglishEntry(): Promise<void> {
  return withIndexWriteLock(async () => {
    const index = await readIndex()
    const existing = index.metas.find((m) => m.id === BUILTIN_ENGLISH_PACK_ID)
    if (existing) {
      // Self-heal: a synced remote index can deliver this meta before
      // this machine has ever created the local body file (the body
      // is excluded from sync — see above — so only the meta arrives
      // remotely). Recreate the placeholder so `getPack` doesn't
      // IO_ERROR; no index change, so no notifyChange here.
      await writeBuiltinEnglishBodyIfMissing()
      return
    }

    const now = nowIso()
    const meta: I18nPackMeta = {
      id: BUILTIN_ENGLISH_PACK_ID,
      filename: `${PACKS_DIRNAME}/${BUILTIN_ENGLISH_PACK_ID}.json`,
      name: 'English',
      version: '0.0.0',
      enabled: true,
      uploaderName: 'pipette',
      savedAt: now,
      updatedAt: now,
    }
    await writeBuiltinEnglishBodyIfMissing()

    // Pin English to the head on first creation (migration for existing
    // installs) so the visual position matches the pre-migration
    // synthesized-always-first row — the user can drag it elsewhere
    // afterwards, same as QWERTY.
    index.metas.unshift(meta)
    await writeIndex(index)
    // Index only — never notifyChange the per-pack sync unit for this id
    // (see the module doc above: its body is placeholder and excluded
    // from sync entirely).
    notifyChange(I18N_INDEX_SYNC_UNIT)
  })
}

async function writeBuiltinEnglishBodyIfMissing(): Promise<void> {
  try {
    await access(getPackPath(BUILTIN_ENGLISH_PACK_ID))
    return
  } catch {
    // missing — fall through and (re)create it
  }
  await mkdir(getPacksDir(), { recursive: true })
  await writeFile(getPackPath(BUILTIN_ENGLISH_PACK_ID), JSON.stringify({ name: 'English', version: '0.0.0' }, null, 2), 'utf-8')
}

// --- Public API --------------------------------------------------------------

export async function listMetas(): Promise<I18nPackMeta[]> {
  await ensureBuiltinEnglishEntry()
  const index = await readIndex()
  return index.metas.filter((m) => !m.deletedAt)
}

export async function listAllMetas(): Promise<I18nPackMeta[]> {
  await ensureBuiltinEnglishEntry()
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
  /** Hub-side `updated_at` for the just-downloaded pack. Pass on
   *  hub-download / hub-sync paths so the startup auto-update can
   *  compare against `POST /api/i18n-packs/timestamps` later. `null`
   *  explicitly clears any inherited value (e.g. detach from Hub). */
  hubUpdatedAt?: string | null
  /** Hub-side `uploader_name`. Same three-state (`null` clears,
   *  `undefined` inherits, string adopts) as `hubUpdatedAt`. */
  uploaderName?: string | null
  appVersionAtImport?: string
  /** English baseline version this pack covered at save time, or null
   * when coverage was partial. Persisted on the meta and surfaced in
   * the language pack list. */
  matchedBaseVersion?: string | null
  /** Coverage snapshot for the row's status line. */
  coverage?: { totalKeys: number; coveredKeys: number } | null
  dangerousKeyCount?: number | null
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
  // Never let an import target the built-in English id directly —
  // overwriting its placeholder body would corrupt the row the
  // renderer specially renders (see `ensureBuiltinEnglishEntry`'s
  // doc). No legitimate caller passes this explicitly; defense in
  // depth alongside the name-based exclusion below.
  if (input.id === BUILTIN_ENGLISH_PACK_ID) {
    // Wording constraint: electron-vite's CJS-shim injector regex-scans
    // the bundled chunk for static imports, and a string ending in the
    // token `import` right before a quote (`...import'`) false-matches
    // as a side-effect import — the shims then get spliced into the
    // middle of the chunk and the main build fails with "Unterminated
    // string literal". Keep the word "import" away from the end of
    // this (and any main-process) string literal.
    return fail('INVALID_NAME', 'The built-in English pack cannot be overwritten')
  }

  return withIndexWriteLock(async () => {
    try {
      const index = await readIndex()
      // Auto-overwrite path: if the caller did not specify an id but
      // an active entry already shares this name (case-insensitive),
      // adopt that entry's id so the import replaces the existing pack
      // instead of failing with DUPLICATE_NAME. Mirrors KeyLabels —
      // except the built-in English entry is never adopted this way:
      // its name is unconditionally "taken", so a same-named import
      // without an explicit id falls through to the DUPLICATE_NAME
      // check below instead of silently overwriting the built-in row.
      let resolvedId = input.id
      if (!resolvedId) {
        const existingByName = findActiveByName(index.metas, header.name)
        if (existingByName && existingByName.id !== BUILTIN_ENGLISH_PACK_ID) {
          resolvedId = existingByName.id
        }
      }
      if (findActiveByName(index.metas, header.name, resolvedId)) {
        return fail('DUPLICATE_NAME', 'A language pack with the same name already exists')
      }

      const id = resolvedId ?? randomUUID()
      if (!isSafePackId(id)) return fail('INVALID_FILE', 'Generated pack id is unsafe')

      await mkdir(getPacksDir(), { recursive: true })
      await writeFile(getPackPath(id), JSON.stringify(input.pack, null, 2), 'utf-8')

      const now = nowIso()
      const existing = index.metas.find((m) => m.id === id)
      // hubUpdatedAt: empty/whitespace string is treated the same as null
      // (explicit clear) so a stray '' from a Hub response never persists.
      const hubUpdatedAtInput = typeof input.hubUpdatedAt === 'string'
        ? (input.hubUpdatedAt.trim() || null)
        : input.hubUpdatedAt
      // uploaderName follows the same empty-string-as-clear rule as hubUpdatedAt.
      const uploaderNameInput = typeof input.uploaderName === 'string'
        ? (input.uploaderName.trim() || null)
        : input.uploaderName
      const nextHubPostId = resolveOptionalField(input.hubPostId, existing?.hubPostId)
      const nextHubUpdatedAt = resolveOptionalField(hubUpdatedAtInput, existing?.hubUpdatedAt)
      const nextUploaderName = resolveOptionalField(uploaderNameInput, existing?.uploaderName)
      const nextMatchedBaseVersion = resolveOptionalField(input.matchedBaseVersion, existing?.matchedBaseVersion)
      const nextCoverage = resolveOptionalField(input.coverage, existing?.coverage)
      const nextDangerousKeyCount = resolveOptionalField(input.dangerousKeyCount, existing?.dangerousKeyCount)
      const meta: I18nPackMeta = {
        id,
        filename: `${PACKS_DIRNAME}/${id}.json`,
        name: header.name,
        version: header.version,
        enabled: input.enabled ?? existing?.enabled ?? true,
        hubPostId: nextHubPostId,
        ...(nextHubUpdatedAt ? { hubUpdatedAt: nextHubUpdatedAt } : {}),
        ...(nextUploaderName ? { uploaderName: nextUploaderName } : {}),
        savedAt: existing?.savedAt ?? now,
        updatedAt: now,
        ...(input.appVersionAtImport ? { appVersionAtImport: input.appVersionAtImport } : {}),
        ...(nextMatchedBaseVersion ? { matchedBaseVersion: nextMatchedBaseVersion } : {}),
        ...(nextCoverage ? { coverage: nextCoverage } : {}),
        ...(typeof nextDangerousKeyCount === 'number' ? { dangerousKeyCount: nextDangerousKeyCount } : {}),
      }

      const existingIndex = index.metas.findIndex((m) => m.id === id)
      if (existingIndex >= 0) {
        index.metas[existingIndex] = meta
      } else {
        index.metas.push(meta)
      }
      await writeIndex(index)

      notifyPackChange(id)
      notifyChange(I18N_INDEX_SYNC_UNIT)
      return ok(meta)
    } catch (err) {
      return fail('IO_ERROR', String(err))
    }
  })
}

export async function renamePack(id: string, newName: string): Promise<I18nPackStoreResult<I18nPackMeta>> {
  const trimmed = typeof newName === 'string' ? newName.trim() : ''
  if (!trimmed) return fail('INVALID_NAME', 'Name must not be empty')
  if (trimmed.length > 64) return fail('INVALID_NAME', 'Name must be at most 64 characters')

  return withIndexWriteLock(async () => {
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

      notifyPackChange(id)
      notifyChange(I18N_INDEX_SYNC_UNIT)
      return ok(meta)
    } catch (err) {
      return fail('IO_ERROR', String(err))
    }
  })
}

export async function setEnabled(id: string, enabled: boolean): Promise<I18nPackStoreResult<I18nPackMeta>> {
  return withIndexWriteLock(async () => {
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
  })
}

export async function deletePack(id: string): Promise<I18nPackStoreResult<void>> {
  if (id === BUILTIN_ENGLISH_PACK_ID) {
    return fail('INVALID_NAME', 'English cannot be deleted')
  }
  return withIndexWriteLock(async () => {
    try {
      const index = await readIndex()
      const meta = index.metas.find((m) => m.id === id)
      if (!meta) return fail('NOT_FOUND', 'Language pack not found')

      const now = nowIso()
      meta.deletedAt = now
      meta.updatedAt = now
      meta.enabled = false
      await writeIndex(index)

      notifyPackChange(id)
      notifyChange(I18N_INDEX_SYNC_UNIT)
      return ok()
    } catch (err) {
      return fail('IO_ERROR', String(err))
    }
  })
}

/**
 * `uploaderName` / `hubUpdatedAt` mirror `key-label-store.ts`'s
 * `setHubPostId`: `undefined` leaves the cached value alone (Update
 * intentionally passes `undefined` for uploaderName — the owner is
 * assumed unchanged), a string adopts the new value, and an
 * empty/whitespace string clears it. Detaching (`hubPostId: null`)
 * always drops `hubUpdatedAt` (meaningless once unlinked) but keeps
 * `uploaderName` unless the caller explicitly clears it too.
 */
export async function setHubPostId(
  id: string,
  hubPostId: string | null,
  uploaderName?: string | null,
  hubUpdatedAt?: string | null,
): Promise<I18nPackStoreResult<I18nPackMeta>> {
  return withIndexWriteLock(async () => {
    try {
      const index = await readIndex()
      const meta = index.metas.find((m) => m.id === id)
      if (!meta) return fail('NOT_FOUND', 'Language pack not found')
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
      notifyChange(I18N_INDEX_SYNC_UNIT)
      return ok(meta)
    } catch (err) {
      return fail('IO_ERROR', String(err))
    }
  })
}

export async function hasActiveName(name: string, excludeId?: string): Promise<boolean> {
  const index = await readIndex()
  return Boolean(findActiveByName(index.metas, name, excludeId))
}

/**
 * Apply a manual order to the active metas. Mirrors
 * `key-label-store.ts`'s `reorderActive`: tombstones and any ids not
 * listed in `orderedIds` keep their relative position behind the
 * sorted prefix, so a stale renderer view never silently drops an
 * entry. Only the index changes — pack bodies are untouched — so only
 * `I18N_INDEX_SYNC_UNIT` is bumped, matching `setEnabled`/`setHubPostId`.
 *
 * Like `key-labels`, `i18n/index` now has entry-level LWW merge wired
 * into `sync-service.ts` (`mergeSyncedIndex`, with `preserveLocalOrder`
 * so drag/Name-sort order survives the merge) — a remote index
 * downloaded during sync merges against this reordered one instead of
 * one side replacing the other wholesale.
 */
export async function reorderActive(orderedIds: string[]): Promise<I18nPackStoreResult<void>> {
  return withIndexWriteLock(async () => {
    try {
      const index = await readIndex()
      const byId = new Map<string, I18nPackMeta>()
      for (const meta of index.metas) byId.set(meta.id, meta)

      const seen = new Set<string>()
      const reordered: I18nPackMeta[] = []
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
      notifyChange(I18N_INDEX_SYNC_UNIT)
      return ok()
    } catch (err) {
      return fail('IO_ERROR', String(err))
    }
  })
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
