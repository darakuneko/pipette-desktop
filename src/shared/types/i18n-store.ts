// SPDX-License-Identifier: GPL-2.0-or-later
//
// Types for the i18n language pack store. A pack file is a single
// JSON document with reserved top-level keys `version` (semver) and
// `name` (display label). The remaining keys form a nested
// translation tree compatible with `english.json`. Packs are
// distributed via Pipette Hub or imported from local `.json` files.

export interface I18nPackMeta {
  /** UUID v4. Stable across rename. */
  id: string
  /** Storage filename relative to `sync/i18n/packs/`. Equals `${id}.json`. */
  filename: string
  /** Display label shown in language pickers. Mirrors the pack JSON's `name` field. */
  name: string
  /** Pack semver, mirrors the JSON's `version` field. Used to invalidate
   * coverage caches when the pack content changes. */
  version: string
  /** Whether the pack is registered as an i18next resource bundle.
   * Disabled packs are kept on disk but not loaded. */
  enabled: boolean
  /** When set, the pack is mirrored to a public Pipette Hub post. */
  hubPostId?: string
  /** Hub-side `updated_at` cached locally so the startup auto-update
   *  can detect remote changes by comparing this against
   *  `POST /api/i18n-packs/timestamps`. Absent for never-uploaded
   *  local entries and legacy rows that predate this field. */
  hubUpdatedAt?: string
  /** Hub-side `uploader_name` cached for the Author column and the
   *  `isMine` check (Update/Remove only shown when this equals the
   *  signed-in user's display name). Refreshed on upload/download/sync
   *  (mirrors `KeyLabelMeta.uploaderName`); intentionally *not*
   *  refreshed on Update, matching Key Labels' assumption that the
   *  owner does not change between updates. Absent for never-uploaded
   *  local entries and legacy rows that predate this field. */
  uploaderName?: string
  /** ISO 8601 timestamp of the first import. */
  savedAt: string
  /** ISO 8601 timestamp of the most recent enable / rename / overwrite. */
  updatedAt: string
  /** ISO 8601 tombstone. Entries older than the GC window are purged. */
  deletedAt?: string
  /** App version captured at import. Mismatch triggers coverage recompute. */
  appVersionAtImport?: string
  /** English-baseline version this pack last matched against. Stamped
   * only when the import covered every key in `english.json`; cleared
   * (undefined) when coverage is partial. The UI shows this — not the
   * pack's own semver — so a visible version doubles as proof that
   * the pack satisfies the bundled English at that revision. */
  matchedBaseVersion?: string
  /** Coverage snapshot at last import / sync. Cached so the row can
   * render `Coverage 93% (1166 / 1253)` without re-running the
   * flatten + diff each render. */
  coverage?: { totalKeys: number; coveredKeys: number }
  /** Number of `__proto__` / `constructor` / `prototype` keys the
   * importer detected. Always 0 in practice (the importer rejects any
   * pack with dangerous keys), surfaced for transparency in the row. */
  dangerousKeyCount?: number
}

export interface I18nPackIndex {
  metas: I18nPackMeta[]
}

/**
 * Stable id for the built-in English entry so drag/sort order and rename
 * history survive sync — mirrors `key-label-store.ts`'s
 * `QWERTY_ENTRY_ID` precedent, promoted from a renderer-synthesized row
 * to a real store entry (`ensureBuiltinEnglishEntry` in
 * `main/i18n-pack-store.ts`) so English can participate in drag reorder
 * and Name sort like any imported pack. Its on-disk pack body is a
 * trivial placeholder (`{ name, version }`, no translation keys) —
 * unlike an imported pack, the renderer always renders English from the
 * bundled `src/renderer/i18n/locales/english.json`, never from this
 * entry's body, so the placeholder is never actually read.
 */
export const BUILTIN_ENGLISH_PACK_ID = 'builtin-english' as const

/** On-disk representation of a single pack file. The translations live
 * alongside `name` / `version` at the top level — these
 * three keys are stripped before passing the body to i18next. */
export interface I18nPackEntryFile {
  raw: unknown
}

/** Snapshot returned to the renderer after parsing an `.json` selected
 * by the user. Drives the Import Preview modal. */
export interface I18nPreviewPayload {
  name: string
  version: string
  fileSizeBytes: number
  totalKeys: number
  coveredKeys: number
  missingKeys: string[]
  excessKeys: string[]
  dangerousKeys: string[]
  errors: string[]
}

export const I18N_PACK_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Common prefix for every i18n sync unit / Drive filename. Use
 * instead of the literal `'i18n/'` so a future namespace move only
 * touches this constant. */
export const I18N_SYNC_UNIT_PREFIX = 'i18n/' as const
export const I18N_INDEX_SYNC_UNIT = 'i18n/index' as const
export type I18nIndexSyncUnit = typeof I18N_INDEX_SYNC_UNIT
export type I18nPackSyncUnit = `i18n/packs/${string}`

// --- IPC result envelope ----------------------------------------------------

export type I18nPackStoreErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_NAME'
  | 'INVALID_FILE'
  | 'DUPLICATE_NAME'
  | 'IO_ERROR'

export interface I18nPackStoreResult<T> {
  success: boolean
  data?: T
  errorCode?: I18nPackStoreErrorCode
  error?: string
}

export interface I18nPackRecord {
  meta: I18nPackMeta
  pack: unknown
}

/** Structurally identical to Theme Packs' `ThemePackImportFile` /
 *  `ThemePackImportDialogResult` — both alias the shared shape in
 *  `pack-import.ts` (see `readSelectedImportFiles` in
 *  `src/main/pack-import-dialog.ts`, which both IPC handlers call).
 *  Aliased (not just re-exported) under the domain-specific name so
 *  existing call sites don't need to change what they import. */
export type { PackImportFile as I18nPackImportFile, PackImportDialogResult as I18nPackImportDialogResult } from './pack-import'

/** Optional flags forwarded with I18N_PACK_IMPORT_APPLY. */
export interface I18nPackImportApplyOptions {
  enabled?: boolean
  hubPostId?: string
  /** Hub-side `updated_at` for the pack just downloaded/synced. Renderer
   *  fetches this via a name-matched Hub list lookup (the download body
   *  itself carries no metadata) and forwards it here so the Updated
   *  column reflects Hub's own timestamp. */
  hubUpdatedAt?: string
  /** Hub-side `uploader_name`, forwarded the same way as `hubUpdatedAt`. */
  uploaderName?: string
  appVersionAtImport?: string
  id?: string
  /** English version the renderer measured the pack against. Set
   * only when coverage is 100%; the meta uses it as the row's
   * displayed version. `null` explicitly clears any inherited value
   * (used when re-importing a partial pack). */
  matchedBaseVersion?: string | null
  /** Coverage measured by the renderer before save. Persisted on the
   * meta so the row's status line can read it without an IPC round
   * trip. `null` explicitly clears the inherited snapshot. */
  coverage?: { totalKeys: number; coveredKeys: number } | null
  /** Number of dangerous keys the renderer's validator flagged.
   * `null` explicitly clears the inherited count. */
  dangerousKeyCount?: number | null
}
