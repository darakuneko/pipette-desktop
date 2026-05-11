// SPDX-License-Identifier: GPL-2.0-or-later

export interface ThemePackMeta {
  id: string
  filename: string
  name: string
  version: string
  baseTheme: 'light' | 'dark'
  hubPostId?: string
  hubUpdatedAt?: string
  savedAt: string
  updatedAt: string
  deletedAt?: string
}

export interface ThemePackIndex {
  metas: ThemePackMeta[]
}

export const THEME_COLOR_KEYS = [
  'surface', 'surface-alt', 'surface-dim', 'surface-raised',
  'content', 'content-secondary', 'content-muted', 'content-inverse',
  'edge', 'edge-subtle', 'edge-strong',
  'accent', 'accent-hover', 'accent-alt', 'success', 'warning', 'danger', 'pending',
  'key-bg', 'key-bg-hover', 'key-bg-active', 'key-border', 'key-shadow',
  'key-label', 'key-sublabel', 'key-label-remap', 'key-bg-multi-selected',
  'tab-bg-active', 'tab-text', 'tab-text-active',
  'picker-bg', 'picker-item-bg', 'picker-item-hover', 'picker-item-text', 'picker-item-border',
] as const

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number]

export type ThemePackColors = Record<ThemeColorKey, string>

export interface ThemePackEntryFile {
  name: string
  version: string
  baseTheme: 'light' | 'dark'
  colors: ThemePackColors
}

export interface ThemePackRecord {
  meta: ThemePackMeta
  pack: ThemePackEntryFile
}

export const THEME_SYNC_UNIT_PREFIX = 'themes/' as const
export const THEME_INDEX_SYNC_UNIT = 'themes/index' as const
export type ThemeIndexSyncUnit = typeof THEME_INDEX_SYNC_UNIT
export type ThemePackSyncUnit = `themes/packs/${string}`

export const THEME_PACK_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000

export const THEME_PACK_LIMITS = {
  MAX_NAME_LENGTH: 64,
} as const

export type ThemePackStoreErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_NAME'
  | 'INVALID_FILE'
  | 'DUPLICATE_NAME'
  | 'IO_ERROR'

export interface ThemePackStoreResult<T> {
  success: boolean
  data?: T
  errorCode?: ThemePackStoreErrorCode
  error?: string
}

export interface ThemePackImportDialogResult {
  canceled: boolean
  raw?: unknown
  fileSizeBytes?: number
  filePath?: string
  parseError?: string
}

export interface ThemePackImportApplyOptions {
  id?: string
  hubPostId?: string
}
