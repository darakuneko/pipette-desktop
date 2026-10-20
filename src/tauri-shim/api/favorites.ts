// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI favorite store members for the Tauri build
// (src-tauri/src/store_commands/favorites.rs). The writes of a type's
// favorites are queued under `favorites/{type}`, the key the backend locks,
// so they reach the backend one at a time in the order the renderer made
// them; the list, the load and the export's read go without waiting. A
// private Hub link crosses as the text of
// JSON.stringify(link), so the backend keeps its keys in their order.
//
// The export and the import convert keycodes, which happens in a worker
// with its own keycode tables (workers/favorite-transfer.worker.ts): the
// backend reads the stored favorites and saves the file the worker built,
// or reads the file the user picks and stores the batches the worker made
// of it. The members check the arguments before those steps and answer
// every failure as `{ success: false, error }`.

import { isValidFavoriteType, isValidVialProtocol } from '../../shared/favorite-data'
import type { FavoriteExportBody, FavoriteImportEntry } from '../../shared/favorite-transfer'
import type { FavoriteImportResult, FavoriteType, SavedFavoriteMeta } from '../../shared/types/favorite-store'
import type { VialAPI } from '../../shared/types/vial-api'
import type { FileOpenResult } from '../generated/FileOpenResult'
import type { FileSaveResult } from '../generated/FileSaveResult'
import { call } from '../ipc'
import { enqueue } from '../key-queue'
import { transfer } from '../workers/favorite-transfer-client'

type Result = { success: boolean; error?: string }

/** The write-lock key of a type's favorites, the name of its sync unit. */
const key = (type: unknown): string => `favorites/${String(type)}`

/** The live favorites an export reads. */
export function readForExport(
  type: FavoriteType,
  entryId: string | undefined,
): Promise<{ success: boolean; entries?: FavoriteExportBody[]; error?: string }> {
  return call('favorite_store_read_for_export', { favoriteType: type, entryId })
}

/** Saves an export file where the user chooses. */
export function saveExport(defaultFilename: string, content: string): Promise<FileSaveResult> {
  return call('favorite_store_save_export', { defaultFilename, content })
}

/** The text of the export file the user picks. */
export function openImport(): Promise<FileOpenResult> {
  return call('favorite_store_open_import')
}

/** Stores one type's converted favorites of an import. The entries cross
 *  as the text of JSON.stringify(entries), so a label keeps a lone
 *  surrogate. */
export function importBatch(
  type: FavoriteType,
  entries: FavoriteImportEntry[],
): Promise<{ success: boolean; imported?: number; skipped?: number; error?: string }> {
  const text = JSON.stringify(entries)
  return enqueue(key(type), () => call('favorite_store_import_batch', { favoriteType: type, entries: text }))
}

/** `{ success }` of a save, without the path the export does not answer. */
function saved(result: FileSaveResult): Result {
  return result.success ? { success: true } : { success: false, error: result.error }
}

async function exportStored(scope: unknown, vialProtocol: unknown, entryId?: unknown): Promise<Result> {
  if (!isValidFavoriteType(scope)) return { success: false, error: 'Invalid scope' }
  if (!isValidVialProtocol(vialProtocol)) return { success: false, error: 'Invalid vialProtocol' }
  if (entryId !== undefined && typeof entryId !== 'string') return { success: false, error: 'Invalid entryId' }

  const read = await readForExport(scope, entryId)
  if (!read.success) return { success: false, error: read.error }
  const bodies = read.entries ?? []
  const built = await transfer({ op: 'export', scope, vialProtocol, bodies, single: entryId !== undefined })
  if ('error' in built) return { success: false, error: built.error }
  return saved(await saveExport(built.defaultFilename, built.content))
}

