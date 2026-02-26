// SPDX-License-Identifier: GPL-2.0-or-later

export type FavoriteType = 'tapDance' | 'macro' | 'combo' | 'keyOverride' | 'altRepeatKey'

export interface SavedFavoriteMeta {
  id: string // UUID v4
  label: string // User label
  savedAt: string // ISO 8601
  filename: string // Internal filename
  updatedAt?: string // ISO 8601 — last update time
  deletedAt?: string // ISO 8601 — tombstone timestamp
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

export interface FavoriteExportFile {
  app: 'pipette'
  version: 2
  scope: 'fav'
  exportedAt: string
  categories: Record<string, FavoriteExportEntry[]>
}

export interface FavoriteImportResult {
  success: boolean
  imported: number
  skipped: number
  error?: string
}
