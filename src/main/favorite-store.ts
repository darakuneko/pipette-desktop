// SPDX-License-Identifier: GPL-2.0-or-later
// Internal favorite store — save/load individual entry snapshots within app userData

import { app, dialog, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { IpcChannels } from '../shared/ipc/channels'
import { isValidFavoriteType, isValidVialProtocol, isFavoriteDataFile, FAV_EXPORT_KEY_MAP, FAV_TYPE_TO_EXPORT_KEY, isValidFavExportFile, buildFavExportFile, serializeFavData, deserializeFavData } from '../shared/favorite-data'
import { serialize as serializeKeycode, deserialize as deserializeKeycode } from '../shared/keycodes/keycodes'
import { withDeserializeProtocol, withSerializeProtocol } from '../shared/keycodes/with-protocol'
import { notifyChange } from './sync/sync-service'
import { withWriteLock } from './per-uid-write-lock'
import { secureHandle } from './ipc-guard'
import { isSafePathSegment, tsForFilename, tsForExportFilename } from './utils/safe-filename'
import { writeFileAtomic } from './utils/write-file-atomic'
import type { FavoriteType, SavedFavoriteMeta, FavoriteIndex, FavoriteExportEntry, FavoriteImportResult } from '../shared/types/favorite-store'
import type { HubPrivateLink } from '../shared/types/hub-private'

function validateType(type: unknown): asserts type is FavoriteType {
  if (!isValidFavoriteType(type)) throw new Error('Invalid favorite type')
}

function getFavoriteDir(type: FavoriteType): string {
  return join(app.getPath('userData'), 'sync', 'favorites', type)
}

function getIndexPath(type: FavoriteType): string {
  return join(getFavoriteDir(type), 'index.json')
}

function getSafeFilePath(type: FavoriteType, filename: string): string {
  if (!isSafePathSegment(filename)) throw new Error('Invalid filename')
  return join(getFavoriteDir(type), filename)
}

async function readIndex(type: FavoriteType): Promise<FavoriteIndex> {
  try {
    const raw = await readFile(getIndexPath(type), 'utf-8')
    const parsed = JSON.parse(raw) as FavoriteIndex
    if (parsed.type === type && Array.isArray(parsed.entries)) {
      return parsed
    }
  } catch {
    // Index does not exist or is corrupt — return empty
  }
  return { type, entries: [] }
}

async function writeIndex(type: FavoriteType, index: FavoriteIndex): Promise<void> {
  const dir = getFavoriteDir(type)
  await mkdir(dir, { recursive: true })
  await writeFileAtomic(getIndexPath(type), JSON.stringify(index, null, 2))
}

async function findEntry(type: FavoriteType, entryId: string): Promise<{ index: FavoriteIndex; entry: SavedFavoriteMeta } | null> {
  const index = await readIndex(type)
  const entry = index.entries.find((e) => e.id === entryId)
  if (!entry) return null
  return { index, entry }
}

/** Locked find → mutate → write → notify for a single entry, mirroring
 *  `snapshot-store.ts`'s `updateEntry`. Locking every mutation (not just
 *  SAVE) against the same `favorites/{type}` key closes the other half of
 *  the race SAVE was already locked against: without this, a RENAME/
 *  DELETE/SET_HUB_* read-modify-write of the index could still land
 *  between a concurrent SAVE's or import's own read and write. `type` is
 *  the caller's already-validated `FavoriteType`, matching SAVE's own
 *  validate-then-lock order. */
async function updateEntry(
  type: FavoriteType,
  entryId: string,
  mutate: (entry: SavedFavoriteMeta) => void,
): Promise<{ success: boolean; error?: string }> {
  return withWriteLock(`favorites/${type}`, async () => {
    try {
      const found = await findEntry(type, entryId)
      if (!found) return { success: false, error: 'Entry not found' }

      mutate(found.entry)
      found.entry.updatedAt = new Date().toISOString()
      await writeIndex(type, found.index)
      notifyChange(`favorites/${type}`)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })
}

export function setupFavoriteStore(): void {
  secureHandle(
    IpcChannels.FAVORITE_STORE_LIST,
    async (_event, type: unknown): Promise<{ success: boolean; entries?: SavedFavoriteMeta[]; error?: string }> => {
      try {
        validateType(type)
        const index = await readIndex(type)
        return { success: true, entries: index.entries.filter((e) => !e.deletedAt) }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.FAVORITE_STORE_SAVE,
    async (
      _event,
      type: unknown,
      json: string,
      label: string,
    ): Promise<{ success: boolean; entry?: SavedFavoriteMeta; error?: string }> => {
      try {
        validateType(type)
        // Locked against a concurrent local-data import touching the same
        // `favorites/{type}` unit — both read-modify-write the index, and
        // without the shared lock one writer's read can be stale by the
        // time it writes, silently dropping the other's entry.
        return await withWriteLock(`favorites/${type}`, async () => {
          const dir = getFavoriteDir(type)
          await mkdir(dir, { recursive: true })

          const now = new Date()
          const timestamp = tsForFilename(now)
          const filename = `${type}_${timestamp}_${randomUUID().slice(0, 8)}.json`
          const filePath = getSafeFilePath(type, filename)

          await writeFile(filePath, json, 'utf-8')

          const nowIso = now.toISOString()
          const entry: SavedFavoriteMeta = {
            id: randomUUID(),
            label,
            filename,
            savedAt: nowIso,
            updatedAt: nowIso,
          }

          const index = await readIndex(type)
          index.entries.unshift(entry)
          await writeIndex(type, index)

          notifyChange(`favorites/${type}`)
          return { success: true, entry }
        })
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.FAVORITE_STORE_LOAD,
    async (_event, type: unknown, entryId: string): Promise<{ success: boolean; data?: string; error?: string }> => {
      try {
        validateType(type)
        const found = await findEntry(type, entryId)
        if (!found) return { success: false, error: 'Entry not found' }
        if (found.entry.deletedAt) return { success: false, error: 'Entry has been deleted' }

        const filePath = getSafeFilePath(type, found.entry.filename)
        const data = await readFile(filePath, 'utf-8')
        return { success: true, data }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.FAVORITE_STORE_RENAME,
    async (_event, type: unknown, entryId: string, newLabel: string): Promise<{ success: boolean; error?: string }> => {
      try {
        validateType(type)
      } catch (err) {
        return { success: false, error: String(err) }
      }
      return updateEntry(type, entryId, (entry) => { entry.label = newLabel })
    },
  )

  secureHandle(
    IpcChannels.FAVORITE_STORE_DELETE,
    async (_event, type: unknown, entryId: string): Promise<{ success: boolean; error?: string }> => {
      try {
        validateType(type)
      } catch (err) {
        return { success: false, error: String(err) }
      }
      return updateEntry(type, entryId, (entry) => { entry.deletedAt = new Date().toISOString() })
    },
  )

  // --- Export ---
  secureHandle(
    IpcChannels.FAVORITE_STORE_EXPORT,
    async (event, scope: unknown, vialProtocol: unknown, entryId?: unknown): Promise<{ success: boolean; error?: string }> => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) return { success: false, error: 'No window' }

        if (!isValidFavoriteType(scope)) return { success: false, error: 'Invalid scope' }
        if (!isValidVialProtocol(vialProtocol)) return { success: false, error: 'Invalid vialProtocol' }
        if (entryId !== undefined && typeof entryId !== 'string') return { success: false, error: 'Invalid entryId' }

        const index = await readIndex(scope)
        const exportKey = FAV_TYPE_TO_EXPORT_KEY[scope]

        // Single entry or all active entries
        const targetEntries = typeof entryId === 'string'
          ? index.entries.filter((e) => e.id === entryId && !e.deletedAt)
          : index.entries.filter((e) => !e.deletedAt)

        // Fail fast if single-entry export finds nothing
        if (typeof entryId === 'string' && targetEntries.length === 0) {
          return { success: false, error: 'Entry not found' }
        }

        const exportEntries: FavoriteExportEntry[] = []
        for (const entry of targetEntries) {
          try {
            const filePath = getSafeFilePath(scope, entry.filename)
            const raw = await readFile(filePath, 'utf-8')
            const parsed = JSON.parse(raw) as Record<string, unknown>
            if (parsed.data == null) continue
            exportEntries.push({
              label: entry.label,
              savedAt: entry.savedAt,
              data: withSerializeProtocol(vialProtocol, () => serializeFavData(scope, parsed.data, serializeKeycode)),
            })
          } catch {
            // Skip unreadable entries
          }
        }

        // For single-entry export, fail if file was unreadable
        if (typeof entryId === 'string' && exportEntries.length === 0) {
          return { success: false, error: 'Entry unreadable' }
        }

        const categories: Record<string, FavoriteExportEntry[]> = exportEntries.length > 0
          ? { [exportKey]: exportEntries }
          : {}

        const now = new Date()
        const ts = tsForExportFilename(now)
        const defaultFilename = `pipette-fav-${exportKey}-${ts}.json`

        const result = await dialog.showSaveDialog(win, {
          title: 'Export Favorites',
          defaultPath: defaultFilename,
          filters: [
            { name: 'JSON', extensions: ['json'] },
            { name: 'All Files', extensions: ['*'] },
          ],
        })

        if (result.canceled || !result.filePath) {
          return { success: false, error: 'cancelled' }
        }

        const exportFile = buildFavExportFile(vialProtocol, categories, now.toISOString())

        await writeFile(result.filePath, JSON.stringify(exportFile, null, 2), 'utf-8')
        return { success: true }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  // --- Export Current (live state without saving first) ---
  secureHandle(
    IpcChannels.FAVORITE_STORE_EXPORT_CURRENT,
    async (event, scope: unknown, vialProtocol: unknown, dataJson: unknown): Promise<{ success: boolean; error?: string }> => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) return { success: false, error: 'No window' }

        if (!isValidFavoriteType(scope)) return { success: false, error: 'Invalid scope' }
        if (!isValidVialProtocol(vialProtocol)) return { success: false, error: 'Invalid vialProtocol' }
        if (typeof dataJson !== 'string') return { success: false, error: 'Invalid data' }

        const parsed = JSON.parse(dataJson) as Record<string, unknown>
        if (parsed.data == null) return { success: false, error: 'Missing data field' }

        const exportKey = FAV_TYPE_TO_EXPORT_KEY[scope]
        const serializedData = withSerializeProtocol(vialProtocol, () => serializeFavData(scope, parsed.data, serializeKeycode))

        const now = new Date()
        const ts = tsForExportFilename(now)
        const defaultFilename = `pipette-fav-${exportKey}-current-${ts}.json`

        const result = await dialog.showSaveDialog(win, {
          title: 'Export Favorites',
          defaultPath: defaultFilename,
          filters: [
            { name: 'JSON', extensions: ['json'] },
            { name: 'All Files', extensions: ['*'] },
          ],
        })

        if (result.canceled || !result.filePath) {
          return { success: false, error: 'cancelled' }
        }

        const exportFile = buildFavExportFile(
          vialProtocol,
          {
            [exportKey]: [{
              label: 'Current',
              savedAt: now.toISOString(),
              data: serializedData,
            }],
          },
          now.toISOString(),
        )

        await writeFile(result.filePath, JSON.stringify(exportFile, null, 2), 'utf-8')
        return { success: true }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  // --- Set Hub Post ID ---
  secureHandle(
    IpcChannels.FAVORITE_STORE_SET_HUB_POST_ID,
    async (_event, type: unknown, entryId: string, hubPostId: string | null): Promise<{ success: boolean; error?: string }> => {
      try {
        validateType(type)
      } catch (err) {
        return { success: false, error: String(err) }
      }
      const normalized = hubPostId?.trim() || null
      return updateEntry(type, entryId, (entry) => {
        if (normalized === null) {
          delete entry.hubPostId
        } else {
          entry.hubPostId = normalized
          // public and private linkage are mutually exclusive
          delete entry.hubPrivate
        }
      })
    },
  )

  secureHandle(
    IpcChannels.FAVORITE_STORE_SET_HUB_PRIVATE,
    async (_event, type: unknown, entryId: string, link: HubPrivateLink | null): Promise<{ success: boolean; error?: string }> => {
      try {
        validateType(type)
      } catch (err) {
        return { success: false, error: String(err) }
      }
      return updateEntry(type, entryId, (entry) => {
        if (link === null) {
          delete entry.hubPrivate
        } else {
          entry.hubPrivate = link
          delete entry.hubPostId
        }
      })
    },
  )

  // --- Import to Current (read file, return first matching entry data without saving) ---
  secureHandle(
    IpcChannels.FAVORITE_STORE_IMPORT_TO_CURRENT,
    async (event, scope: unknown): Promise<{ success: boolean; data?: unknown; error?: string }> => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) return { success: false, error: 'No window' }

        if (!isValidFavoriteType(scope)) return { success: false, error: 'Invalid scope' }

        const result = await dialog.showOpenDialog(win, {
          title: 'Import Favorites',
          filters: [
            { name: 'JSON', extensions: ['json'] },
            { name: 'All Files', extensions: ['*'] },
          ],
          properties: ['openFile'],
        })

        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, error: 'cancelled' }
        }

        const raw = await readFile(result.filePaths[0], 'utf-8')
        const parsed: unknown = JSON.parse(raw)

        if (!isValidFavExportFile(parsed)) {
          return { success: false, error: 'Invalid export file format' }
        }

        const exportKey = FAV_TYPE_TO_EXPORT_KEY[scope]
        const entries = parsed.categories[exportKey]
        if (!entries || entries.length === 0) {
          return { success: false, error: 'No matching data found for this type' }
        }

        const firstEntry = entries[0]
        const normalizedData = withDeserializeProtocol(parsed.vial_protocol, () =>
          deserializeFavData(scope, firstEntry.data, deserializeKeycode),
        )

        return { success: true, data: normalizedData }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  // --- Import ---
  secureHandle(
    IpcChannels.FAVORITE_STORE_IMPORT,
    async (event): Promise<FavoriteImportResult> => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) return { success: false, imported: 0, skipped: 0, error: 'No window' }

        const result = await dialog.showOpenDialog(win, {
          title: 'Import Favorites',
          filters: [
            { name: 'JSON', extensions: ['json'] },
            { name: 'All Files', extensions: ['*'] },
          ],
          properties: ['openFile'],
        })

        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, imported: 0, skipped: 0, error: 'cancelled' }
        }

        const raw = await readFile(result.filePaths[0], 'utf-8')
        const parsed: unknown = JSON.parse(raw)

        if (!isValidFavExportFile(parsed)) {
          return { success: false, imported: 0, skipped: 0, error: 'Invalid export file format' }
        }

        let imported = 0
        let skipped = 0
        const changedTypes = new Set<FavoriteType>()

        for (const [exportKey, entries] of Object.entries(parsed.categories)) {
          const favType = FAV_EXPORT_KEY_MAP[exportKey]
          if (!favType) { skipped += entries.length; continue }

          // Locked against a concurrent save/rename/delete/import of the
          // same type — see FAVORITE_STORE_SAVE's lock comment.
          const typeChanged = await withWriteLock(`favorites/${favType}`, async () => {
            const index = await readIndex(favType)
            const dir = getFavoriteDir(favType)
            await mkdir(dir, { recursive: true })

            let changed = false
            for (const entry of entries) {
              const normalizedData = withDeserializeProtocol(parsed.vial_protocol, () =>
                deserializeFavData(favType, entry.data, deserializeKeycode),
              )
              if (!isFavoriteDataFile({ type: favType, data: normalizedData }, favType)) {
                skipped++
                continue
              }

              const isDuplicate = index.entries.some(
                (existing) => !existing.deletedAt && existing.label === entry.label && existing.savedAt === entry.savedAt,
              )
              if (isDuplicate) {
                skipped++
                continue
              }

              const now = new Date()
              const timestamp = tsForFilename(now)
              const filename = `${favType}_${timestamp}_${randomUUID().slice(0, 8)}.json`
              const filePath = getSafeFilePath(favType, filename)

              await writeFile(filePath, JSON.stringify({ type: favType, data: normalizedData }), 'utf-8')

              const meta: SavedFavoriteMeta = {
                id: randomUUID(),
                label: entry.label,
                filename,
                savedAt: entry.savedAt,
                updatedAt: now.toISOString(),
              }

              index.entries.unshift(meta)
              imported++
              changed = true
            }

            if (changed) await writeIndex(favType, index)
            return changed
          })

          if (typeChanged) changedTypes.add(favType)
        }

        for (const favType of changedTypes) {
          notifyChange(`favorites/${favType}`)
        }

        return { success: true, imported, skipped }
      } catch (err) {
        return { success: false, imported: 0, skipped: 0, error: String(err) }
      }
    },
  )
}