async function exportCurrent(scope: unknown, vialProtocol: unknown, dataJson: unknown): Promise<Result> {
  if (!isValidFavoriteType(scope)) return { success: false, error: 'Invalid scope' }
  if (!isValidVialProtocol(vialProtocol)) return { success: false, error: 'Invalid vialProtocol' }
  if (typeof dataJson !== 'string') return { success: false, error: 'Invalid data' }

  const built = await transfer({ op: 'exportCurrent', scope, vialProtocol, dataJson })
  if ('error' in built) return { success: false, error: built.error }
  return saved(await saveExport(built.defaultFilename, built.content))
}

async function importToCurrent(scope: unknown): Promise<{ success: boolean; data?: unknown; error?: string }> {
  if (!isValidFavoriteType(scope)) return { success: false, error: 'Invalid scope' }
  const opened = await openImport()
  if (!opened.success) return { success: false, error: opened.error }
  const current = await transfer({ op: 'importToCurrent', scope, raw: opened.data ?? '' })
  if ('error' in current) return { success: false, error: current.error }
  return { success: true, data: current.data }
}

async function importFile(): Promise<FavoriteImportResult> {
  const failed = (error?: string): FavoriteImportResult => ({ success: false, imported: 0, skipped: 0, error })
  const opened = await openImport()
  if (!opened.success) return failed(opened.error)
  const prepared = await transfer({ op: 'import', raw: opened.data ?? '' })
  if ('error' in prepared) return failed(prepared.error)

  const { batches, failure } = prepared.plan
  let { skipped } = prepared.plan
  let imported = 0
  for (const batch of batches) {
    const stored = await importBatch(batch.type, batch.entries)
    if (!stored.success) return failed(stored.error)
    imported += stored.imported ?? 0
    skipped += stored.skipped ?? 0
  }
  if (failure !== undefined) return failed(failure)
  return { success: true, imported, skipped }
}

/** `run`'s answer, or a thrown error answered with its `String(err)`. */
async function caught<T>(run: () => Promise<T>, failed: (error: string) => T): Promise<T> {
  try {
    return await run()
  } catch (err) {
    return failed(String(err))
  }
}

export const favoritesApi = {
  favoriteStoreList: (type) =>
    call<{ success: boolean; entries?: SavedFavoriteMeta[]; error?: string }>('favorite_store_list', { favoriteType: type }),
  favoriteStoreSave: (type, json, label) =>
    enqueue(key(type), () =>
      call<{ success: boolean; entry?: SavedFavoriteMeta; error?: string }>('favorite_store_save', {
        favoriteType: type,
        json,
        label,
      }),
    ),
  favoriteStoreLoad: (type, entryId) =>
    call<{ success: boolean; data?: string; error?: string }>('favorite_store_load', { favoriteType: type, entryId }),
  favoriteStoreRename: (type, entryId, newLabel) =>
    enqueue(key(type), () => call<Result>('favorite_store_rename', { favoriteType: type, entryId, newLabel })),
  favoriteStoreDelete: (type, entryId) =>
    enqueue(key(type), () => call<Result>('favorite_store_delete', { favoriteType: type, entryId })),
  favoriteStoreSetHubPostId: (type, entryId, hubPostId) =>
    enqueue(key(type), () => call<Result>('favorite_store_set_hub_post_id', { favoriteType: type, entryId, hubPostId })),
  favoriteStoreSetHubPrivate: (type, entryId, link) => {
    const text = JSON.stringify(link)
    return enqueue(key(type), () =>
      call<Result>('favorite_store_set_hub_private', { favoriteType: type, entryId, link: text }),
    )
  },
  favoriteStoreExport: (scope, vialProtocol, entryId?) =>
    caught(() => exportStored(scope, vialProtocol, entryId), (error) => ({ success: false, error })),
  favoriteStoreExportCurrent: (scope, vialProtocol, data) =>
    caught(() => exportCurrent(scope, vialProtocol, data), (error) => ({ success: false, error })),
  favoriteStoreImportToCurrent: (scope) => caught(() => importToCurrent(scope), (error) => ({ success: false, error })),
  favoriteStoreImport: () => caught(importFile, (error) => ({ success: false, imported: 0, skipped: 0, error })),
} satisfies Partial<VialAPI>
