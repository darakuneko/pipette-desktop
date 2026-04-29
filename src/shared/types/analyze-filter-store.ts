// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze filter snapshot store — saves a labelled "search condition"
// for a single keyboard so the user can flip between past states.
// Sync layout mirrors keyboards/{uid}/snapshots: an index.json plus one
// JSON file per entry under sync/keyboards/{uid}/analyze_filters/.

export interface AnalyzeFilterSnapshotMeta {
  id: string // UUID v4
  label: string
  /** Snapshot of the user-visible filter labels (keyboard, device, app,
   * keymap, range) joined with ", " at save time. Surfaced under the
   * label in the panel so the user can recognise saved conditions
   * without having to load each snapshot. */
  summary?: string
  filename: string // {label-or-uid}_{timestamp}.json
  savedAt: string // ISO 8601
  updatedAt?: string
  deletedAt?: string // tombstone
}

export interface AnalyzeFilterSnapshotIndex {
  uid: string
  entries: AnalyzeFilterSnapshotMeta[]
}

/** Stable IPC error code for the per-keyboard cap so renderer/main agree
 * without string comparison drift. */
export const ANALYZE_FILTER_STORE_ERROR_MAX_ENTRIES = 'max entries reached'

/** Per-keyboard maximum number of saved Analyze search-condition
 * entries. Shared between main (enforces the cap on save) and renderer
 * (formats the cap-reached toast via i18n interpolation) so the number
 * cannot drift between the validator and the user-facing message. */
export const ANALYZE_FILTER_STORE_MAX_ENTRIES_PER_KEYBOARD = 50
