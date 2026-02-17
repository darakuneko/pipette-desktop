// SPDX-License-Identifier: GPL-2.0-or-later
// Internal favorite store — save/load individual entry snapshots within app userData

import { app } from 'electron'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { IpcChannels } from '../shared/ipc/channels'
import { isValidFavoriteType } from '../shared/favorite-data'
import { notifyChange } from './sync/sync-service'
import { secureHandle } from './ipc-guard'
import type { FavoriteType, SavedFavoriteMeta, FavoriteIndex } from '../shared/types/favorite-store'

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
        const filename = `${type}_${timestamp}.json`
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
        const index = await readIndex(type)
        const entry = index.entries.find((e) => e.id === entryId)
        if (!entry) {
          return { success: false, error: 'Entry not found' }
        }
        if (entry.deletedAt) {
          return { success: false, error: 'Entry has been deleted' }
        }

        const filePath = getSafeFilePath(type, entry.filename)
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
        const index = await readIndex(type)
        const entry = index.entries.find((e) => e.id === entryId)
        if (!entry) {
          return { success: false, error: 'Entry not found' }
        }

        entry.label = newLabel
        entry.updatedAt = new Date().toISOString()
        await writeIndex(type, index)
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
        const index = await readIndex(type)
        const entry = index.entries.find((e) => e.id === entryId)
        if (!entry) {
          return { success: false, error: 'Entry not found' }
        }

        const now = new Date().toISOString()
        entry.deletedAt = now
        entry.updatedAt = now
        await writeIndex(type, index)
        notifyChange(`favorites/${type}`)
        return { success: true }
      } catch (err) {
        return { success: false, error: String(err) }
      }
    },
  )
}
