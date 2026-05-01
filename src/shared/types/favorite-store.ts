// SPDX-License-Identifier: GPL-2.0-or-later

export type FavoriteType = 'tapDance' | 'macro' | 'combo' | 'keyOverride' | 'altRepeatKey'

export interface SavedFavoriteMeta {
  id: string // UUID v4
  label: string // User label
  savedAt: string // ISO 8601
  filename: string // Internal filename
  updatedAt?: string // ISO 8601 — last update time
  deletedAt?: string // ISO 8601 — tombstone timestamp
  hubPostId?: string // Hub post ID (if uploaded)
}

export interface FavoriteIndex {
  type: FavoriteType
  entries: SavedFavoriteMeta[]
}

export interface FavoriteExportEntry {
  label: string
  savedAt: string
  data: unknown
}

/**
 * Pipette favorite export file.
 *
 * - v2 (legacy): no `vial_protocol` field. Imported with the current default protocol.
 * - v3: `vial_protocol` is written by the exporter. Importer uses it to
 *   resolve protocol-specific keycode values; if absent on a v3 file
 *   (out-of-spec but tolerated), falls back to the default protocol.
 *
 * New exports always emit v3.
 */
export interface FavoriteExportFile {
  app: 'pipette'
  version: 2 | 3
  scope: 'fav'
  exportedAt: string
  /** Vial protocol the exporter was using. Required on v3 exports, absent on v2. */
  vial_protocol?: number
  categories: Record<string, FavoriteExportEntry[]>
}

export interface FavoriteImportResult {
  success: boolean
  imported: number
  skipped: number
  error?: string
}
