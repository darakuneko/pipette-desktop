// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Per-entry metadata persisted in `userData/sync/key-labels/index.json`.
 * Mirrors the favorite-store pattern: entry-level LWW with soft tombstones.
 */
export interface KeyLabelMeta {
  /** Local UUID v4. Stable across renames; used as keyboardLayout selector value. */
  id: string
  /** Display name. Must be unique (case-insensitive) across active entries. */
  name: string
  /** Hub `uploader_name` cached locally for the Author column. Absent
   *  for entries that have never been associated with a Hub post. */
  uploaderName?: string
  /** Hub post id when synced to Pipette Hub. */
  hubPostId?: string
  /** Internal filename (`{id}_{timestamp}.json`). */
  filename: string
  /** First save time (ISO 8601). */
  savedAt: string
  /** Last update time (ISO 8601). */
  updatedAt: string
  /** Soft delete tombstone (ISO 8601). 30-day GC matches favorites. */
  deletedAt?: string
}

export interface KeyLabelIndex {
  entries: KeyLabelMeta[]
}

/**
 * On-disk content of `{filename}`. Mirrors the Pipette Hub
 * `GET /api/key-labels/:id/download` body, which is `{ name, map,
 * composite_labels }` (the `author` field has been retired upstream).
 */
export interface KeyLabelEntryFile {
  name: string
  map: Record<string, string>
  compositeLabels?: Record<string, string>
}

/** Combined meta + entry payload returned by `get`. */
export interface KeyLabelRecord {
  meta: KeyLabelMeta
  data: KeyLabelEntryFile
}

/** Specific error codes the renderer can branch on. */
export type KeyLabelStoreErrorCode =
  | 'INVALID_NAME'
  | 'DUPLICATE_NAME'
  | 'NOT_FOUND'
  | 'INVALID_FILE'
  | 'IO_ERROR'

export interface KeyLabelStoreResult<T> {
  success: boolean
  data?: T
  errorCode?: KeyLabelStoreErrorCode
  error?: string
}
