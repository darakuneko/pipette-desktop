// SPDX-License-Identifier: GPL-2.0-or-later
// The keycode conversion and file building of the favorite export and
// import: a stored favorite's keycodes become QMK names in an export file
// and numbers again on import, at the file's Vial protocol. Everything
// here reads the module-global keycode tables of
// src/shared/keycodes/keycodes.ts, so it must run where those tables are
// the defaults: the Electron main process (src/main/favorite-store.ts),
// or the Tauri build's worker
// (src/tauri-shim/workers/favorite-transfer.worker.ts), never the
// renderer, whose tables follow the connected keyboard.

import {
  FAV_EXPORT_KEY_MAP,
  FAV_TYPE_TO_EXPORT_KEY,
  buildFavExportFile,
  deserializeFavData,
  isFavoriteDataFile,
  isValidFavExportFile,
  isValidFavoriteType,
  serializeFavData,
} from './favorite-data'
import { deserialize as deserializeKeycode, serialize as serializeKeycode } from './keycodes/keycodes'
import { withDeserializeProtocol, withSerializeProtocol } from './keycodes/with-protocol'
import type { FavoriteExportEntry, FavoriteExportFile, FavoriteType } from './types/favorite-store'
import { tsForExportFilename } from './utils/safe-filename'

/** A stored favorite to export: its index entry's label and save time as
 *  they are, and the text of its body file. */
export interface FavoriteExportBody {
  label?: unknown
  savedAt?: unknown
  body: string
}

/** An export file to save, or why there is none. */
export type FavoriteExportBuild = { defaultFilename: string; content: string } | { error: string }

/** The text of an export file: two-space indented JSON. */
function exportText(vialProtocol: number, categories: Record<string, FavoriteExportEntry[]>, now: Date): string {
  return JSON.stringify(buildFavExportFile(vialProtocol, categories, now.toISOString()), null, 2)
}

/**
 * The export file of `bodies`, stored favorites of `scope`, with their
 * keycodes as names at `vialProtocol`. A body that is not JSON or has no
 * `data` is left out; `single` (the export of one entry) fails when that
 * leaves nothing.
 */
export function buildFavoriteExport(
  scope: FavoriteType,
  vialProtocol: number,
  bodies: readonly FavoriteExportBody[],
  single: boolean,
  now: Date,
): FavoriteExportBuild {
  const exportEntries: FavoriteExportEntry[] = []
  for (const { label, savedAt, body } of bodies) {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>
      if (parsed.data == null) continue
      exportEntries.push({
        label: label as string,
        savedAt: savedAt as string,
        data: withSerializeProtocol(vialProtocol, () => serializeFavData(scope, parsed.data, serializeKeycode)),
      })
    } catch {
      // Skip unreadable entries
    }
  }
  if (single && exportEntries.length === 0) return { error: 'Entry unreadable' }

  const exportKey = FAV_TYPE_TO_EXPORT_KEY[scope]
  const categories: Record<string, FavoriteExportEntry[]> = exportEntries.length > 0 ? { [exportKey]: exportEntries } : {}
  return {
    defaultFilename: `pipette-fav-${exportKey}-${tsForExportFilename(now)}.json`,
    content: exportText(vialProtocol, categories, now),
  }
}

/**
 * The export file of the editor's current value: `dataJson` is
 * `{ type, data }` as the renderer serializes it, exported as one entry
 * labelled `Current`. Throws when `dataJson` is not JSON.
 */
export function buildCurrentFavoriteExport(
  scope: FavoriteType,
  vialProtocol: number,
  dataJson: string,
  now: Date,
): FavoriteExportBuild {
  const parsed = JSON.parse(dataJson) as Record<string, unknown>
  if (parsed.data == null) return { error: 'Missing data field' }

  const exportKey = FAV_TYPE_TO_EXPORT_KEY[scope]
  const data = withSerializeProtocol(vialProtocol, () => serializeFavData(scope, parsed.data, serializeKeycode))
  const categories = { [exportKey]: [{ label: 'Current', savedAt: now.toISOString(), data }] }
  return {
    defaultFilename: `pipette-fav-${exportKey}-current-${tsForExportFilename(now)}.json`,
    content: exportText(vialProtocol, categories, now),
  }
}

/** The export file in `raw`, or null when it is JSON of another shape.
 *  Throws when `raw` is not JSON. */
export function readFavoriteExportFile(raw: string): FavoriteExportFile | null {
  const parsed: unknown = JSON.parse(raw)
  return isValidFavExportFile(parsed) ? parsed : null
}

/** The first `scope` favorite of `file`, with its keycodes as numbers, to
 *  put in the editor. */
export function favoriteDataForCurrent(scope: FavoriteType, file: FavoriteExportFile): { data: unknown } | { error: string } {
  const entries = file.categories[FAV_TYPE_TO_EXPORT_KEY[scope]]
  if (!entries || entries.length === 0) return { error: 'No matching data found for this type' }
  return { data: withDeserializeProtocol(file.vial_protocol, () => deserializeFavData(scope, entries[0].data, deserializeKeycode)) }
}

/** The body file text of an imported `type` favorite whose exported data
 *  is `data`, or null when the data is not a valid favorite of that type. */
export function favoriteImportBody(type: FavoriteType, vialProtocol: number | undefined, data: unknown): string | null {
  const normalized = withDeserializeProtocol(vialProtocol, () => deserializeFavData(type, data, deserializeKeycode))
  if (!isFavoriteDataFile({ type, data: normalized }, type)) return null
  return JSON.stringify({ type, data: normalized })
}

/** A favorite to import into a store: the exported label and save time,
 *  and the body file text. */
export interface FavoriteImportEntry {
  label: string
  savedAt: string
  body: string
}

/** The favorites of one category, to import into the `type` store. */
export interface FavoriteImportBatch {
  type: FavoriteType
  entries: FavoriteImportEntry[]
}

/**
 * The import of `file`, store by store in the file's category order:
 * `batches` for the stores to write (a category whose entries are all
 * invalid still has one, as the store is read and migrated for it),
 * `skipped` the entries left out here (unknown categories, invalid data).
 * `failure` is set when a category names no store but an inherited
 * property of the key map (`constructor`, `__proto__`): the import stops
 * there with that error after writing the batches before it.
 */
export interface FavoriteImportPlan {
  batches: FavoriteImportBatch[]
  skipped: number
  failure?: string
}

/** The import of `file` as the FAVORITE_STORE_IMPORT handler of
 *  src/main/favorite-store.ts runs it, split for a backend that writes the
 *  stores without converting keycodes. */
export function planFavoriteImport(file: FavoriteExportFile): FavoriteImportPlan {
  const batches: FavoriteImportBatch[] = []
  let skipped = 0
  for (const [exportKey, entries] of Object.entries(file.categories)) {
    const type = FAV_EXPORT_KEY_MAP[exportKey]
    if (!type) { skipped += entries.length; continue }
    if (!isValidFavoriteType(type)) return { batches, skipped, failure: 'Invalid favorite type' }
    const valid: FavoriteImportEntry[] = []
    for (const entry of entries) {
      const body = favoriteImportBody(type, file.vial_protocol, entry.data)
      if (body === null) { skipped++; continue }
      valid.push({ label: entry.label, savedAt: entry.savedAt, body })
    }
    batches.push({ type, entries: valid })
  }
  return { batches, skipped }
}
