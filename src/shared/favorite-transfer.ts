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

/** The export entry of a stored `scope` favorite, with its keycodes as
 *  names at `vialProtocol`, or null when its body has no `data`. Throws
 *  when `body` is not JSON. */
export function favoriteExportEntry(
  scope: FavoriteType,
  vialProtocol: number,
  label: unknown,
  savedAt: unknown,
  body: string,
): FavoriteExportEntry | null {
  const parsed = JSON.parse(body) as Record<string, unknown>
  if (parsed.data == null) return null
  return {
    label: label as string,
    savedAt: savedAt as string,
    data: withSerializeProtocol(vialProtocol, () => serializeFavData(scope, parsed.data, serializeKeycode)),
  }
}

/** The categories of an export of `scope` favorites: none when there are
 *  no entries. */
export function favoriteExportCategories(
  scope: FavoriteType,
  entries: FavoriteExportEntry[],
): Record<string, FavoriteExportEntry[]> {
  return entries.length > 0 ? { [FAV_TYPE_TO_EXPORT_KEY[scope]]: entries } : {}
}

/** The default name of an export file made at `now`; `current` for the
 *  export of the editor's value. */
export function favoriteExportFilename(scope: FavoriteType, now: Date, current = false): string {
  return `pipette-fav-${FAV_TYPE_TO_EXPORT_KEY[scope]}${current ? '-current' : ''}-${tsForExportFilename(now)}.json`
}

/** The text of an export file: two-space indented JSON. */
export function favoriteExportText(file: FavoriteExportFile): string {
  return JSON.stringify(file, null, 2)
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
      const exported = favoriteExportEntry(scope, vialProtocol, label, savedAt, body)
      if (exported) exportEntries.push(exported)
    } catch {
      // Skip unreadable entries
    }
  }
  if (single && exportEntries.length === 0) return { error: 'Entry unreadable' }
  const file = buildFavExportFile(vialProtocol, favoriteExportCategories(scope, exportEntries), now.toISOString())
  return { defaultFilename: favoriteExportFilename(scope, now), content: favoriteExportText(file) }
}

/** The data of the editor's current value with its keycodes as names at
 *  `vialProtocol`: `dataJson` is `{ type, data }` as the renderer
 *  serializes it. Throws when `dataJson` is not JSON. */
export function currentFavoriteExportData(
  scope: FavoriteType,
  vialProtocol: number,
  dataJson: string,
): { data: unknown } | { error: string } {
  const parsed = JSON.parse(dataJson) as Record<string, unknown>
  if (parsed.data == null) return { error: 'Missing data field' }
  return { data: withSerializeProtocol(vialProtocol, () => serializeFavData(scope, parsed.data, serializeKeycode)) }
}

/** The export file of the editor's converted value, as one entry labelled
 *  `Current` saved at `now`. */
export function currentFavoriteExportFile(
  scope: FavoriteType,
  vialProtocol: number,
  data: unknown,
  now: Date,
): FavoriteExportFile {
  const categories = { [FAV_TYPE_TO_EXPORT_KEY[scope]]: [{ label: 'Current', savedAt: now.toISOString(), data }] }
  return buildFavExportFile(vialProtocol, categories, now.toISOString())
}

/** The export file of the editor's current value. Throws when `dataJson`
 *  is not JSON. */
export function buildCurrentFavoriteExport(
  scope: FavoriteType,
  vialProtocol: number,
  dataJson: string,
  now: Date,
): FavoriteExportBuild {
  const current = currentFavoriteExportData(scope, vialProtocol, dataJson)
  if ('error' in current) return current
  return {
    defaultFilename: favoriteExportFilename(scope, now, true),
    content: favoriteExportText(currentFavoriteExportFile(scope, vialProtocol, current.data, now)),
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

/** The data of an imported `type` favorite whose exported data is `data`,
 *  with its keycodes as numbers, or null when it is not a valid favorite
 *  of that type. */
export function favoriteImportData(type: FavoriteType, vialProtocol: number | undefined, data: unknown): { data: unknown } | null {
  const normalized = withDeserializeProtocol(vialProtocol, () => deserializeFavData(type, data, deserializeKeycode))
  return isFavoriteDataFile({ type, data: normalized }, type) ? { data: normalized } : null
}

/** The body file text of an imported `type` favorite. */
export function favoriteImportBody(type: FavoriteType, data: unknown): string {
  return JSON.stringify({ type, data })
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
      const imported = favoriteImportData(type, file.vial_protocol, entry.data)
      if (!imported) { skipped++; continue }
      valid.push({ label: entry.label, savedAt: entry.savedAt, body: favoriteImportBody(type, imported.data) })
    }
    batches.push({ type, entries: valid })
  }
  return { batches, skipped }
}
