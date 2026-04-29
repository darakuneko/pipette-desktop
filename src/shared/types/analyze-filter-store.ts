// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze filter snapshot store — saves a labelled "search condition"
// for a single keyboard so the user can flip between past states.
// Sync layout mirrors keyboards/{uid}/snapshots: an index.json plus one
// JSON file per entry under sync/keyboards/{uid}/analyze_filters/.

export interface AnalyzeFilterSnapshotMeta {
  id: string // UUID v4
  label: string
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
