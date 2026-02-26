// SPDX-License-Identifier: GPL-2.0-or-later
// Internal favorite store — save/load individual entry snapshots within app userData

import { app, dialog, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { IpcChannels } from '../shared/ipc/channels'
import { isValidFavoriteType, isFavoriteDataFile, FAV_EXPORT_KEY_MAP, FAV_TYPE_TO_EXPORT_KEY, isValidFavExportFile, serializeFavData, deserializeFavData } from '../shared/favorite-data'
import { serialize as serializeKeycode, deserialize as deserializeKeycode } from '../shared/keycodes/keycodes'
import { notifyChange } from './sync/sync-service'
import { secureHandle } from './ipc-guard'
import type { FavoriteType, SavedFavoriteMeta, FavoriteIndex, FavoriteExportEntry, FavoriteImportResult } from '../shared/types/favorite-store'

function isSafePathSegment(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..') return false
  return !/[/\\]/.test(segment)
}

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
  await writeFile(getIndexPath(type), JSON.stringify(index, null, 2), 'utf-8')
}

async function findEntry(type: FavoriteType, entryId: string): Promise<{ index: FavoriteIndex; entry: SavedFavoriteMeta } | null> {
  const index = await readIndex(type)
  const entry = index.entries.find((e) => e.id === entryId)
  if (!entry) return null
  return { index, entry }
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
        const dir = getFavoriteDir(type)
        await mkdir(dir, { recursive: true })

        const now = new Date()
        const timestamp = now.toISOString().replace(/:/g, '-')
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
        const found = await findEntry(type, entryId)
        if (!found) return { success: false, error: 'Entry not found' }

        found.entry.label = newLabel
        found.entry.updatedAt = new Date().toISOString()
        await writeIndex(type, found.index)
        notifyChange(`favorites/${type}`)
        return { success: true }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  secureHandle(
    IpcChannels.FAVORITE_STORE_DELETE,
    async (_event, type: unknown, entryId: string): Promise<{ success: boolean; error?: string }> => {
      try {
        validateType(type)
        const found = await findEntry(type, entryId)
        if (!found) return { success: false, error: 'Entry not found' }

        const now = new Date().toISOString()
        found.entry.deletedAt = now
        found.entry.updatedAt = now
        await writeIndex(type, found.index)
        notifyChange(`favorites/${type}`)
        return { success: true }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )

  // --- Export ---
  secureHandle(
    IpcChannels.FAVORITE_STORE_EXPORT,
    async (event, scope: unknown, entryId?: unknown): Promise<{ success: boolean; error?: string }> => {
      try {
        const win = BrowserWindow.fromWebContents(event.sender)
        if (!win) return { success: false, error: 'No window' }

        if (!isValidFavoriteType(scope)) return { success: false, error: 'Invalid scope' }
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
              data: serializeFavData(scope, parsed.data, serializeKeycode),
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
        const ts = now.toISOString().replace(/:/g, '').replace(/\.\d+Z$/, '').replace('T', '-')
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

        const exportFile = {
          app: 'pipette' as const,
          version: 2 as const,
          scope: 'fav' as const,
          exportedAt: now.toISOString(),
          categories,
        }

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
        const found = await findEntry(type, entryId)
        if (!found) return { success: false, error: 'Entry not found' }

        const normalized = hubPostId?.trim() || null
        if (normalized === null) {
          delete found.entry.hubPostId
        } else {
          found.entry.hubPostId = normalized
        }
        found.entry.updatedAt = new Date().toISOString()
        await writeIndex(type, found.index)
        notifyChange(`favorites/${type}`)
        return { success: true }
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

          const index = await readIndex(favType)
          const dir = getFavoriteDir(favType)
          await mkdir(dir, { recursive: true })

          for (const entry of entries) {
            const normalizedData = deserializeFavData(favType, entry.data, deserializeKeycode)
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
            const timestamp = now.toISOString().replace(/:/g, '-')
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
            changedTypes.add(favType)
          }

          if (changedTypes.has(favType)) {
            await writeIndex(favType, index)
          }
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
