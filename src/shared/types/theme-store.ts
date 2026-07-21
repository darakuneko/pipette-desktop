// SPDX-License-Identifier: GPL-2.0-or-later

export interface ThemePackMeta {
  id: string
  filename: string
  name: string
  version: string
  hubPostId?: string
  hubUpdatedAt?: string
  /** Hub-side `uploader_name` cached for the Author column and the
   *  `isMine` check. See `I18nPackMeta.uploaderName` for the full
   *  refresh-point contract (upload/download/sync, not Update). Absent
   *  for never-uploaded local entries and legacy rows. */
  uploaderName?: string
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

/** Optional color tokens: a theme pack may omit these entirely without
 *  failing validation. `key-label-simulated` (the permutation-pack
 *  "Display Only" tint, distinct from the `key-label-remap` "actual"
 *  tint) falls back to an automatic complement of `key-label-remap` when
 *  absent — see `deriveSimulatedColor` in `simulated-color.ts` and
 *  `applyPackColors` in `useTheme.ts`. */
export const OPTIONAL_THEME_COLOR_KEYS = ['key-label-simulated'] as const

export type OptionalThemeColorKey = (typeof OPTIONAL_THEME_COLOR_KEYS)[number]

/** Every color key a theme pack's `colors` object may contain, required
 *  and optional combined — used for "unknown key" validation warnings. */
export const ALL_THEME_COLOR_KEYS = [...THEME_COLOR_KEYS, ...OPTIONAL_THEME_COLOR_KEYS] as const

export type AnyThemeColorKey = ThemeColorKey | OptionalThemeColorKey

export type ThemePackColors = Record<ThemeColorKey, string> & Partial<Record<OptionalThemeColorKey, string>>

export type ThemeColorScheme = 'light' | 'dark'

export const THEME_COLOR_SCHEMES: readonly ThemeColorScheme[] = ['light', 'dark'] as const

export interface ThemePackEntryFile {
  name: string
  version: string
  colorScheme: ThemeColorScheme
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

/** Structurally identical to Language Packs' `I18nPackImportFile` /
 *  `I18nPackImportDialogResult` — both alias the shared shape in
 *  `pack-import.ts` (see `readSelectedImportFiles` in
 *  `src/main/pack-import-dialog.ts`, which both IPC handlers call).
 *  Aliased (not just re-exported) under the domain-specific name so
 *  existing call sites don't need to change what they import. */
export type { PackImportFile as ThemePackImportFile, PackImportDialogResult as ThemePackImportDialogResult } from './pack-import'

export interface ThemePackImportApplyOptions {
  id?: string
  hubPostId?: string
  /** Hub-side `updated_at` for the pack just downloaded/synced; see
   *  `I18nPackImportApplyOptions.hubUpdatedAt`. */
  hubUpdatedAt?: string
  /** Hub-side `uploader_name`, forwarded the same way as `hubUpdatedAt`. */
  uploaderName?: string
}
